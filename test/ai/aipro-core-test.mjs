// PRIVO AI core tests, offline: the reply reader and conversation builder, the prompt and live snapshot, the Pro model
// list and the payment math (USDG, and $PRIVO at 20% off).
//   node test/ai/aipro-core-test.mjs
import { parseProReply, historyFor, paymentValue, covers, privoFor, PRICE_MICRO, PRIVO_BONUS, assistantPrompt, snapshotLine, MODELS, modelByKey } from "../../src/privo-aipro-core.js";

let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };

console.log("reply reader:");
{
  const r = parseProReply('Sure! {"say":"Selling half your TSLA, then buying NVDA with 50 USDG.","intents":[{"type":"spot","side":"sell","sym":"TSLA","pct":50},{"type":"spot","side":"buy","sym":"nvda","usdg":50}]}');
  check(r.intents.length === 2 && r.intents[1].sym === "NVDA" && /Selling half/.test(r.say), "two tickets in order, symbols cleaned");
  const d = parseProReply('{"say":"x","intents":[{"type":"spot","side":"buy","sym":"NOPE","usdg":5},{"type":"limit","side":"buy","sym":"TSLA","usdg":5}]}');
  check(d.intents.length === 0 && d.dropped.length === 2, "tickets that fail the checks are dropped: " + d.dropped.join("; "));
  check(parseProReply(JSON.stringify({ say: "s", intents: Array.from({ length: 7 }, () => ({ type: "spot", side: "buy", sym: "NVDA", usdg: 1 })) })).intents.length === 4, "at most 4 tickets");
  check(parseProReply("I can't predict prices.").say === "I can't predict prices." && parseProReply("").intents.length === 0, "a reply with no JSON becomes its text, with no tickets");
}

console.log("conversation:");
{
  const msgs = [{ role: "ai", say: "hello" }, { role: "user", text: "buy 50 nvda" }, { role: "ai", intent: { type: "spot", side: "buy", sym: "NVDA", usdg: 50 } }, { role: "user", text: "make it 80" }];
  const h = historyFor(msgs);
  check(h.length === 3 && h[0].role === "user" && h[1].content.includes('"usdg":50') && h[2].content === "make it 80", "earlier tickets go back to the model so follow-ups work");
  check(historyFor(Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "ai" : "user", text: "t" + i, say: "s" }))).length <= 16, "Pro sends only the last 16 turns");
  const pp = assistantPrompt({ pro: true, snapshot: snapshotLine({ NVDA: [156.2, 1.5], NOPE: [1, 1], TSLA: ["x", 0] }) });
  check(/talk about anything/i.test(pp) && /never promise returns/i.test(pp) && /not financial advice/i.test(pp), "the prompt answers anything, with no promised returns and a not-advice note on views");
  const snap = pp.split("Live snapshot")[1] || "";
  check(snap.includes("NVDA 156.20 (+1.50%)") && !snap.includes("NOPE") && !/TSLA \d/.test(snap), "the live snapshot keeps only real markets and numbers");
  check(parseProReply("Gold is a metal.\n- dense\n- shiny").say.includes("- shiny"), "a plain-text answer (not JSON) is kept whole");
}

console.log("payment math:");
check(PRICE_MICRO === 2000 && paymentValue({ token: "USDG", raw: 2000n }) === 2000 && covers(2000, "USDG") && !covers(1999, "USDG"), "USDG: $0.002 pays for a default message, a micro-dollar less does not");
check(MODELS.length >= 10 && new Set(MODELS.map(m => m.key)).size === MODELS.length && MODELS.every(m => m.price >= 2000 && m.id.includes("/")), MODELS.length + " Pro models, each with an OpenRouter id and a price");
check(paymentValue({ token: "PRIVO", raw: 1n, privoUsdgOut: 1600n }) === 2000 && covers(1900, "PRIVO"), "$PRIVO counts at 1.25x its sale value, with 5% slack for price moves");
const need = privoFor(10_000n * 10n ** 18n, 340_000n);     // 10,000 PRIVO sells for $0.34
check(need > 0n && paymentValue({ token: "PRIVO", raw: need, privoUsdgOut: need * 340_000n / (10_000n * 10n ** 18n) }) >= PRICE_MICRO, "the app sends enough $PRIVO to cover one message: " + need / 10n ** 18n + " PRIVO");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
