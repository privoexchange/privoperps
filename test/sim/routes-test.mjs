// Every route, compared: each route a quote finds (listed pools and the standard Uniswap routes added by routesOf) is
// forced in turn, built with buildSwap and run as eth_call from a throwaway wallet on mainnet state (balance and Permit2
// approval faked with state overrides). A pass means every route the ticket can pick fills, pays the PRIVO fee and keeps
// its minimum; a quote raised above what the route pays must revert. Nothing is sent.
//   node tools/sim/routes-test.mjs
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, pad, toHex, parseUnits } from "viem";
import { ADDR, USDG, MARKETS, decimalsOf, isNative, routeLabel, venueLabel, routesOf, makeClient, addToken, quote, approvalState, permitTypedData, buildSwap } from "../../src/privo-swap.js";

const c = makeClient(["https://robinhood-rpc.publicnode.com"]);
const acct = privateKeyToAccount(generatePrivateKey());
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };

const slots = {};
async function findSlot(token, data, want) {
  const al = await c.request({ method: "eth_createAccessList", params: [{ to: token, data }, "latest"] });
  for (const e of al.accessList) for (const k of e.storageKeys) {
    let r; try { r = await c.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [e.address]: { stateDiff: { [k]: pad(toHex(want)) } } }] }); } catch { continue; }
    if (r && r !== "0x" && BigInt(r) === want) return { holder: e.address, slot: k };
  }
  throw new Error("slot not found on " + token);
}
async function overrides(token, amount) {
  slots[token] ||= await Promise.all([
    findSlot(token, encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [acct.address] }), 7n),
    findSlot(token, encodeFunctionData({ abi: erc, functionName: "allowance", args: [acct.address, ADDR.PERMIT2] }), 7n)]);
  const [bal, alw] = slots[token], max = pad(toHex((1n << 256n) - 1n));
  const ov = bal.holder === alw.holder ? { [bal.holder]: { stateDiff: { [bal.slot]: pad(toHex(amount)), [alw.slot]: max } } }
    : { [bal.holder]: { stateDiff: { [bal.slot]: pad(toHex(amount)) } }, [alw.holder]: { stateDiff: { [alw.slot]: max } } };
  ov[acct.address] = { balance: toHex(10n ** 17n) };
  return ov;
}
async function execute(q, { slip = 50 } = {}) {
  const token = q.side === "buy" ? USDG.address : MARKETS[q.sym].address;
  let tx, ov;
  if (q.side === "sell" && isNative(q.sym)) { tx = buildSwap(q, { slippageBps: slip }); ov = { [acct.address]: { balance: toHex(q.amount + 10n ** 17n) } }; }
  else {
    const st = await approvalState(c, acct.address, token, q.amount);
    const td = permitTypedData({ token, amount: q.amount, nonce: st.nonce });
    tx = buildSwap(q, { slippageBps: slip, permit: { message: td.message, signature: await acct.signTypedData(td) } });
    ov = await overrides(token, q.amount);
  }
  try { await c.request({ method: "eth_call", params: [{ from: acct.address, to: tx.to, data: tx.data, value: toHex(tx.value), gas: toHex(3_000_000n) }, "latest", ov] }); return "ok"; }
  catch (e) { return "revert " + (e.details || e.shortMessage || e.message).slice(0, 70); }
}
// The quote with its route forced to r (as if r had paid most), fee and net recomputed like quote() does.
function forced(q, r) {
  const sellFee = q.side === "sell" ? r.out * q.bips / 10000n : q.fee;
  return { ...q, pool: r.pool, grossOut: r.out, fee: sellFee, netOut: q.side === "buy" ? r.out : r.out - sellFee };
}

const cases = [["TSLA", "buy", "200"], ["TSLA", "sell", "0.3"], ["NVDA", "buy", "200"], ["GLD", "sell", "0.5"], ["PONS", "buy", "30"], ["PONS", "sell", "200"],
  ["TEXEL", "buy", "30"], ["BTC", "buy", "200"], ["ETH", "buy", "200"], ["ETH", "sell", "0.05"], ["PRIVO", "buy", "10"]];
// Tokens pasted by contract address (not listed on PRIVO), registered the way the app does it: name, symbol and decimals
// read from the token. INDEX trades on Uniswap only; SCRPT has a Pons launch pool, found from its address alone.
const meta = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const pasted = {};
for (const a of ["0x56910d4409f3a0c78c64dd8d0545ff0705389870", "0x33e8a3e73bfeb324a40164730c3659827f2cd3e8"]) {
  const [name, symbol, decimals] = await Promise.all(["name", "symbol", "decimals"].map(fn => c.readContract({ address: a, abi: meta, functionName: fn })));
  pasted[a] = addToken({ address: a, symbol, name, decimals });
}
check(addToken({ address: MARKETS.HEY.address.toLowerCase(), symbol: "HEY", name: "x", decimals: 18 }) === "HEY", "pasting a listed token's address opens the listed market");
const [pIndex, pScrpt] = Object.values(pasted);
cases.push([pIndex, "buy", "10"], [pIndex, "sell", "1000"], [pScrpt, "buy", "10"], [pScrpt, "sell", "1000"]);
const shapes = new Set();
for (const [sym, side, human] of cases) {
  const q = await quote(c, { sym, side, amount: parseUnits(human, side === "buy" ? USDG.decimals : decimalsOf(sym)) });
  const ok = q.all.filter(r => r.out);
  check(q.checked === routesOf(sym).length && ok.length >= 1 && q.grossOut === ok.reduce((a, r) => (r.out > a ? r.out : a), 0n),
    `${side} ${human} ${sym}: ${q.checked} routes checked, ${ok.length} with a pool, the best one is used (${venueLabel(q.pool)} ${routeLabel(q.pool)})`);
  for (const r of ok) {
    if (r.out * 100n < q.grossOut) continue; // a route paying under 1% of the best is a dust pool; never picked
    const res = await execute(forced(q, r));
    shapes.add([r.pool.v, r.pool.hop || "", r.pool.via ? "via" : "", r.pool.auto ? "auto" : "listed"].join("/"));
    check(res === "ok", `  ${venueLabel(r.pool)} ${routeLabel(r.pool)}${r.pool.auto ? " (added)" : ""} fills: ${res}`);
  }
}
// The minimum must bite on an added route too: the quote raised 2% above what the route pays reverts.
const q = await quote(c, { sym: "TSLA", side: "buy", amount: parseUnits("200", 6) });
const auto = q.all.find(r => r.out && r.pool.auto && r.out * 100n >= q.grossOut);
if (auto) check((await execute(forced(q, { ...auto, out: auto.out * 10200n / 10000n }))).startsWith("revert"), "an added route quoted 2% too high reverts on the minimum");
check(shapes.has("3///auto") && shapes.has("3//via/auto") && shapes.has("4/ETH//auto"), "added v3, v3-through-WETH and v4-through-ETH routes were all executed: " + [...shapes].join(", "));
// The fee Safe buyback still quotes only $PRIVO's listed pool.
const qb = await quote(c, { sym: "PRIVO", side: "buy", amount: parseUnits("5", 6), fee: false, every: false });
check(qb.checked === MARKETS.PRIVO.pools.length && !qb.pool.auto, "every: false quotes only the listed pools (fee Safe buyback)");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
