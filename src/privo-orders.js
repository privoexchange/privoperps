// PRIVO limit orders and TWAP on Robinhood Chain: EIP-712 orders for the PrivoOrders contract, slice math, and the fill
// call a keeper sends. Wallet-free, runs in the browser and in Node.
// An order sells `amountIn` of one token for at least `minAmountOut` of the other, in `slices` parts `interval` seconds
// apart (slices = 1 is a limit order). USDG is always one side; the other is a stock token. The maker approves the
// contract once and signs; a fill moves one slice at or better than the maker's limit, or reverts.
import { parseAbi, encodeFunctionData, getAddress, isAddress, toHex, hashTypedData } from "viem";
import { USDG, MARKETS, STOCK_DECIMALS, quote, fillRoute } from "./privo-swap.js";

// Deterministic CREATE2 address of contracts/PrivoOrders.sol (salt "PRIVO Orders v1", test/orders/deploy-core.js).
// orders-test checks it matches the build; the app turns orders on only once code is deployed here.
export const ORDERS = "0x18dA607Db67Bc9Cc4F2F5a4b26d09788b47Cf60A";
export const FEE_BIPS = 15n;
export const MAX_SLICES = 100;
export const MIN_INTERVAL = 60;            // seconds between TWAP slices
export const MAX_DAYS = 30;                // an order lives at most this long
// PRIVO's keeper, pinned here: the app and the SDK sign it as the filler and refuse any other address the API returns.
// The filler picks the route and the moment of each fill, and with them the price anywhere between the market and the
// maker's limit. So an order should name only a filler the maker trusts, and its limit should be the worst price they accept.
export const KEEPER = getAddress("0x30feed4ee19955b50c1794e0f8da23804ca548de");
export const ORDERS_ABI = parseAbi([
  "function fill((address maker,address filler,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint32 slices,uint32 interval,uint64 start,uint64 deadline,uint256 nonce) o, bytes signature, bytes commands, bytes[] inputs) returns (uint256)",
  "function cancel(uint256 nonce)",
  "function slicesFilled(bytes32) view returns (uint256)",
  "function nonceCancelled(address,uint256) view returns (bool)",
  "function hashOrder((address maker,address filler,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint32 slices,uint32 interval,uint64 start,uint64 deadline,uint256 nonce) o) view returns (bytes32)",
  "event Filled(bytes32 indexed orderHash, address indexed maker, uint256 slice, uint256 amountIn, uint256 amountOut, uint256 fee)",
  "event OrderCancelled(address indexed maker, uint256 indexed nonce)",
  "error NotFiller()", "error Expired()", "error TooEarly()", "error BadOrder()", "error OrderCancelledError()", "error OrderDone()",
  "error BadSignature()", "error BelowLimit()", "error InputLeftInRouter()", "error Reentrancy()",
  "error TransferFailed(address token, address from, address to, uint256 amount)",
]);
export const ORDER_TYPES = { Order: [["maker", "address"], ["filler", "address"], ["tokenIn", "address"], ["tokenOut", "address"], ["amountIn", "uint256"], ["minAmountOut", "uint256"],
  ["slices", "uint32"], ["interval", "uint32"], ["start", "uint64"], ["deadline", "uint64"], ["nonce", "uint256"]].map(([name, type]) => ({ name, type })) };
export const domain = (verifyingContract = ORDERS) => ({ name: "PRIVO Orders", version: "1", chainId: 4663, verifyingContract });
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const ZERO = "0x0000000000000000000000000000000000000000";
const now = () => Math.floor(Date.now() / 1000);
const randNonce = () => BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));

// Orders take stock markets only (18 decimals against USDG), like the Block desk.
export function orderMarket(sym) {
  const m = Object.hasOwn(MARKETS, sym) ? MARKETS[sym] : null;
  return m && !m.native && (m.decimals ?? STOCK_DECIMALS) === STOCK_DECIMALS && m.address !== USDG.address ? m : null;
}
// The stock symbol of an order (or null), from its token addresses.
export function orderSym(o) {
  const stock = getAddress(o.tokenIn) === getAddress(USDG.address) ? o.tokenOut : o.tokenIn;
  return Object.keys(MARKETS).find(s => orderMarket(s) && getAddress(MARKETS[s].address) === getAddress(stock)) || null;
}

/** side "buy": spend amountIn USDG (6 decimals, bigint) for at least minAmountOut stock (18 decimals).
 *  side "sell": sell amountIn stock for at least minAmountOut USDG, after the 0.15% fee. */
export function newOrder({ maker, filler = KEEPER, open = false, sym, side, amountIn, minAmountOut, slices = 1, interval = 0, start = now(), hours = 24 * 7, nonce = randNonce() }) {
  const m = orderMarket(sym);
  if (!m) throw new Error("Orders take stock markets only");
  if (!isAddress(maker)) throw new Error("Connect a wallet first");
  if (side !== "buy" && side !== "sell") throw new Error("Pick buy or sell");
  if (!isAddress(filler)) throw new Error("Bad filler");
  // filler = address(0) lets anyone fill, at any price down to the limit: only when the caller asks for it explicitly
  if (getAddress(filler) === ZERO && !open) throw new Error("An order must name its filler (pass open: true for an anyone-can-fill order)");
  slices = Number(slices); interval = Number(interval); start = Number(start);
  if (!Number.isInteger(slices) || slices < 1 || slices > MAX_SLICES) throw new Error("Slices must be between 1 and " + MAX_SLICES);
  if (slices > 1 && (!Number.isInteger(interval) || interval < MIN_INTERVAL)) throw new Error("Time between slices must be at least " + MIN_INTERVAL + " seconds");
  if (!(hours > 0) || hours > MAX_DAYS * 24) throw new Error("An order can stay open for at most " + MAX_DAYS + " days");
  const deadline = start + Math.round(hours * 3600);
  if (start + (slices - 1) * interval > deadline) throw new Error("The order ends before its last slice");
  if (!(amountIn >= BigInt(slices))) throw new Error("Enter an amount");
  if (!(minAmountOut > 0n)) throw new Error("Set a limit price");
  const [tokenIn, tokenOut] = side === "buy" ? [USDG.address, m.address] : [m.address, USDG.address];
  return { maker: getAddress(maker), filler: getAddress(filler), tokenIn: getAddress(tokenIn), tokenOut: getAddress(tokenOut), amountIn, minAmountOut,
    slices, interval: slices > 1 ? interval : 0, start: BigInt(start), deadline: BigInt(deadline), nonce: BigInt(nonce) };
}
export const sideOf = o => (getAddress(o.tokenIn) === getAddress(USDG.address) ? "buy" : "sell");

// Limit price in USDG per share -> minAmountOut, after the fee. Buy: (amountIn - fee) / price shares. Sell: amountIn * price - fee.
export function minOutForPrice(side, amountIn, price) {
  const p = BigInt(Math.round(Number(price) * 1e6)); // USDG per share, 6 decimals
  if (!(p > 0n)) throw new Error("Set a limit price");
  if (side === "buy") return (amountIn - amountIn * FEE_BIPS / 10000n) * 10n ** 18n / p;
  const gross = amountIn * p / 10n ** 18n;
  return gross - gross * FEE_BIPS / 10000n;
}
// Worst average price an order accepts, USDG per share.
export function limitPrice(o) {
  const sell = sideOf(o) === "sell";
  if (sell) return Number(o.minAmountOut * 10000n / (10000n - FEE_BIPS)) / 1e6 / (Number(o.amountIn) / 1e18);
  return Number(o.amountIn - o.amountIn * FEE_BIPS / 10000n) / 1e6 / (Number(o.minAmountOut) / 1e18);
}

// Same math as the contract: size of slice i and the least the maker must receive for it (rounded up).
export function slice(o, i) {
  const n = BigInt(o.slices), part = o.amountIn / n;
  const amountIn = BigInt(i) + 1n === n ? o.amountIn - part * (n - 1n) : part;
  return { amountIn, minOut: (o.minAmountOut * amountIn + o.amountIn - 1n) / o.amountIn };
}
export const dueAt = (o, i) => Number(o.start) + i * Number(o.interval);
// When the keeper may fill the next slice. The contract only refuses a slice before its due time, so after an outage
// several slices can be overdue at once. The keeper never catches up in a burst: it keeps `interval` between its own
// fills, shortened only as far as needed to fit the slices left before the deadline (never under MIN_INTERVAL).
export function nextFillAt(o, filled, lastFillAt = 0, nowSec = now()) {
  const due = dueAt(o, filled);
  if (!lastFillAt || o.slices < 2) return due;
  const left = o.slices - filled, room = Number(o.deadline) - Math.max(nowSec, lastFillAt);
  const gap = Math.max(MIN_INTERVAL, Math.min(Number(o.interval), Math.floor(room / left)));
  return Math.max(due, lastFillAt + gap);
}

export const orderTypedData = (o, contract = ORDERS) => ({ domain: domain(contract), types: ORDER_TYPES, primaryType: "Order", message: o });
export const orderHash = (o, contract = ORDERS) => hashTypedData(orderTypedData(o, contract));

/* ---------- state ---------- */
// { filled, cancelled, expired, done, next } for an order, read from the contract.
export async function orderState(client, o, contract = ORDERS) {
  const [filled, cancelled] = await Promise.all([
    client.readContract({ address: contract, abi: ORDERS_ABI, functionName: "slicesFilled", args: [orderHash(o, contract)] }),
    client.readContract({ address: contract, abi: ORDERS_ABI, functionName: "nonceCancelled", args: [o.maker, o.nonce] }),
  ]);
  const expired = BigInt(now()) > o.deadline, done = Number(filled) >= o.slices;
  return { filled: Number(filled), cancelled, expired, done, open: !cancelled && !expired && !done, next: done ? null : dueAt(o, Number(filled)) };
}
// Can the maker cover the next slice right now? Checks balance and the approval to the contract.
export async function makerReady(client, o, contract = ORDERS) {
  const need = slice(o, o.slices - 1).amountIn; // the last slice is the largest
  const [bal, allow] = await Promise.all([
    client.readContract({ address: o.tokenIn, abi: ERC20, functionName: "balanceOf", args: [o.maker] }),
    client.readContract({ address: o.tokenIn, abi: ERC20, functionName: "allowance", args: [o.maker, contract] }),
  ]);
  return { balance: bal >= need, approved: allow >= need };
}

/* ---------- fills (keeper) ---------- */
// Quotes slice i through the best pool and builds the fill call. Returns { to, data, slice, quote, expectedOut, fillable }:
// fillable is false when the pool would pay less than the maker's limit for this slice (the call would revert).
export async function buildFill(client, o, signature, i, { contract = ORDERS, slippageBps = 50 } = {}) {
  const sym = orderSym(o); if (!sym) throw new Error("Unknown market");
  const side = sideOf(o), s = slice(o, i);
  const q = await quote(client, { sym, side, amount: s.amountIn });
  // the router minimum is never below what the maker's limit needs (for a sell, gross of the 0.15% fee)
  const limitGross = side === "sell" ? (s.minOut * 10000n + 10000n - FEE_BIPS - 1n) / (10000n - FEE_BIPS) : s.minOut;
  const route = fillRoute(q, { slippageBps, floor: limitGross });
  return { to: contract, slice: s, quote: q, expectedOut: q.netOut, fillable: q.grossOut >= limitGross,
    data: encodeFunctionData({ abi: ORDERS_ABI, functionName: "fill", args: [o, signature, route.commands, route.inputs] }) };
}

/* ---------- transactions (maker) ---------- */
export async function needsApproval(client, owner, token, amount, contract = ORDERS) {
  return (await client.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [owner, contract] })) < amount;
}
export const approveTx = (token, amount, contract = ORDERS) => ({ to: getAddress(token), data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [contract, amount] }) });
export const cancelTx = (nonce, contract = ORDERS) => ({ to: contract, data: encodeFunctionData({ abi: ORDERS_ABI, functionName: "cancel", args: [BigInt(nonce)] }) });

/* ---------- storage form (JSON-safe) ---------- */
export const toJson = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
export const fromJson = o => ({ ...o, maker: getAddress(o.maker), filler: getAddress(o.filler), tokenIn: getAddress(o.tokenIn), tokenOut: getAddress(o.tokenOut),
  amountIn: BigInt(o.amountIn), minAmountOut: BigInt(o.minAmountOut), slices: Number(o.slices), interval: Number(o.interval), start: BigInt(o.start), deadline: BigInt(o.deadline), nonce: BigInt(o.nonce) });
