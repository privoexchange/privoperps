// End-to-end check of privo-desk.js against the DEPLOYED PrivoBlockDesk on Robinhood Chain, sending nothing.
// Throwaway maker and taker keys; balances and allowances are faked by state override; settle runs as eth_call
// from the maker against the real contract address.
import { createPublicClient, http, encodeFunctionData, parseAbi, pad, toHex, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DESK, newRequest, requestLink, parseRequest, buildQuote, quoteTypedData, encodeQuote, decodeQuotes, checkQuote, quoteTerms, settleTx, makerApproval } from "../../src/privo-desk.js";
import { USDG, MARKETS } from "../../src/privo-swap.js";

const c = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { timeout: 30000, retryCount: 2 }) });
const maker = privateKeyToAccount(generatePrivateKey()), takers = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const cache = {};
async function slot(token, data) {
  if (cache[token + data]) return cache[token + data];
  const al = await c.request({ method: "eth_createAccessList", params: [{ to: token, data }, "latest"] });
  for (const e of al.accessList) for (const k of e.storageKeys) {
    try { const r = await c.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [e.address]: { stateDiff: { [k]: pad(toHex(7n)) } } }] }); if (r !== "0x" && BigInt(r) === 7n) return (cache[token + data] = { a: e.address, k }); } catch {}
  }
  throw new Error("slot");
}
const ov = {};
async function give(token, who, amount, spender) {
  const s = await slot(token, encodeFunctionData({ abi: erc, functionName: spender ? "allowance" : "balanceOf", args: spender ? [who, spender] : [who] }));
  ov[s.a] = ov[s.a] || { stateDiff: {} }; ov[s.a].stateDiff[s.k] = pad(toHex(amount));
}

// Maker wants to SELL 3 NVDA, limit 140 USDG.
const req = newRequest({ maker: maker.address, side: "sell", sym: "NVDA", qty: "3", limit: "140", hours: 4 });
const link = requestLink(req, "https://privo-exchange.netlify.app/app.html");
const back = parseRequest(link);
check(back.id === req.id && back.maker === maker.address && back.qty === "3" && link.length < 600, `request link round-trips (${link.length} chars)`);

// Three takers answer: 151, 149.5, 130 (below the limit).
const prices = ["151", "149.5", "130"], codes = [];
for (let i = 0; i < 3; i++) {
  const q = buildQuote(back, takers[i].address, prices[i]);
  codes.push(encodeQuote(q, await takers[i].signTypedData(quoteTypedData(q))));
}
const quotes = decodeQuotes(codes.join("\n"));
check(quotes.length === 3 && quotes[0].q.takerAmount === parseUnits("453", 6), "3 quote codes decode; 3 NVDA at 151 = 453 USDG");

// Only takers 0 and 2 funded and approved; taker 1 approved too little.
await give(MARKETS.NVDA.address, maker.address, parseUnits("3", 18));
for (let i = 0; i < 3; i++) { await give(USDG.address, takers[i].address, parseUnits("1000", 6)); await give(USDG.address, takers[i].address, i === 1 ? parseUnits("10", 6) : parseUnits("1000", 6), DESK); }
ov[maker.address] = { balance: toHex(10n ** 17n) };
const call = (fn, args) => c.request({ method: "eth_call", params: [args, "latest", ov] });
// checkQuote reads chain state, so give it a client that applies the same overrides
const oc = { readContract: async ({ address, abi, functionName, args }) => {
  const { decodeFunctionResult } = await import("viem");
  const r = await call(null, { to: address, data: encodeFunctionData({ abi, functionName, args }) });
  return decodeFunctionResult({ abi, functionName, data: r });
} };
const checks = await Promise.all(quotes.map(q => checkQuote(oc, back, q)));
check(checks[0].ok, "quote at 151 passes every check");
check(!checks[1].ok && checks[1].problems.some(p => /approved/.test(p)), "quote at 149.5 flagged: taker approved too little");
check(!checks[2].ok && checks[2].problems.some(p => /limit/.test(p)), "quote at 130 flagged: below the maker's 140 limit");
const t = quoteTerms(quotes[0].q);
check(t.price === 151 && t.makerGets === parseUnits("452.547", 6) && t.fee === parseUnits("0.453", 6), `maker gets 452.547 USDG after the 0.453 fee`);

// Maker approves (faked) and settles the best quote against the deployed contract.
const ap = makerApproval(quotes[0].q);
await give(ap.token, maker.address, ap.amount, DESK);
const tx = settleTx(quotes[0]);
let res = "ok"; try { await call(null, { from: maker.address, ...tx, gas: toHex(800000n) }); } catch (e) { res = (e.details || e.shortMessage || "").slice(0, 80); }
check(res === "ok", "settle of the best quote goes through on the deployed contract " + DESK);
let res2 = "ok"; try { await call(null, { from: takers[0].address, ...tx, gas: toHex(800000n) }); } catch { res2 = "reverted"; }
check(res2 === "reverted", "the taker cannot settle it themselves");
let res3 = "ok"; try { await call(null, { from: maker.address, ...settleTx(quotes[1]), gas: toHex(800000n) }); } catch { res3 = "reverted"; }
check(res3 === "reverted", "settling the under-approved quote reverts on chain, as flagged");
let threw = false; try { buildQuote(back, maker.address, "150"); } catch { threw = true; }
check(threw, "maker cannot answer their own request");
console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
