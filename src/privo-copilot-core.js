// PRIVO Copilot core: turns a typed request ("buy 50 usdg NVDA", "sell half TSLA", "basket chips 100") into a ticket intent,
// and checks any intent (from this parser or from the AI fallback) against PRIVO's markets before the app fills a ticket.
// Shared by the PRIVO app (browser and server) and the tests (test/ai). It never trades: an
// intent only fills a ticket, which the user reviews and signs.
//
// Intent shapes (all amounts are decimal numbers):
//   { type: "spot",  side: "buy"|"sell", sym, usdg? | qty? | pct? }
//   { type: "limit", side, sym, usdg? | qty? | pct?, price }
//   { type: "twap",  side, sym, usdg? | qty? | pct?, price?, slices, everyMin, days? }
//   { type: "basket", legs: [{ sym, pct }], usdg, name? }      (legs from a theme or the stocks named)
//   { type: "rebalance", basket? }
//   { type: "open", sym }
//   { type: "help" }
import { MARKETS, BASKET_MAX } from "./privo-swap.js";

// Ready-made baskets: equal shares. Names describe the theme; they are not indexes.
export const BASKET_THEMES = [
  ["Big Tech", ["AAPL", "MSFT", "GOOGL", "AMZN", "META"]],
  ["Chips", ["NVDA", "AMD", "AVGO", "TSM", "MU"]],
  ["AI", ["NVDA", "MSFT", "GOOGL", "PLTR", "ORCL"]],
  ["Crypto stocks", ["COIN", "MSTR", "CRCL", "GLXY"]],
  ["Metals and oil", ["GLD", "SLV", "USO"]],
].map(([name, syms]) => [name, syms.filter(s => MARKETS[s]?.kind === "stock")]);

const live = s => !!MARKETS[s] && !MARKETS[s].delisted;
const isStock = s => live(s) && MARKETS[s].kind === "stock" && !MARKETS[s].native;
// Short tickers that are also everyday words: only taken when typed in capitals or with a $ in front.
const SHY = new Set(["F", "NU", "BA", "NET", "ON", "IT", "AI"]);
const num = s => parseFloat(String(s).replace(",", "."));

/* ---------- checking an intent ---------- */
// Returns { ok: true, intent } with a cleaned intent, or { ok: false, error }.
export function validate(x) {
  if (!x || typeof x !== "object") return { ok: false, error: "Not a request PRIVO can fill" };
  const pos = v => typeof v === "number" && isFinite(v) && v > 0;
  const amt = (o, out) => {
    const n = ["usdg", "qty", "pct"].filter(k => o[k] != null);
    if (n.length > 1) return "Give one amount: USDG, tokens or a percent";
    if (n.length === 1) { const k = n[0]; if (!pos(o[k]) || (k === "pct" && o[k] > 100)) return "That amount is not valid"; out[k] = o[k]; }
    return null;
  };
  const sym = typeof x.sym === "string" ? x.sym.toUpperCase().replace(/^\$/, "") : null;
  switch (x.type) {
    case "help": return { ok: true, intent: { type: "help" } };
    case "open":
      if (!sym || !live(sym)) return { ok: false, error: "No live market for " + (x.sym || "that") };
      return { ok: true, intent: { type: "open", sym } };
    case "spot": case "limit": case "twap": {
      if (!sym || !live(sym)) return { ok: false, error: "No live market for " + (x.sym || "that") };
      if (x.side !== "buy" && x.side !== "sell") return { ok: false, error: "Say whether to buy or sell" };
      const out = { type: x.type, side: x.side, sym };
      const e = amt(x, out); if (e) return { ok: false, error: e };
      if (x.type !== "spot") {
        if (!isStock(sym)) return { ok: false, error: "Limit and TWAP orders take stock tokens only" };
        if (x.price != null) { if (!pos(x.price)) return { ok: false, error: "That price is not valid" }; out.price = x.price; }
        else if (x.type === "limit") return { ok: false, error: "A limit order needs a price, for example \"at 380\"" };
      }
      if (x.type === "twap") {
        const sl = Math.round(x.slices ?? 6), ev = Math.round(x.everyMin ?? 15);
        if (!(sl >= 2 && sl <= 100)) return { ok: false, error: "A TWAP splits into 2 to 100 slices" };
        if (!(ev >= 1 && ev <= 1440)) return { ok: false, error: "Slices can be 1 minute to 1 day apart" };
        out.slices = sl; out.everyMin = ev;
      }
      if (x.type !== "spot" && x.days != null) { if (!(x.days > 0 && x.days <= 30)) return { ok: false, error: "Orders stay open up to 30 days" }; out.days = x.days; }
      return { ok: true, intent: out };
    }
    case "basket": {
      if (!Array.isArray(x.legs) || x.legs.length < 2 || x.legs.length > BASKET_MAX) return { ok: false, error: "A basket holds 2 to " + BASKET_MAX + " stock tokens" };
      const legs = x.legs.map(l => ({ sym: String(l.sym || "").toUpperCase().replace(/^\$/, ""), pct: +l.pct }));
      if (legs.some(l => !isStock(l.sym))) return { ok: false, error: "Baskets take stock tokens only (" + legs.find(l => !isStock(l.sym)).sym + ")" };
      if (new Set(legs.map(l => l.sym)).size !== legs.length) return { ok: false, error: "A stock is in the basket twice" };
      if (legs.some(l => !pos(l.pct)) || Math.abs(legs.reduce((a, l) => a + l.pct, 0) - 100) > 0.05) return { ok: false, error: "The shares must add up to 100%" };
      if (x.usdg != null && !pos(x.usdg)) return { ok: false, error: "That amount is not valid" };
      const out = { type: "basket", legs };
      if (x.usdg != null) out.usdg = x.usdg;
      if (typeof x.name === "string" && x.name.trim()) out.name = x.name.trim().slice(0, 32);
      return { ok: true, intent: out };
    }
    case "rebalance": return { ok: true, intent: { type: "rebalance", ...(typeof x.basket === "string" && x.basket.trim() ? { basket: x.basket.trim().slice(0, 40) } : {}) } };
    default: return { ok: false, error: "Not a request PRIVO can fill" };
  }
}

/* ---------- the local parser (no AI) ---------- */
const equalLegs = syms => { const b = Math.floor(10000 / syms.length) / 100; return syms.map((sym, i) => ({ sym, pct: i === syms.length - 1 ? +(100 - b * (syms.length - 1)).toFixed(2) : b })); };
const W = {
  buy: /\b(buy|long|invest|put|add)\b/, sell: /\b(sell|short|cash out|dump)\b/,
  limit: /\b(limit)\b/, twap: /\b(twap|dca|spread out|over time)\b/,
  basket: /\b(basket|equal|equally|evenly|split)\b/, rebalance: /\b(rebalance|rebalancing)\b/,
  open: /\b(open|show|chart)\b/, help: /^(help|\?|what can you do)\b/,
};
// Returns { intent } (checked), { error } when the request is understood but cannot be filled, or null when not understood.
export function parse(text, { names = {} } = {}) {
  const raw = String(text || "").trim().slice(0, 300);
  if (!raw) return null;
  // 1,000.5 -> 1000.5 ; 12,5 -> 12.5
  let t = raw.replace(/(\d{1,3})((?:,\d{3})+)(?!\d)/g, (m, a, b) => a + b.replace(/,/g, "")).replace(/(\d),(\d)/g, "$1.$2");
  const low = t.toLowerCase();
  if (W.help.test(low)) return { intent: { type: "help" } };

  // symbols, in the order typed: tickers, $tickers, and company names the app knows
  const found = [];
  const add = (sym, at) => { if (live(sym) && !found.some(f => f.sym === sym)) found.push({ sym, at }); };
  for (const m of t.matchAll(/\$?[A-Za-z][A-Za-z0-9.]{0,9}/g)) {
    const w = m[0].replace(/^\$/, ""), up = w.toUpperCase(), dollar = m[0][0] === "$";
    if (!MARKETS[up]) continue;
    if ((SHY.has(up) || up.length <= 2) && !(dollar || w === up)) continue;
    add(up, m.index);
  }
  for (const [sym, name] of Object.entries(names)) {
    const n = String(name || "").toLowerCase();
    if (n.length < 3) continue;
    const w = n.split(/[ ,]/)[0].length >= 4 ? n.split(/[ ,]/)[0] : n, i = low.indexOf(w);
    if (i >= 0 && !/[a-z0-9]/.test(low[i - 1] || "") && !/[a-z0-9]/.test(low[i + w.length] || "")) add(sym, i);
  }
  found.sort((a, b) => a.at - b.at);
  const syms = found.map(f => f.sym);

  let rest = " " + low + " ";
  const take = re => { const m = rest.match(re); if (m) rest = rest.replace(m[0], " "); return m; };
  const price = take(/(?:\bat\b|@|\bprice\b|<=|>=)\s*\$?\s*(\d+(?:\.\d+)?)/);
  const every = take(/(?:\bevery\b|\bper\b)\s*(\d+(?:\.\d+)?)?\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/);
  const slices = take(/(\d+)\s*(?:x|times|slices?|parts?)\b/);
  const days = take(/(?:\bfor\b|\bexpires?\b)?\s*(\d+)\s*(?:days?|d)\b/);
  const usdg = take(/\$\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:usdg|usd|dollars?|bucks?)\b/);
  const pctAll = [...rest.matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
  const word = /\b(half)\b/.test(rest) ? 50 : /\b(quarter)\b/.test(rest) ? 25 : /\b(all|max|everything)\b/.test(rest) ? 100 : null;
  const theme = BASKET_THEMES.find(([n]) => new RegExp("\\b" + n.toLowerCase() + "\\b").test(low));

  const side = W.sell.test(low) ? "sell" : W.buy.test(low) ? "buy" : null;
  const everyMin = every ? (num(every[1] || 1) * (/^(hours?|hrs?|h)$/.test(every[2]) ? 60 : /^(days?|d)$/.test(every[2]) ? 1440 : 1)) : null;

  if (W.rebalance.test(low)) {
    const b = theme?.[0] || (low.match(/rebalance\s+(?:basket\s+)?(.+)$/)?.[1] || "").trim();
    return check({ type: "rebalance", ...(b ? { basket: b } : {}) });
  }

  // baskets: a theme, or 2+ stocks with "basket"/"rata", or 2+ stocks bought together
  const stockSyms = syms.filter(isStock);
  if ((W.basket.test(low) || (side === "buy" && stockSyms.length >= 2)) && side !== "sell") {
    let legs = null, name;
    if (stockSyms.length >= 2) {
      // weights typed next to each stock ("nvda 60 amd 40", "60% nvda 40% amd")
      const ws = stockSyms.map(s => { const f = found.find(x => x.sym === s); const after = low.slice(f.at).match(/^\$?[a-z0-9.]+\s*(\d+(?:\.\d+)?)\s*%?/); const before = low.slice(0, f.at).match(/(\d+(?:\.\d+)?)\s*%\s*$/); return after ? num(after[1]) : before ? num(before[1]) : null; });
      legs = ws.every(w => w > 0) && Math.abs(ws.reduce((a, w) => a + w, 0) - 100) < 0.05 ? stockSyms.map((sym, i) => ({ sym, pct: ws[i] })) : equalLegs(stockSyms);
    } else if (theme && W.basket.test(low)) { legs = equalLegs(theme[1]); name = theme[0]; }
    if (legs) {
      // the amount: USDG if written as such, else the first bare number that is not one of the typed weights
      const typedW = legs.length === stockSyms.length ? legs.map(l => l.pct) : [];
      const bare = [...rest.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map(m => num(m[1])).filter(v => !typedW.includes(v));
      const amount = usdg ? num(usdg[1] || usdg[2]) : bare[0];
      return check({ type: "basket", legs, ...(amount ? { usdg: amount } : {}), ...(name ? { name } : {}) });
    }
  }

  if (!syms.length) return null;
  const sym = syms[0];
  if (!side) return W.open.test(low) || syms.length === 1 && low.replace(/[^a-z]/g, "") === sym.toLowerCase() ? check({ type: "open", sym }) : null;

  const type = W.twap.test(low) || slices || every ? "twap" : W.limit.test(low) || price ? "limit" : "spot";
  const o = { type, side, sym };
  if (usdg) o.usdg = num(usdg[1] || usdg[2]);
  else if (pctAll.length) o.pct = num(pctAll[0][1]);
  else if (word) o.pct = word;
  else {
    // a bare number: tokens when selling, USDG when buying
    const n = rest.match(/\b(\d+(?:\.\d+)?)\b/);
    if (n) o[side === "sell" ? "qty" : "usdg"] = num(n[1]);
  }
  if (price) o.price = num(price[1]);
  if (type === "twap") { if (slices) o.slices = parseInt(slices[1], 10); if (everyMin) o.everyMin = everyMin; }
  if (days && type !== "spot") o.days = parseInt(days[1], 10);
  return check(o);
}
function check(x) { const v = validate(x); return v.ok ? { intent: v.intent } : { error: v.error }; }

/* ---------- the AI fallback (OpenRouter), shared prompt and reply parsing ---------- */
export function systemPrompt() {
  const stocks = Object.keys(MARKETS).filter(isStock), crypto = Object.keys(MARKETS).filter(s => live(s) && !isStock(s));
  return [
    "You turn a trader's request on PRIVO (a trading app on Robinhood Chain) into ONE JSON object that fills an order ticket. The trader reviews and signs it; you never trade.",
    "Reply with the JSON object only: no prose, no code fences.",
    "Shapes (numbers are plain numbers; give at most one of usdg, qty, pct):",
    '{"type":"spot","side":"buy"|"sell","sym":"TSLA","usdg":50} usdg = USDG to spend (buy) or the USDG value to sell; qty = tokens; pct = percent of the balance',
    '{"type":"limit","side":"buy"|"sell","sym":"TSLA","usdg":100,"price":380,"days":7} price = worst USDG per token; stock tokens only',
    '{"type":"twap","side":"buy"|"sell","sym":"TSLA","qty":3,"price":400,"slices":6,"everyMin":15,"days":1} stock tokens only',
    '{"type":"basket","legs":[{"sym":"NVDA","pct":60},{"sym":"AMD","pct":40}],"usdg":90,"name":"Chips"} 2 to 8 stock tokens, pct adds up to 100',
    '{"type":"rebalance","basket":"Big Tech"}   {"type":"open","sym":"NVDA"}   {"type":"help"}',
    '{"type":"none","reason":"..."} when the request is not a trade on these markets (news, advice, predictions, anything else).',
    "Never give financial advice or pick stocks by opinion. A basket theme by name is fine: " + BASKET_THEMES.map(([n, s]) => n + " = " + s.join(" ")).join("; ") + ".",
    "Stock token symbols: " + stocks.join(" ") + ".",
    "Crypto (spot only): " + crypto.join(" ") + ".",
  ].join("\n");
}
// The first JSON object in a model reply (models sometimes wrap it in a code fence or a sentence).
export function extractJson(s) {
  const str = String(s || ""), i = str.indexOf("{");
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = i; j < str.length; j++) {
    const c = str[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) { try { return JSON.parse(str.slice(i, j + 1)); } catch { return null; } }
  }
  return null;
}
