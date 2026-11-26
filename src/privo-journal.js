// Spot trade journal: every buy and sell of a PRIVO market, with average cost and profit and loss.
// Sources: the receipt of trades made in this app, plus a backfill from Blockscout's token-transfer API.
// Stored in this browser only (localStorage), per wallet. Wallet-free and testable in Node.
import { formatUnits, getAddress, parseAbiItem, decodeEventLog } from "viem";
import { CONFIG, ADDR, USDG, WETH, MARKETS, decimalsOf, isNative } from "./privo-swap.js";

const KEY = a => "privo-spot-journal:" + a.toLowerCase();
const EXPLORER_API = "https://robinhoodchain.blockscout.com/api/v2";
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const WETH_IN = parseAbiItem("event Deposit(address indexed dst, uint256 wad)");
const WETH_OUT = parseAbiItem("event Withdrawal(address indexed src, uint256 wad)");
const bySymbol = Object.fromEntries(Object.entries(MARKETS).map(([s, m]) => [m.address.toLowerCase(), s]));

export function load(addr) {
  try { const j = JSON.parse(localStorage.getItem(KEY(addr)) || "null"); return j && Array.isArray(j.trades) ? j : { trades: [], synced: 0 }; } catch { return { trades: [], synced: 0 }; }
}
export function save(addr, j) { try { localStorage.setItem(KEY(addr), JSON.stringify(j)); } catch {} }
// One entry per transaction and market: a basket buy is one transaction with several markets.
const tradeKey = t => t.hash.toLowerCase() + ":" + t.sym;
export function merge(j, entries) {
  const seen = new Set(j.trades.map(tradeKey));
  for (const e of entries) if (!seen.has(tradeKey(e))) { j.trades.push(e); seen.add(tradeKey(e)); }
  j.trades.sort((a, b) => a.ts - b.ts);
  return j;
}

// One swap from its receipt: what left the wallet and what arrived. Native ETH legs come from WETH wrap/unwrap.
export function fromReceipt(rc, addr, sym, { value = 0n, ts = Date.now() } = {}) {
  const me = addr.toLowerCase(), tok = (isNative(sym) ? WETH : MARKETS[sym].address).toLowerCase(), usdg = USDG.address.toLowerCase();
  let usdgOut = 0n, usdgIn = 0n, tokOut = 0n, tokIn = 0n;
  for (const l of rc.logs) {
    const a = l.address.toLowerCase();
    try {
      if (a === usdg || (!isNative(sym) && a === tok)) {
        const { args } = decodeEventLog({ abi: [TRANSFER], data: l.data, topics: l.topics });
        const from = args.from.toLowerCase(), to = args.to.toLowerCase();
        if (a === usdg) { if (from === me) usdgOut += args.value; if (to === me) usdgIn += args.value; }
        else { if (from === me) tokOut += args.value; if (to === me) tokIn += args.value; }
      } else if (isNative(sym) && a === WETH.toLowerCase()) {
        if (l.topics[0] === "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65") tokIn += decodeEventLog({ abi: [WETH_OUT], data: l.data, topics: l.topics }).args.wad; // Withdrawal: ETH to the buyer
      }
    } catch { /* not a matching event */ }
  }
  if (isNative(sym) && value > 0n) tokOut += value; // selling native ETH: the swap's value
  return entry({ hash: rc.transactionHash, ts, sym, usdgOut, usdgIn, tokOut, tokIn });
}
function entry({ hash, ts, sym, usdgOut, usdgIn, tokOut, tokIn }) {
  const d = decimalsOf(sym);
  if (usdgOut > usdgIn && tokIn > tokOut) return { hash, ts, sym, side: "buy", qty: +formatUnits(tokIn - tokOut, d), usdg: +formatUnits(usdgOut - usdgIn, USDG.decimals) };
  if (tokOut > tokIn && usdgIn > usdgOut) return { hash, ts, sym, side: "sell", qty: +formatUnits(tokOut - tokIn, d), usdg: +formatUnits(usdgIn - usdgOut, USDG.decimals) };
  return null;
}

// Basket buys: one transaction that buys several markets with USDG. Transfers in log order ({ tok, from, to, v }, lowercase
// addresses): each leg is the wallet's USDG pulled into the router followed by that market's token arriving; the PRIVO fee
// (sent straight to the fee Safe) is shared over the legs by their USDG. Returns one buy per market, or null when the
// transaction is not a basket (fewer than two markets bought).
export function basketEntries(transfers, addr, { hash, ts = Date.now() }) {
  const me = addr.toLowerCase(), usdg = USDG.address.toLowerCase(), fw = (CONFIG.FEE_WALLET || "").toLowerCase();
  let pending = 0n, fee = 0n;
  const legs = [];
  for (const t of transfers) {
    if (t.tok === usdg && t.from === me) { if (fw && t.to === fw) fee += t.v; else pending += t.v; }
    else if (bySymbol[t.tok] && !isNative(bySymbol[t.tok]) && t.to === me && pending > 0n) { legs.push({ sym: bySymbol[t.tok], tokIn: t.v, usdg: pending }); pending = 0n; }
  }
  if (legs.length < 2 || new Set(legs.map(l => l.sym)).size !== legs.length) return null;
  const total = legs.reduce((a, l) => a + l.usdg, 0n);
  let feeLeft = fee;
  return legs.map((l, i) => {
    const f = i === legs.length - 1 ? feeLeft : fee * l.usdg / total;
    feeLeft -= f;
    return entry({ hash, ts, sym: l.sym, usdgOut: l.usdg + f, usdgIn: 0n, tokOut: 0n, tokIn: l.tokIn });
  });
}
// Basket sales: one transaction that sells several markets for USDG. In log order, each leg is that market's token leaving
// the wallet followed by the USDG its pool pays into the router; then the router pays the PRIVO fee and sweeps the rest to
// the wallet. The USDG received is shared over the legs by what each pool paid. Returns one sell per market, or null when
// the transaction is not a basket sale.
export function basketSellEntries(transfers, addr, { hash, ts = Date.now() }) {
  const me = addr.toLowerCase(), usdg = USDG.address.toLowerCase(), router = ADDR.ROUTER.toLowerCase();
  const legs = [];
  let net = 0n;
  for (const t of transfers) {
    if (t.tok === usdg) {
      if (t.from === me) return null; // the wallet paid USDG: not a sale
      if (t.to === me) net += t.v;
      else if (t.to === router && legs.length) legs.at(-1).gross += t.v;
    } else if (bySymbol[t.tok] && !isNative(bySymbol[t.tok]) && t.from === me) legs.push({ sym: bySymbol[t.tok], tokOut: t.v, gross: 0n });
  }
  if (legs.length < 2 || new Set(legs.map(l => l.sym)).size !== legs.length || net <= 0n || legs.some(l => l.gross <= 0n)) return null;
  const total = legs.reduce((a, l) => a + l.gross, 0n);
  let left = net;
  return legs.map((l, i) => {
    const u = i === legs.length - 1 ? left : net * l.gross / total;
    left -= u;
    return entry({ hash, ts, sym: l.sym, usdgOut: 0n, usdgIn: u, tokOut: l.tokOut, tokIn: 0n });
  });
}
// Basket rebalances: one transaction that sells some markets and buys others. In log order: each sold market's token
// leaves the wallet followed by the USDG its pool pays into the router; the router pays the PRIVO fee and sweeps the USDG
// to the wallet; then for each bought market the wallet's USDG goes into the router followed by that market's token
// arriving. The swept USDG is shared over the sold legs by what each pool paid; each buy costs the USDG pulled for it.
// Returns one sell per sold market and one buy per bought market, or null when the transaction is not a rebalance.
export function rebalanceEntries(transfers, addr, { hash, ts = Date.now() }) {
  const me = addr.toLowerCase(), usdg = USDG.address.toLowerCase(), router = ADDR.ROUTER.toLowerCase(), fw = (CONFIG.FEE_WALLET || "").toLowerCase();
  const sells = [], buys = [];
  let net = 0n, pending = 0n;
  for (const t of transfers) {
    const sym = t.tok === usdg ? "USDG" : bySymbol[t.tok];
    if (!sym || (sym !== "USDG" && isNative(sym))) continue;
    if (sym === "USDG") {
      if (t.to === me) { if (buys.length || pending) return null; net += t.v; }
      else if (t.from === me) { if (fw && t.to === fw) return null; pending += t.v; }
      else if (t.to === router && sells.length && !pending && !buys.length) sells.at(-1).gross += t.v;
    } else if (t.from === me) { if (pending || buys.length) return null; sells.push({ sym, tokOut: t.v, gross: 0n }); }
    else if (t.to === me && pending > 0n) { buys.push({ sym, tokIn: t.v, usdg: pending }); pending = 0n; }
  }
  if (!sells.length || !buys.length || net <= 0n || pending) return null;
  const syms = [...sells, ...buys].map(l => l.sym);
  if (new Set(syms).size !== syms.length) return null;
  if (sells.length > 1 && sells.some(l => l.gross <= 0n)) return null;
  const total = sells.reduce((a, l) => a + l.gross, 0n);
  let left = net;
  const out = sells.map((l, i) => {
    const u = i === sells.length - 1 ? left : net * l.gross / total;
    left -= u;
    return entry({ hash, ts, sym: l.sym, usdgOut: 0n, usdgIn: u, tokOut: l.tokOut, tokIn: 0n });
  });
  for (const l of buys) out.push(entry({ hash, ts, sym: l.sym, usdgOut: l.usdg, usdgIn: 0n, tokOut: 0n, tokIn: l.tokIn }));
  return out.every(Boolean) ? out : null;
}
// A basket buy, sale or rebalance, as one trade per market; null for anything else.
export const multiEntries = (transfers, addr, opts) => rebalanceEntries(transfers, addr, opts) || basketEntries(transfers, addr, opts) || basketSellEntries(transfers, addr, opts);
// ERC-20 transfers of a receipt, in log order, for basketEntries and basketSellEntries.
export function receiptTransfers(rc) {
  const out = [];
  for (const l of rc.logs) {
    if (l.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" || l.topics.length !== 3) continue;
    out.push({ tok: l.address.toLowerCase(), from: "0x" + l.topics[1].slice(26).toLowerCase(), to: "0x" + l.topics[2].slice(26).toLowerCase(), v: BigInt(l.data) });
  }
  return out;
}

// Backfill: ERC-20 transfers of the wallet, grouped per transaction. Only the real USDG and PRIVO market
// tokens count (look-alike tokens with the same name are ignored by address). Native ETH legs are not in
// this feed, so ETH trades come from receipts only.
export async function backfill(addr, { pages = 6, fetchFn = fetch } = {}) {
  const me = addr.toLowerCase(), usdg = USDG.address.toLowerCase();
  const tx = {};
  let q = "", n = 0;
  do {
    const r = await fetchFn(`${EXPLORER_API}/addresses/${getAddress(addr)}/token-transfers?type=ERC-20${q}`);
    if (!r.ok) throw new Error("Blockscout returned HTTP " + r.status);
    const j = await r.json();
    for (const it of j.items || []) {
      const a = (it.token?.address_hash || it.token?.address || "").toLowerCase();
      const sym = a === usdg ? "USDG" : bySymbol[a];
      if (!sym || (sym !== "USDG" && isNative(sym))) continue;
      const t = tx[it.transaction_hash] ||= { hash: it.transaction_hash, ts: Date.parse(it.timestamp), legs: {}, list: [] };
      t.list.push({ i: Number(it.log_index ?? 0), tok: a, from: (it.from?.hash || "").toLowerCase(), to: (it.to?.hash || "").toLowerCase(), v: BigInt(it.total?.value || 0) });
      const leg = t.legs[sym] ||= { out: 0n, in: 0n };
      const v = BigInt(it.total?.value || 0);
      if (it.from?.hash?.toLowerCase() === me) leg.out += v;
      if (it.to?.hash?.toLowerCase() === me) leg.in += v;
    }
    q = j.next_page_params ? "&" + new URLSearchParams(j.next_page_params).toString() : "";
  } while (q && ++n < pages);
  const out = [];
  for (const t of Object.values(tx)) {
    const u = t.legs.USDG; if (!u) continue;
    const basket = multiEntries(t.list.sort((a, b) => a.i - b.i), addr, { hash: t.hash, ts: t.ts });
    if (basket) { out.push(...basket); continue; }
    const sold = Object.entries(t.legs).filter(([s, l]) => s !== "USDG" && l.out > l.in), got = Object.entries(t.legs).filter(([s, l]) => s !== "USDG" && l.in > l.out);
    if ((sold.length >= 2 || (sold.length && got.length)) && u.in > 0n) {
      // A basket sale or rebalance: the wallet's own feed has no pool payments, so read the whole transaction's transfers
      // to split the USDG by leg. If that fails, leave the transaction out rather than book it wrongly.
      try {
        const r = await fetchFn(`${EXPLORER_API}/transactions/${t.hash}/token-transfers?type=ERC-20`);
        const items = r.ok ? (await r.json()).items || [] : [];
        const list = items.map(it => ({ i: Number(it.log_index ?? 0), tok: (it.token?.address_hash || it.token?.address || "").toLowerCase(), from: (it.from?.hash || "").toLowerCase(), to: (it.to?.hash || "").toLowerCase(), v: BigInt(it.total?.value || 0) }));
        const es = multiEntries(list.sort((a, b) => a.i - b.i), addr, { hash: t.hash, ts: t.ts });
        if (es) out.push(...es);
      } catch { /* Blockscout busy */ }
      continue;
    }
    for (const [sym, l] of Object.entries(t.legs)) {
      if (sym === "USDG") continue;
      const e = entry({ hash: t.hash, ts: t.ts, sym, usdgOut: u.out, usdgIn: u.in, tokOut: l.out, tokIn: l.in });
      if (e) out.push(e);
    }
  }
  return out;
}

// Baskets held: every basket buy in the journal (one transaction buying several markets), less the basket sales linked
// to it and with the rebalances linked to it. links: { saleOrRebalanceHash: buyHash }, kept by the app that sent it. Each
// leg keeps what is left of its quantity, its basis (pro rata on sales, plus what rebalance buys cost) and what sales
// realized; cost stays what the first buy put into that leg, so cost shares are the basket's target shares. Fees are
// inside the USDG amounts. Returns [{ id, ts, sales, rebalances, legs: [{ sym, bought, cost, qty, basis, proceeds,
// realized }] }], oldest first.
export function basketPositions(trades, links = {}) {
  const byHash = new Map(), out = new Map();
  for (const t of [...trades].sort((a, b) => a.ts - b.ts)) {
    const h = t.hash.toLowerCase();
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(t);
  }
  const lk = Object.fromEntries(Object.entries(links).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
  for (const [h, ts] of byHash) {
    if (ts.length < 2) continue;
    if (ts.every(t => t.side === "buy")) {
      out.set(h, { id: h, ts: ts[0].ts, sales: 0, rebalances: 0, legs: ts.map(t => ({ sym: t.sym, bought: t.qty, cost: t.usdg, qty: t.qty, basis: t.usdg, proceeds: 0, realized: 0 })) });
    } else if (out.has(lk[h])) {
      const b = out.get(lk[h]);
      for (const t of ts) {
        const l = b.legs.find(x => x.sym === t.sym);
        if (l && t.side === "buy") { l.qty += t.qty; l.basis += t.usdg; continue; }
        if (!l || !(l.qty > 0)) continue;
        const q = Math.min(t.qty, l.qty), c = l.basis * q / l.qty, p = t.usdg * q / t.qty;
        l.qty -= q; l.basis -= c; l.proceeds += p; l.realized += p - c;
        if (l.qty <= l.bought * 1e-9) { l.qty = 0; l.basis = 0; }
      }
      if (ts.every(t => t.side === "sell")) b.sales++; else b.rebalances++;
    }
  }
  return [...out.values()];
}

// Average-cost book per market. Fees are inside the USDG amounts, so PnL is after PRIVO's fee.
export function book(trades) {
  const b = {};
  for (const t of [...trades].sort((x, y) => x.ts - y.ts)) {
    const p = b[t.sym] ||= { qty: 0, cost: 0, realized: 0, bought: 0, sold: 0, soldCost: 0, sells: 0, wins: 0 };
    if (t.side === "buy") { p.qty += t.qty; p.cost += t.usdg; p.bought += t.usdg; }
    else {
      const q = Math.min(t.qty, p.qty), avg = p.qty > 0 ? p.cost / p.qty : 0;
      const r = t.usdg * (q / t.qty) - avg * q; // sales beyond the tracked amount have no known cost
      p.realized += r; p.soldCost += avg * q; p.cost -= avg * q; p.qty -= q; p.sold += t.usdg;
      if (q > 0) { p.sells++; if (r > 0) p.wins++; }
      if (p.qty < 1e-12) { p.qty = 0; p.cost = 0; }
    }
  }
  for (const p of Object.values(b)) p.avg = p.qty > 0 ? p.cost / p.qty : 0;
  return b;
}

// Every sale as a realized-PnL event: { ts, sym, pnl, cost, proceeds, holdMs }. Hold time is measured from
// the quantity-weighted purchase time of what was held (average-cost basis, matching book()).
export function realizedEvents(trades) {
  const pos = {}, out = [];
  for (const t of [...trades].sort((x, y) => x.ts - y.ts)) {
    const p = pos[t.sym] ||= { qty: 0, cost: 0, tsw: 0 };
    if (t.side === "buy") { p.tsw = (p.tsw * p.qty + t.ts * t.qty) / (p.qty + t.qty || 1); p.qty += t.qty; p.cost += t.usdg; continue; }
    const q = Math.min(t.qty, p.qty); if (!(q > 0)) continue;
    const avg = p.cost / p.qty, proceeds = t.usdg * (q / t.qty), cost = avg * q;
    out.push({ ts: t.ts, sym: t.sym, pnl: proceeds - cost, cost, proceeds, holdMs: Math.max(0, t.ts - p.tsw), hash: t.hash });
    p.cost -= cost; p.qty -= q;
    if (p.qty < 1e-12) { p.qty = 0; p.cost = 0; p.tsw = 0; }
  }
  return out;
}
