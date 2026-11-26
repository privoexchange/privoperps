// Spot buys and sells of $PRIVO against Robinhood Chain mainnet state, sending nothing. $PRIVO's only pool is the Pons launch
// pool, Uniswap v4 against native ETH with the Pons hook, so PRIVO routes USDG -> WETH (v3) -> ETH -> PRIVO (v4) in one router
// call, and back the same way. A throwaway key buys 20 and 100 USDG of PRIVO, approves it to Permit2 and sells everything back,
// all in one eth_simulateV1 block with transfer tracing (native ETH included): the tokens arrive exactly as quoted, the PRIVO
// fee reaches the fee Safe on both legs, the slippage floors hold, the router keeps nothing, and the Pons hook keeps 3%.
//   node test/sim/privo-token-test.mjs        (PRIVO_RPC=<rpc with eth_simulateV1> to use another RPC)
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, pad, toHex, parseUnits, formatUnits, keccak256, encodeAbiParameters } from "viem";
import { CONFIG, ADDR, USDG, MARKETS, makeClient, quote, buildSwap, permitTypedData, portion, splitBasket, routeLabel, midPrice } from "../../src/privo-swap.js";
import { orderMarket } from "../../src/privo-orders.js";
import { fromReceipt } from "../../src/privo-journal.js";

const c = makeClient(process.env.PRIVO_RPC ? process.env.PRIVO_RPC.split(",") : undefined);
const acct = privateKeyToAccount(generatePrivateKey());
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // eth_simulateV1 logs native ETH moves as transfers from this address
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
const balSlot = await guessSlot(USDG.address, encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [acct.address] }), 7n);
const alwSlot = await guessSlot(USDG.address, encodeFunctionData({ abi: erc, functionName: "allowance", args: [acct.address, ADDR.PERMIT2] }), 7n);
const call = (to, data) => ({ from: acct.address, to, data, gas: toHex(3_000_000n) });
const flows = logs => logs.filter(l => l.topics[0] === TRANSFER && l.topics.length === 3).map(l => ({ tok: l.address.toLowerCase(), from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), v: BigInt(l.data) }));
const me = acct.address.toLowerCase(), router = ADDR.ROUTER.toLowerCase(), usdg = USDG.address.toLowerCase(), fw = CONFIG.FEE_WALLET.toLowerCase();
const m = MARKETS.PRIVO, tok = m.address.toLowerCase();
const routerLeft = fs => { const left = {}; for (const t of fs) { if (t.to === router) left[t.tok] = (left[t.tok] || 0n) + t.v; if (t.from === router) left[t.tok] = (left[t.tok] || 0n) - t.v; } return left; };

for (const human of ["20", "100"]) {
  const amount = parseUnits(human, 6);
  const ov = { [USDG.address]: { stateDiff: { [balSlot]: pad(toHex(amount)), [alwSlot]: pad(toHex((1n << 256n) - 1n)) } }, [acct.address]: { balance: toHex(10n ** 17n) } };
  // one pinned block for both simulations: the pool trades often, so the second run must see the same state as the first
  const blk = toHex(await c.getBlockNumber());
  const sim = calls => c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides: ov, calls }], traceTransfers: true, validation: false }, blk] }).then(r => r[0].calls);
  const qb = await quote(c, { sym: "PRIVO", side: "buy", amount });
  const p1 = permitTypedData({ token: USDG.address, amount, nonce: 0 });
  const buy = buildSwap(qb, { slippageBps: 50, permit: { message: p1.message, signature: await acct.signTypedData(p1) } });
  const [b] = await sim([call(buy.to, buy.data)]);
  if (b.status !== "0x1") { check(false, human + " USDG buy reverted: " + (b.error?.message || "")); continue; }
  const fb = flows(b.logs), got = fb.filter(t => t.tok === tok && t.to === me).reduce((a, t) => a + t.v, 0n);
  const feeBuy = fb.filter(t => t.tok === usdg && t.to === fw).reduce((a, t) => a + t.v, 0n);
  const leftB = routerLeft(fb);
  const drift = Math.abs(Number(got - qb.netOut)) / Number(qb.netOut); // the quote reads the newest block, which may be one later
  check(drift < 0.002 && got >= buy.minOut && feeBuy === qb.fee && Object.values(leftB).every(v => v === 0n),
    `${human} USDG -> ${Number(formatUnits(got, 18)).toLocaleString("en-US")} PRIVO, ${drift === 0 ? "exactly as quoted" : "within " + (drift * 100).toFixed(3) + "% of the quote (a newer block)"} (${routeLabel(qb.pool)}); fee ${formatUnits(feeBuy, 6)} USDG to the Safe; router keeps nothing (USDG, WETH, ETH, PRIVO)`);
  const rc = { status: "success", logs: b.logs.map(l => ({ ...l })) };
  const je = fromReceipt(rc, acct.address, "PRIVO", { ts: 1 });
  check(je && je.side === "buy" && Math.abs(je.qty - Number(formatUnits(got, 18))) < 1e-6 && Math.abs(je.usdg - Number(human)) < 1e-6, "the journal books it as a PRIVO buy for " + human + " USDG");
  const qs = await quote(c, { sym: "PRIVO", side: "sell", amount: got });
  const p2 = permitTypedData({ token: m.address, amount: got, nonce: 0 });
  const sell = buildSwap(qs, { slippageBps: 50, permit: { message: p2.message, signature: await acct.signTypedData(p2) } });
  const calls = await sim([call(buy.to, buy.data), call(m.address, encodeFunctionData({ abi: erc, functionName: "approve", args: [ADDR.PERMIT2, (1n << 256n) - 1n] })), call(sell.to, sell.data)]);
  const s = calls.at(-1);
  if (s.status !== "0x1") { check(false, human + " USDG sell reverted: " + (s.error?.message || "")); continue; }
  const fs2 = flows(s.logs);
  const back = fs2.filter(t => t.tok === usdg && t.to === me).reduce((a, t) => a + t.v, 0n);
  const feeSell = fs2.filter(t => t.tok === usdg && t.to === fw).reduce((a, t) => a + t.v, 0n);
  const nativeSeen = fs2.some(t => t.tok === NATIVE);
  check(back >= sell.minOut && feeSell === portion(back + feeSell, qs.bips) && Object.values(routerLeft(fs2)).every(v => v === 0n) && fs2.some(t => t.tok === tok && t.from === me && t.v === got),
    `selling it all back -> ${formatUnits(back, 6)} USDG (floor ${formatUnits(sell.minOut, 6)}); fee ${formatUnits(feeSell, 6)} USDG; router keeps nothing${nativeSeen ? " (native ETH traced)" : ""}`);
  console.log(`        round trip: ${human} USDG -> ${formatUnits(back, 6)} USDG (${((1 - Number(back) / Number(amount)) * 100).toFixed(2)}% kept by fees and the two pools)`);
}

check(!orderMarket("PRIVO"), "PRIVO is not taken by limit or TWAP orders");
let refused = false; try { splitBasket([{ sym: "PRIVO", w: 5000 }, { sym: "TSLA", w: 5000 }], 10n ** 8n); } catch { refused = true; }
check(refused, "PRIVO is not taken in baskets");
// what a buy pays above the pool's own price: the Pons hook's 3%, the ETH pool fee and the PRIVO fee
{
  const mid = await midPrice(c, "PRIVO");
  const q = await quote(c, { sym: "PRIVO", side: "buy", amount: parseUnits("1", 6) });
  const paid = 1 / Number(formatUnits(q.grossOut, 18));
  check(mid > 0 && paid / mid > 1.025 && paid / mid < 1.045, `live mid ${mid.toExponential(4)} USDG per PRIVO; a 1 USDG buy pays ${((paid / mid - 1) * 100).toFixed(2)}% above it (Pons 3% plus the ETH pool fee and the 0.15% PRIVO fee)`);
}

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
