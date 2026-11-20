// Tests contracts/PrivoBlockDesk.sol against Robinhood Chain state (real USDG and TSLA tokens), sending nothing.
// The desk runtime code and a DeskProbe (playing the maker) are placed by state override; the taker is a
// throwaway key that signs EIP-712 quotes. Balances and allowances are faked by state override.
//   node test/blockdesk/desk-test.mjs
import fs from "node:fs";
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, decodeErrorResult, parseAbi, pad, toHex, parseUnits, formatUnits, keccak256, encodeAbiParameters } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { compile } from "./compile.mjs";

const c = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { timeout: 30000, retryCount: 2 }) });
const out = compile({ "PrivoBlockDesk.sol": "../../contracts/PrivoBlockDesk.sol", "DeskProbe.sol": "./DeskProbe.sol" });
const desk = out["PrivoBlockDesk.sol"].PrivoBlockDesk, probe = out["DeskProbe.sol"].DeskProbe;
const DESK = "0xdec0000000000000000000000000000000000b10", MAKER = "0x7a11ce000000000000000000000000000000b0b1";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d";
const FEE = "0xCc051cf47547386bA147FDDfcBCFE00E791C1418";
const taker = privateKeyToAccount(generatePrivateKey()), stranger = privateKeyToAccount(generatePrivateKey());
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
let bad = 0;
const check = (cond, msg) => { console.log((cond ? "  ok    " : "  FAIL  ") + msg); if (!cond) bad++; };

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

const DOMAIN = { name: "PRIVO Block Desk", version: "1", chainId: 4663, verifyingContract: DESK };
const TYPES = { Quote: [["maker", "address"], ["taker", "address"], ["makerToken", "address"], ["makerAmount", "uint256"], ["takerToken", "address"], ["takerAmount", "uint256"], ["blockId", "bytes32"], ["nonce", "uint256"], ["deadline", "uint256"]].map(([name, type]) => ({ name, type })) };
const now = BigInt(Math.floor(Date.now() / 1000));

// One scenario: overrides, sign, run the probe, return deltas and results.
async function run({ q, signer = taker, sig, times = 1, takerAllow = null, makerBal = null, takerBal = null, extraState = {}, from = MAKER, mutate }) {
  const signature = sig ?? await signer.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Quote", message: q });
  const sent = mutate ? mutate({ ...q }) : q;
  const call = encodeFunctionData({ abi: desk.abi, functionName: "settle", args: [sent, signature] });
  const ov = { [DESK]: { code: "0x" + desk.evm.deployedBytecode.object, stateDiff: extraState }, [MAKER]: { code: "0x" + probe.evm.deployedBytecode.object } };
  const put = (s, v) => { ov[s.a] = ov[s.a] || { stateDiff: {} }; ov[s.a].stateDiff = ov[s.a].stateDiff || {}; ov[s.a].stateDiff[s.k] = pad(toHex(v)); };
  put(await balSlot(q.makerToken, MAKER), makerBal ?? q.makerAmount * 2n);
  put(await balSlot(q.takerToken, taker.address), takerBal ?? q.takerAmount);
  put(await alwSlot(q.takerToken, taker.address, DESK), takerAllow ?? q.takerAmount);
  const toks = [USDG, TSLA], accts = [MAKER, taker.address, FEE];
  let data;
  if (from === MAKER) data = encodeFunctionData({ abi: probe.abi, functionName: "run", args: [DESK, q.makerToken, call, BigInt(times), toks, accts] });
  else { // someone else calls settle directly
    try { await c.request({ method: "eth_call", params: [{ from, to: DESK, data: call }, "latest", ov] }); return { results: ["OK"] }; }
    catch (e) { return { results: [e.data || e.cause?.data || "0x"] }; }
  }
  const r = await c.request({ method: "eth_call", params: [{ from: MAKER, to: MAKER, data, gas: toHex(5_000_000n) }, "latest", ov] });
  const [pre, post, results] = decodeFunctionResult({ abi: probe.abi, functionName: "run", data: r });
  const d = (ti, ai) => post[ti * 3 + ai] - pre[ti * 3 + ai];
  return { results, usdg: { maker: d(0, 0), taker: d(0, 1), fee: d(0, 2) }, tsla: { maker: d(1, 0), taker: d(1, 1), fee: d(1, 2) } };
}
const errName = r => { if (r === "OK" || r === "0x4f4b") return "OK"; try { return decodeErrorResult({ abi: desk.abi, data: r }).errorName; } catch { return "revert " + String(r).slice(0, 10); } };
const u = v => formatUnits(v, 6), t = v => formatUnits(v, 18);

const base = { maker: MAKER, taker: taker.address, blockId: keccak256(toHex("pv_test_block")), nonce: 1n, deadline: now + 3600n };

// 1. Maker sells 2 TSLA, taker pays 770 USDG: fee 0.10% from the USDG the taker pays.
let q = { ...base, makerToken: TSLA, makerAmount: parseUnits("2", 18), takerToken: USDG, takerAmount: parseUnits("770", 6) };
let r = await run({ q });
check(errName(r.results[0]) === "OK", "settle: maker sells 2 TSLA for 770 USDG");
check(r.usdg.taker === -parseUnits("770", 6) && r.tsla.taker === parseUnits("2", 18), `taker gives exactly 770 USDG and gets exactly 2 TSLA (${u(r.usdg.taker)} / +${t(r.tsla.taker)})`);
check(r.usdg.fee === parseUnits("0.77", 6) && r.usdg.maker === parseUnits("769.23", 6) && r.tsla.maker === -parseUnits("2", 18), `fee 0.77 USDG to the Safe, maker gets 769.23 USDG (${u(r.usdg.fee)} / ${u(r.usdg.maker)})`);

// 2. Maker buys 2 TSLA paying 760 USDG: maker pays the fee on top, taker gets the full 760.
q = { ...base, makerToken: USDG, makerAmount: parseUnits("760", 6), takerToken: TSLA, takerAmount: parseUnits("2", 18) };
r = await run({ q });
check(errName(r.results[0]) === "OK" && r.usdg.taker === parseUnits("760", 6) && r.tsla.taker === -parseUnits("2", 18), "maker buys: taker gives exactly 2 TSLA and gets exactly 760 USDG");
check(r.usdg.fee === parseUnits("0.76", 6) && r.usdg.maker === -parseUnits("760.76", 6) && r.tsla.maker === parseUnits("2", 18), `maker pays 760 + 0.76 fee (${u(r.usdg.maker)})`);

// 3. Failure cases.
q = { ...base, makerToken: TSLA, makerAmount: parseUnits("1", 18), takerToken: USDG, takerAmount: parseUnits("385", 6) };
r = await run({ q, times: 2 });
check(errName(r.results[0]) === "OK" && errName(r.results[1]) === "NonceAlreadyUsed", "same quote cannot settle twice (NonceAlreadyUsed)");
r = await run({ q, mutate: x => ({ ...x, makerAmount: x.makerAmount / 2n }) });
check(errName(r.results[0]) === "BadSignature", "maker cannot change the signed amounts (BadSignature)");
r = await run({ q, signer: stranger });
check(errName(r.results[0]) === "BadSignature", "quote signed by someone other than the named taker is refused");
r = await run({ q: { ...q, deadline: now - 10n } });
check(errName(r.results[0]) === "Expired", "expired quote is refused");
r = await run({ q, from: stranger.address });
check(errName(r.results[0]) === "NotMaker", "nobody but the named maker can settle (NotMaker)");
const cancelSlot = keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [q.nonce, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [taker.address, 0n]))]));
r = await run({ q, extraState: { [cancelSlot]: pad(toHex(1n)) } });
check(errName(r.results[0]) === "NonceAlreadyUsed", "quote whose nonce the taker cancelled is refused");
r = await run({ q, takerAllow: parseUnits("100", 6) });
check(errName(r.results[0]) === "TransferFailed" && r.usdg.maker === 0n && r.tsla.taker === 0n, "taker without enough allowance: whole settle reverts, nothing moves");
r = await run({ q, makerBal: parseUnits("0.5", 18) });
check(errName(r.results[0]) === "TransferFailed" && r.usdg.taker === 0n, "maker without enough TSLA: whole settle reverts, nothing moves");
const sigBytes = await taker.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Quote", message: q });
const sv = BigInt("0x" + sigBytes.slice(66, 130)), N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const flipped = sigBytes.slice(0, 66) + (N - sv).toString(16).padStart(64, "0") + (sigBytes.slice(130) === "1b" ? "1c" : "1b");
r = await run({ q, sig: flipped });
check(errName(r.results[0]) === "BadSignature", "malleable (high-s) copy of a valid signature is refused");
r = await run({ q: { ...q, takerToken: TSLA } });
check(errName(r.results[0]) === "BadQuote", "same token on both legs is refused (BadQuote)");

// 4. Hash in the contract matches the EIP-712 hash wallets sign.
const { hashTypedData } = await import("viem");
const hc = await c.request({ method: "eth_call", params: [{ to: DESK, data: encodeFunctionData({ abi: desk.abi, functionName: "hashQuote", args: [q] }) }, "latest", { [DESK]: { code: "0x" + desk.evm.deployedBytecode.object } }] });
check(hc === hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: "Quote", message: q }), "hashQuote() equals the EIP-712 hash a wallet signs");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
