// Tests contracts/PrivoOrders.sol against Robinhood Chain mainnet state (real USDG, stock tokens, Uniswap pools and the
// Universal Router), sending nothing. The Orders runtime code and an OrdersProbe (playing the filler) are placed by state
// override; the maker is a throwaway key that signs EIP-712 orders. Balances and allowances are faked by state override.
//   node test/orders/orders-test.mjs
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, decodeErrorResult, parseAbi, pad, toHex, parseUnits, formatUnits, keccak256, encodeAbiParameters, hashTypedData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { compile } from "../blockdesk/compile.mjs";
import { makeClient, MARKETS, USDG as USDG_T } from "../../src/privo-swap.js";
import { newOrder, orderTypedData, buildFill, slice, minOutForPrice, limitPrice, ORDERS_ABI, ORDERS } from "../../src/privo-orders.js";
import { predictedAddress } from "./deploy-core.js";
import fs from "node:fs";

const RPC = "https://robinhood-rpc.publicnode.com";
const c = createPublicClient({ transport: http(RPC, { timeout: 30000, retryCount: 2 }) });
const qc = makeClient([RPC]);
const out = compile({ "PrivoOrders.sol": "../../contracts/PrivoOrders.sol", "OrdersProbe.sol": "../orders/OrdersProbe.sol" });
const ord = out["PrivoOrders.sol"].PrivoOrders, probe = out["OrdersProbe.sol"].OrdersProbe;
const ORD = "0x0de0000000000000000000000000000000000b10", PROBE = "0x7a11ce0000000000000000000000000000000f11";
const USDG = USDG_T.address, TSLA = MARKETS.TSLA.address, NVDA = MARKETS.NVDA.address, ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
const FEE = "0xCc051cf47547386bA147FDDfcBCFE00E791C1418";
const maker = privateKeyToAccount(generatePrivateKey()), stranger = privateKeyToAccount(generatePrivateKey());
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
let bad = 0;
const check = (cond, msg) => { console.log((cond ? "  ok    " : "  FAIL  ") + msg); if (!cond) bad++; };
// Orders are dated from the chain head, not the wall clock, so the test holds on an RPC whose head lags or leads it.
const now = Number((await c.getBlock()).timestamp);
const mkOrder = x => newOrder({ start: now, ...x });

const slotCache = {};
async function slot(token, data) {
  const key = token + data; if (slotCache[key]) return slotCache[key];
  const al = await c.request({ method: "eth_createAccessList", params: [{ to: token, data }, "latest"] });
  for (const e of al.accessList) for (const k of e.storageKeys) {
    try { const r = await c.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [e.address]: { stateDiff: { [k]: pad(toHex(7n)) } } }] }); if (r !== "0x" && BigInt(r) === 7n) return (slotCache[key] = { a: e.address, k }); } catch {}
  }
  throw new Error("slot not found");
}
const balSlot = (t, who) => slot(t, encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [who] }));
const alwSlot = (t, who, sp) => slot(t, encodeFunctionData({ abi: erc, functionName: "allowance", args: [who, sp] }));

const sign = (o, who = maker) => who.signTypedData(orderTypedData(o, ORD));
const fillData = async (o, sig, i, opts) => (await buildFill(qc, o, sig, i, { contract: ORD, ...opts })).data;
const errName = r => { if (r === "OK" || r === "0x4f4b") return "OK"; try { return decodeErrorResult({ abi: ord.abi, data: r }).errorName; } catch { return "revert " + String(r).slice(0, 10); } };

// Runs fill calls from the probe (the filler) with the maker funded and approved; returns per-call results and deltas.
async function run({ o, calls, bal = null, allow = null, extraState = {}, from = PROBE }) {
  const ov = { [ORD]: { code: "0x" + ord.evm.deployedBytecode.object, stateDiff: extraState }, [PROBE]: { code: "0x" + probe.evm.deployedBytecode.object } };
  const put = (s, v) => { ov[s.a] = ov[s.a] || { stateDiff: {} }; ov[s.a].stateDiff = ov[s.a].stateDiff || {}; ov[s.a].stateDiff[s.k] = pad(toHex(v)); };
  put(await balSlot(o.tokenIn, maker.address), bal ?? o.amountIn);
  put(await alwSlot(o.tokenIn, maker.address, ORD), allow ?? o.amountIn);
  if (from !== PROBE) {
    try { await c.request({ method: "eth_call", params: [{ from, to: ORD, data: calls[0], gas: toHex(3_000_000n) }, "latest", ov] }); return { results: ["OK"] }; }
    catch (e) { return { results: [e.data || e.cause?.data || e.details || "0x"] }; }
  }
  const toks = [USDG, o.tokenIn === USDG ? o.tokenOut : o.tokenIn], accts = [maker.address, FEE, ORD, ROUTER];
  const data = encodeFunctionData({ abi: probe.abi, functionName: "run", args: [ORD, calls, toks, accts] });
  const r = await c.request({ method: "eth_call", params: [{ from: PROBE, to: PROBE, data, gas: toHex(8_000_000n) }, "latest", ov] });
  const [pre, post, results] = decodeFunctionResult({ abi: probe.abi, functionName: "run", data: r });
  const d = (ti, ai) => post[ti * 4 + ai] - pre[ti * 4 + ai];
  return { results, usdg: { maker: d(0, 0), fee: d(0, 1), ord: d(0, 2), router: d(0, 3) }, stock: { maker: d(1, 0), ord: d(1, 2), router: d(1, 3) } };
}
const u = v => formatUnits(v, 6), t = v => formatUnits(v, 18);

// Market price for TSLA from a small quote, to place limits around it.
const probeQ = await buildFill(qc, mkOrder({ maker: maker.address, filler: PROBE, sym: "TSLA", side: "buy", amountIn: parseUnits("100", 6), minAmountOut: 1n }), "0x", 0, { contract: ORD });
const tslaPx = 100 * 0.9985 / Number(formatUnits(probeQ.quote.grossOut, 18));
console.log(`  TSLA pool price ~ ${tslaPx.toFixed(2)} USDG`);

// 1. Limit buy: 100 USDG for TSLA, limit 2% above market (fills now).
let o = mkOrder({ maker: maker.address, filler: PROBE, sym: "TSLA", side: "buy", amountIn: parseUnits("100", 6), minAmountOut: minOutForPrice("buy", parseUnits("100", 6), tslaPx * 1.02) });
let sig = await sign(o);
let r = await run({ o, calls: [await fillData(o, sig, 0)] });
check(errName(r.results[0]) === "OK", "limit buy 100 USDG of TSLA fills when the pool is inside the limit");
check(r.usdg.maker === -parseUnits("100", 6) && r.usdg.fee === parseUnits("0.15", 6), `maker pays exactly 100 USDG, 0.15 USDG fee to the Safe (${u(r.usdg.maker)} / ${u(r.usdg.fee)})`);
check(r.stock.maker >= o.minAmountOut && r.stock.ord === 0n && r.usdg.ord === 0n && r.usdg.router === 0n, `maker gets ${t(r.stock.maker)} TSLA (>= limit); nothing stays in the contract or the router`);
check(Math.abs(limitPrice(o) - tslaPx * 1.02) / tslaPx < 0.001, "limitPrice() reads back the price the order was made with");

// 2. Limit buy above the market price does not fill: the pool would pay less than the limit.
o = mkOrder({ maker: maker.address, filler: PROBE, sym: "TSLA", side: "buy", amountIn: parseUnits("100", 6), minAmountOut: minOutForPrice("buy", parseUnits("100", 6), tslaPx * 0.95) });
sig = await sign(o);
const notYet = await buildFill(qc, o, sig, 0, { contract: ORD });
r = await run({ o, calls: [notYet.data] });
check(!notYet.fillable && errName(r.results[0]) !== "OK" && r.usdg.maker === 0n, "a buy limit 5% below market is not fillable yet; a fill attempt reverts and nothing moves");

// 3. Limit sell 1 NVDA for USDG, 2% below market: fee comes out of the USDG.
const nq = await buildFill(qc, mkOrder({ maker: maker.address, filler: PROBE, sym: "NVDA", side: "sell", amountIn: parseUnits("1", 18), minAmountOut: 1n }), "0x", 0, { contract: ORD });
const nvdaPx = Number(formatUnits(nq.quote.grossOut, 6));
o = mkOrder({ maker: maker.address, filler: PROBE, sym: "NVDA", side: "sell", amountIn: parseUnits("1", 18), minAmountOut: minOutForPrice("sell", parseUnits("1", 18), nvdaPx * 0.98) });
sig = await sign(o);
r = await run({ o, calls: [await fillData(o, sig, 0)] });
check(errName(r.results[0]) === "OK" && r.stock.maker === -parseUnits("1", 18), `limit sell 1 NVDA fills (pool ~ ${nvdaPx.toFixed(2)} USDG)`);
const gross = r.usdg.maker + r.usdg.fee;
check(r.usdg.maker >= o.minAmountOut && r.usdg.fee === gross * 15n / 10000n && r.usdg.ord === 0n, `maker gets ${u(r.usdg.maker)} USDG after a ${u(r.usdg.fee)} USDG fee (0.15%), nothing stays in the contract`);

// 4. TWAP: 3 slices of 100 USDG, 10 minutes apart.
o = mkOrder({ maker: maker.address, filler: PROBE, sym: "TSLA", side: "buy", amountIn: parseUnits("300", 6), minAmountOut: minOutForPrice("buy", parseUnits("300", 6), tslaPx * 1.03), slices: 3, interval: 600, start: now - 60 });
sig = await sign(o);
r = await run({ o, calls: [await fillData(o, sig, 0), await fillData(o, sig, 1)] });
check(errName(r.results[0]) === "OK" && errName(r.results[1]) === "TooEarly" && r.usdg.maker === -parseUnits("100", 6), "TWAP: slice 1 fills, slice 2 is refused before its time (TooEarly)");
o = { ...o, start: BigInt(now - 1300) }; sig = await sign(o);
r = await run({ o, calls: [await fillData(o, sig, 0), await fillData(o, sig, 1), await fillData(o, sig, 2), await fillData(o, sig, 2)] });
check(r.results.slice(0, 3).every(x => errName(x) === "OK") && errName(r.results[3]) === "OrderDone" && r.usdg.maker === -parseUnits("300", 6), "TWAP: all 3 due slices fill, a 4th is refused (OrderDone), 300 USDG spent in total");
check(r.usdg.fee === parseUnits("0.45", 6) && r.stock.maker >= o.minAmountOut, `TWAP fee 0.45 USDG over 3 slices, maker got ${t(r.stock.maker)} TSLA (>= limit)`);
const odd = mkOrder({ maker: maker.address, sym: "TSLA", side: "buy", amountIn: 100n, minAmountOut: 7n, slices: 3, interval: 60 });
check(slice(odd, 0).amountIn === 33n && slice(odd, 2).amountIn === 34n && slice(odd, 0).minOut + slice(odd, 1).minOut + slice(odd, 2).minOut >= 7n, "slices split the remainder into the last one; slice minimums round up");

// 5. Refusals.
o = mkOrder({ maker: maker.address, filler: PROBE, sym: "TSLA", side: "buy", amountIn: parseUnits("50", 6), minAmountOut: minOutForPrice("buy", parseUnits("50", 6), tslaPx * 1.02) });
sig = await sign(o);
const good = await fillData(o, sig, 0);
r = await run({ o, calls: [good], from: stranger.address });
check(errName(r.results[0]) === "NotFiller", "only the filler the maker named can fill (NotFiller)");
r = await run({ o, calls: [await fillData({ ...o, minAmountOut: 1n }, sig, 0)] });
check(errName(r.results[0]) === "BadSignature", "a filler cannot lower the signed limit (BadSignature)");
r = await run({ o, calls: [await fillData(o, await sign(o, stranger), 0)] });
check(errName(r.results[0]) === "BadSignature", "an order signed by someone other than the maker is refused");
const exp = { ...o, deadline: BigInt(now - 10), start: BigInt(now - 100) }, expSig = await sign(exp);
r = await run({ o: exp, calls: [await fillData(exp, expSig, 0)] });
check(errName(r.results[0]) === "Expired", "an expired order is refused");
const cancelSlot = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [o.nonce, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [maker.address, 1n]))]));
r = await run({ o, calls: [good], extraState: { [cancelSlot]: pad(toHex(1n)) } });
check(errName(r.results[0]) === "OrderCancelledError", "an order whose nonce the maker cancelled is refused");
r = await run({ o, calls: [encodeFunctionData({ abi: ORDERS_ABI, functionName: "fill", args: [o, sig, "0x", []] })] });
check(errName(r.results[0]) === "InputLeftInRouter" && r.usdg.maker === 0n, "a route that does not spend the slice is refused (InputLeftInRouter), nothing moves");
r = await run({ o, calls: [good], allow: parseUnits("10", 6) });
check(errName(r.results[0]) === "TransferFailed" && r.usdg.maker === 0n, "maker without enough approval: the fill reverts, nothing moves");
const anyone = { ...o, filler: "0x0000000000000000000000000000000000000000" }, anySig = await sign(anyone);
r = await run({ o: anyone, calls: [await fillData(anyone, anySig, 0)] });
check(errName(r.results[0]) === "OK", "an order with no named filler can be filled by anyone");

// 6. Uniswap v4 market (AAPL has only a v4 pool), and the contract's own limit check behind a loose route.
const aq = await buildFill(qc, mkOrder({ maker: maker.address, filler: PROBE, sym: "AAPL", side: "buy", amountIn: parseUnits("50", 6), minAmountOut: 1n }), "0x", 0, { contract: ORD });
const aaplPx = 50 * 0.9985 / Number(formatUnits(aq.quote.grossOut, 18));
o = mkOrder({ maker: maker.address, filler: PROBE, sym: "AAPL", side: "buy", amountIn: parseUnits("50", 6), minAmountOut: minOutForPrice("buy", parseUnits("50", 6), aaplPx * 1.02) });
sig = await sign(o);
r = await run({ o, calls: [await fillData(o, sig, 0)] });
check(errName(r.results[0]) === "OK" && r.stock.maker >= o.minAmountOut && r.usdg.fee === parseUnits("0.075", 6), `limit buy on a Uniswap v4 pool (AAPL ~ ${aaplPx.toFixed(2)}) fills, fee 0.075 USDG`);
o = mkOrder({ maker: maker.address, filler: PROBE, sym: "TSLA", side: "buy", amountIn: parseUnits("100", 6), minAmountOut: minOutForPrice("buy", parseUnits("100", 6), tslaPx * 0.99) });
sig = await sign(o);
const { fillRoute, quote: swapQuote } = await import("../../src/privo-swap.js");
const loose = fillRoute(await swapQuote(qc, { sym: "TSLA", side: "buy", amount: parseUnits("100", 6) }), { slippageBps: 500 });
r = await run({ o, calls: [encodeFunctionData({ abi: ORDERS_ABI, functionName: "fill", args: [o, sig, loose.commands, loose.inputs] })] });
check(errName(r.results[0]) === "BelowLimit" && r.usdg.maker === 0n, "a route with a loose minimum still cannot fill below the maker's limit (BelowLimit), nothing moves");

// 6. The contract's hash equals the EIP-712 hash a wallet signs.
const hc = await c.request({ method: "eth_call", params: [{ to: ORD, data: encodeFunctionData({ abi: ord.abi, functionName: "hashOrder", args: [o] }) }, "latest", { [ORD]: { code: "0x" + ord.evm.deployedBytecode.object } }] });
check(hc === hashTypedData(orderTypedData(o, ORD)), "hashOrder() equals the EIP-712 hash a wallet signs");

// 8. The address the app uses is the CREATE2 address of this exact build, and the artifact matches the source.
const art = JSON.parse(fs.readFileSync(new URL("../../contracts/out/PrivoOrders.json", import.meta.url), "utf8"));
check(art.deployedBytecode === "0x" + ord.evm.deployedBytecode.object, "contracts/out/PrivoOrders.json matches the source (run node test/orders/build.mjs after any change)");
check(predictedAddress(art.bytecode).toLowerCase() === ORDERS.toLowerCase(), `ORDERS in privo-orders.js is the CREATE2 address of this build (${ORDERS})`);

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
