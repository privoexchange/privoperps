// Market feed tests, offline (fetch is faked): pool prices survive a failed GeckoTerminal batch, and server
// functions read through PRIVO's cached /api/market proxy, falling back to GeckoTerminal when the proxy fails.
//   node test/sim/feed-test.mjs
import { MARKETS } from "../../src/privo-swap.js";
import { poolStats, useProxy } from "../../src/privo-feed.js";

let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };

// A fake GeckoTerminal answer for every pool in a /pools/multi/ batch: price 1 for the market's token.
const owner = new Map(Object.values(MARKETS).flatMap(m => m.pools.map(p => [p.id.toLowerCase(), m])));
function multi(ids) {
  return { data: ids.map(id => { const m = owner.get(id.toLowerCase()); return { attributes: { address: id, base_token_price_usd: "1", quote_token_price_usd: "1", reserve_in_usd: "1000", volume_usd: { h24: "5" }, price_change_percentage: { h24: "0" } }, relationships: { base_token: { data: { id: "robinhood_" + m.address } } } }; }) };
}
const idsOf = url => decodeURIComponent(url).split("/pools/multi/")[1].split(/[&?]/)[0].split(",");
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fail = status => new Response("{}", { status });
const live = Object.keys(MARKETS).filter(s => !MARKETS[s].delisted);

let calls = [];
const run = async handler => { calls = []; globalThis.fetch = async url => { url = String(url); calls.push(url); return handler(url); }; try { return await poolStats(); } catch (e) { return e; } };

// 1. One batch rate-limited: the other batches still give prices.
{
  let n = 0;
  const r = await run(url => (n++ === 1 ? fail(429) : ok(multi(idsOf(url)))));
  const priced = Object.keys(r).length;
  check(!(r instanceof Error) && priced > 0 && priced < live.length, `one failed batch keeps the others (${priced} of ${live.length} markets priced)`);
}
// 2. Every batch fails: the call fails, so callers can tell "no data" from "no markets".
{
  const r = await run(() => fail(429));
  check(r instanceof Error, "every batch failing throws");
}
// 3. With useProxy, requests go to the site's /api/market, not to GeckoTerminal.
useProxy("https://privoexchange.example");
{
  const r = await run(url => ok(multi(idsOf(url))));
  check(calls.length > 0 && calls.every(u => u.startsWith("https://privoexchange.example/api/market?src=gecko&p=")) && Object.keys(r).length === live.length, "server reads go through the cached proxy and price every market");
}
// 4. Proxy down: falls back to GeckoTerminal directly.
{
  const r = await run(url => (url.includes("/api/market") ? fail(502) : ok(multi(idsOf(url)))));
  check(calls.some(u => u.startsWith("https://api.geckoterminal.com/")) && Object.keys(r).length === live.length, "proxy failure falls back to GeckoTerminal");
}

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
