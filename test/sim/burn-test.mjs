// $PRIVO buyback & burn from the fee Safe, simulated on Robinhood Chain mainnet state without sending anything.
// A copy of the fee Safe's proxy is placed at an unused address (state override) with three throwaway owners
// (2 of 3), some USDG and some $PRIVO. Two owners sign the batch built by privo-burn.js and eth_simulateV1 runs
// execTransaction, so the logs show where every token went.
//   node test/sim/burn-test.mjs
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, encodeAbiParameters, pad, toHex, parseUnits, formatUnits, encodeFunctionData, parseAbi, getAddress } from "viem";
import { makeClient, USDG, ADDR, MARKETS } from "../../src/privo-swap.js";
import { DEAD, MULTISEND, PRIVO, planBurn, burnTx, burnCalls, decodeBatch, matchesBurn, paramsToJson, paramsFromJson } from "../../src/privo-burn.js";
import { safeTxTypedData, encodePackage, decodePackage, checkSignatures, packSignatures, execCall } from "./safe-tx.js";

const RPC = "https://robinhood-rpc.publicnode.com";
const c = makeClient([RPC]);
const REAL_SAFE = "0xCc051cf47547386bA147FDDfcBCFE00E791C1418"; // only its proxy bytecode is copied
const SINGLETON = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const FAKE = "0x5afe00000000000000000000000000000000b0e1";
const SENTINEL = "0x0000000000000000000000000000000000000001";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const accts = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey())).sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
let bad = 0;
const check = (cond, msg) => { console.log((cond ? "  ok    " : "  FAIL  ") + msg); if (!cond) bad++; };

// Safe storage: singleton, owners linked list, owner count 3, threshold 2, nonce 0.
const slotOf = (key, slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, BigInt(slot)]));
const word = v => pad(toHex(v));
const ring = [SENTINEL, ...accts.map(a => a.address), SENTINEL];
const safeState = { [pad("0x0")]: pad(SINGLETON), [pad("0x3")]: word(3n), [pad("0x4")]: word(2n), [pad("0x5")]: word(0n) };
for (let i = 0; i < 4; i++) safeState[slotOf(ring[i], 2)] = pad(ring[i + 1]);

// balanceOf slot of FAKE for a token, found through an access list and confirmed by overriding it.
async function balSlot(token) {
  const data = encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [FAKE] });
  const al = await c.request({ method: "eth_createAccessList", params: [{ to: token, data }, "latest"] });
  for (const e of al.accessList) for (const k of e.storageKeys) {
    try { const r = await c.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [e.address]: { stateDiff: { [k]: word(7n) } } }] }); if (BigInt(r) === 7n) return { a: e.address, k }; } catch {}
  }
  throw new Error("balance slot not found for " + token);
}
const USDG_IN = parseUnits("50", 6), PRIVO_HELD = parseUnits("1000", 18);
const [code, su, sp] = await Promise.all([c.getCode({ address: REAL_SAFE }), balSlot(USDG.address), balSlot(PRIVO)]);
const overrides = { [FAKE]: { code, stateDiff: safeState } };
const addDiff = (o, a, k, v) => { o[a] ??= {}; o[a].stateDiff = { ...(o[a].stateDiff || {}), [k]: v }; };
addDiff(overrides, su.a, su.k, word(USDG_IN));
addDiff(overrides, sp.a, sp.k, word(PRIVO_HELD));
for (const a of accts) overrides[a.address] = { balance: toHex(10n ** 17n) };
const ov = Object.entries(overrides).map(([address, v]) => ({ address, ...v }));
const toSim = o => Object.fromEntries(Object.entries(o).map(([a, v]) => [a, { ...(v.code ? { code: v.code } : {}), ...(v.balance ? { balance: v.balance } : {}), ...(v.stateDiff ? { stateDiff: v.stateDiff } : {}) }]));

// 1. Plan and build.
const plan = await planBurn(c, { usdgIn: USDG_IN, privoHeld: PRIVO_HELD, slippageBps: 200 });
check(plan.expected > 0n && plan.minOut === plan.expected * 9800n / 10000n, `quote: 50 USDG buys about ${Number(formatUnits(plan.expected, 18)).toFixed(0)} $PRIVO, minimum ${Number(formatUnits(plan.minOut, 18)).toFixed(0)} at 2% slippage`);
const tx = burnTx(plan);
const calls = decodeBatch(tx);
check(tx.to === MULTISEND && tx.operation === 1 && calls.length === 3 && calls.every(x => x.op === 0), "one MultiSendCallOnly batch of three plain calls");
check(calls[0].to === getAddress(USDG.address) && calls[1].to === getAddress(ADDR.ROUTER) && calls[2].to === getAddress(PRIVO), "USDG to the router, the router's swap, then held $PRIVO to the burn address");
check(JSON.stringify(burnCalls(plan).map(x => x.data)) === JSON.stringify(calls.map(x => x.data)), "decoding the batch gives back the same calls");

// 2. The code passed between owners rebuilds to the same bytes; a changed parameter does not.
const p2 = paramsFromJson(JSON.parse(JSON.stringify(paramsToJson(plan))));
check(matchesBurn(tx, p2), "parameters carried in the code rebuild the exact signed batch");
check(!matchesBurn(tx, { ...p2, minOut: p2.minOut - 1n }) && !matchesBurn(tx, { ...p2, usdgIn: p2.usdgIn + 1n }), "a batch whose bytes differ from its parameters is refused");
const pkg0 = { safe: FAKE, nonce: 0n, tx, sigs: [], meta: paramsToJson(plan) };
const round = decodePackage(encodePackage(pkg0));
check(round.meta?.kind === "privo-burn" && round.tx.data === tx.data && round.tx.operation === 1, "signature code carries the batch and its parameters");

// 3. Two owners sign; owner B sends. Simulate and follow the tokens.
const td = safeTxTypedData(FAKE, tx, 0n);
const pkg = { ...pkg0, sigs: [{ signer: accts[0].address, sig: await accts[0].signTypedData(td) }, { signer: accts[2].address, sig: await accts[2].signTypedData(td) }] };
const { valid } = await checkSignatures(pkg, accts.map(a => a.address));
const ex = execCall(pkg, packSignatures(valid, null));
const bal = (t, w) => ({ to: t, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [w] }) });
async function simulate(execData) {
  const r = await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides: toSim(overrides), calls: [
    { from: accts[1].address, to: FAKE, data: execData, gas: toHex(3_000_000n) },
    bal(USDG.address, FAKE), bal(PRIVO, FAKE), bal(USDG.address, ADDR.ROUTER), bal(PRIVO, ADDR.ROUTER),
  ] }] }, "latest"] });
  return r[0].calls;
}
const out = await simulate(ex.data);
const logs = out[0].logs || [];
const tr = logs.filter(l => l.topics[0] === TRANSFER).map(l => ({ token: getAddress(l.address), from: getAddress("0x" + l.topics[1].slice(26)), to: getAddress("0x" + l.topics[2].slice(26)), amount: BigInt(l.data) }));
const burned = tr.filter(t => t.token === getAddress(PRIVO) && t.to === getAddress(DEAD)).reduce((s, t) => s + t.amount, 0n);
const toSafe = tr.filter(t => t.token === getAddress(PRIVO) && t.to === getAddress(FAKE));
check(out[0].status === "0x1" && BigInt(out[0].returnData) === 1n, `execTransaction succeeds (gas ${BigInt(out[0].gasUsed)})`);
check(burned >= PRIVO_HELD + plan.minOut, `burn address received ${Number(formatUnits(burned, 18)).toFixed(0)} $PRIVO (held 1000 + bought at least the minimum)`);
check(toSafe.length === 0, "no $PRIVO comes back to the Safe");
check(BigInt(out[1].returnData) === 0n && BigInt(out[2].returnData) === 0n, "the Safe ends with no USDG and no $PRIVO");
check(BigInt(out[4].returnData) === 0n, "nothing is left in the router ($PRIVO)");
check(!tr.some(t => t.token === getAddress(USDG.address) && t.to !== getAddress(ADDR.ROUTER) && t.from === getAddress(FAKE)), "the Safe's USDG goes only to the router");

// 4. A minimum above what the pool pays makes the whole batch fail: nothing moves.
const greedy = { ...plan, minOut: plan.expected * 12n / 10n };
const gtx = burnTx(greedy), gtd = safeTxTypedData(FAKE, gtx, 0n);
const gpkg = { safe: FAKE, nonce: 0n, tx: gtx, sigs: [{ signer: accts[0].address, sig: await accts[0].signTypedData(gtd) }, { signer: accts[2].address, sig: await accts[2].signTypedData(gtd) }] };
const gv = (await checkSignatures(gpkg, accts.map(a => a.address))).valid;
const gout = await simulate(execCall(gpkg, packSignatures(gv, null)).data);
check(gout[0].status !== "0x1" || BigInt(gout[0].returnData || "0x0") === 0n, "a minimum 20% above the quote reverts the batch");
check(BigInt(gout[1].returnData) === USDG_IN && BigInt(gout[2].returnData) === PRIVO_HELD, "after a failed batch the Safe still holds everything");

// 5. Only $PRIVO held, no USDG: one transfer to the burn address.
const only = await planBurn(c, { usdgIn: 0n, privoHeld: PRIVO_HELD });
const oc = decodeBatch(burnTx(only));
check(oc.length === 1 && oc[0].to === getAddress(PRIVO), "with no USDG the batch is a single $PRIVO transfer to the burn address");
let threw = false; try { await planBurn(c, {}); } catch { threw = true; }
check(threw, "nothing to burn is refused");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
