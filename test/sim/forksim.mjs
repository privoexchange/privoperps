// Simulate PRIVO swaps through the Uniswap Universal Router on Robinhood Chain with eth_call + state overrides.
// No transaction is sent. A Probe contract is placed at a fake address, given balances, and acts as the trader.
import fs from "node:fs";
import solc from "solc";
import { createPublicClient, http, parseAbi, encodeAbiParameters, encodePacked, encodeFunctionData, decodeFunctionResult,
  keccak256, pad, toHex, formatUnits, parseUnits, concatHex } from "viem";

const RPC = process.env.RPC || "https://robinhood-rpc.publicnode.com";
const c = createPublicClient({ chain: { id: 4663, name: "rh", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC, { retryCount: 3, timeout: 60000 }) });

// compile
const src = fs.readFileSync(new URL("./Probe.sol", import.meta.url), "utf8");
const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources: { "Probe.sol": { content: src } },
  settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.deployedBytecode.object"] } } } })));
if (out.errors?.some(e => e.severity === "error")) { console.error(out.errors); process.exit(1); }
const P = out.contracts["Probe.sol"].Probe; const probeAbi = P.abi; const probeCode = "0x" + P.evm.deployedBytecode.object;

const ROUTERS = { "UR (docs)": "0x8876789976decbfcbbbe364623c63652db8c0904", "UR 2.1.2": "0x204FAca1764B154221e35c0d20aBb3c525710498" };
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const T = { NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9" };
const PROBE = "0x7a11ce000000000000000000000000000000b0b1";
const FEE = "0xfee0000000000000000000000000000000000001";
const MSG_SENDER = "0x0000000000000000000000000000000000000001", ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const CONTRACT_BALANCE = 1n << 255n;
const erc = parseAbi(["function balanceOf(address) view returns (uint256)"]);

// find the balanceOf storage slot for PROBE through an access list, then confirm by overriding it
const slotCache = {};
async function balanceSlot(token) {
  if (slotCache[token]) return slotCache[token];
  const data = encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [PROBE] });
  const al = await c.request({ method: "eth_createAccessList", params: [{ to: token, data }, "latest"] });
  const want = 123456789n;
  for (const e of al.accessList) for (const k of e.storageKeys) {
    const r = await c.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [e.address]: { stateDiff: { [k]: pad(toHex(want)) } } }] });
    if (r && r !== "0x" && BigInt(r) === want) return (slotCache[token] = { holder: e.address, slot: k });
  }
  throw new Error("balance slot not found for " + token);
}

async function sim({ label, router, tokenIn, amountIn, toks, commands, inputs }) {
  const { holder, slot } = await balanceSlot(tokenIn);
  const accts = [PROBE, FEE, router];
  const data = encodeFunctionData({ abi: probeAbi, functionName: "run", args: [router, PERMIT2, tokenIn, toks, accts, commands, inputs] });
  const override = { [PROBE]: { code: probeCode, balance: toHex(10n ** 18n) }, [holder]: { stateDiff: { [slot]: pad(toHex(amountIn)) } } };
  const raw = await c.request({ method: "eth_call", params: [{ from: PROBE, to: PROBE, data, gas: toHex(30_000_000n) }, "latest", override] });
  const [pre, post, gasUsed, ok, err] = decodeFunctionResult({ abi: probeAbi, functionName: "run", data: raw });
  const names = { [PROBE]: "trader", [FEE]: "fee", [router]: "router" };
  const dec = t => t === USDG ? 6 : 18, sym = t => t === USDG ? "USDG" : Object.keys(T).find(k => T[k] === t);
  const rows = [];
  toks.forEach((t, i) => accts.forEach((a, j) => { const d = post[i * 3 + j] - pre[i * 3 + j]; if (d) rows.push(`${names[a]} ${d > 0n ? "+" : ""}${formatUnits(d, dec(t))} ${sym(t)}`); }));
  console.log(`\n# ${label}\n  ok=${ok} gas=${gasUsed}${ok ? "" : " err=" + err}\n  ${rows.join("\n  ")}`);
  const delta = (t, a) => post[toks.indexOf(t) * 3 + accts.indexOf(a)] - pre[toks.indexOf(t) * 3 + accts.indexOf(a)];
  return { ok, err, delta };
}

const enc = (types, vals) => encodeAbiParameters(types.map(t => typeof t === "string" ? { type: t } : t), vals);
const cmds = (...x) => concatHex(x.map(n => toHex(n, { size: 1 })));
const v3path = (a, fee, b) => encodePacked(["address", "uint24", "address"], [a, fee, b]);

// Buy with fee taken from the USDG input: pull -> PAY_PORTION -> swap the rest (v3)
function buyV3(router, out, fee, amt, bips) {
  return { router, tokenIn: USDG, amountIn: amt, toks: [USDG, out],
    commands: cmds(0x02, 0x06, 0x00),
    inputs: [enc(["address", "address", "uint160"], [USDG, ADDRESS_THIS, amt]),
             enc(["address", "address", "uint256"], [USDG, FEE, bips]),
             enc(["address", "uint256", "uint256", "bytes", "bool"], [MSG_SENDER, CONTRACT_BALANCE, 0n, v3path(USDG, fee, out), false])] };
}
// Sell with fee taken from the USDG output: pull -> swap to router -> PAY_PORTION -> SWEEP rest to trader (v3)
function sellV3(router, tok, fee, amt, bips) {
  return { router, tokenIn: tok, amountIn: amt, toks: [USDG, tok],
    commands: cmds(0x02, 0x00, 0x06, 0x04),
    inputs: [enc(["address", "address", "uint160"], [tok, ADDRESS_THIS, amt]),
             enc(["address", "uint256", "uint256", "bytes", "bool"], [ADDRESS_THIS, CONTRACT_BALANCE, 0n, v3path(tok, fee, USDG), false]),
             enc(["address", "address", "uint256"], [USDG, FEE, bips]),
             enc(["address", "address", "uint160"], [USDG, MSG_SENDER, 0n])] };
}
// Buy on a v4 pool (no hooks), fee from the USDG input
const keyT = { type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] };
function buyV4(router, out, fee, ts, amt, bips) {
  const [c0, c1] = BigInt(USDG) < BigInt(out) ? [USDG, out] : [out, USDG];
  const key = { currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks: "0x0000000000000000000000000000000000000000" };
  const swap = enc([{ type: "tuple", components: [{ name: "poolKey", ...keyT }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" }] }],
    [{ poolKey: key, zeroForOne: c0 === USDG, amountIn: 0n, amountOutMinimum: 0n, minHopPriceX36: 0n, hookData: "0x" }]);
  const actions = cmds(0x0b, 0x06, 0x0f); // SETTLE, SWAP_EXACT_IN_SINGLE (amountIn = open credit), TAKE_ALL
  const params = [enc(["address", "uint256", "bool"], [USDG, CONTRACT_BALANCE, false]), swap, enc(["address", "uint256"], [out, 0n])];
  return { router, tokenIn: USDG, amountIn: amt, toks: [USDG, out],
    commands: cmds(0x02, 0x06, 0x10),
    inputs: [enc(["address", "address", "uint160"], [USDG, ADDRESS_THIS, amt]),
             enc(["address", "address", "uint256"], [USDG, FEE, bips]),
             enc(["bytes", "bytes[]"], [actions, params])] };
}

console.log("block", await c.getBlockNumber());
for (const [n, a] of Object.entries(ROUTERS)) console.log(n, a, "code bytes:", ((await c.getCode({ address: a })) || "0x").length / 2 - 1);

const amt = parseUnits("1000", 6), bips = 25n;
for (const [n, R] of Object.entries(ROUTERS)) {
  const r = await sim({ label: `${n}: buy NVDA v3 0.05%, 1000 USDG, fee ${bips} bips on input`, ...buyV3(R, T.NVDA, 500, amt, bips) });
  if (r.ok) console.log("  fee/input =", Number(r.delta(USDG, FEE)) / Number(amt) * 1e4, "bips");
}
const R = ROUTERS["UR (docs)"];
await sim({ label: "buy NVDA v3, no fee (reference)", ...buyV3(R, T.NVDA, 500, amt, 0n) });
await sim({ label: "buy TSLA v3 0.30%, fee 25 bips", ...buyV3(R, T.TSLA, 3000, amt, 25n) });
await sim({ label: "buy AAPL v4 0.30% ts60, fee 25 bips", ...buyV4(R, T.AAPL, 3000, 60, amt, 25n) });
await sim({ label: "sell 2 NVDA v3, fee 25 bips on USDG output", ...sellV3(R, T.NVDA, 500, parseUnits("2", 18), 25n) });
for (const b of [1n, 10n, 30n, 100n]) { const r = await sim({ label: "fee " + b + " bips", ...buyV3(R, T.NVDA, 500, amt, b) }); console.log("  fee/input =", Number(r.delta(USDG, FEE)) / Number(amt) * 1e4, "bips"); }
await sim({ label: "bips = 10000 (whole input to fee)", ...buyV3(R, T.NVDA, 500, amt, 10000n) });
await sim({ label: "bips = 10001 (over the cap)", ...buyV3(R, T.NVDA, 500, amt, 10001n) });
