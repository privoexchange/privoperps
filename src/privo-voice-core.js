// PRIVO voice: turns what a speech recognizer heard ("by twenty dollars of Tesla.", "sell half of n v d a") into the typed
// form PRIVO AI already reads ("buy 20 dollars of Tesla", "sell half of NVDA"), and writes the short line PRIVO AI says
// back. Pure functions, shared by the PRIVO app and the tests (test/ai/voice-test.mjs). It never trades: the
// result goes through the same parser and checks as typed text, and the trader still reviews and signs every ticket.

const ONES = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE = { hundred: 100, thousand: 1000, million: 1e6 };
const FRAC = { half: 0.5, quarter: 0.25 };

// Words a recognizer writes for a market's name or sound, mapped to the ticker (written in capitals so the parser takes it).
export const SPOKEN = {
  google: "GOOGL", alphabet: "GOOGL", facebook: "META", meta: "META", amazon: "AMZN", netflix: "NFLX", nvidia: "NVDA",
  "n video": "NVDA", "in video": "NVDA", tesla: "TSLA", apple: "AAPL", microsoft: "MSFT", palantir: "PLTR",
  coinbase: "COIN", "micro strategy": "MSTR", microstrategy: "MSTR", robinhood: "HOOD", "robin hood": "HOOD",
  bitcoin: "BTC", ethereum: "ETH", ether: "ETH", "e t h": "ETH", privo: "PRIVO", "privo token": "PRIVO", "pre vo": "PRIVO",
  gold: "GLD", silver: "SLV", oil: "USO",
};

// "twenty five" -> 25, "one hundred and fifty" -> 150, "two point five" -> 2.5, "a hundred" -> 100. Returns [value, words used].
function readNumber(w, i) {
  let total = 0, cur = 0, used = 0, any = false;
  for (let j = i; j < w.length; j++) {
    const x = w[j];
    if (x === "a" && !any && SCALE[w[j + 1]]) { cur = 1; any = true; used++; continue; }
    if (x === "and" && any && (ONES[w[j + 1]] != null || TENS[w[j + 1]] != null)) { used++; continue; }
    if (ONES[x] != null && !(x === "oh" && !any)) { cur += ONES[x]; any = true; used++; continue; }
    // "three eighty" is 380 (how prices are said), "twenty five" is 25
    if (TENS[x] != null) { cur = any && cur > 0 && cur < 10 && total === 0 ? cur * 100 + TENS[x] : cur + TENS[x]; any = true; used++; continue; }
    if (SCALE[x] && any) { if (x === "hundred") cur *= 100; else { total += cur * SCALE[x]; cur = 0; } used++; continue; }
    if (/^\d+(\.\d+)?$/.test(x) && !any) { cur = parseFloat(x); any = true; used++; continue; }
    break;
  }
  if (!any) return null;
  let v = total + cur;
  // decimals: "point five", "point two five"
  if (w[i + used] === "point") {
    let d = "", k = i + used + 1;
    while (k < w.length && (ONES[w[k]] != null && ONES[w[k]] < 10 || /^\d$/.test(w[k]))) { d += /^\d$/.test(w[k]) ? w[k] : ONES[w[k]]; k++; }
    if (d) { v = parseFloat(v + "." + d); used = k - i; }
  }
  return [v, used];
}

export function normalizeSpeech(heard) {
  let t = String(heard || "").replace(/[‘’]/g, "'").trim().slice(0, 300);
  if (!t) return "";
  // punctuation a recognizer adds ("NVDA." would not match a ticker); keep $, %, decimals and commas inside numbers
  t = t.replace(/(\d{1,3})((?:,\d{3})+)(?!\d)/g, (m, a, b) => a + b.replace(/,/g, "")).replace(/(\d)[.,](?=\d)/g, "$1\u0000").replace(/[.,!?;:]+/g, " ").replace(/\u0000/g, ".").replace(/\s+/g, " ").trim();
  // spelled tickers: "n v d a", "N. V. D. A." -> NVDA (three or more single letters in a row)
  t = t.replace(/\b([a-z])(?:\s+([a-z])\b){2,5}/gi, m => m.replace(/\s+/g, "").toUpperCase());

  let w = t.toLowerCase().split(" ");
  const out = [];
  for (let i = 0; i < w.length;) {
    // numbers written as words
    const n = readNumber(w, i);
    if (n && !(n[1] === 1 && /^\d/.test(w[i]))) {
      let [v, used] = n;
      if (w[i + used] === "and" && w[i + used + 1] === "a" && FRAC[w[i + used + 2]]) { v += FRAC[w[i + used + 2]]; used += 3; }
      out.push(String(v)); i += used; continue;
    }
    out.push(t.split(" ")[i] ?? w[i]); i++;
  }
  t = out.join(" ");

  // words for symbols and sounds a recognizer mishears
  t = t.replace(/\s*\bper ?cent\b/gi, "%")
    .replace(/\b(\d+(?:\.\d+)?)\s+(?:us\s+)?dollars?\b/gi, "$1 dollars")
    .replace(/\busd ?g\b|\busd ?gee\b|\bu s d g\b|\bUSDG\b/gi, "USDG")
    .replace(/\b(?:t ?wap|tee ?wap|tea ?wap)\b/gi, "twap")
    .replace(/\b(?:d c a|dee see ay)\b/gi, "dca");
  // "by"/"bye"/"bi" at the start of a request (or after please/limit/now) is "buy"; "cell" and "sale" are "sell"
  t = t.replace(/(^|\b(?:please|limit|now|then|and)\s+)(?:by|bye|bi)\b/gi, "$1buy")
    .replace(/(^|\b(?:please|limit|now|then|and)\s+)(?:cell|sale|sail)\b/gi, "$1sell");
  // names spoken for a market -> $TICKER (longest names first so "micro strategy" wins over "strategy")
  for (const name of Object.keys(SPOKEN).sort((a, b) => b.length - a.length)) {
    const re = new RegExp("(^|[^a-z$])" + name.replace(/ /g, "\\s+") + "(?![a-z])", "i");
    t = t.replace(re, (m, pre) => pre + SPOKEN[name]);
  }
  // "PRIVO token", "TSLA stock" -> the ticker
  t = t.replace(/\b([A-Z]{2,6})\s+(?:token|stock|shares?)\b/g, "$1");
  return t.replace(/\s+/g, " ").trim();
}

/* ---------- what PRIVO AI says back ---------- */
const amountWords = x => x.usdg != null ? x.usdg + " dollars of" : x.pct != null ? (x.pct === 100 ? "all of your" : x.pct === 50 ? "half of your" : x.pct + " percent of your") : x.qty != null ? String(x.qty) : "";
// One short sentence for a reply card. Never advice; always ends by telling the trader to check and sign.
export function spokenReply(m) {
  if (!m) return "";
  if (m.error) return String(m.error).replace(/\s*Try "help".*$/, "");
  if (m.say != null) {
    // the first two sentences, without list marks or markdown, so a long answer is not read out in full
    const plain = String(m.say).replace(/[*`#]/g, "").replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, "").replace(/\s+/g, " ").trim();
    const two = (plain.match(/[^.!?]+[.!?]+/g) || [plain]).slice(0, 2).join(" ").trim();
    return two + (m.intents?.length ? " Check each ticket and sign if it looks right." : "");
  }
  if (m.help) return "Here are some things you can say.";
  if (m.info) return m.info.type === "price" ? "Here is the price of " + m.info.sym + "." : m.info.type === "balance" ? "Here are your balances." : m.info.type === "radar" ? "Here is what ranked wallets are trading." : "Here you go.";
  const x = m.intent;
  if (!x) return "";
  const check = " Check the ticket and sign if it looks right.";
  if (x.type === "basket") return "A basket of " + x.legs.length + " stocks" + (x.usdg ? " for " + x.usdg + " dollars" : "") + "." + check;
  if (x.type === "rebalance") return "Rebalancing " + (x.basket ? "your " + x.basket + " basket" : "your basket") + "." + check;
  if (x.type === "open") return "Opening " + x.sym + ".";
  const what = [x.side === "buy" ? "Buy" : "Sell", amountWords(x), x.sym].filter(Boolean).join(" ");
  if (x.type === "limit") return what + " at " + x.price + "." + check;
  if (x.type === "twap") return what + " in " + x.slices + " slices." + check;
  return what + "." + check;
}
