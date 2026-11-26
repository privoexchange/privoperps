// Basket sales (several stock tokens sold for USDG in one router call, one PermitBatch signature) against Robinhood Chain
// mainnet state, without sending anything. A throwaway key buys a basket with faked USDG, approves each stock token to
// Permit2, then sells the basket, all in one eth_simulateV1 block with transfer tracing. The test reads where every token
// went: the PRIVO fee to the fee Safe, the rest of the USDG to the trader above the floor, nothing left in the router,
// and the journal reads the sale as one sell per stock.
//   node test/sim/basket-sell-test.mjs
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, pad, toHex, parseUnits, formatUnits } from "viem";
import { basketSellEntries, receiptTransfers, multiEntries } from "../../src/privo-journal.js";
import { CONFIG, ADDR, USDG, MARKETS, makeClient, quoteBasket, buildBasket, quoteBasketSell, buildBasketSell, permitTypedData, permitBatchTypedData, portion, BASKET_MAX } from "../../src/privo-swap.js";

const c = makeClient(["https://robinhood-rpc.publicnode.com"]);
const acct = privateKeyToAccount(generatePrivateKey());
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
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
let usdgSlots = null;
async function overrides(amount) {
  usdgSlots ||= [await findSlot(USDG.address, encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [acct.address] }), 7n),
    await findSlot(USDG.address, encodeFunctionData({ abi: erc, functionName: "allowance", args: [acct.address, ADDR.PERMIT2] }), 7n)];
  const [bal, alw] = usdgSlots;
  return { [bal.holder]: { stateDiff: { [bal.slot]: pad(toHex(amount)), [alw.slot]: pad(toHex((1n << 256n) - 1n)) } }, [acct.address]: { balance: toHex(10n ** 17n) } };
}
const equal = syms => syms.map((sym, i) => ({ sym, w: i === syms.length - 1 ? 10000 - Math.floor(10000 / syms.length) * (syms.length - 1) : Math.floor(10000 / syms.length) }));
const call = (to, data) => ({ from: acct.address, to, data, gas: toHex(6_000_000n) });
const transfers = logs => logs.filter(l => l.topics[0] === TRANSFER).map(l => ({ tok: l.address.toLowerCase(), from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), v: BigInt(l.data) }));

// Buys a basket, then sells share/1 of each leg (or what sellLegs() returns), in one simulated block.
async function buyThenSell(syms, human, { share = 1n, slip = 50, inflate = null } = {}) {
  const amount = parseUnits(human, 6);
  const qb = await quoteBasket(c, { legs: equal(syms), amount });
  const td = permitTypedData({ token: USDG.address, amount, nonce: 0 });
  const buy = buildBasket(qb, { slippageBps: 100, permit: { message: td.message, signature: await acct.signTypedData(td) } });
  const ov = Object.fromEntries(Object.entries(await overrides(amount)));
  // first pass: the buy alone, to learn what the trader got
  const r1 = await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides: ov, calls: [call(buy.to, buy.data)] }], traceTransfers: true, validation: false }, "latest"] });
  if (r1[0].calls[0].status !== "0x1") return { ok: false, err: "buy: " + (r1[0].calls[0].error?.message || "reverted") };
  const me = acct.address.toLowerCase(), got = {};
  for (const t of transfers(r1[0].calls[0].logs)) if (t.to === me) got[t.tok] = (got[t.tok] || 0n) + t.v;
  const legs = syms.map(sym => ({ sym, amount: (got[MARKETS[sym].address.toLowerCase()] || 0n) / share }));
  const qs = await quoteBasketSell(c, { legs });
  if (inflate) qs.legs = qs.legs.map(l => l.sym === inflate ? { ...l, grossOut: l.grossOut * 10200n / 10000n } : l);
  const bt = permitBatchTypedData({ items: qs.legs.map(l => ({ token: MARKETS[l.sym].address, amount: l.amount, nonce: 0 })) });
  const sell = buildBasketSell(qs, { slippageBps: slip, permit: { message: bt.message, signature: await acct.signTypedData(bt) } });
  const approvals = syms.map(s => call(MARKETS[s].address, encodeFunctionData({ abi: erc, functionName: "approve", args: [ADDR.PERMIT2, (1n << 256n) - 1n] })));
  const r = await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides: ov, calls: [call(buy.to, buy.data), ...approvals, call(sell.to, sell.data)] }], traceTransfers: true, validation: false }, "latest"] });
  const sc = r[0].calls.at(-1);
  if (sc.status !== "0x1") return { ok: false, qs, sell, err: sc.error?.message || "reverted" };
  const router = ADDR.ROUTER.toLowerCase(), usdg = USDG.address.toLowerCase(), fw = CONFIG.FEE_WALLET.toLowerCase();
  let net = 0n, fee = 0n, gross = 0n; const left = {}, sold = {};
  for (const t of transfers(sc.logs)) {
    if (t.tok === usdg && t.to === me) net += t.v;
    if (t.tok === usdg && t.to === fw) fee += t.v;
    if (t.tok === usdg && t.to === router && t.from !== me) gross += t.v;
    if (t.from === me && t.tok !== usdg) sold[t.tok] = (sold[t.tok] || 0n) + t.v;
    if (t.to === router) left[t.tok] = (left[t.tok] || 0n) + t.v;
    if (t.from === router) left[t.tok] = (left[t.tok] || 0n) - t.v;
  }
  return { ok: true, qs, sell, net, fee, gross, left, sold, gas: BigInt(sc.gasUsed), logs: sc.logs };
}

// 1. every stock market, in baskets of 8: buy, then sell everything that was bought
const stocks = Object.keys(MARKETS).filter(s => MARKETS[s].kind === "stock");
for (let i = 0; i < stocks.length; i += BASKET_MAX) {
  const syms = stocks.slice(i, i + BASKET_MAX);
  if (syms.length < 2) syms.unshift(stocks[0]);
  const r = await buyThenSell(syms, String(40 * syms.length));
  if (!r.ok) { check(false, `sell ${syms.join(",")}: ${r.err}`); continue; }
  const allSold = r.qs.legs.every(l => r.sold[MARKETS[l.sym].address.toLowerCase()] === l.amount);
  const routerClean = Object.values(r.left).every(v => v === 0n);
  check(allSold && r.net >= r.sell.minOut && r.fee === portion(r.gross, r.qs.bips) && r.net + r.fee === r.gross && routerClean,
    `${syms.join(", ")}: every leg sold exactly; ${formatUnits(r.net, 6)} USDG to the trader (floor ${formatUnits(r.sell.minOut, 6)}); fee ${formatUnits(r.fee, 6)} to the Safe; router keeps nothing; gas ${r.gas}`);
}

// 2. half a basket, and the journal reads the sale as one sell per stock
const half = await buyThenSell(["TSLA", "NVDA", "AAPL", "ORCL"], "200", { share: 2n });
const es = half.ok && basketSellEntries(receiptTransfers({ logs: half.logs }), acct.address, { hash: "0xbeef", ts: 1 });
check(half.ok && es && es.length === 4 && es.every(e => e.side === "sell" && e.qty > 0) && Math.abs(es.reduce((a, e) => a + e.usdg, 0) - Number(formatUnits(half.net, 6))) < 1e-9,
  "selling half: four sells whose USDG adds up to what the trader received" + (half.ok ? "" : " (" + half.err + ")"));
check(half.ok && multiEntries(receiptTransfers({ logs: half.logs }), acct.address, { hash: "0xbeef" })?.length === 4, "the backfill and Arena path (multiEntries) reads it the same way");

// 3. the floor bites on a single leg
const inf = await buyThenSell(["AAPL", "MSFT", "ORCL"], "120", { inflate: "MSFT" });
check(!inf.ok, "a leg quoted 2% above what its pool pays makes the whole sale revert (" + (inf.err || "").slice(0, 60) + ")");

// 4. input rules
const fails = async f => { try { await f(); return false; } catch { return true; } };
check(await fails(() => quoteBasketSell(c, { legs: [{ sym: "TSLA", amount: 10n ** 15n }] })) && await fails(() => quoteBasketSell(c, { legs: [{ sym: "TSLA", amount: 1n }, { sym: "TSLA", amount: 1n }] }))
  && await fails(() => quoteBasketSell(c, { legs: [{ sym: "ETH", amount: 1n }, { sym: "TSLA", amount: 1n }] })) && await fails(() => quoteBasketSell(c, { legs: [{ sym: "NVDA", amount: 0n }, { sym: "TSLA", amount: 1n }] })),
  "a sale needs 2 or more different stock tokens, each with an amount");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
