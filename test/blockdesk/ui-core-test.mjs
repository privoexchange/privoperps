// End-to-end check of privo-desk.js against the DEPLOYED PrivoBlockDesk on Robinhood Chain, sending nothing.
// Throwaway maker and taker keys; balances and allowances are faked by state override; settle runs as eth_call
// from the maker against the real contract address.
import { createPublicClient, http, encodeFunctionData, parseAbi, pad, toHex, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DESK, newRequest, requestLink, parseRequest, buildQuote, quoteTypedData, encodeQuote, decodeQuotes, checkQuote, quoteTerms, settleTx, makerApproval, deskMarket, quoteStatus, settlementsOf, requestSettled, DESK_FROM_BLOCK } from "../../src/privo-desk.js";
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

// M-1 (HEY Research GHSA-9rqx-mq7q-7m59): a quote that pays the maker in a look-alike token must fail.
const breq = parseRequest(requestLink(newRequest({ maker: maker.address, side: "buy", sym: "TSLA", qty: "2", limit: "400", hours: 4 })));
// A real, deployed ERC-20 that is not on PRIVO's list ($PRIVO itself) stands in for a look-alike the taker deployed.
// It has code, a balance and an allowance, so on the old code every check would pass instead of crashing.
const fake = "0xD5eE65798eb4E0528CdF9B6C23b663d8a2276dA0";
await give(fake, takers[1].address, parseUnits("2", 18)); await give(fake, takers[1].address, parseUnits("2", 18), DESK);
await give(fake, takers[2].address, parseUnits("1000", 18)); await give(fake, takers[2].address, parseUnits("1000", 18), DESK);
const honestQ = buildQuote(breq, takers[0].address, "385");
const evilQ = { ...buildQuote(breq, takers[1].address, "380"), takerToken: fake };
const [honest, evil] = decodeQuotes([encodeQuote(honestQ, await takers[0].signTypedData(quoteTypedData(honestQ))), encodeQuote(evilQ, await takers[1].signTypedData(quoteTypedData(evilQ)))].join(" "));
await give(MARKETS.TSLA.address, takers[0].address, parseUnits("2", 18)); await give(MARKETS.TSLA.address, takers[0].address, parseUnits("2", 18), DESK);
const [hc, ec] = await Promise.all([checkQuote(oc, breq, honest), checkQuote(oc, breq, evil)]);
check(hc.ok, "buy request: honest TSLA quote at 385 passes");
check(!ec.ok && ec.problems.includes("Tokens do not match the request"), "buy request: look-alike taker token is rejected (" + ec.problems.join(", ") + ")");
const sreqEvil = { ...buildQuote(back, takers[2].address, "150"), takerToken: fake };
const sc = await checkQuote(oc, back, { q: sreqEvil, sig: await takers[2].signTypedData(quoteTypedData(sreqEvil)) });
check(!sc.ok && sc.problems.includes("Tokens do not match the request"), "sell request: fake USDG as taker token is rejected");
check(!quoteTerms(evil.q, "buy").makerSells && quoteTerms(evil.q, "buy").shares === parseUnits("2", 18), "terms follow the request side, not the quote's taker token");
check(makerApproval(honest.q, "buy").token.toLowerCase() === USDG.address.toLowerCase() && makerApproval(honest.q, "buy").amount === honest.q.makerAmount + quoteTerms(honest.q, "buy").fee, "buy request: maker approves USDG leg plus fee");

// The fake token really is a funded, approved ERC-20 here (so this is a true regression test).
const fb = await oc.readContract({ address: fake, abi: erc, functionName: "balanceOf", args: [takers[1].address] });
const fa = await oc.readContract({ address: fake, abi: erc, functionName: "allowance", args: [takers[1].address, DESK] });
check(fb === parseUnits("2", 18) && fa === parseUnits("2", 18), "look-alike is a live ERC-20 with balance and allowance for the desk");

// Desk markets: stock tokens only (cbBTC has 8 decimals), and no prototype names.
check(deskMarket("TSLA") && !deskMarket("BTC") && !deskMarket("ETH") && !deskMarket("__proto__") && !deskMarket("constructor") && !deskMarket("toString"), "desk takes stock markets only; BTC, ETH and prototype names are refused");
let btc = false; try { newRequest({ maker: maker.address, side: "buy", sym: "BTC", qty: "0.00000001" }); } catch { btc = true; }
check(btc, "a BTC request is refused (8-decimal cbBTC would be sized as 18)");
let proto = false; try { parseRequest(requestLink({ ...req, sym: "__proto__" })); } catch { proto = true; }
check(proto, "a link with sym __proto__ is refused");

// Losing quotes: once the request settles, by anyone, an unused quote is "lost" (withdraw it). Decided by the quote's own nonce.
const HEAD = DESK_FROM_BLOCK + 12_000_000n, spans = [];
const fakeChain = ({ used = false, settled = [] }) => ({
  readContract: async () => used, getBlockNumber: async () => HEAD,
  getLogs: async ({ fromBlock, toBlock }) => { spans.push([fromBlock, toBlock]); return toBlock === HEAD ? settled.map(x => ({ args: x, transactionHash: "0x" + "1".repeat(64) })) : []; },
});
const leg = q => ({ taker: q.taker, makerAmount: q.makerAmount, takerAmount: q.takerAmount });
const mineQ = buildQuote(back, takers[1].address, "150");
check((await quoteStatus(fakeChain({ settled: [leg(buildQuote(back, takers[0].address, "151"))] }), mineQ)) === "lost", "quote is 'lost' after the request settled with another taker");
check((await quoteStatus(fakeChain({}), mineQ)) === "open", "quote is 'open' before anyone settles");
check((await quoteStatus(fakeChain({ used: true }), mineQ)) === "done", "a cancelled quote is 'done'");
// N-3: the same taker re-quotes; one of the two settles. The other one is still unused, so it is "lost", not "open".
const reQ = buildQuote(back, takers[1].address, "152");
check((await quoteStatus(fakeChain({ settled: [leg(reQ)] }), mineQ)) === "lost", "N-3: the taker's other quote is 'lost' when their re-quote won");
check((await quoteStatus(fakeChain({ used: true, settled: [leg(mineQ)] }), mineQ)) === "won", "the quote that settled the request is 'won'");
// Logs start at the desk's deployment block and go in windows of at most 5M blocks (public RPCs cap the range).
spans.length = 0; await settlementsOf(fakeChain({}), back.id);
check(spans[0][0] === DESK_FROM_BLOCK && spans.at(-1)[1] === HEAD && spans.every(([x, y]) => y - x < 5_000_000n), "settlementsOf reads from the deployment block in <= 5M-block windows, never from block 0");
spans.length = 0; await settlementsOf(fakeChain({}), back.id, 0n);
check(spans[0][0] === DESK_FROM_BLOCK, "a fromBlock of 0 is raised to the deployment block");
// L-1: one settlement per request, enforced by the app and the SDK.
check((await requestSettled(fakeChain({ settled: [leg(reQ)] }), back.id))?.taker === takers[1].address && (await requestSettled(fakeChain({}), back.id)) === null, "requestSettled finds the settlement that closed a request");

// L-1: requests and quotes cannot outlive 24 hours, and a quote cannot outlive its request.
let long = false; try { newRequest({ maker: maker.address, side: "sell", sym: "NVDA", qty: "1", hours: 48 }); } catch { long = true; }
check(long, "a request longer than 24 hours is refused");
const farLink = requestLink({ ...req, deadline: Math.floor(Date.now() / 1000) + 30 * 86400 });
let far = false; try { parseRequest(farLink); } catch { far = true; }
check(far, "a link that stays open for 30 days is refused when parsed");
const shortQ = buildQuote(back, takers[0].address, "151", { hours: 1 });
check(Number(shortQ.deadline) <= Math.floor(Date.now() / 1000) + 3600 && Number(shortQ.deadline) < back.deadline, "taker can sign a quote that ends before the request");
const lateQ = { ...buildQuote(back, takers[0].address, "151"), deadline: BigInt(back.deadline + 3600) };
const lc = await checkQuote(oc, back, { q: lateQ, sig: await takers[0].signTypedData(quoteTypedData(lateQ)) });
check(!lc.ok && lc.problems.includes("Quote stays valid longer than your request"), "a quote that outlives the request is flagged");

// I-9: the limit check is exact in integers (149.999999 is below a 150 limit).
const edgeReq = { ...back, limit: "150" };
const edgeQ = buildQuote(edgeReq, takers[0].address, "149.999999");
const ecq = await checkQuote(oc, edgeReq, { q: edgeQ, sig: await takers[0].signTypedData(quoteTypedData(edgeQ)) });
check(ecq.problems.includes("Outside your limit price"), "149.999999 per share is flagged against a 150 limit");
console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
