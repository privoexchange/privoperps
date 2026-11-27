// PRIVO gifts. Offline: the link format (key and message after "#"), bad links, funding transactions, and the sweep against
// a stand-in chain (every token first, then the ETH left after gas; refuses to send a gift to itself). On Robinhood Chain
// mainnet state (sending nothing): a gift wallet funded with USDG and the planned gas budget sends the USDG and then sweeps
// its ETH to the claimer in one eth_simulateV1 block with fee validation on, so the gas budget is shown to be enough.
//   node test/sim/gift-test.mjs        (PRIVO_RPC=<rpc with eth_simulateV1> to use another RPC)
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, decodeFunctionData, parseAbi, pad, toHex, parseUnits, formatEther, keccak256, encodeAbiParameters } from "viem";
import { encodeGift, decodeGift, giftUrl, fundTxs, sweep, gasBudget, GIFT_MIN_GAS } from "../../src/privo-gift-core.js";
import { USDG, MARKETS, makeClient } from "../../src/privo-swap.js";

let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };
const ERC20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

console.log("links:");
const key = generatePrivateKey(), addr = privateKeyToAccount(key).address;
const frag = encodeGift({ key, msg: "Happy birthday! <b>enjoy</b> 🎉" });
const back = decodeGift("#" + frag);
check(frag.startsWith("g1.") && back.key === key && back.address === addr, "the key round-trips through the link and gives the same gift wallet");
check(back.msg === "Happy birthday! b enjoy /b 🎉".replace(" b ", " ").replace(" /b ", " ") || back.msg === "Happy birthday! b enjoy /b 🎉" || !/[<>]/.test(back.msg), "the message comes back without markup: " + JSON.stringify(back.msg));
check(giftUrl("https://privoexchange.com", { key }).startsWith("https://privoexchange.com/app/gift#g1.") && !giftUrl("https://privoexchange.com", { key }).split("#")[0].includes(key.slice(2, 10)), "the key is only after # (never in the path or query)");
check([null, "", "g1.", "g2.abc", "g1.AAAA", "nonsense"].every(x => decodeGift(x) === null), "broken or foreign links are refused");
check(encodeGift({ key, msg: "x".repeat(500) }).length < 300, "long messages are cut to 140 characters");

console.log("funding:");
const gas = GIFT_MIN_GAS;
const tx = fundTxs({ sym: "TSLA", amount: 5n * 10n ** 17n, to: addr, gas });
const dec = decodeFunctionData({ abi: ERC20, data: tx[0].data });
check(tx.length === 2 && tx[0].to === MARKETS.TSLA.address && dec.args[0] === addr && dec.args[1] === 5n * 10n ** 17n && tx[1].to === addr && tx[1].value === gas, "a token gift is a transfer of the token plus a small ETH transfer for the claim's gas");
const te = fundTxs({ sym: "ETH", amount: 10n ** 15n, to: addr, gas });
check(te.length === 1 && te[0].value === 10n ** 15n + gas, "an ETH gift is one transfer: the gift plus the gas");
let refused = 0; for (const f of [() => fundTxs({ sym: "TSLA", amount: 0n, to: addr, gas }), () => fundTxs({ sym: "NOPE", amount: 1n, to: addr, gas })]) { try { f(); } catch { refused++; } }
check(refused === 2, "zero amounts and unknown tokens are refused");

console.log("sweep (stand-in chain):");
{
  const usdg = 25_000000n, eth = 30000000000000n, gp = 20000000n;
  const sent = [];
  const client = {
    getGasPrice: async () => gp,
    estimateGas: async ({ data }) => (data ? 62000n : 21000n),
    getBalance: async () => eth - sent.filter(s => s.data).reduce((a, s) => a + s.gas * s.gasPrice, 0n),
    waitForTransactionReceipt: async () => ({ status: "success" }),
    multicall: async ({ contracts }) => contracts.map(c => ({ status: "success", result: c.address.toLowerCase() === USDG.address.toLowerCase() ? usdg : 0n })),
  };
  const account = privateKeyToAccount(key);
  const wallet = { account, chain: { id: 4663 }, sendTransaction: async t => { sent.push(t); return "0x" + String(sent.length).padStart(64, "0"); } };
  const dest = privateKeyToAccount(generatePrivateKey()).address;
  const hs = await sweep(client, wallet, dest);
  const t0 = decodeFunctionData({ abi: ERC20, data: sent[0].data });
  const last = sent.at(-1);
  check(hs.length === 2 && sent[0].to === USDG.address && t0.args[0] === dest && t0.args[1] === usdg, "the USDG goes to the claimer first");
  check(!last.data && last.to === dest && last.value > 0n && last.value + last.gas * last.gasPrice <= eth - sent[0].gas * sent[0].gasPrice, `then the ETH left after gas (${formatEther(last.value)} ETH) goes to the claimer`);
  let self = false; try { await sweep(client, wallet, account.address); } catch { self = true; }
  check(self, "a gift cannot be sent back to its own gift wallet");
}

console.log("on mainnet state (eth_simulateV1, fees validated):");
{
  const c = makeClient(process.env.PRIVO_RPC ? process.env.PRIVO_RPC.split(",") : undefined);
  const g = privateKeyToAccount(generatePrivateKey()), dest = privateKeyToAccount(generatePrivateKey()).address;
  // find USDG's balance slot for the gift wallet (plain mapping)
  const bal = encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [g.address] });
  let slot = null;
  for (let i = 0n; i < 100n && !slot; i++) {
    const k = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [g.address, i]));
    const r = await c.request({ method: "eth_call", params: [{ to: USDG.address, data: bal }, "latest", { [USDG.address]: { stateDiff: { [k]: pad(toHex(7n)) } } }] }).catch(() => null);
    if (r && BigInt(r) === 7n) slot = k;
  }
  const budget = await gasBudget(c, 1), amount = parseUnits("25", 6);
  const gp = toHex((await c.getGasPrice()) * 2n);
  const ov = { [USDG.address]: { stateDiff: { [slot]: pad(toHex(amount)) } }, [g.address]: { balance: toHex(budget) } };
  const transfer = { from: g.address, to: USDG.address, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [dest, amount] }), gas: toHex(90000n), maxFeePerGas: gp, maxPriorityFeePerGas: "0x0", nonce: "0x0" };
  const r1 = await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides: ov, calls: [transfer] }], traceTransfers: true, validation: true }, "latest"] });
  const used = BigInt(r1[0].calls[0].gasUsed), base = BigInt(r1[0].baseFeePerGas || 0);
  const left = budget - used * base;
  const sweepGas = 60000n, sweepVal = left - sweepGas * BigInt(gp);
  const eth = { from: g.address, to: dest, value: toHex(sweepVal), gas: toHex(sweepGas), maxFeePerGas: gp, maxPriorityFeePerGas: "0x0", nonce: "0x1" };
  const r2 = await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides: ov, calls: [transfer, eth] }], traceTransfers: true, validation: true }, "latest"] });
  const [a, b] = r2[0].calls;
  const got = (b.logs || []).filter(l => l.topics.length === 3 && ("0x" + l.topics[2].slice(26)).toLowerCase() === dest.toLowerCase());
  check(slot && a.status === "0x1" && b.status === "0x1" && sweepVal > 0n, `budget ${formatEther(budget)} ETH pays both transfers (USDG used ${used} gas); ${formatEther(sweepVal)} ETH left over goes to the claimer`);
  check(got.length >= 1, "the claimer receives the ETH (traced)");
}

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
