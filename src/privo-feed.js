// Real market data for Live mode: Uniswap pool prices and candles (GeckoTerminal) and
// stock perp funding (Orderly public API). Read-only, no keys.
import { MARKETS } from "./privo-swap.js";

const GECKO = "https://api.geckoterminal.com/api/v2/networks/robinhood";
const ORDERLY = "https://api.orderly.org";
// Perps that every Orderly builder can list (checked on 19 Nov 2026). Others are broker-specific.
export const PERPS = { TSLA: "PERP_TSLA_USDC", NVDA: "PERP_NVDA_USDC", ETH: "PERP_ETH_USDC", BTC: "PERP_BTC_USDC" };
const TF = { "15m": ["minute", 15], "1h": ["hour", 1], "4h": ["hour", 4], "1d": ["day", 1] };

async function direct(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status + " from " + new URL(url).host);
  return r.json();
}
// In the browser, go through PRIVO's cached proxy (/api/market) first: one shared copy for every
// visitor, no rate limits per phone, no cross-origin errors. Falls back to the source directly
// (local preview without functions, or the proxy being down). In Node there is no proxy.
let proxyOff = typeof location === "undefined" || !/^https?:$/.test(location.protocol);
async function getJson(url) {
  const src = url.startsWith(GECKO) ? ["gecko", GECKO] : url.startsWith(ORDERLY) ? ["orderly", ORDERLY] : null;
  if (src && !proxyOff) {
    try {
      const r = await fetch("/api/market?src=" + src[0] + "&p=" + encodeURIComponent(url.slice(src[1].length)));
      if (r.ok) return await r.json();
      if (r.status === 404) proxyOff = true; // no functions here (local preview)
    } catch { /* fall through to the source */ }
  }
  return direct(url);
}

// One request for every pool. For each market the deepest pool wins.
// Returns { SYM: { px, chg, vol, depth, pool } } with USD figures (USDG is treated as $1).
export async function poolStats() {
  const ids = Object.values(MARKETS).flatMap(m => m.pools.map(p => p.id));
  const j = await getJson(GECKO + "/pools/multi/" + ids.join(","));
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
export async function candles(pool, tf, token = "base", limit = 72) {
  const [unit, agg] = TF[tf] || TF["1h"];
  const j = await getJson(`${GECKO}/pools/${pool}/ohlcv/${unit}?aggregate=${agg}&limit=${limit}&token=${token}`);
  return (j.data?.attributes?.ohlcv_list || []).map(r => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] || 0 })).sort((a, b) => a.t - b.t);
}

// Orderly perps (stocks and crypto): mark price, 24h change,, funding per 8h (in %), open interest, 24h volume.
export async function perpStats() {
  const out = {};
  await Promise.all(Object.entries(PERPS).map(async ([sym, s]) => {
    const j = await getJson(`${ORDERLY}/v1/public/futures/${s}`);
    const d = j.data; if (!d) return;
    out[sym] = { symbol: s, chg24: d["24h_open"] ? (d["24h_close"] / d["24h_open"] - 1) * 100 : null, mark: +d.mark_price, index: +d.index_price, funding: +d.est_funding_rate * 100, lastFunding: +d.last_funding_rate * 100, oi: +d.open_interest, vol: +d["24h_amount"], nextFunding: d.next_funding_time };
  }));
  return out;
}

// Orderly perp candles (TradingView history API), oldest first, as { t, o, h, l, c, v }.
const RES = { "15m": ["15", 900], "1h": ["60", 3600], "4h": ["240", 14400], "1d": ["1D", 86400] };
export async function perpCandles(sym, tf, limit = 300) {
  const [res, sec] = RES[tf] || RES["1h"], to = Math.floor(Date.now() / 10000) * 10; // 10 s steps share the proxy cache
  const j = await getJson(`${ORDERLY}/tv/history?symbol=${PERPS[sym]}&resolution=${res}&from=${to - sec * limit}&to=${to}`);
  if (j.s !== "ok" || !j.t) return [];
  return j.t.map((t, i) => ({ t, o: +j.o[i], h: +j.h[i], l: +j.l[i], c: +j.c[i], v: +(j.v?.[i] || 0) }));
}
