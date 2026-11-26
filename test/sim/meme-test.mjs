// Spot buys and sells of the memecoin markets (PONS, CASHCAT, AI, ORBIO: Uniswap v4 USDG pools without hooks) against
// Robinhood Chain mainnet state, sending nothing. A throwaway key buys 50 USDG of each, approves it to Permit2 and sells
// everything back, all in one eth_simulateV1 block with transfer tracing: the tokens arrive exactly as quoted (no transfer
// tax), the PRIVO fee reaches the fee Safe on both legs, the slippage floors hold and the router keeps nothing.
//   node test/sim/meme-test.mjs        (PRIVO_RPC=<rpc with eth_simulateV1> to use another RPC)
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, pad, toHex, parseUnits, formatUnits, keccak256, encodeAbiParameters } from "viem";
import { CONFIG, ADDR, USDG, MARKETS, makeClient, quote, buildSwap, permitTypedData, portion } from "../../src/privo-swap.js";
import { orderMarket } from "../../src/privo-orders.js";
import { splitBasket } from "../../src/privo-swap.js";

const c = makeClient([process.env.PRIVO_RPC || "https://robinhood-rpc.publicnode.com"]);
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
    if (r && r !== "0x" && BigInt(r) === want) return { holder: token, slot: k };
  }
  throw new Error("slot not found on " + token);
}
async function findSlot(token, data, want) {
  let al; try { al = await c.request({ method: "eth_createAccessList", params: [{ to: token, data }, "latest"] }); } catch { return guessSlot(token, data, want); }
  for (const e of al.accessList) for (const k of e.storageKeys) {
    let r; try { r = await c.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [e.address]: { stateDiff: { [k]: pad(toHex(want)) } } }] }); } catch { continue; }
    if (r && r !== "0x" && BigInt(r) === want) return { holder: e.address, slot: k };
  }
  throw new Error("slot not found on " + token);
}
const bal = await findSlot(USDG.address, encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [acct.address] }), 7n);
const alw = await findSlot(USDG.address, encodeFunctionData({ abi: erc, functionName: "allowance", args: [acct.address, ADDR.PERMIT2] }), 7n);
const amount = parseUnits("50", 6);
const ov = { [bal.holder]: { stateDiff: { [bal.slot]: pad(toHex(amount)), [alw.slot]: pad(toHex((1n << 256n) - 1n)) } }, [acct.address]: { balance: toHex(10n ** 17n) } };
const call = (to, data) => ({ from: acct.address, to, data, gas: toHex(3_000_000n) });
const sim = calls => c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides: ov, calls }] , traceTransfers: true, validation: false }, "latest"] }).then(r => r[0].calls);
const flows = logs => logs.filter(l => l.topics[0] === TRANSFER).map(l => ({ tok: l.address.toLowerCase(), from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), v: BigInt(l.data) }));
const me = acct.address.toLowerCase(), router = ADDR.ROUTER.toLowerCase(), usdg = USDG.address.toLowerCase(), fw = CONFIG.FEE_WALLET.toLowerCase();

for (const sym of ["PONS", "CASHCAT", "ORBIO"]) { // AI delisted 27 Nov 2026 (pool liquidity withdrawn)
  const m = MARKETS[sym], tok = m.address.toLowerCase();
  const qb = await quote(c, { sym, side: "buy", amount });
  const p1 = permitTypedData({ token: USDG.address, amount, nonce: 0 });
  const buy = buildSwap(qb, { slippageBps: 50, permit: { message: p1.message, signature: await acct.signTypedData(p1) } });
  const [b] = await sim([call(buy.to, buy.data)]);
  if (b.status !== "0x1") { check(false, sym + " buy reverted: " + (b.error?.message || "")); continue; }
  const fb = flows(b.logs), got = fb.filter(t => t.tok === tok && t.to === me).reduce((a, t) => a + t.v, 0n);
  const feeBuy = fb.filter(t => t.tok === usdg && t.to === fw).reduce((a, t) => a + t.v, 0n);
  check(got === qb.netOut && got >= buy.minOut && feeBuy === qb.fee, `${sym} buy: 50 USDG -> ${formatUnits(got, 18)} tokens, exactly as quoted (no transfer tax); fee ${formatUnits(feeBuy, 6)} USDG to the Safe`);
  const qs = await quote(c, { sym, side: "sell", amount: got });
  const p2 = permitTypedData({ token: m.address, amount: got, nonce: 0 });
  const sell = buildSwap(qs, { slippageBps: 50, permit: { message: p2.message, signature: await acct.signTypedData(p2) } });
  const calls = await sim([call(buy.to, buy.data), call(m.address, encodeFunctionData({ abi: erc, functionName: "approve", args: [ADDR.PERMIT2, (1n << 256n) - 1n] })), call(sell.to, sell.data)]);
  const s = calls.at(-1);
  if (s.status !== "0x1") { check(false, sym + " sell reverted: " + (s.error?.message || "")); continue; }
  const fs2 = flows(s.logs);
  const back = fs2.filter(t => t.tok === usdg && t.to === me).reduce((a, t) => a + t.v, 0n);
  const feeSell = fs2.filter(t => t.tok === usdg && t.to === fw).reduce((a, t) => a + t.v, 0n);
  const left = {}; for (const t of fs2) { if (t.to === router) left[t.tok] = (left[t.tok] || 0n) + t.v; if (t.from === router) left[t.tok] = (left[t.tok] || 0n) - t.v; }
  check(back >= sell.minOut && feeSell === portion(back + feeSell, qs.bips) && Object.values(left).every(v => v === 0n) && fs2.some(t => t.tok === tok && t.from === me && t.v === got),
    `${sym} sell: all ${formatUnits(got, 18)} back -> ${formatUnits(back, 6)} USDG (floor ${formatUnits(sell.minOut, 6)}); fee ${formatUnits(feeSell, 6)} USDG; router keeps nothing`);
}
check(["PONS", "CASHCAT", "ORBIO", "AI"].every(s => !orderMarket(s)), "memecoins are not taken by limit or TWAP orders");
let refused = false; try { splitBasket([{ sym: "PONS", w: 5000 }, { sym: "TSLA", w: 5000 }], 10n ** 8n); } catch { refused = true; }
check(refused, "memecoins are not taken in baskets");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
