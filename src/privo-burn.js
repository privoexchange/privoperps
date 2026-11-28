// $PRIVO buyback & burn from the PRIVO fee Safe. Every PRIVO fee (spot swaps, Block desk, limit and TWAP fills, AI Pro
// in USDG or $PRIVO) lands in the fee Safe; the Safe owners periodically sign one batch that
//   1. sends the Safe's USDG to the Uniswap router and buys $PRIVO with it, the router sending every bought token
//      straight to the burn address (the tokens never come back to the Safe), and
//   2. sends any $PRIVO the Safe already holds (AI Pro paid in $PRIVO) to the burn address.
// The batch runs through Safe's MultiSendCallOnly, so it is all or nothing, and leaves no approval behind.
// A signed batch carries its parameters; anyone can rebuild it from them with burnTx() and compare the bytes.
import { encodeFunctionData, encodePacked, decodeFunctionData, parseAbi, getAddress, size, concatHex, sliceHex, hexToBigInt, hexToNumber } from "viem";
import { MARKETS, USDG, ADDR, quote, buyToRoute, applySlippage } from "./privo-swap.js";

export const DEAD = "0x000000000000000000000000000000000000dEaD";
// MultiSendCallOnly 1.4.1 (canonical Safe deployment; code checked on chain 4663). Call-only: no nested delegatecalls.
export const MULTISEND = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
export const PRIVO = MARKETS.PRIVO.address;
export const SYM = "PRIVO";
export const MAX_SLIPPAGE_BPS = 500;

const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const MS = parseAbi(["function multiSend(bytes transactions) payable"]);

// The pool a quote picked, as indexes into MARKETS (so a signed batch names its route without trusting the code's text).
export function routeOf(pool) {
  const i = MARKETS[SYM].pools.findIndex(p => p.id.toLowerCase() === pool.id.toLowerCase());
  if (i < 0) throw new Error("Unknown $PRIVO pool");
  const e = pool.eth ? MARKETS.ETH.pools.findIndex(p => p.id.toLowerCase() === pool.eth.id.toLowerCase()) : null;
  if (pool.eth && e < 0) throw new Error("Unknown ETH pool");
  return { pool: i, eth: e };
}
const poolOf = r => {
  const p = MARKETS[SYM].pools[r.pool];
  if (!p) throw new Error("Unknown $PRIVO pool");
  if (p.hop !== "ETH") return p;
  const eth = MARKETS.ETH.pools[r.eth];
  if (!eth) throw new Error("Unknown ETH pool");
  return { ...p, eth };
};

// Quotes a buyback: usdgIn of the Safe's USDG into $PRIVO (no PRIVO fee), plus privoHeld already in the Safe.
// Returns the batch parameters ({ usdgIn, privoHeld, expected, minOut, route, deadline }) for burnTx().
export async function planBurn(client, { usdgIn = 0n, privoHeld = 0n, slippageBps = 200, ttlSec = 86400, now = Date.now() } = {}) {
  if (slippageBps < 1 || slippageBps > MAX_SLIPPAGE_BPS) throw new Error("Slippage must be between 0.01% and 5%");
  if (usdgIn < 0n || privoHeld < 0n) throw new Error("Amounts cannot be negative");
  if (usdgIn === 0n && privoHeld === 0n) throw new Error("Nothing to burn: the Safe holds no USDG or $PRIVO");
  const deadline = BigInt(Math.floor(now / 1000) + ttlSec);
  if (usdgIn === 0n) return { usdgIn, privoHeld, expected: 0n, minOut: 0n, route: null, deadline, slippageBps };
  const q = await quote(client, { sym: SYM, side: "buy", amount: usdgIn, fee: false, every: false });
  if (q.bips !== 0n || q.fee !== 0n) throw new Error("A buyback must not pay the PRIVO fee");
  return { usdgIn, privoHeld, expected: q.grossOut, minOut: applySlippage(q.grossOut, slippageBps), route: routeOf(q.pool), deadline, slippageBps };
}

// The calls of a buyback, in order.
export function burnCalls({ usdgIn, privoHeld, minOut, route, deadline }) {
  const calls = [];
  if (usdgIn > 0n) {
    const swap = buyToRoute({ sym: SYM, pool: poolOf(route), recipient: DEAD, minOut, deadline });
    calls.push({ to: getAddress(USDG.address), value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [getAddress(ADDR.ROUTER), usdgIn] }) });
    calls.push({ to: getAddress(swap.to), value: 0n, data: swap.data });
  }
  if (privoHeld > 0n) calls.push({ to: getAddress(PRIVO), value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [DEAD, privoHeld] }) });
  if (!calls.length) throw new Error("Nothing to burn");
  return calls;
}

// One Safe transaction (operation 1 = delegatecall into MultiSendCallOnly) for the whole buyback.
export function burnTx(params) {
  const packed = concatHex(burnCalls(params).map(c => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, c.to, c.value, BigInt(size(c.data)), c.data])));
  return { to: MULTISEND, value: 0n, data: encodeFunctionData({ abi: MS, functionName: "multiSend", args: [packed] }), operation: 1 };
}

// The calls inside a MultiSend transaction (for showing a batch to an owner).
export function decodeBatch(tx) {
  if (getAddress(tx.to) !== MULTISEND || tx.operation !== 1) throw new Error("Not a MultiSend batch");
  const { functionName, args } = decodeFunctionData({ abi: MS, data: tx.data });
  if (functionName !== "multiSend") throw new Error("Not a MultiSend batch");
  const b = args[0], out = [];
  let i = 0;
  while (i < size(b)) {
    const op = hexToNumber(sliceHex(b, i, i + 1)), to = getAddress(sliceHex(b, i + 1, i + 21)), value = hexToBigInt(sliceHex(b, i + 21, i + 53)), len = Number(hexToBigInt(sliceHex(b, i + 53, i + 85)));
    out.push({ op, to, value, data: len ? sliceHex(b, i + 85, i + 85 + len) : "0x" });
    i += 85 + len;
  }
  return out;
}

// Parameters travel with the signed code as strings; these turn them back and forth.
export const paramsToJson = p => ({ kind: "privo-burn", usdgIn: p.usdgIn.toString(), privoHeld: p.privoHeld.toString(), minOut: p.minOut.toString(), expected: (p.expected ?? 0n).toString(), route: p.route, deadline: p.deadline.toString(), slippageBps: p.slippageBps });
export function paramsFromJson(j) {
  if (!j || j.kind !== "privo-burn") throw new Error("This code is not a $PRIVO buyback");
  return { usdgIn: BigInt(j.usdgIn), privoHeld: BigInt(j.privoHeld), minOut: BigInt(j.minOut), expected: BigInt(j.expected || 0), route: j.route, deadline: BigInt(j.deadline), slippageBps: j.slippageBps };
}

// True only when tx is exactly the buyback these parameters describe: same target, operation and bytes.
export function matchesBurn(tx, params) {
  const want = burnTx(params);
  return getAddress(tx.to) === want.to && tx.operation === want.operation && BigInt(tx.value) === 0n && tx.data.toLowerCase() === want.data.toLowerCase();
}
