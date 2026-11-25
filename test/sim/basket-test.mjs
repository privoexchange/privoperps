// Basket buys (one USDG amount spread over several stock tokens, one router call) against Robinhood Chain mainnet state,
// without sending anything. A throwaway key signs the Permit2 message; its USDG balance and approval to Permit2 are faked
// with state overrides; router.execute runs in eth_simulateV1 with transfer tracing, so the test reads exactly where every
// token went: the PRIVO fee to the fee Safe, each stock token to the trader at or above its floor, nothing left in the router.
//   node test/sim/basket-test.mjs
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, pad, toHex, parseUnits, formatUnits } from "viem";
import { basketEntries, receiptTransfers } from "../../src/privo-journal.js";
import { CONFIG, ADDR, USDG, MARKETS, makeClient, quoteBasket, splitBasket, buildBasket, approvalState, permitTypedData, routeLabel, BASKET_MAX } from "../../src/privo-swap.js";

const c = makeClient(["https://robinhood-rpc.publicnode.com"]); // quotes, access lists and eth_simulateV1
const acct = privateKeyToAccount(generatePrivateKey());
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };

async function findSlot(token, data, want) {
  const al = await c.request({ method: "eth_createAccessList", params: [{ to: token, data }, "latest"] });
  for (const e of al.accessList) for (const k of e.storageKeys) {
    let r; try { r = await c.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [e.address]: { stateDiff: { [k]: pad(toHex(want)) } } }] }); } catch { continue; }
    if (r && r !== "0x" && BigInt(r) === want) return { holder: e.address, slot: k };
  }
  throw new Error("slot not found on " + token);
}
let ov0 = null;
async function overrides(amount) {
  const bal = await findSlot(USDG.address, encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [acct.address] }), 7n);
  const alw = await findSlot(USDG.address, encodeFunctionData({ abi: erc, functionName: "allowance", args: [acct.address, ADDR.PERMIT2] }), 7n);
  const sd = { [bal.slot]: pad(toHex(amount)), [alw.slot]: pad(toHex((1n << 256n) - 1n)) };
  return [{ address: bal.holder, stateDiff: sd }, { address: acct.address, balance: toHex(10n ** 17n) }];
}
const equal = syms => syms.map((sym, i) => ({ sym, w: i === syms.length - 1 ? 10000 - Math.floor(10000 / syms.length) * (syms.length - 1) : Math.floor(10000 / syms.length) }));

async function run(syms, human, { slip = 30, inflate = null } = {}) {
  const amount = parseUnits(human, 6);
  const qb = await quoteBasket(c, { legs: equal(syms), amount });
  if (inflate) qb.legs = qb.legs.map(l => l.sym === inflate ? { ...l, grossOut: l.grossOut * 10200n / 10000n } : l);
  const st = await approvalState(c, acct.address, USDG.address, amount);
  const td = permitTypedData({ token: USDG.address, amount, nonce: st.nonce });
  const tx = buildBasket(qb, { slippageBps: slip, permit: { message: td.message, signature: await acct.signTypedData(td) } });
  ov0 ||= await overrides(amount);
  const ov = ov0.map(o => o.stateDiff ? { ...o, stateDiff: { ...o.stateDiff, [Object.keys(o.stateDiff)[0]]: pad(toHex(amount)) } } : o);
  const r = await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides: Object.fromEntries(ov.map(({ address, ...x }) => [address, x])), calls: [{ from: acct.address, to: tx.to, data: tx.data, gas: toHex(6_000_000n) }] }], traceTransfers: true, validation: false }, "latest"] });
  const call = r[0].calls[0];
  if (call.status !== "0x1") return { ok: false, qb, tx, err: call.error?.message || "reverted" };
  const got = {}, me = acct.address.toLowerCase(), router = ADDR.ROUTER.toLowerCase();
  let fee = 0n, routerIn = 0n, routerOut = 0n;
  for (const l of call.logs) {
    if (l.topics[0] !== TRANSFER) continue;
    const tok = l.address.toLowerCase(), from = "0x" + l.topics[1].slice(26), to = "0x" + l.topics[2].slice(26), v = BigInt(l.data);
    if (tok === USDG.address.toLowerCase() && to === CONFIG.FEE_WALLET.toLowerCase()) fee += v;
    if (to === me) got[tok] = (got[tok] || 0n) + v;
    if (tok === USDG.address.toLowerCase()) { if (to === router) routerIn += v; if (from === router) routerOut += v; }
  }
  return { ok: true, qb, tx, got, fee, gas: BigInt(call.gasUsed), routerLeft: routerIn - routerOut, logs: call.logs };
}

// 1. splitting rules
check(splitBasket(equal(["TSLA", "NVDA", "AAPL"]), 100_000000n).legs.reduce((a, l) => a + l.swapIn, 0n) + splitBasket(equal(["TSLA", "NVDA", "AAPL"]), 100_000000n).fee === 100_000000n, "fee plus legs is exactly the amount (the last leg takes the rounding)");
const bad1 = f => { try { f(); return false; } catch { return true; } };
check(bad1(() => splitBasket([{ sym: "ETH", w: 5000 }, { sym: "TSLA", w: 5000 }], 10n ** 8n)) && bad1(() => splitBasket([{ sym: "TSLA", w: 5000 }, { sym: "TSLA", w: 5000 }], 10n ** 8n)), "crypto legs and duplicates are refused");
check(bad1(() => splitBasket([{ sym: "TSLA", w: 5000 }, { sym: "NVDA", w: 4000 }], 10n ** 8n)) && bad1(() => splitBasket(equal(Object.keys(MARKETS).filter(s => MARKETS[s].kind === "stock").slice(0, BASKET_MAX + 1)), 10n ** 9n)), "shares must add up to 100%, and at most " + BASKET_MAX + " stocks");

// 2. every stock market, in baskets of 8, 40 USDG per leg
const stocks = Object.keys(MARKETS).filter(s => MARKETS[s].kind === "stock");
for (let i = 0; i < stocks.length; i += BASKET_MAX) {
  const syms = stocks.slice(i, i + BASKET_MAX);
  if (syms.length < 2) syms.unshift(stocks[0]);
  const r = await run(syms, String(40 * syms.length));
  if (!r.ok) { check(false, `basket ${syms.join(",")}: ${r.err}`); continue; }
  const legsOk = r.qb.legs.every((l, k) => (r.got[MARKETS[l.sym].address.toLowerCase()] || 0n) >= r.tx.mins[k]);
  check(legsOk && r.fee === r.qb.fee && r.routerLeft === 0n,
    `${syms.join(", ")}: each token reached the trader above its floor; fee ${formatUnits(r.fee, 6)} USDG to the Safe; router keeps nothing; gas ${r.gas}`);
  for (const l of r.qb.legs) if (l.pool.v === 4 || l.pool.via) console.log(`        ${l.sym} via v${l.pool.v} ${routeLabel(l.pool)}`);
}

// 2b. the journal and Arena read a basket transaction as one buy per stock, sharing the fee
const jr = await run(["TSLA", "NVDA", "ORCL"], "90");
const es = jr.ok && basketEntries(receiptTransfers({ logs: jr.logs }), acct.address, { hash: "0xbeef", ts: 1 });
check(es && es.length === 3 && es.map(e => e.sym).join() === "TSLA,NVDA,ORCL" && es.every(e => e.side === "buy" && e.qty > 0) && Math.abs(es.reduce((a, e) => a + e.usdg, 0) - 90) < 1e-9,
  "a basket receipt becomes one buy per stock, and their USDG (fee included) adds up to the 90 USDG spent");
check(!basketEntries(receiptTransfers({ logs: jr.logs.filter(l => l.address.toLowerCase() !== MARKETS.NVDA.address.toLowerCase() && l.address.toLowerCase() !== MARKETS.ORCL.address.toLowerCase()) }), acct.address, { hash: "0x1" }), "a transaction with one market is not read as a basket");

// 3. uneven shares, and the floor must bite on a single leg
const un = await run(["NVDA", "TSLA"], "100");
const unQ = await quoteBasket(c, { legs: [{ sym: "NVDA", w: 7000 }, { sym: "TSLA", w: 3000 }], amount: 100_000000n });
check(unQ.legs[0].swapIn === 69_895000n && unQ.legs[1].swapIn === 29_955000n && un.ok, "70/30 splits 99.85 USDG after the fee into 69.895 and 29.955");
const inf = await run(["AAPL", "MSFT", "ORCL"], "120", { inflate: "ORCL" });
check(!inf.ok, "a leg quoted 2% above what its pool pays makes the whole basket revert (" + (inf.err || "").slice(0, 60) + ")");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
