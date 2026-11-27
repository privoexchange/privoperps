// PRIVO Copilot tests, offline: the local parser on English requests, the intent checker on bad AI replies, and JSON
// extraction from model replies.
//   node test/ai/copilot-test.mjs
import { parse, validate, extractJson, systemPrompt, BASKET_THEMES } from "../../src/privo-copilot-core.js";

let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };
const names = { NVDA: "NVIDIA", TSLA: "Tesla", AAPL: "Apple", MSFT: "Microsoft", AMD: "AMD", PLTR: "Palantir", NET: "Cloudflare", F: "Ford Motor", ETH: "Ether", PRIVO: "Privo Exchange" };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const P = (t, want) => { const r = parse(t, { names }); const ok = want === null ? r === null : want.error ? !!r?.error && new RegExp(want.error, "i").test(r.error) : same(r?.intent, want); check(ok, `"${t}" -> ${JSON.stringify(r)}`); };

console.log("parser:");
P("buy 50 usdg NVDA", { type: "spot", side: "buy", sym: "NVDA", usdg: 50 });
P("buy $50 NVDA", { type: "spot", side: "buy", sym: "NVDA", usdg: 50 });
P("buy tesla 100", { type: "spot", side: "buy", sym: "TSLA", usdg: 100 });
P("sell half tsla", { type: "spot", side: "sell", sym: "TSLA", pct: 50 });
P("sell all AAPL", { type: "spot", side: "sell", sym: "AAPL", pct: 100 });
P("sell 0.5 nvda", { type: "spot", side: "sell", sym: "NVDA", qty: 0.5 });
P("sell 25% eth", { type: "spot", side: "sell", sym: "ETH", pct: 25 });
P("buy 1,000 usdg privo", { type: "spot", side: "buy", sym: "PRIVO", usdg: 1000 });
P("limit buy tsla 100 usdg at 380", { type: "limit", side: "buy", sym: "TSLA", usdg: 100, price: 380 });
P("buy NVDA 200 usdg at 170 for 30 days", { type: "limit", side: "buy", sym: "NVDA", usdg: 200, price: 170, days: 30 });
P("twap sell 3 tsla at 400, 6 slices every 10 min", { type: "twap", side: "sell", sym: "TSLA", qty: 3, price: 400, slices: 6, everyMin: 10 });
P("dca buy 600 usdg nvda 12 times every 1 hour", { type: "twap", side: "buy", sym: "NVDA", usdg: 600, slices: 12, everyMin: 60 });
P("basket chips 100", { type: "basket", legs: [{ sym: "NVDA", pct: 20 }, { sym: "AMD", pct: 20 }, { sym: "AVGO", pct: 20 }, { sym: "TSM", pct: 20 }, { sym: "MU", pct: 20 }], usdg: 100, name: "Chips" });
P("buy 90 usdg aapl msft nvda equally", { type: "basket", legs: [{ sym: "AAPL", pct: 33.33 }, { sym: "MSFT", pct: 33.33 }, { sym: "NVDA", pct: 33.34 }], usdg: 90 });
P("basket nvda 60 amd 40 50 usdg", { type: "basket", legs: [{ sym: "NVDA", pct: 60 }, { sym: "AMD", pct: 40 }], usdg: 50 });
P("rebalance big tech", { type: "rebalance", basket: "Big Tech" });
P("I want to put around 40 bucks into apple and microsoft, split evenly", { type: "basket", legs: [{ sym: "AAPL", pct: 50 }, { sym: "MSFT", pct: 50 }], usdg: 40 });
P("put 60 dollars into tesla and nvidia, split evenly", { type: "basket", legs: [{ sym: "TSLA", pct: 50 }, { sym: "NVDA", pct: 50 }], usdg: 60 });
P("invest 25 usdg in palantir", { type: "spot", side: "buy", sym: "PLTR", usdg: 25 });
P("cash out all nvda", { type: "spot", side: "sell", sym: "NVDA", pct: 100 });
P("open nvda", { type: "open", sym: "NVDA" });
P("NVDA", { type: "open", sym: "NVDA" });
P("help", { type: "help" });
P("limit buy pons at 0.1", { error: "stock tokens only" });
P("limit buy tsla 50 usdg", { error: "needs a price" });
P("buy 50 usdg ai", null);
P("sell net 2", null);
P("sell 2 NET", { type: "spot", side: "sell", sym: "NET", qty: 2 });
P("which stock will go up tomorrow", null);
P("beli 50 usdg nvda", null); // English only

console.log("checker (AI replies):");
check(!validate({ type: "spot", side: "buy", sym: "FAKE", usdg: 5 }).ok, "unknown symbol refused");
check(!validate({ type: "spot", side: "buy", sym: "AI", usdg: 5 }).ok, "delisted market refused");
check(!validate({ type: "spot", side: "buy", sym: "TSLA", usdg: -5 }).ok, "negative amount refused");
check(!validate({ type: "spot", side: "buy", sym: "TSLA", usdg: 5, qty: 1 }).ok, "two amounts refused");
check(!validate({ type: "basket", legs: [{ sym: "TSLA", pct: 50 }, { sym: "ETH", pct: 50 }], usdg: 5 }).ok, "ETH in a basket refused");
check(!validate({ type: "basket", legs: [{ sym: "TSLA", pct: 50 }, { sym: "NVDA", pct: 40 }], usdg: 5 }).ok, "shares not adding to 100 refused");
check(!validate({ type: "twap", side: "buy", sym: "TSLA", usdg: 5, slices: 500 }).ok, "500 slices refused");
check(!validate({ type: "transfer", to: "0xabc" }).ok && !validate({ type: "none" }).ok, "anything that is not a ticket refused (transfers, none)");
check(validate({ type: "spot", side: "buy", sym: "tsla", usdg: 5 }).intent?.sym === "TSLA", "lower-case symbol from a model is normalised");
check(same(extractJson('Sure! ```json\n{"type":"open","sym":"NVDA","note":"a } in \\"text\\""}\n```'), { type: "open", sym: "NVDA", note: 'a } in "text"' }), "JSON pulled out of a fenced, chatty reply");
check(extractJson("no json here") === null, "no JSON -> null");
check(systemPrompt().includes("TSLA") && !/\bAI\b(?! =)/.test(systemPrompt().split("Crypto")[1] || "") && BASKET_THEMES.every(([, s]) => s.length >= 3), "prompt lists live markets (not the delisted AI) and the themes");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
