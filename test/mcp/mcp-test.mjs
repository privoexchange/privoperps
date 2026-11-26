// PRIVO MCP server test, sending nothing on chain.
// 1. Over stdio, as an agent would run it: without a key only read tools exist and they answer; with a throwaway key the
//    trading tools appear, the per-trade limit refuses big trades before anything is signed, and bad inputs are refused.
// 2. In process: privo_buy and privo_basket_buy build their transactions through the SDK, a stand-in for sending captures
//    them, and eth_simulateV1 runs them on Robinhood Chain mainnet state with faked USDG: the tokens arrive, the PRIVO fee
//    reaches the fee Safe.
//   node test/mcp/mcp-test.mjs        (PRIVO_RPC=<comma-separated RPCs with eth_simulateV1>, default PRIVO's list)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, parseAbi, pad, toHex, keccak256, encodeAbiParameters, parseUnits } from "viem";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RPC = process.env.PRIVO_RPC || "https://robinhood-rpc.publicnode.com,https://rpc.mainnet.chain.robinhood.com";
process.env.PRIVO_RPC = RPC;
process.env.PRIVO_MCP_NO_START = "1";
const DATA = mkdtempSync(join(tmpdir(), "privo-mcp-test-"));
let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };
const text = r => r.content?.[0]?.text || "";
const body = r => { try { return JSON.parse(text(r)); } catch { return null; } };

async function stdio(env) {
  const c = new Client({ name: "privo-mcp-test", version: "1" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [new URL("../../mcp/privo-mcp.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")],
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT || "", PRIVO_RPC: RPC, PRIVO_DATA_DIR: DATA, ...env }, stderr: "pipe" }));
  return c;
}
const READ = ["privo_arena", "privo_markets", "privo_prices", "privo_quote", "privo_quote_basket", "privo_wallet"];
const TRADE = ["privo_basket_buy", "privo_basket_sell", "privo_buy", "privo_cancel_order", "privo_limit_order", "privo_orders", "privo_perps_account", "privo_perps_cancel",
  "privo_perps_connect", "privo_perps_deposit", "privo_perps_order", "privo_sell", "privo_twap_order"];

/* ---------- 1. read-only over stdio ---------- */
{
  const c = await stdio({});
  const names = (await c.listTools()).tools.map(t => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify(READ), "no key: only the six read tools (" + names.join(", ") + ")");
  const m = body(await c.callTool({ name: "privo_markets", arguments: {} }));
  check(m?.markets?.length >= 60 && m.markets.some(x => x.sym === "TSLA" && x.perp), `privo_markets: ${m?.markets?.length} markets, TSLA with its perp`);
  const p = body(await c.callTool({ name: "privo_prices", arguments: { symbols: ["TSLA", "ETH"] } }));
  check((p?.prices?.TSLA?.pool?.px > 0 || p?.prices?.TSLA?.perp?.mark > 0) && Object.keys(p.prices).length === 2, "privo_prices filters to TSLA and ETH, TSLA mark " + p?.prices?.TSLA?.perp?.mark);
  const q = body(await c.callTool({ name: "privo_quote", arguments: { symbol: "TSLA", side: "buy", amount: "100" } }));
  check(q && +q.estimatedOut > 0 && +q.minimumOut < +q.estimatedOut && q.privoFeeUsdg === "0.15", `privo_quote: 100 USDG -> ${q?.estimatedOut} TSLA, min ${q?.minimumOut}, fee ${q?.privoFeeUsdg}, ${q?.route}`);
  const qs = body(await c.callTool({ name: "privo_quote", arguments: { symbol: "NVDA", side: "sell", amount: "0.5" } }));
  check(qs && +qs.estimatedOut > 0 && qs.outToken === "USDG", "privo_quote sell: 0.5 NVDA -> " + qs?.estimatedOut + " USDG");
  const qb = body(await c.callTool({ name: "privo_quote_basket", arguments: { legs: ["AAPL", "MSFT", "NVDA"], amount: "90" } }));
  check(qb?.legs?.length === 3 && qb.privoFeeUsdg === "0.135", "privo_quote_basket: 3 legs, fee once 0.135 USDG");
  const w = body(await c.callTool({ name: "privo_wallet", arguments: {} }));
  check(w?.readOnly === true, "privo_wallet without a key says read-only");
  const unk = await c.callTool({ name: "privo_quote", arguments: { symbol: "NOPE", side: "buy", amount: "1" } });
  check(unk.isError && /Unknown market/.test(text(unk)), "an unknown market is refused");
  const neg = await c.callTool({ name: "privo_quote", arguments: { symbol: "TSLA", side: "buy", amount: "-5" } }).catch(e => ({ isError: true, content: [{ text: e.message }] }));
  check(neg.isError, "a negative amount is refused by the schema");
  await c.close();
}

/* ---------- 2. trading tools over stdio, throwaway key ---------- */
const key = generatePrivateKey(), addr = privateKeyToAccount(key).address;
{
  const c = await stdio({ PRIVO_PRIVATE_KEY: key, PRIVO_MAX_USDG: "50" });
  const names = (await c.listTools()).tools.map(t => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify([...READ, ...TRADE].sort()), `with a key: ${names.length} tools, trading included`);
  const ann = (await c.listTools()).tools.find(t => t.name === "privo_buy").annotations;
  check(ann?.destructiveHint === true && ann?.readOnlyHint === false, "privo_buy is marked destructive, so clients ask before running it");
  const w = body(await c.callTool({ name: "privo_wallet", arguments: {} }));
  check(w?.wallet === addr && w.limits.maxTradeUsdg === 50 && Object.keys(w.balances).length === 0, "privo_wallet: the key's address, limit 50 USDG, no balances");
  const big = await c.callTool({ name: "privo_buy", arguments: { symbol: "TSLA", usdg: "75" } });
  check(big.isError && /above this agent's limit of 50 USDG/.test(text(big)) && /Nothing was sent/.test(text(big)), "a 75 USDG buy is refused by the 50 USDG limit");
  const bigB = await c.callTool({ name: "privo_basket_buy", arguments: { legs: ["AAPL", "MSFT"], amount: "51" } });
  check(bigB.isError && /limit/.test(text(bigB)), "a 51 USDG basket is refused too");
  const bigO = await c.callTool({ name: "privo_limit_order", arguments: { symbol: "TSLA", side: "sell", amount: "1", price: 300 } });
  check(bigO.isError && /limit of 50/.test(text(bigO)), "a limit sell worth 300 USDG at its price is refused");
  const meme = await c.callTool({ name: "privo_limit_order", arguments: { symbol: "PONS", side: "buy", amount: "10", price: 0.1 } });
  check(meme.isError && /stock tokens only/.test(text(meme)), "limit orders on a memecoin are refused");
  const none = await c.callTool({ name: "privo_sell", arguments: { symbol: "TSLA", amount: "all" } });
  check(none.isError && /holds no TSLA/.test(text(none)), "selling \"all\" with no balance is refused");
  const ethAll = await c.callTool({ name: "privo_sell", arguments: { symbol: "ETH", amount: "all" } });
  check(ethAll.isError && /gas/.test(text(ethAll)), "selling all ETH is refused (gas)");
  const noFunds = await c.callTool({ name: "privo_buy", arguments: { symbol: "TSLA", usdg: "5" } });
  check(noFunds.isError, "a buy from an empty wallet fails before sending (" + text(noFunds).slice(0, 70) + ")");
  const cancel = await c.callTool({ name: "privo_cancel_order", arguments: { orderId: "123" } });
  check(cancel.isError && /No order 123/.test(text(cancel)), "cancelling an unknown order is refused");
  check(!/0x[0-9a-f]{64}/i.test(JSON.stringify(w)) , "the key never appears in a reply");
  await c.close();
}
{
  const c = await stdio({ PRIVO_PRIVATE_KEY: key, PRIVO_READ_ONLY: "1" });
  const names = (await c.listTools()).tools.map(t => t.name).sort();
  check(JSON.stringify(names) === JSON.stringify(READ), "PRIVO_READ_ONLY=1 hides the trading tools even with a key");
  await c.close();
}
{
  const r = await stdio({ PRIVO_PRIVATE_KEY: "0x1234" }).then(async c => { await c.close(); return "started"; }, () => "refused");
  check(r === "refused", "a malformed key stops the server");
}

/* ---------- 3. in process: the transactions privo_buy and privo_basket_buy build, simulated on mainnet state ---------- */
process.env.PRIVO_DATA_DIR = DATA; process.env.PRIVO_MAX_USDG = "100";
const { buildServer, makePrivo } = await import("../../mcp/privo-mcp.mjs");
const { Swap } = await import("../../src/privo-sdk.js");
const privo = makePrivo({ key });
const sent = [];
privo._send = async t => { sent.push(t); return "0x" + String(sent.length).padStart(64, "0"); };
const server = buildServer(privo);
const [ct, st] = InMemoryTransport.createLinkedPair();
const c = new Client({ name: "inproc", version: "1" });
await Promise.all([server.connect(st), c.connect(ct)]);

const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
async function slot(token, data, want) {
  const sel = data.slice(0, 10), args = data.slice(10).match(/.{64}/g).map(w => "0x" + w);
  for (let i = 0n; i < 100n; i++) {
    let k = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [args[0], i]));
    if (sel === "0xdd62ed3e") k = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [args[1], k]));
    let r; try { r = await privo.client.request({ method: "eth_call", params: [{ to: token, data }, "latest", { [token]: { stateDiff: { [k]: pad(toHex(want)) } } }] }); } catch { continue; }
    if (r && r !== "0x" && BigInt(r) === want) return k;
  }
  throw new Error("slot not found");
}
const balSlot = await slot(Swap.USDG.address, encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [addr] }), 7n);
const ov = { [Swap.USDG.address]: { stateDiff: { [balSlot]: pad(toHex(parseUnits("200", 6))) } }, [addr]: { balance: toHex(10n ** 17n) } };
const simulate = txs => privo.client.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ stateOverrides: ov, calls: txs.map(t => ({ from: addr, to: t.to, data: t.data, gas: toHex(6_000_000n) })) }], traceTransfers: true, validation: false }, "latest"] }).then(r => r[0].calls);
const into = (logs, token, to) => logs.filter(l => l.topics[0] === TRANSFER && l.address.toLowerCase() === token.toLowerCase() && ("0x" + l.topics[2].slice(26)).toLowerCase() === to.toLowerCase()).reduce((a, l) => a + BigInt(l.data), 0n);

const r1 = body(await c.callTool({ name: "privo_buy", arguments: { symbol: "TSLA", usdg: "20" } }));
const calls1 = await simulate(sent);
const got = into(calls1.at(-1).logs, Swap.MARKETS.TSLA.address, addr), fee = into(calls1.at(-1).logs, Swap.USDG.address, Swap.CONFIG.FEE_WALLET);
check(r1?.hash && sent.length === 2 && calls1.every(x => x.status === "0x1") && got > 0n && fee === 30000n,
  `privo_buy TSLA 20 USDG: approve + swap, both succeed on mainnet state; ${Number(got) / 1e18} TSLA to the agent (quoted ${r1?.quotedOut}), fee 0.03 USDG to the Safe`);

sent.length = 0;
const r2 = body(await c.callTool({ name: "privo_basket_buy", arguments: { legs: [{ sym: "NVDA", pct: 60 }, { sym: "AMD", pct: 40 }], amount: "50" } }));
const calls2 = await simulate([{ to: Swap.USDG.address, data: encodeFunctionData({ abi: parseAbi(["function approve(address,uint256)"]), functionName: "approve", args: [Swap.ADDR.PERMIT2, (1n << 256n) - 1n] }) }, ...sent]);
const s2 = calls2.at(-1);
check(r2?.hash && s2.status === "0x1" && into(s2.logs, Swap.MARKETS.NVDA.address, addr) > 0n && into(s2.logs, Swap.MARKETS.AMD.address, addr) > 0n && into(s2.logs, Swap.USDG.address, Swap.CONFIG.FEE_WALLET) === 75000n,
  "privo_basket_buy NVDA 60 / AMD 40 for 50 USDG: one swap, both stocks arrive, fee once 0.075 USDG");
await c.close();

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
