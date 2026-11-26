// privo-sdk.js against Robinhood Chain mainnet state, sending nothing. A throwaway key signs everything; the "wallet"
// records each transaction and runs it as eth_call with balances and approvals faked by state overrides.
// Orderly is stubbed for the perps part.   cd test/sim && node sdk-test.mjs
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, pad, toHex, parseUnits, decodeFunctionData } from "viem";
import { Privo, Swap, Perps } from "../../src/privo-sdk.js";

const realFetch = globalThis.fetch;
let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };
const c = Swap.makeClient(["https://robinhood-rpc.publicnode.com"]);
const acct = privateKeyToAccount(generatePrivateKey());
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
async function slot(token, data) {
  const al = await c.request({ method: "eth_createAccessList", params: [{ to: token, data }, "latest"] });
  for (const e of al.accessList) for (const k of e.storageKeys) {
    try { const r = await c.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [e.address]: { stateDiff: { [k]: pad(toHex(7n)) } } }] }); if (r !== "0x" && BigInt(r) === 7n) return { a: e.address, k }; } catch {}
  }
  throw new Error("slot");
}
const ov = { [acct.address]: { balance: toHex(10n ** 17n) } };
async function give(token, amount, spender) {
  const s = await slot(token, encodeFunctionData({ abi: erc, functionName: spender ? "allowance" : "balanceOf", args: spender ? [acct.address, spender] : [acct.address] }));
  ov[s.a] = ov[s.a] || { stateDiff: {} }; ov[s.a].stateDiff = { ...ov[s.a].stateDiff, [s.k]: pad(toHex(amount)) };
}
// a client whose reads see the overrides, and a wallet that "sends" by eth_call
const sent = [];
const sim = { ...c,
  readContract: async ({ address, abi, functionName, args }) => {
    const { decodeFunctionResult } = await import("viem");
    const r = await c.request({ method: "eth_call", params: [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, "latest", ov] });
    return decodeFunctionResult({ abi, functionName, data: r });
  },
  estimateGas: async () => 500000n,
  waitForTransactionReceipt: async ({ hash }) => ({ status: sent.find(s => s.hash === hash)?.ok ? "success" : "reverted" }),
};
const wallet = {
  account: acct,
  signTypedData: a => acct.signTypedData(a),
  sendTransaction: async tx => {
    let ok = true, err = "";
    try { await c.request({ method: "eth_call", params: [{ from: acct.address, to: tx.to, data: tx.data, value: toHex(tx.value || 0n), gas: toHex(3_000_000n) }, "latest", ov] }); }
    catch (e) { ok = false; err = (e.details || e.shortMessage || e.message).slice(0, 100); }
    // an approve that went through is reflected in later reads
    if (ok) try { const d = decodeFunctionData({ abi: erc, data: tx.data }); if (d.functionName === "approve") await give(tx.to, d.args[1], d.args[0]); } catch {}
    const hash = "0x" + (sent.length + 1).toString(16).padStart(64, "0");
    sent.push({ hash, to: tx.to, ok, err, data: tx.data });
    return hash;
  },
};
const privo = new Privo({ wallet, client: sim });

// 1. spot buy: approve USDG to Permit2, sign the permit, swap with the PRIVO fee
await give(Swap.USDG.address, parseUnits("500", 6));
const q = await privo.spot.quote("TSLA", "buy", "100");
check(q.out > 0 && q.feeUsdg === "0.15", `quote: 100 USDG -> ${(+q.out).toFixed(4)} TSLA, fee ${q.feeUsdg} USDG, ${q.route}`);
const b = await privo.spot.buy("TSLA", "100");
check(sent.length === 2 && sent[0].to.toLowerCase() === Swap.USDG.address.toLowerCase() && sent[1].to.toLowerCase() === Swap.ADDR.ROUTER.toLowerCase(), "buy sends: one-time approve to Permit2, then the router swap");
check(sent.every(s => s.ok) && b.hash === sent[1].hash, "the swap goes through on mainnet state (permit, fee and slippage floor held)");

// 2. spot sell of a stock and of native ETH
await give(Swap.MARKETS.NVDA.address, parseUnits("2", 18));
const n0 = sent.length; await privo.spot.sell("NVDA", "1");
check(sent.slice(n0).every(s => s.ok) && sent.at(-1).to.toLowerCase() === Swap.ADDR.ROUTER.toLowerCase(), "sell 1 NVDA goes through");
const n1 = sent.length; await privo.spot.sell("ETH", "0.01");
check(sent.length === n1 + 1 && sent.at(-1).ok, "sell native ETH needs no approval or permit, one transaction");
let unk = false; try { await privo.spot.quote("__proto__", "buy", "1"); } catch { unk = true; }
check(unk, "unknown markets are refused");

// 3. block desk: request, answer with a signed quote, check
const { request, link } = privo.block.request({ side: "sell", sym: "NVDA", qty: "1", limit: "100", hours: 2 });
check(link.includes("#block/pv_") && request.maker === acct.address, "block request link is created for this wallet");
const taker = privateKeyToAccount(generatePrivateKey());
const tq = { ...await import("../../src/privo-desk.js").then(D => D.buildQuote(D.parseRequest(link), taker.address, "180")) };
const D = await import("../../src/privo-desk.js");
const code = D.encodeQuote(tq, await taker.signTypedData(D.quoteTypedData(tq)));
const [row] = await privo.block.check(request, [code]);
check(row.terms.price === 180 && row.problems.some(p => /approved|holds/.test(p)), "block check reads the quote and flags an unfunded taker");
// One settle per request, even when two calls start together (the lock is taken before the first await).
const tqSig = D.decodeQuotes(code)[0];
const [s1, s2] = await Promise.allSettled([privo.block.settle(request, tqSig), privo.block.settle(request, tqSig)]);
check(s1.status === "rejected" && /checks/.test(s1.reason.message) && s2.status === "rejected" && /already being settled/.test(s2.reason.message), "two settle calls started together: the second is refused at once");
const s3 = await privo.block.settle(request, tqSig).catch(e => e);
check(/checks/.test(s3.message), "a settle that failed releases the lock, so it can be retried");

// 4. perps with Orderly stubbed: connect registers + adds a key, order is a signed POST
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); calls.push({ u, init });
  const ok = d => new Response(JSON.stringify({ success: true, data: d }), { headers: { "content-type": "application/json" } });
  if (u.includes("/v1/get_account")) return calls.filter(x => x.u.includes("/v1/register_account")).length ? ok({ account_id: "0xabc" }) : new Response(JSON.stringify({ success: false, code: -1607 }));
  if (u.includes("/v1/registration_nonce")) return ok({ registration_nonce: "123456" });
  if (u.includes("/v1/register_account")) return ok({ account_id: "0xabc" });
  if (u.includes("/v1/orderly_key")) return ok({ orderly_key: "x" });
  if (u.includes("/v1/order")) return ok({ order_id: 42 });
  return ok({});
};
const conn = await privo.perps.connect();
check(conn.accountId === "0xabc" && /^[0-9a-f]{64}$/.test(conn.key.secret) && conn.key.orderlyKey.startsWith("ed25519:"), "perps.connect registers the wallet and returns a storable trading key");
check(calls.some(x => x.u.includes("/v1/register_account")) && calls.some(x => x.u.includes("/v1/orderly_key")), "registration and add-key messages were signed and sent");
const o = await privo.perps.order({ sym: "ETH", side: "BUY", qty: 0.01 });
const oc = calls.find(x => x.u.endsWith("/v1/order"));
check(o.order_id === 42 && oc.init.method === "POST" && JSON.parse(oc.init.body).symbol === "PERP_ETH_USDC" && oc.init.headers["orderly-key"] === conn.key.orderlyKey, "perps.order sends a signed PERP_ETH_USDC market order");
const again = new Privo({ wallet, client: sim, perpsKey: conn.key });
await again.perps.order({ sym: "BTC", side: "SELL", qty: 0.001, type: "LIMIT", price: 70000 });
check(JSON.parse(calls.at(-1).init.body).order_type === "LIMIT", "a saved key works without connecting again");
// 5. limit orders: approve the Orders contract, sign the order, hand it to PRIVO's keeper (API stubbed, contract code faked)
const { Orders } = await import("../../src/privo-sdk.js");
const { verifyTypedData } = await import("viem");
let KEEPER = "0x00000000000000000000000000000000000Ce0e1";
let posted = null;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).endsWith("/api/orders")) return realFetch(url, init);
  if (init.method === "POST") { posted = JSON.parse(init.body); return new Response(JSON.stringify({ hash: "0x" + "cd".repeat(32) })); }
  return new Response(JSON.stringify({ contract: Orders.ORDERS, keeper: KEEPER }));
};
sim.getCode = async ({ address } = {}) => (address && address.toLowerCase() === acct.address.toLowerCase() ? "0x" : "0x6080"); // the bot is a plain EOA
let refused = ""; try { await privo.orders.limit({ sym: "TSLA", side: "buy", amount: "100", price: 300 }); } catch (e) { refused = e.message; }
check(/unexpected keeper/.test(refused) && posted === null, "the SDK refuses to sign when the order API names any keeper but PRIVO's pinned one");
KEEPER = Orders.KEEPER;
const n0o = sent.length;
const placed = await privo.orders.limit({ sym: "TSLA", side: "buy", amount: "100", price: 300 });
const po = Orders.fromJson(posted.order);
check(placed.hash && po.filler.toLowerCase() === KEEPER.toLowerCase() && po.maker === acct.address && po.amountIn === parseUnits("100", 6) && po.minAmountOut === Orders.minOutForPrice("buy", parseUnits("100", 6), 300), "orders.limit builds a buy order at the given price, naming PRIVO's keeper");
check(await verifyTypedData({ address: acct.address, signature: posted.signature, ...Orders.orderTypedData(po) }), "the order the SDK sends is signed by the bot's wallet");
const ap = decodeFunctionData({ abi: erc, data: sent.at(-1).data });
check(sent.length === n0o + 1 && sent.at(-1).to.toLowerCase() === Swap.USDG.address.toLowerCase() && ap.args[0] === Orders.ORDERS && ap.args[1] >= parseUnits("100", 6), "it approves the Orders contract for the USDG it may spend, one transaction");
const tw = await privo.orders.twap({ sym: "TSLA", side: "sell", amount: "3", price: 400, slices: 6, every: 600, days: 1 });
check(tw.order.slices === 6 && tw.order.interval === 600, "orders.twap splits the order into slices");
const n0r = sent.length; await privo.orders.revoke();
const rv = decodeFunctionData({ abi: erc, data: sent.at(-1).data });
check(sent.length === n0r + 1 && sent.at(-1).to.toLowerCase() === Swap.USDG.address.toLowerCase() && rv.functionName === "approve" && rv.args[0] === Orders.ORDERS && rv.args[1] === 0n, "orders.revoke() sets the USDG approval for the Orders contract to 0");

// baskets: buy three stocks in one router call, then sell half of two of them in one router call
const bq = await privo.baskets.quote({ legs: ["AAPL", "MSFT", "NVDA"], amount: "90" });
check(bq.out.length === 3 && bq.feeUsdg === "0.135" && bq.out.every(l => +l.tokens > 0), "baskets.quote: 90 USDG over three stocks, fee 0.135 USDG once");
const nb = sent.length, bb = await privo.baskets.buy({ legs: [{ sym: "AAPL", pct: 50 }, { sym: "MSFT", pct: 30 }, { sym: "NVDA", pct: 20 }], amount: "90" });
check(sent.length === nb + 1 && sent.at(-1).ok && sent.at(-1).to.toLowerCase() === Swap.ADDR.ROUTER.toLowerCase() && bb.hash === sent.at(-1).hash && bb.legs[0].usdg === "44.9325",
  "baskets.buy: one router transaction on mainnet state (USDG already approved to Permit2), 50/30/20 split after the fee");
await give(Swap.MARKETS.AAPL.address, parseUnits("0.2", 18)); await give(Swap.MARKETS.NVDA.address, parseUnits("0.3", 18));
const sq = await privo.baskets.quoteSell({ legs: ["AAPL", "NVDA"], pct: 50 });
check(sq.out[0].tokens === "0.1" && sq.out[1].tokens === "0.15" && +sq.outUsdg > 0, "baskets.quoteSell: half of each balance, " + sq.outUsdg + " USDG after the fee");
const ns = sent.length, bs = await privo.baskets.sell({ legs: ["AAPL", "NVDA"], pct: 50 });
// NVDA was approved to Permit2 by the spot sell above, so only AAPL needs its one-time approval
check(sent.length === ns + 2 && sent[ns].to.toLowerCase() === Swap.MARKETS.AAPL.address.toLowerCase() && sent.slice(ns).every(s => s.ok) && sent.at(-1).to.toLowerCase() === Swap.ADDR.ROUTER.toLowerCase() && bs.hash === sent.at(-1).hash,
  "baskets.sell: a one-time Permit2 approval only for the stock token that lacks one, then one router transaction under one PermitBatch signature");
const ln = privo.baskets.link(["AAPL", "MSFT", "NVDA"], "My picks");
const pl = privo.baskets.parse(ln);
check(/\?basket=AAPL:33\.34,MSFT:33\.33,NVDA:33\.33&name=My%20picks#trade$/.test(ln) && pl.name === "My picks" && pl.legs.map(l => l.w).join() === "3334,3333,3333", "baskets.link and baskets.parse round-trip a basket");
let badLegs = false; try { await privo.baskets.quote({ legs: [{ sym: "AAPL", pct: 60 }, { sym: "MSFT", pct: 30 }], amount: "10" }); } catch (e) { badLegs = /100%/.test(e.message); }
check(badLegs, "shares that do not add up to 100% are refused");

let noWallet = false; try { await new Privo().spot.buy("TSLA", "1"); } catch (e) { noWallet = /wallet/.test(e.message); }
check(noWallet, "trading without a wallet is refused with a clear error");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
