// End-to-end check of privo-swap.js against Robinhood Chain mainnet state, without sending anything.
// A throwaway key made here signs the Permit2 message. Balances and the ERC-20 approval to Permit2 are
// faked with state overrides, then router.execute runs as eth_call from that address.
// A pass means the permit signature, the transfer, the fee and the slippage floor all held on real pools.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, pad, toHex, parseUnits, formatUnits } from "viem";
import { CONFIG, ADDR, USDG, MARKETS, decimalsOf, isNative, routeLabel, makeClient, quote, approvalState, permitTypedData, buildSwap } from "../../src/privo-swap.js";

// Uses the real FEE_WALLET from privo-swap.js. Set FEE_WALLET_OVERRIDE to test another address.
if (process.env.FEE_WALLET_OVERRIDE) CONFIG.FEE_WALLET = process.env.FEE_WALLET_OVERRIDE;
console.log("fee wallet", CONFIG.FEE_WALLET, "fee bips", CONFIG.FEE_BIPS);
const c = makeClient(["https://robinhood-rpc.publicnode.com"]);
const acct = privateKeyToAccount(generatePrivateKey());
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);

async function findSlot(token, data, want) {
  const al = await c.request({ method: "eth_createAccessList", params: [{ to: token, data }, "latest"] });
  for (const e of al.accessList) for (const k of e.storageKeys) {
    let r; try { r = await c.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [e.address]: { stateDiff: { [k]: pad(toHex(want)) } } }] }); } catch { continue; }
    if (r && r !== "0x" && BigInt(r) === want) return { holder: e.address, slot: k };
  }
  throw new Error("slot not found on " + token);
}

async function run(sym, side, human, { slip = 30, inflate = 0 } = {}) {
  const token = side === "buy" ? USDG.address : MARKETS[sym].address;
  const amount = parseUnits(human, side === "buy" ? USDG.decimals : decimalsOf(sym));
  const q = await quote(c, { sym, side, amount });
  const q2 = inflate ? { ...q, grossOut: q.grossOut * BigInt(10000 + inflate) / 10000n } : q;
  const nativeSell = side === "sell" && isNative(sym);
  let st = { needErc20Approve: false, needPermit: false }, ov = {};
  let tx;
  if (nativeSell) {
    tx = buildSwap(q2, { slippageBps: slip });
    ov[acct.address] = { balance: toHex(amount + 10n ** 17n) };
  } else {
  st = await approvalState(c, acct.address, token, amount);
  const td = permitTypedData({ token, amount, nonce: st.nonce });
  const signature = await acct.signTypedData(td);
  tx = buildSwap(q2, { slippageBps: slip, permit: { message: td.message, signature } });
  const bal = await findSlot(token, encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [acct.address] }), 7n);
  const alw = await findSlot(token, encodeFunctionData({ abi: erc, functionName: "allowance", args: [acct.address, ADDR.PERMIT2] }), 7n);
  const diff = { [bal.slot]: pad(toHex(amount)) };
  ov = bal.holder === alw.holder ? { [bal.holder]: { stateDiff: { ...diff, [alw.slot]: pad(toHex((1n << 256n) - 1n)) } } }
    : { [bal.holder]: { stateDiff: diff }, [alw.holder]: { stateDiff: { [alw.slot]: pad(toHex((1n << 256n) - 1n)) } } };
  ov[acct.address] = { balance: toHex(10n ** 17n) };
  }
  let res = "ok";
  try { await c.request({ method: "eth_call", params: [{ from: acct.address, to: tx.to, data: tx.data, value: toHex(tx.value), gas: toHex(3_000_000n) }, "latest", ov] }); }
  catch (e) { res = "revert " + (e.details || e.shortMessage || e.message).slice(0, 80); }
  const outDec = side === "buy" ? decimalsOf(sym) : USDG.decimals;
  console.log(`${side.padEnd(4)} ${human.padStart(5)} ${side === "buy" ? "USDG" : sym} -> ${sym === "x" ? "" : side === "buy" ? sym : "USDG"} | v${q.pool.v} ${routeLabel(q.pool)} | net ${Number(formatUnits(q.netOut, outDec)).toFixed(4)} | privo fee ${formatUnits(q.fee, 6)} USDG | needs approve ${st.needErc20Approve}, permit ${st.needPermit} | ${inflate ? "quote inflated " + inflate / 100 + "% -> " : ""}${res}`);
  return res;
}

let bad = 0;
for (const s of Object.keys(MARKETS)) if ((await run(s, "buy", "250")) !== "ok") bad++;
for (const [s, n] of [["NVDA", "1"], ["TSLA", "0.5"], ["AAPL", "0.5"], ["PLTR", "1"], ["ETH", "0.2"], ["BTC", "0.005"]]) if ((await run(s, "sell", n)) !== "ok") bad++;
// Slippage floor must bite: quote raised 2% above what the pool gives.
if ((await run("NVDA", "buy", "250", { inflate: 200 })) === "ok") bad++;
if ((await run("AAPL", "sell", "0.5", { inflate: 200 })) === "ok") bad++;
if ((await run("ETH", "sell", "0.2", { inflate: 200 })) === "ok") bad++;
if ((await run("BTC", "buy", "250", { inflate: 200 })) === "ok") bad++;
console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
