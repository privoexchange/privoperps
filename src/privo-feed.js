// Real market data for Live mode: Uniswap pool prices and candles (GeckoTerminal) and
// stock perp funding (Orderly public API). Read-only, no keys.
import { MARKETS } from "./privo-swap.js";

const GECKO = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const ORDERLY = "https://api.orderly.org";
// Perps that every Orderly builder can list (checked on 19 Nov 2026). Others are broker-specific.
export const PERPS = Object.fromEntries(["TSLA", "NVDA", "GOOGL", "ETH", "BTC",
  // crypto perps open to every builder on Orderly (checked 20 Nov 2026); perps only, no Robinhood Chain spot pool
  "SOL", "XRP", "BNB", "DOGE", "HYPE", "AVAX", "LINK", "SUI", "AAVE", "ENA", "ONDO", "ARB", "NEAR", "DOT", "TAO", "INJ", "TIA", "HBAR", "ZEC", "XMR", "TRUMP", "JUP", "1000PEPE"].map(s => [s, "PERP_" + s + "_USDC"]));
// Markets that only trade as perps in PRIVO (no spot pool on Robinhood Chain).
export const PERP_ONLY = ["SOL", "XRP", "BNB", "DOGE", "HYPE", "AVAX", "LINK", "SUI", "AAVE", "ENA", "ONDO", "ARB", "NEAR", "DOT", "TAO", "INJ", "TIA", "HBAR", "ZEC", "XMR", "TRUMP", "JUP", "1000PEPE"];
// [GeckoTerminal unit, aggregate, group]: group > 1 (or "w"/"M") merges candles where the API has no such timeframe.
const TF = { "1m": ["minute", 1], "3m": ["minute", 1, 3], "5m": ["minute", 5], "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1], "1w": ["day", 1, "w"], "1M": ["day", 1, "M"] };
// Merge candles into 3-minute, weekly (Monday, UTC) or monthly (UTC) buckets.
function bucket(t, g) {
  if (g === "w") return (Math.floor((t / 86400 + 3) / 7) * 7 - 3) * 86400;
  if (g === "M") { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; }
  return Math.floor(t / (g * 60)) * g * 60;
}
function group(rows, g) {
  if (!g) return rows;
  const out = [];
  for (const k of rows) {
    const b = bucket(k.t, g), last = out.at(-1);
    if (last && last.t === b) { last.h = Math.max(last.h, k.h); last.l = Math.min(last.l, k.l); last.c = k.c; last.v += k.v; }
    else out.push({ ...k, t: b });
  }
  return out;
}
const rawLimit = (g, limit) => Math.min(1000, g === "w" || g === "M" ? 1000 : g ? limit * g : limit);

// On servers (Netlify functions) GeckoTerminal refuses requests without a user agent; browsers send their own.
const SERVER = typeof window === "undefined";
async function direct(url) {
  const r = await fetch(url, { headers: SERVER ? { accept: "application/json", "user-agent": "privo-site" } : { accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status + " from " + new URL(url).host);
  return r.json();
}
// In the browser, go through PRIVO's cached proxy (/api/market) first: one shared copy for every
// visitor, no rate limits per phone, no cross-origin errors. Falls back to the source directly
// (local preview without functions, or the proxy being down). In Node there is no proxy.
let proxyOff = typeof location === "undefined" || !/^https?:$/.test(location.protocol), proxyBase = "";
// Server functions (e.g. /api/v1/prices) call this with their own origin to share the proxy's durable CDN cache
// instead of hitting GeckoTerminal from Netlify's shared IPs, where requests are often rate limited.
export function useProxy(origin) { proxyBase = origin; proxyOff = false; }
async function getJson(url) {
  const src = url.startsWith(GECKO) ? ["gecko", GECKO] : url.startsWith(ORDERLY) ? ["orderly", ORDERLY] : null;
  if (src && !proxyOff) {
    try {
      const r = await fetch(proxyBase + "/api/market?src=" + src[0] + "&p=" + encodeURIComponent(url.slice(src[1].length)), SERVER ? { signal: AbortSignal.timeout(9000) } : undefined);
      if (r.ok) return await r.json();
      if (r.status === 404) proxyOff = true; // no functions here (local preview)
    } catch { /* fall through to the source */ }
  }
  return direct(url);
}

// GeckoTerminal returns up to 30 pools per request, so the pools go in batches. For each market the deepest pool wins.
// Returns { SYM: { px, chg, vol, depth, pool } } with USD figures (USDG is treated as $1).
export async function poolStats() {
  const ids = Object.values(MARKETS).filter(m => !m.delisted).flatMap(m => m.pools.map(p => p.id)), batches = [];
  for (let i = 0; i < ids.length; i += 25) batches.push(ids.slice(i, i + 25));
  // A failed batch only loses its own markets; the call fails only when every batch does.
  const settled = await Promise.allSettled(batches.map(b => getJson(GECKO + "/pools/multi/" + b.join(","))));
  const parts = settled.filter(s => s.status === "fulfilled").map(s => s.value);
  if (!parts.length && settled.length) throw settled[0].reason;
  const j = { data: parts.flatMap(p => p.data || []) };
  // GeckoTerminal may list the asset as base or quote token (USDG/WETH lists USDG first), so pick the right side.
  const byId = new Map((j.data || []).map(d => [d.attributes.address.toLowerCase(), { ...d.attributes, base: d.relationships?.base_token?.data?.id || "" }]));
  const out = {};
  for (const [sym, m] of Object.entries(MARKETS)) {
    let best = null;
    for (const p of m.pools) {
      const a = byId.get(p.id.toLowerCase()); if (!a) continue;
      const depth = +a.reserve_in_usd || 0;
      const isBase = a.base.toLowerCase().endsWith(m.address.toLowerCase());
      if (!best || depth > best.depth) best = { px: +(isBase ? a.base_token_price_usd : a.quote_token_price_usd), chg: isBase ? +(a.price_change_percentage?.h24 ?? 0) : null, vol: +(a.volume_usd?.h24 ?? 0), depth, pool: p.id };
    }
    if (best && best.px > 0) out[sym] = best;
  }
  return out;
}

// Candles for one pool, oldest first, as { t (unix s), o, h, l, c, v (USD) }.
// before (unix s): only candles that start before it, for loading older history when the chart is panned left.
export async function candles(pool, tf, token = "base", limit = 72, before = 0) {
  const [unit, agg, g] = TF[tf] || TF["1h"];
  const j = await getJson(`${GECKO}/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=${rawLimit(g, limit)}&token=${token}` + (before ? `&before_timestamp=${before}` : ""));
  return group((j.data?.attributes?.ohlcv_list || []).map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] || 0 })).sort((a, b) => a.t - b.t), g);
}

// Orderly perps (stocks and crypto): mark price, 24h change,, funding per 8h (in %), open interest, 24h volume.
export async function perpStats() {
  const out = {}, j = await getJson(`${ORDERLY}/v1/public/futures`);
  const by = new Map((j.data?.rows || []).map(d => [d.symbol, d]));
  for (const [sym, s] of Object.entries(PERPS)) {
    const d = by.get(s); if (!d) continue;
    out[sym] = { symbol: s, chg24: d["24h_open"] ? (d["24h_close"] / d["24h_open"] - 1) * 100 : null, mark: +d.mark_price, index: +d.index_price, funding: +d.est_funding_rate * 100, lastFunding: +d.last_funding_rate * 100, oi: +d.open_interest, vol: +d["24h_amount"], nextFunding: d.next_funding_time };
  }
  return out;
}

// Highest leverage Orderly allows per perp (1 / base_imr), e.g. { BTC: 100, TSLA: 20 }.
export async function perpMaxLev() {
  const j = await getJson(`${ORDERLY}/v1/public/info`), out = {};
  const by = new Map((j.data?.rows || []).map(d => [d.symbol, d]));
  for (const [sym, s] of Object.entries(PERPS)) { const d = by.get(s); if (d && +d.base_imr > 0) out[sym] = Math.max(1, Math.floor(1 / +d.base_imr + 1e-9)); }
  return out;
}

// Orderly perp candles (TradingView history API), oldest first, as { t, o, h, l, c, v }.
// [Orderly resolution, seconds per candle, group]; Orderly has no 3-minute candles, so 1-minute ones are merged.
const RES = { "1m": ["1", 60], "3m": ["1", 60, 3], "5m": ["5", 300], "15m": ["15", 900], "1h": ["60", 3600], "4h": ["240", 14400], "1d": ["1D", 86400], "1w": ["1W", 604800], "1M": ["1M", 2678400] };
export async function perpCandles(sym, tf, limit = 300, before = 0) {
  const [res, sec, g] = RES[tf] || RES["1h"], to = before ? before - 1 : Math.floor(Date.now() / 10000) * 10; // 10 s steps share the proxy cache
  const j = await getJson(`${ORDERLY}/tv/history?symbol=${PERPS[sym]}&resolution=${res}&from=${to - sec * limit * (g || 1)}&to=${to}`);
  if (j.s !== "ok" || !j.t) return [];
  return group(j.t.map((t, i) => ({ t, o: +j.o[i], h: +j.h[i], l: +j.l[i], c: +j.c[i], v: +(j.v?.[i] || 0) })), g);
}
