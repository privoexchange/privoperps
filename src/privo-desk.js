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
const isId = s => /^0x[0-9a-fA-F]{64}$/.test(String(s));
// A request (and every quote signed for it) lives at most this long, so a signed quote cannot become a long free option.
export const MAX_HOURS = 24;
const MAX_LIFE = MAX_HOURS * 3600 + 300; // 5 min slack for clock drift between maker and taker

// The desk sizes every stock leg with STOCK_DECIMALS (18), so it only takes stock markets (cbBTC has 8 decimals).
// Object.hasOwn keeps names like "__proto__" or "constructor" from passing as a market.
export const deskMarket = sym => typeof sym === "string" && Object.hasOwn(MARKETS, sym) && MARKETS[sym].kind === "stock" && (MARKETS[sym].decimals ?? STOCK_DECIMALS) === STOCK_DECIMALS;

/* ---------- tokens: names only from PRIVO's fixed list, never from the token contract ---------- */
// The two tokens a request trades, as [maker gives, taker gives].
export function requestTokens(r) {
  const stock = getAddress(MARKETS[r.sym].address), usdg = getAddress(USDG.address);
  return r.side === "sell" ? { makerToken: stock, takerToken: usdg } : { makerToken: usdg, takerToken: stock };
}
export function tokenLabel(addr) {
  const a = String(addr || "").toLowerCase();
  if (a === USDG.address.toLowerCase()) return "USDG";
  const hit = Object.entries(MARKETS).find(([, m]) => m.address.toLowerCase() === a);
  return hit ? hit[0] : "Unknown token";
}

/* ---------- requests (maker) ---------- */
// side: what the MAKER wants to do with the stock: "sell" or "buy". qty in shares (string), limit in USDG per share (string or "").
export function newRequest({ maker, side, sym, qty, limit = "", hours = 4 }) {
  if (!isAddress(maker)) throw new Error("Connect a wallet first");
  if (!deskMarket(sym)) throw new Error("The block desk trades stock tokens only");
  if (side !== "sell" && side !== "buy") throw new Error("Pick buy or sell");
  const q = parseUnits(String(qty), STOCK_DECIMALS); if (q <= 0n) throw new Error("Enter a quantity");
  if (limit !== "" && parseUnits(String(limit), USDG.decimals) <= 0n) throw new Error("Limit price must be above zero");
  if (!(+hours > 0) || +hours > MAX_HOURS) throw new Error(`Quotes can stay valid for up to ${MAX_HOURS} hours`);
  return { v: 1, id: rand32(), maker: getAddress(maker), side, sym, qty: String(qty), limit: limit === "" ? "" : String(limit), deadline: now() + Math.round(hours * 3600) };
}
export const requestLink = (r, base) => (base || "") + "#block/pv_" + b64e(JSON.stringify(r));
export function parseRequest(text) {
  const m = String(text || "").match(/pv_([A-Za-z0-9_-]+)/); if (!m) throw new Error("No PRIVO block link found");
  const r = JSON.parse(b64d(m[1]));
  if (r.v !== 1 || !isAddress(r.maker) || !deskMarket(r.sym) || !isId(r.id) || (r.side !== "sell" && r.side !== "buy") || !Number.isInteger(r.deadline)) throw new Error("This block link is damaged");
  if (r.deadline > now() + MAX_LIFE) throw new Error(`This request stays open longer than ${MAX_HOURS} hours, so PRIVO will not quote it`);
  return { ...r, maker: getAddress(r.maker) };
}

/* ---------- quotes (taker) ---------- */
// price: USDG per share offered by the taker (string). hours: optional shorter life for this quote than the request's.
export function buildQuote(r, taker, price, { hours } = {}) {
  if (!isAddress(taker)) throw new Error("Connect a wallet first");
  if (!deskMarket(r.sym)) throw new Error("The block desk trades stock tokens only");
  if (getAddress(taker) === r.maker) throw new Error("You made this request. Use another wallet to answer it.");
  if (r.deadline <= now() + 60) throw new Error("This request has closed");
  if (r.deadline > now() + MAX_LIFE) throw new Error(`This request stays open longer than ${MAX_HOURS} hours, so PRIVO will not quote it`);
  const deadline = hours > 0 ? Math.min(r.deadline, now() + Math.round(hours * 3600)) : r.deadline;
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
    blockId: r.id, nonce: randNonce(), deadline: BigInt(deadline),
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
    if (!isId(q.blockId)) throw new Error("one code is not a PRIVO quote");
    return { q: { ...q, maker: getAddress(q.maker), taker: getAddress(q.taker), makerToken: getAddress(q.makerToken), takerToken: getAddress(q.takerToken), makerAmount: BigInt(q.makerAmount), takerAmount: BigInt(q.takerAmount), nonce: BigInt(q.nonce), deadline: BigInt(q.deadline) }, sig: j.sig };
  });
}

// Price per share in USDG and the fee, from the maker's point of view. The direction comes from the request's side
// (never from the quote's takerToken, which the taker chooses); without a side it falls back to the maker's own token.
export function quoteTerms(q, side) {
  const makerSells = side ? side === "sell" : q.makerToken.toLowerCase() !== USDG.address.toLowerCase();
  const usdg = makerSells ? q.takerAmount : q.makerAmount, shares = makerSells ? q.makerAmount : q.takerAmount;
  const fee = usdg * FEE_BIPS / 10000n;
  return { makerSells, usdg, shares, fee, price: Number(formatUnits(usdg, USDG.decimals)) / Number(formatUnits(shares, STOCK_DECIMALS)),
    makerGets: makerSells ? usdg - fee : shares, makerPays: makerSells ? shares : usdg + fee };
}

// Everything the maker needs to know before settling one quote.
export async function checkQuote(client, r, { q, sig }) {
  const problems = [];
  if (!deskMarket(r.sym)) return { ok: false, problems: ["The block desk trades stock tokens only"], terms: quoteTerms(q, r.side) };
  let signer = null;
  try { signer = await recoverTypedDataAddress({ ...quoteTypedData(q), signature: sig }); } catch {}
  if (!signer || signer !== q.taker) problems.push("Signature does not match the taker");
  if (q.blockId !== r.id) problems.push("Answers a different request");
  if (q.maker !== r.maker) problems.push("Made out to another maker");
  // Both legs must be exactly the request's tokens: a look-alike token on either side is rejected.
  const want = requestTokens(r);
  const tokensOk = q.makerToken.toLowerCase() === want.makerToken.toLowerCase() && q.takerToken.toLowerCase() === want.takerToken.toLowerCase();
  if (!tokensOk) problems.push("Tokens do not match the request");
  const qty = parseUnits(r.qty, STOCK_DECIMALS);
  if ((r.side === "sell" ? q.makerAmount : q.takerAmount) !== qty) problems.push("Quantity differs from the request");
  if (q.deadline <= BigInt(now())) problems.push("Expired");
  if (q.deadline > BigInt(r.deadline)) problems.push("Quote stays valid longer than your request");
  const t = quoteTerms(q, r.side);
  if (r.limit && t.shares > 0n) {
    // integer compare: usdg / shares vs limit, both scaled to USDG units per whole share
    const lhs = t.usdg * 10n ** BigInt(STOCK_DECIMALS), rhs = parseUnits(String(r.limit), USDG.decimals) * t.shares;
    if ((r.side === "sell" && lhs < rhs) || (r.side === "buy" && lhs > rhs)) problems.push("Outside your limit price");
  }
  // Balance and allowance are only meaningful on the real token; skip the reads on a mismatched one.
  if (!tokensOk) return { ok: false, problems, terms: t };
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

/* ---------- after settlement: a losing quote stays fillable until its deadline unless the taker cancels it ---------- */
const SETTLED = parseAbi(["event Settled(bytes32 indexed blockId, address indexed maker, address indexed taker, address makerToken, uint256 makerAmount, address takerToken, uint256 takerAmount, address feeToken, uint256 fee)"]);
// Settlements of one request since fromBlock: [{ taker, tx }].
export async function settlementsOf(client, blockId, fromBlock = 0n) {
  const logs = await client.getLogs({ address: DESK, event: SETTLED[0], args: { blockId }, fromBlock: BigInt(fromBlock), toBlock: "latest" });
  return logs.map(l => ({ taker: getAddress(l.args.taker), tx: l.transactionHash }));
}
// For a taker's own quote: "open" (not settled yet), "won" (settled with this quote), "lost" (the request settled with
// someone else and this quote can still be filled: cancel it), "done" (used, cancelled or expired).
export async function quoteStatus(client, q, fromBlock = 0n) {
  if (q.deadline <= BigInt(now())) return "done";
  const used = await client.readContract({ address: DESK, abi: DESK_ABI, functionName: "nonceUsed", args: [q.taker, q.nonce] });
  const s = await settlementsOf(client, q.blockId, fromBlock);
  if (s.some(x => x.taker === getAddress(q.taker))) return used ? "won" : "open";
  if (used) return "done";
  return s.length ? "lost" : "open";
}

/* ---------- transactions ---------- */
export async function needsApproval(client, owner, token, amount) {
  return (await client.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [owner, DESK] })) < amount;
}
export const approveTx = (token, amount) => ({ to: getAddress(token), data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [DESK, amount] }) });
export const settleTx = ({ q, sig }) => ({ to: DESK, data: encodeFunctionData({ abi: DESK_ABI, functionName: "settle", args: [q, sig] }) });
export const cancelTx = nonce => ({ to: DESK, data: encodeFunctionData({ abi: DESK_ABI, functionName: "cancel", args: [BigInt(nonce)] }) });
// What the maker must approve: the maker leg, plus the fee when the maker pays USDG.
export function makerApproval(q, side) { const t = quoteTerms(q, side); return { token: q.makerToken, amount: t.makerSells ? q.makerAmount : q.makerAmount + t.fee }; }
