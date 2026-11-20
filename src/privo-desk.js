// PRIVO Block desk on Robinhood Chain: private request links, signed quotes, checks and settle calldata
// for the deployed PrivoBlockDesk contract. Wallet-free, runs in the browser and in Node.
import { parseAbi, encodeFunctionData, getAddress, isAddress, recoverTypedDataAddress, toHex, parseUnits, formatUnits } from "viem";
import { USDG, MARKETS, STOCK_DECIMALS } from "./privo-swap.js";

// Deployed 19 Nov 2026 via CREATE2; on-chain code checked against contracts/out/PrivoBlockDesk.json.
export const DESK = "0x8D94fCe2925EBA2448DA28f9461c8b644c26b8e7";
export const FEE_BIPS = 10n;
export const DESK_ABI = parseAbi([
  "function settle((address maker,address taker,address makerToken,uint256 makerAmount,address takerToken,uint256 takerAmount,bytes32 blockId,uint256 nonce,uint256 deadline) q, bytes takerSignature)",
  "function cancel(uint256 nonce)",
  "function nonceUsed(address,uint256) view returns (bool)",
  "error NotMaker()", "error Expired()", "error NonceAlreadyUsed()", "error BadQuote()", "error BadSignature()",
  "error TransferFailed(address token, address from, address to, uint256 amount)",
]);
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
export const DOMAIN = { name: "PRIVO Block Desk", version: "1", chainId: 4663, verifyingContract: DESK };
export const QUOTE_TYPES = { Quote: [["maker", "address"], ["taker", "address"], ["makerToken", "address"], ["makerAmount", "uint256"], ["takerToken", "address"], ["takerAmount", "uint256"], ["blockId", "bytes32"], ["nonce", "uint256"], ["deadline", "uint256"]].map(([name, type]) => ({ name, type })) };

const b64e = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = s => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4))));
const rand32 = () => toHex(crypto.getRandomValues(new Uint8Array(32)));
const randNonce = () => BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
const now = () => Math.floor(Date.now() / 1000);

/* ---------- requests (maker) ---------- */
// side: what the MAKER wants to do with the stock: "sell" or "buy". qty in shares (string), limit in USDG per share (string or "").
export function newRequest({ maker, side, sym, qty, limit = "", hours = 4 }) {
  if (!isAddress(maker)) throw new Error("Connect a wallet first");
  if (!MARKETS[sym]) throw new Error("Unknown market");
  if (side !== "sell" && side !== "buy") throw new Error("Pick buy or sell");
  const q = parseUnits(String(qty), STOCK_DECIMALS); if (q <= 0n) throw new Error("Enter a quantity");
  if (limit !== "" && parseUnits(String(limit), USDG.decimals) <= 0n) throw new Error("Limit price must be above zero");
  return { v: 1, id: rand32(), maker: getAddress(maker), side, sym, qty: String(qty), limit: limit === "" ? "" : String(limit), deadline: now() + Math.round(hours * 3600) };
}
export const requestLink = (r, base) => (base || "") + "#block/pv_" + b64e(JSON.stringify(r));
export function parseRequest(text) {
  const m = String(text || "").match(/pv_([A-Za-z0-9_-]+)/); if (!m) throw new Error("No PRIVO block link found");
  const r = JSON.parse(b64d(m[1]));
  if (r.v !== 1 || !isAddress(r.maker) || !MARKETS[r.sym] || !/^0x[0-9a-fA-F]{64}$/.test(r.id)) throw new Error("This block link is damaged");
  return { ...r, maker: getAddress(r.maker) };
}

/* ---------- quotes (taker) ---------- */
// price: USDG per share offered by the taker (string).
export function buildQuote(r, taker, price) {
  if (!isAddress(taker)) throw new Error("Connect a wallet first");
  if (getAddress(taker) === r.maker) throw new Error("You made this request. Use another wallet to answer it.");
  if (r.deadline <= now() + 60) throw new Error("This request has closed");
  const stock = MARKETS[r.sym].address;
  const qty = parseUnits(r.qty, STOCK_DECIMALS);
  const px = parseUnits(String(price), USDG.decimals); if (px <= 0n) throw new Error("Enter your price");
  const total = qty * px / 10n ** BigInt(STOCK_DECIMALS);
  if (total <= 0n) throw new Error("Total is too small");
  const makerSells = r.side === "sell";
  return {
    maker: r.maker, taker: getAddress(taker),
    makerToken: makerSells ? stock : USDG.address, makerAmount: makerSells ? qty : total,
    takerToken: makerSells ? USDG.address : stock, takerAmount: makerSells ? total : qty,
    blockId: r.id, nonce: randNonce(), deadline: BigInt(r.deadline),
  };
}
export const quoteTypedData = q => ({ domain: DOMAIN, types: QUOTE_TYPES, primaryType: "Quote", message: q });
export function encodeQuote(q, sig) {
  const j = Object.fromEntries(Object.entries(q).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  return "PRIVO-QUOTE:" + b64e(JSON.stringify({ v: 1, q: j, sig }));
}
export function decodeQuotes(text) {
  return String(text || "").split(/\s+/).filter(s => s.startsWith("PRIVO-QUOTE:")).map(s => {
    let j; try { j = JSON.parse(b64d(s.slice(12))); } catch { throw new Error("one code is not a complete PRIVO quote (cut off while copying?)"); }
    if (j.v !== 1 || !j.q || !j.sig) throw new Error("one code is not a PRIVO quote");
    const q = j.q;
    return { q: { ...q, maker: getAddress(q.maker), taker: getAddress(q.taker), makerToken: getAddress(q.makerToken), takerToken: getAddress(q.takerToken), makerAmount: BigInt(q.makerAmount), takerAmount: BigInt(q.takerAmount), nonce: BigInt(q.nonce), deadline: BigInt(q.deadline) }, sig: j.sig };
  });
}

// Price per share in USDG and the fee, from the maker's point of view.
export function quoteTerms(q) {
  const makerSells = q.takerToken.toLowerCase() === USDG.address.toLowerCase();
  const usdg = makerSells ? q.takerAmount : q.makerAmount, shares = makerSells ? q.makerAmount : q.takerAmount;
  const fee = usdg * FEE_BIPS / 10000n;
  return { makerSells, usdg, shares, fee, price: Number(formatUnits(usdg, USDG.decimals)) / Number(formatUnits(shares, STOCK_DECIMALS)),
    makerGets: makerSells ? usdg - fee : shares, makerPays: makerSells ? shares : usdg + fee };
}

// Everything the maker needs to know before settling one quote.
export async function checkQuote(client, r, { q, sig }) {
  const problems = [];
  let signer = null;
  try { signer = await recoverTypedDataAddress({ ...quoteTypedData(q), signature: sig }); } catch {}
  if (!signer || signer !== q.taker) problems.push("Signature does not match the taker");
  if (q.blockId !== r.id) problems.push("Answers a different request");
  if (q.maker !== r.maker) problems.push("Made out to another maker");
  const stock = MARKETS[r.sym].address.toLowerCase(), wantMaker = r.side === "sell" ? stock : USDG.address.toLowerCase();
  if (q.makerToken.toLowerCase() !== wantMaker) problems.push("Tokens do not match the request");
  const qty = parseUnits(r.qty, STOCK_DECIMALS);
  if ((r.side === "sell" ? q.makerAmount : q.takerAmount) !== qty) problems.push("Quantity differs from the request");
  if (q.deadline <= BigInt(now())) problems.push("Expired");
  const t = quoteTerms(q);
  if (r.limit && ((r.side === "sell" && t.price < +r.limit) || (r.side === "buy" && t.price > +r.limit))) problems.push("Outside your limit price");
  const [used, tBal, tAllow] = await Promise.all([
    client.readContract({ address: DESK, abi: DESK_ABI, functionName: "nonceUsed", args: [q.taker, q.nonce] }),
    client.readContract({ address: q.takerToken, abi: ERC20, functionName: "balanceOf", args: [q.taker] }),
    client.readContract({ address: q.takerToken, abi: ERC20, functionName: "allowance", args: [q.taker, DESK] }),
  ]);
  if (used) problems.push("Cancelled or already used by the taker");
  if (tBal < q.takerAmount) problems.push("Taker's wallet no longer holds enough");
  if (tAllow < q.takerAmount) problems.push("Taker has not approved the desk for this amount");
  return { ok: problems.length === 0, problems, terms: t };
}

/* ---------- transactions ---------- */
export async function needsApproval(client, owner, token, amount) {
  return (await client.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [owner, DESK] })) < amount;
}
export const approveTx = (token, amount) => ({ to: getAddress(token), data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [DESK, amount] }) });
export const settleTx = ({ q, sig }) => ({ to: DESK, data: encodeFunctionData({ abi: DESK_ABI, functionName: "settle", args: [q, sig] }) });
export const cancelTx = nonce => ({ to: DESK, data: encodeFunctionData({ abi: DESK_ABI, functionName: "cancel", args: [BigInt(nonce)] }) });
// What the maker must approve: the maker leg, plus the fee when the maker pays USDG.
export function makerApproval(q) { const t = quoteTerms(q); return { token: q.makerToken, amount: t.makerSells ? q.makerAmount : q.makerAmount + t.fee }; }
