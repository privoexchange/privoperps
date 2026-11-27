// PRIVO voice tests, offline: what speech recognizers write for spoken requests, cleaned by normalizeSpeech and then read by
// the same parser as typed text (privo-copilot-core.js), plus the short line PRIVO AI says back.
//   node test/ai/voice-test.mjs
import { normalizeSpeech, spokenReply } from "../../src/privo-voice-core.js";
import { parse } from "../../src/privo-copilot-core.js";

let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };
const names = { NVDA: "NVIDIA", TSLA: "Tesla", AAPL: "Apple", MSFT: "Microsoft", AMD: "AMD", PLTR: "Palantir", ETH: "Ether", PRIVO: "Privo Exchange" };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const V = (heard, want) => {
  const said = normalizeSpeech(heard), r = parse(said, { names });
  check(same(r?.intent, want), `"${heard}" -> "${said}" -> ${JSON.stringify(r?.intent ?? r)}`);
};

console.log("spoken requests:");
V("Buy $20 of Tesla.", { type: "spot", side: "buy", sym: "TSLA", usdg: 20 });
V("by twenty dollars of tesla", { type: "spot", side: "buy", sym: "TSLA", usdg: 20 });
V("Bye 50 dollars of Nvidia", { type: "spot", side: "buy", sym: "NVDA", usdg: 50 });
V("buy one hundred and fifty dollars of apple", { type: "spot", side: "buy", sym: "AAPL", usdg: 150 });
V("buy a hundred dollars of google", { type: "spot", side: "buy", sym: "GOOGL", usdg: 100 });
V("sell half of my n v d a", { type: "spot", side: "sell", sym: "NVDA", pct: 50 });
V("Sell half of my NVDA.", { type: "spot", side: "sell", sym: "NVDA", pct: 50 });
V("cell twenty five percent of my ethereum", { type: "spot", side: "sell", sym: "ETH", pct: 25 });
V("sell zero point five tesla", { type: "spot", side: "sell", sym: "TSLA", qty: 0.5 });
V("sell all my microsoft", { type: "spot", side: "sell", sym: "MSFT", pct: 100 });
V("buy two thousand dollars of privo token", { type: "spot", side: "buy", sym: "PRIVO", usdg: 2000 });
V("limit by Tesla one hundred dollars at three hundred eighty", { type: "limit", side: "buy", sym: "TSLA", usdg: 100, price: 380 });
V("limit buy tesla one hundred dollars at three eighty", { type: "limit", side: "buy", sym: "TSLA", usdg: 100, price: 380 });
V("limit sell nvidia half at one ninety five", { type: "limit", side: "sell", sym: "NVDA", pct: 50, price: 195 });
V("put sixty dollars into tesla and nvidia split evenly", { type: "basket", legs: [{ sym: "TSLA", pct: 50 }, { sym: "NVDA", pct: 50 }], usdg: 60 });
V("buy twenty five dollars of apple", { type: "spot", side: "buy", sym: "AAPL", usdg: 25 });
V("tee wap sell three tesla six slices every ten minutes", { type: "twap", side: "sell", sym: "TSLA", qty: 3, slices: 6, everyMin: 10 });
V("buy 1,000 USD G of Palantir", { type: "spot", side: "buy", sym: "PLTR", usdg: 1000 });
V("buy fifty dollars of bitcoin", { type: "spot", side: "buy", sym: "BTC", usdg: 50 });

console.log("left as they are:");
const same2 = (heard, want) => { const s = normalizeSpeech(heard); check(s === want, `"${heard}" -> "${s}"`); };
same2("buy 12.5 dollars of AMD", "buy 12.5 dollars of AMD");
same2("what is smart money buying?", "what is smart money buying");
same2("", "");
same2("my balance", "my balance");
same2("stand by", "stand by");
same2("someone", "someone");

console.log("spoken replies:");
const R = (m, want) => { const s = spokenReply(m); check(new RegExp(want, "i").test(s), JSON.stringify(m) + ` -> "${s}"`); };
R({ intent: { type: "spot", side: "buy", sym: "TSLA", usdg: 20 } }, "^Buy 20 dollars of TSLA\\. Check the ticket and sign");
R({ intent: { type: "spot", side: "sell", sym: "NVDA", pct: 50 } }, "^Sell half of your NVDA\\.");
R({ intent: { type: "limit", side: "buy", sym: "TSLA", usdg: 100, price: 380 } }, "at 380\\. Check");
R({ intent: { type: "basket", legs: [{}, {}, {}], usdg: 100 } }, "basket of 3 stocks for 100 dollars");
R({ error: "I could not read that. Try \"help\" for examples." }, "^I could not read that\\.$");
R({ info: { type: "price", sym: "NVDA" } }, "price of NVDA");
check(!/\b(should|recommend|good buy|profit)\b/i.test(["spot", "limit", "twap"].map(type => spokenReply({ intent: { type, side: "buy", sym: "NVDA", usdg: 5, price: 1, slices: 2 } })).join(" ")), "replies never advise");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
