// Spot trade journal: every buy and sell of a PRIVO market, with average cost and profit and loss.
// Sources: the receipt of trades made in this app, plus a backfill from Blockscout's token-transfer API.
// Stored in this browser only (localStorage), per wallet. Wallet-free and testable in Node.
import { formatUnits, getAddress, parseAbiItem, decodeEventLog } from "viem";
import { USDG, WETH, MARKETS, decimalsOf, isNative } from "./privo-swap.js";

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
export function merge(j, entries) {
  const seen = new Set(j.trades.map(t => t.hash.toLowerCase()));
  for (const e of entries) if (!seen.has(e.hash.toLowerCase())) { j.trades.push(e); seen.add(e.hash.toLowerCase()); }
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
      const t = tx[it.transaction_hash] ||= { hash: it.transaction_hash, ts: Date.parse(it.timestamp), legs: {} };
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
    for (const [sym, l] of Object.entries(t.legs)) {
      if (sym === "USDG") continue;
      const e = entry({ hash: t.hash, ts: t.ts, sym, usdgOut: u.out, usdgIn: u.in, tokOut: l.out, tokIn: l.in });
      if (e) out.push(e);
    }
  }
  return out;
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
