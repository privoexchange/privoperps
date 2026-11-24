// Checks PRIVO's advanced perps requests without real funds: stop, TP/SL, bracket, post-only/IOC, cancel-all,
// and the private websocket auth signature. Orderly's private endpoints are stubbed; nothing is sent to Orderly.
//   node test/sim/perps-pro-test.mjs
import * as ed from "@noble/ed25519";
import * as P from "../../src/privo-perps.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ok    " : "  FAIL  ") + m); if (!c) fail++; };
const key = await P.newOrderlyKey({ webcrypto: false }), id = "0x" + "ab".repeat(32);
const pub = await ed.getPublicKeyAsync(Uint8Array.from(key.secret.match(/../g).map(x => parseInt(x, 16))));
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));

const sent = [];
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(P.PERPS_CONFIG.API, ""), h = init.headers || {};
  const good = await ed.verifyAsync(unb64(h["orderly-signature"]), new TextEncoder().encode(h["orderly-timestamp"] + (init.method || "GET") + path + (init.body || "")), pub);
  sent.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null, good });
  return new Response(JSON.stringify(good ? { success: true, data: { order_id: 7, rows: [] } } : { success: false, message: "bad signature" }));
};
const last = () => sent.at(-1);
const S = "PERP_TSLA_USDC";

await P.placeOrder(key, id, { symbol: S, side: "BUY", qty: 0.05, type: "MARKET" });
ok(last().good && last().body.order_type === "MARKET" && !("order_price" in last().body), "market order: no price, request signed");
await P.placeOrder(key, id, { symbol: S, side: "SELL", qty: 0.05, type: "POST_ONLY", price: 400.5 });
ok(last().body.order_type === "POST_ONLY" && last().body.order_price === 400.5, "post-only order carries its price");
await P.placeOrder(key, id, { symbol: S, side: "BUY", qty: 0.05, type: "IOC", price: 399 });
ok(last().body.order_type === "IOC", "IOC order");

await P.stopOrder(key, id, { symbol: S, side: "SELL", qty: 0.05, trigger: 350 });
let b = last().body;
ok(last().path === "/v1/algo/order" && b.algo_type === "STOP" && b.type === "MARKET" && b.trigger_price === 350 && b.trigger_price_type === "MARK_PRICE" && b.side === "SELL" && b.quantity === 0.05, "stop market: algo STOP on the mark price");

await P.positionTpSl(key, id, { symbol: S, closeSide: "SELL", tp: 420, sl: 340 });
b = last().body;
const kids = b.child_orders || [];
ok(b.algo_type === "POSITIONAL_TP_SL" && kids.length === 2, "position TP/SL: POSITIONAL_TP_SL with two children");
ok(kids.every(k => k.type === "CLOSE_POSITION" && k.reduce_only === true && k.side === "SELL" && k.symbol === S && k.trigger_price_type === "MARK_PRICE"), "children close the whole position, reduce only, opposite side");
ok(kids.find(k => k.algo_type === "TAKE_PROFIT").trigger_price === 420 && kids.find(k => k.algo_type === "STOP_LOSS").trigger_price === 340, "take profit and stop loss triggers in place");
await P.positionTpSl(key, id, { symbol: S, closeSide: "BUY", sl: 380 });
ok(last().body.child_orders.length === 1 && last().body.child_orders[0].algo_type === "STOP_LOSS" && last().body.child_orders[0].side === "BUY", "stop loss alone on a short closes with a buy");

await P.bracketOrder(key, id, { symbol: S, side: "BUY", qty: 0.05, price: 355, tp: 380, sl: 345 });
b = last().body;
ok(b.algo_type === "BRACKET" && b.type === "LIMIT" && b.price === 355 && b.quantity === 0.05 && b.side === "BUY", "bracket: limit entry");
ok(b.child_orders[0].algo_type === "POSITIONAL_TP_SL" && b.child_orders[0].child_orders.length === 2 && b.child_orders[0].child_orders.every(k => k.side === "SELL"), "bracket: nested position TP/SL that sells");

const parts = P.algoParts({ algo_type: "BRACKET", child_orders: b.child_orders });
ok(parts.tp === 380 && parts.sl === 345, "algoParts reads TP and SL out of nested children");

await P.cancelAll(key, id); ok(last().method === "DELETE" && last().path === "/v1/orders" && last().good, "cancel all orders (signed DELETE)");
await P.cancelAll(key, id, S); ok(last().path === "/v1/orders?symbol=" + S, "cancel all on one market");
await P.cancelAllAlgo(key, id); ok(last().path === "/v1/algo/orders", "cancel all algo orders");
await P.cancelAlgo(key, id, 99, S); ok(last().path === "/v1/algo/order?order_id=99&symbol=" + S && last().method === "DELETE", "cancel one algo order");
await P.algoOrders(key, id); ok(last().path === "/v1/algo/orders?status=INCOMPLETE", "list open algo orders");
await P.fundingHistory(key, id); ok(last().path === "/v1/funding_fee/history", "funding history");

const a = await P.wsAuthParams(key);
ok(a.orderly_key === key.orderlyKey && /^\d{13}$/.test(a.timestamp), "ws auth: key and millisecond timestamp");
ok(await ed.verifyAsync(unb64(a.sign), new TextEncoder().encode(a.timestamp), pub), "ws auth: signature over the timestamp verifies (base64url)");
ok(P.PRIVATE_WS === "wss://ws-private-evm.orderly.org/v2/ws/private/stream/", "private stream URL");

const info = { quoteTick: 0.01 };
ok(P.roundPrice(355.004, info) === 355 && P.roundPrice(355.006, info) === 355.01, "prices round to the market tick");

console.log(fail ? `\n${fail} check(s) failed` : "\nall checks passed");
process.exit(fail ? 1 : 0);
