// Basket rebalances (sell what is above target, buy what is below, in one router call under one PermitBatch signature)
// against Robinhood Chain mainnet state, without sending anything. A throwaway key buys a basket with lopsided shares
// using faked USDG, approves its stock tokens to Permit2, then rebalances the holding to other target shares, all in one
// eth_simulateV1 block with transfer tracing. The test reads where every token went: the PRIVO fee once on what the sales
// bring in, the router keeps nothing, the trader pays in no more USDG than the sales return, the shares land near their
// targets, and the journal reads the rebalance as sells and buys that update the basket position.
//   node test/sim/rebalance-test.mjs        (PRIVO_RPC=<rpc with eth_simulateV1> to use another RPC)
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, pad, toHex, parseUnits, formatUnits, keccak256, encodeAbiParameters } from "viem";
import { rebalanceEntries, basketEntries, receiptTransfers, multiEntries, basketPositions } from "../../src/privo-journal.js";
import { CONFIG, ADDR, USDG, MARKETS, makeClient, quoteBasket, buildBasket, quoteRebalance, buildRebalance, rebalancePulls, permitTypedData, permitBatchTypedData, portion } from "../../src/privo-swap.js";

const c = makeClient(process.env.PRIVO_RPC ? process.env.PRIVO_RPC.split(",") : undefined);
const acct = privateKeyToAccount(generatePrivateKey());
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };

async function guessSlot(token, data, want) {
  const sel = data.slice(0, 10), args = data.slice(10).match(/.{64}/g).map(w => "0x" + w);
  for (let i = 0n; i < 100n; i++) {
    let k = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [args[0], i]));
    if (sel === "0xdd62ed3e") k = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [args[1], k]));
    let r; try { r = await c.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [token]: { stateDiff: { [k]: pad(toHex(want)) } } }] }); } catch { continue; }
    if (r && r !== "0x" && BigInt(r) === want) return k;
  }
  throw new Error("slot not found on " + token);
}
const me = acct.address.toLowerCase(), router = ADDR.ROUTER.toLowerCase(), usdg = USDG.address.toLowerCase(), fw = CONFIG.FEE_WALLET.toLowerCase();
const balSlot = await guessSlot(USDG.address, encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [acct.address] }), 7n);
const alwSlot = await guessSlot(USDG.address, encodeFunctionData({ abi: erc, functionName: "allowance", args: [acct.address, ADDR.PERMIT2] }), 7n);
const call = (to, data) => ({ from: acct.address, to, data, gas: toHex(8_000_000n) });
const transfers = logs => logs.filter(l => l.topics[0] === TRANSFER && l.topics.length === 3).map(l => ({ tok: l.address.toLowerCase(), from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), v: BigInt(l.data) }));
const sim = (ov, calls) => c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides: ov, calls }], traceTransfers: true, validation: false }, "latest"] }).then(r => r[0].calls);

// Buys `buyW` shares of `human` USDG, then rebalances what was bought to `target` shares.
async function run(syms, buyW, target, human, { slip = 50, inflate = null } = {}) {
  const amount = parseUnits(human, 6);
  const ov = { [USDG.address]: { stateDiff: { [balSlot]: pad(toHex(amount)), [alwSlot]: pad(toHex((1n << 256n) - 1n)) } }, [acct.address]: { balance: toHex(10n ** 17n) } };
  const qb = await quoteBasket(c, { legs: syms.map((sym, i) => ({ sym, w: buyW[i] })), amount });
  const td = permitTypedData({ token: USDG.address, amount, nonce: 0 });
  const buy = buildBasket(qb, { slippageBps: 100, permit: { message: td.message, signature: await acct.signTypedData(td) } });
  const [b1] = await sim(ov, [call(buy.to, buy.data)]);
  if (b1.status !== "0x1") return { ok: false, err: "buy: " + (b1.error?.message || "reverted") };
  const held = {}; for (const t of transfers(b1.logs)) if (t.to === me && t.tok !== usdg) held[t.tok] = (held[t.tok] || 0n) + t.v;
  const legs = syms.map((sym, i) => ({ sym, w: target[i], amount: held[MARKETS[sym].address.toLowerCase()] || 0n }));
  const qr = await quoteRebalance(c, { legs, slippageBps: slip });
  if (inflate) qr.buys = qr.buys.map(l => l.sym === inflate ? { ...l, grossOut: l.grossOut * 10300n / 10000n } : l);
  // Permit2 nonces: the buy used USDG nonce 0; each stock token is fresh
  const items = rebalancePulls(qr).map(p => ({ ...p, nonce: p.token === USDG.address ? 1 : 0 }));
  const bt = permitBatchTypedData({ items });
  const tx = buildRebalance(qr, { permit: { message: bt.message, signature: await acct.signTypedData(bt) } });
  const approvals = qr.sells.map(s => call(MARKETS[s.sym].address, encodeFunctionData({ abi: erc, functionName: "approve", args: [ADDR.PERMIT2, (1n << 256n) - 1n] })));
  const calls = await sim(ov, [call(buy.to, buy.data), ...approvals, call(tx.to, tx.data)]);
  const rc = calls.at(-1);
  if (rc.status !== "0x1") return { ok: false, qr, err: rc.error?.message || "reverted" };
  const ts = transfers(rc.logs);
  let usdgIn = 0n, usdgOut = 0n, fee = 0n, gross = 0n; const left = {}, got = {}, gave = {};
  for (const t of ts) {
    if (t.tok === usdg && t.to === me) usdgIn += t.v;
    if (t.tok === usdg && t.from === me) usdgOut += t.v;
    if (t.tok === usdg && t.to === fw) fee += t.v;
    if (t.tok === usdg && t.to === router && t.from !== me) gross += t.v;
    if (t.tok !== usdg && t.to === me) got[t.tok] = (got[t.tok] || 0n) + t.v;
    if (t.tok !== usdg && t.from === me) gave[t.tok] = (gave[t.tok] || 0n) + t.v;
    if (t.to === router) left[t.tok] = (left[t.tok] || 0n) + t.v;
    if (t.from === router) left[t.tok] = (left[t.tok] || 0n) - t.v;
  }
  // the shares after, valued by quoting what each leg now holds
  const now = legs.map(l => { const a = MARKETS[l.sym].address.toLowerCase(); return { ...l, amount: l.amount - (gave[a] || 0n) + (got[a] || 0n) }; });
  return { ok: true, qr, tx, held, now, usdgIn, usdgOut, fee, gross, left, got, gave, gas: BigInt(rc.gasUsed), logs: rc.logs, buyLogs: b1.logs };
}

// 1. two stocks bought 75/25, rebalanced to 50/50
{
  const r = await run(["AAPL", "NVDA"], [7500, 2500], [5000, 5000], "200");
  if (!r.ok) check(false, "AAPL/NVDA 75/25 -> 50/50: " + r.err);
  else {
    const q2 = await quoteRebalance(c, { legs: r.now, minDriftBps: 1 }).catch(e => e);
    const shares = q2 instanceof Error ? null : q2.legs.map(l => l.now / 100);
    check(r.qr.sells.length === 1 && r.qr.sells[0].sym === "AAPL" && r.qr.buys[0].sym === "NVDA", "75/25 -> 50/50: sells AAPL, buys NVDA");
    check(r.fee === portion(r.gross, r.qr.bips) && r.usdgOut === r.qr.minNet && r.usdgIn >= r.usdgOut && Object.values(r.left).every(v => v === 0n),
      `fee ${formatUnits(r.fee, 6)} USDG = 0.15% of the ${formatUnits(r.gross, 6)} the sale brought in; the wallet got ${formatUnits(r.usdgIn, 6)} and paid ${formatUnits(r.usdgOut, 6)} back for the buy (kept ${formatUnits(r.usdgIn - r.usdgOut, 6)}); router keeps nothing; gas ${r.gas}`);
    check(shares && shares.every(s => Math.abs(s - 50) < 1), "after: " + (shares ? shares.map(s => s.toFixed(2) + "%").join(" / ") : String(q2?.message)) + " (target 50 / 50, within 1 point)");
    const es = rebalanceEntries(receiptTransfers({ logs: r.logs }), acct.address, { hash: "0xreb", ts: 2 });
    check(es && es.length === 2 && es[0].side === "sell" && es[0].sym === "AAPL" && es[1].side === "buy" && es[1].sym === "NVDA" && Math.abs(es[0].usdg - Number(formatUnits(r.usdgIn, 6))) < 1e-6 && Math.abs(es[1].usdg - Number(formatUnits(r.usdgOut, 6))) < 1e-6,
      "the journal reads it as a sell of AAPL (USDG received) and a buy of NVDA (USDG paid)");
    const me2 = multiEntries(receiptTransfers({ logs: r.logs }), acct.address, { hash: "0xreb" });
    check(me2?.length === 2 && me2.some(e => e.side === "sell") && me2.some(e => e.side === "buy"), "multiEntries (backfill, Arena) reads it the same way");
    const bes = basketEntries(receiptTransfers({ logs: r.buyLogs }), acct.address, { hash: "0xbuy", ts: 1 });
    const pos = basketPositions([...bes, ...es], { "0xreb": "0xbuy" })[0];
    const nv = pos?.legs.find(l => l.sym === "NVDA"), ap = pos?.legs.find(l => l.sym === "AAPL");
    check(pos && pos.rebalances === 1 && pos.sales === 0 && Math.abs(ap.qty - Number(formatUnits(r.now[0].amount, 18))) < 1e-9 && Math.abs(nv.qty - Number(formatUnits(r.now[1].amount, 18))) < 1e-9 && ap.cost / (ap.cost + nv.cost) > 0.74,
      "the basket position follows: AAPL and NVDA quantities match the wallet, one rebalance, cost shares (the targets) unchanged");
  }
}

// 2. four stocks bought 40/30/20/10, rebalanced to equal: two sells, two buys
{
  const syms = ["MSFT", "TSLA", "AMZN", "META"];
  const r = await run(syms, [4000, 3000, 2000, 1000], [2500, 2500, 2500, 2500], "400");
  if (!r.ok) check(false, "4 stocks 40/30/20/10 -> equal: " + r.err);
  else {
    const q2 = await quoteRebalance(c, { legs: r.now, minDriftBps: 1 }).catch(e => e);
    const shares = q2 instanceof Error ? null : q2.legs.map(l => l.now / 100);
    check(r.qr.sells.length === 2 && r.qr.buys.length === 2 && r.fee === portion(r.gross, r.qr.bips) && Object.values(r.left).every(v => v === 0n) && r.usdgIn >= r.usdgOut,
      `40/30/20/10 -> 25 each: sells ${r.qr.sells.map(s => s.sym).join(", ")}, buys ${r.qr.buys.map(s => s.sym).join(", ")}; fee once ${formatUnits(r.fee, 6)}; router keeps nothing; gas ${r.gas}`);
    check(shares && shares.every(s => Math.abs(s - 25) < 1), "after: " + (shares ? shares.map(s => s.toFixed(2) + "%").join(" / ") : String(q2?.message)));
    const es = rebalanceEntries(receiptTransfers({ logs: r.logs }), acct.address, { hash: "0xr2", ts: 2 });
    check(es?.length === 4 && es.filter(e => e.side === "sell").length === 2 && Math.abs(es.filter(e => e.side === "sell").reduce((a, e) => a + e.usdg, 0) - Number(formatUnits(r.usdgIn, 6))) < 1e-6,
      "the journal splits the swept USDG over the two sold stocks and books two buys");
  }
}

// 3. a buy floor that cannot be met reverts everything
{
  const r = await run(["AAPL", "NVDA"], [7000, 3000], [5000, 5000], "100", { inflate: "NVDA" });
  check(!r.ok, "a buy quoted 3% above what its pool pays makes the whole rebalance revert (" + (r.err || "").slice(0, 60) + ")");
}

// 4. rules
const fails = async f => { try { await f(); return false; } catch (e) { return e.message; } };
const one = parseUnits("1", 18);
const near = await fails(() => quoteRebalance(c, { legs: [{ sym: "AAPL", w: 5000, amount: one }, { sym: "AAPL", w: 5000, amount: one }] }));
check(/twice/.test(near), "the same stock twice is refused");
check(/stock tokens only/.test(await fails(() => quoteRebalance(c, { legs: [{ sym: "ETH", w: 5000, amount: one }, { sym: "AAPL", w: 5000, amount: one }] }))), "ETH or memecoins are refused");
check(/100%/.test(await fails(() => quoteRebalance(c, { legs: [{ sym: "NVDA", w: 5000, amount: one }, { sym: "AAPL", w: 4000, amount: one }] }))), "targets must add up to 100%");
check(/nothing to rebalance/.test(await fails(() => quoteRebalance(c, { legs: [{ sym: "NVDA", w: 5000, amount: 0n }, { sym: "AAPL", w: 5000, amount: 0n }] }))), "an empty basket is refused");
const vq = await quoteRebalance(c, { legs: [{ sym: "NVDA", w: 5000, amount: one }, { sym: "AAPL", w: 5000, amount: one }] }).catch(e => e);
const ok2 = !(vq instanceof Error) || /within/.test(vq.message);
check(ok2, "a basket 1 NVDA + 1 AAPL quotes a rebalance or says it is within the band" + (vq instanceof Error ? " (" + vq.message + ")" : ` (sell ${vq.sells.map(s => s.sym)}, buy ${vq.buys.map(s => s.sym)})`));

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
