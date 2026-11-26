#!/usr/bin/env node
// PRIVO MCP server: lets an AI agent read PRIVO markets and trade on PRIVO (Robinhood Chain, chain 4663) with its own wallet,
// over the Model Context Protocol (stdio). It wraps the PRIVO SDK, so every trade is the same signed transaction the app
// sends: spot through Uniswap with the 0.15% PRIVO fee, baskets, limit and TWAP orders through PrivoOrders, and Orderly perps.
// The key never leaves this machine and is never returned to the agent. PRIVO never holds keys or funds.
//
// Environment:
//   PRIVO_PRIVATE_KEY      the agent's own wallet key (0x...). Without it the server is read-only.
//   PRIVO_MAX_USDG         largest trade the agent may make, in USDG (default 100). Buys count what is spent, sells what the
//                          quote says comes back, perps deposits their amount.
//   PRIVO_MAX_PERPS_USDG   largest perps order notional at the mark price, in USDG (default 5x PRIVO_MAX_USDG)
//   PRIVO_SLIPPAGE_BPS     spot and basket slippage limit, 1..500 (default 50 = 0.5%)
//   PRIVO_READ_ONLY        1 to offer only the read tools even with a key
//   PRIVO_RPC              comma-separated Robinhood Chain RPC URLs (default: PRIVO's list)
//   PRIVO_DATA_DIR         where the perps trading key and placed orders are kept (default ~/.privo-mcp)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createWalletClient, http, formatUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Privo, Swap, Perps } from "../src/privo-sdk.js";

export const VERSION = "1.0.0";
const E = process.env;
const num = (v, d) => (v != null && v !== "" && Number.isFinite(+v) ? +v : d);
export const LIMITS = { maxUsdg: num(E.PRIVO_MAX_USDG, 100) };
LIMITS.maxPerps = num(E.PRIVO_MAX_PERPS_USDG, LIMITS.maxUsdg * 5);
const SLIP = num(E.PRIVO_SLIPPAGE_BPS, 50);
if (!(SLIP >= 1 && SLIP <= 500)) throw new Error("PRIVO_SLIPPAGE_BPS is 1..500");
const RPCS = E.PRIVO_RPC ? E.PRIVO_RPC.split(",").map(s => s.trim()).filter(Boolean) : Swap.CHAIN.rpcUrls.default.http;
const DIR = E.PRIVO_DATA_DIR || join(homedir(), ".privo-mcp");

/* ---------- wallet and SDK ---------- */
export function makePrivo({ key = E.PRIVO_PRIVATE_KEY, client = null } = {}) {
  let wallet = null;
  if (key) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key.trim())) throw new Error("PRIVO_PRIVATE_KEY must be 0x followed by 64 hex characters");
    wallet = createWalletClient({ account: privateKeyToAccount(key.trim()), chain: Swap.CHAIN, transport: http(RPCS[0], { timeout: 30000 }) });
  }
  const privo = new Privo({ wallet, client: client || Swap.makeClient(RPCS), slippageBps: SLIP });
  return privo;
}

/* ---------- small local store (perps key, placed orders), readable only by this user ---------- */
const file = (kind, addr) => join(DIR, `${kind}-${addr.toLowerCase()}.json`);
function load(kind, addr, d) { try { return JSON.parse(readFileSync(file(kind, addr), "utf8")); } catch { return d; } }
function save(kind, addr, v) {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(file(kind, addr), JSON.stringify(v, null, 2), { mode: 0o600 });
  try { chmodSync(file(kind, addr), 0o600); } catch {}
}

/* ---------- helpers ---------- */
const json = v => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const ok = v => ({ content: [{ type: "text", text: json(v) }] });
const fail = e => ({ isError: true, content: [{ type: "text", text: String(e?.shortMessage || e?.message || e) }] });
const wrap = fn => async a => { try { return ok(await fn(a)); } catch (e) { return fail(e); } };
const sym = z.string().describe("Market symbol, for example TSLA, NVDA, ETH or BTC (see privo_markets)");
const dec = z.string().regex(/^\d+(\.\d+)?$/, "a positive decimal number as a string, like \"25\" or \"0.5\"");
const tx = h => ({ hash: h, explorer: "https://explorer.mainnet.chain.robinhood.com/tx/" + h });
function market(s) {
  const m = Swap.MARKETS[s];
  if (!m) throw new Error(`Unknown market ${s}. Call privo_markets for the list.`);
  return m;
}
export function capCheck(usdg, max, what) {
  if (!(Number(usdg) <= max)) throw new Error(`${what} is ${Number(usdg).toFixed(2)} USDG, above this agent's limit of ${max} USDG (PRIVO_MAX_USDG / PRIVO_MAX_PERPS_USDG). Nothing was sent.`);
}
const minOut = (q, dec) => formatUnits(q.netOut * BigInt(10000 - SLIP) / 10000n, dec);

/* ---------- the server ---------- */
export function buildServer(privo = makePrivo(), { readOnly = E.PRIVO_READ_ONLY === "1" } = {}) {
  const me = privo.address;
  const trading = !!me && !readOnly;
  const server = new McpServer({ name: "privo", version: VERSION }, {
    instructions: "PRIVO is a trading layer on Robinhood Chain (chain 4663) for stock tokens and crypto. Prices are in USDG (a USD stablecoin, 6 decimals); gas is paid in ETH. " +
      "Stock tokens follow a stock's price and are not shares. Always quote before trading and tell the user the price, the minimum received and the fee. " +
      (trading ? `This server trades from wallet ${me}, up to ${LIMITS.maxUsdg} USDG per trade. Every trade is real and on chain.` : "This server is read-only: no wallet key is set, or PRIVO_READ_ONLY=1."),
  });
  const RO = { readOnlyHint: true, openWorldHint: true };
  const RW = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
  let perpsKey = me ? load("perps-key", me, null) : null;
  if (perpsKey) privo._key = perpsKey;
  const orders = () => (me ? load("orders", me, []) : []);

  /* ----- reads ----- */
  server.registerTool("privo_markets", { title: "List PRIVO markets", annotations: RO,
    description: "Every PRIVO spot market (stock tokens, ETH, BTC, memecoins) with its token address, kind and perps symbol, plus PRIVO's fees and contract addresses." },
  wrap(async () => {
    const m = await privo.markets();
    return { quote: m.quote, fees: m.fees, contracts: m.contracts, markets: m.markets.map(x => ({ sym: x.sym, kind: x.kind, meme: x.meme || undefined, token: x.token, perp: x.perp || null })) };
  }));

  server.registerTool("privo_prices", { title: "Get prices", annotations: RO,
    description: "Pool price, 24h change, volume and depth for spot markets, and Orderly mark, index and funding for perps. Pass symbols to filter. A pool price can be null for a moment when the price feed is busy; privo_quote always reads the pool on chain.",
    inputSchema: { symbols: z.array(z.string()).optional().describe("Only these symbols, for example [\"TSLA\",\"NVDA\"]") } },
  wrap(async ({ symbols }) => {
    const p = await privo.prices();
    return { at: p.at, prices: symbols?.length ? Object.fromEntries(symbols.map(s => [s, p.prices[s] ?? null])) : p.prices };
  }));

  server.registerTool("privo_arena", { title: "Arena leaderboard", annotations: RO,
    description: "PRIVO Arena: traders ranked by realized return after fees (never sizes), and recent PRIVO trades." },
  wrap(() => privo.arena()));

  server.registerTool("privo_wallet", { title: "Wallet and limits", annotations: RO,
    description: "This agent's wallet address, its non-zero balances on Robinhood Chain (ETH, USDG and every PRIVO token), and its trade limits." },
  wrap(async () => {
    if (!me) return { wallet: null, readOnly: true, note: "No PRIVO_PRIVATE_KEY set: read-only." };
    const b = await Swap.balances(privo.client, me);
    const bal = Object.fromEntries(Object.entries(b).filter(([, v]) => v > 0n).map(([k, v]) => [k, formatUnits(v, k === "USDG" ? 6 : k === "ETH" ? 18 : Swap.decimalsOf(k))]));
    return { wallet: me, chainId: Swap.CHAIN.id, balances: bal, limits: { maxTradeUsdg: LIMITS.maxUsdg, maxPerpsNotionalUsdg: LIMITS.maxPerps, slippageBps: SLIP }, trading, perpsConnected: !!perpsKey };
  }));

  server.registerTool("privo_quote", { title: "Quote a spot trade", annotations: RO,
    description: "Quote a spot buy or sell on Uniswap with the 0.15% PRIVO fee, without trading. Buy amount is USDG to spend; sell amount is tokens to sell.",
    inputSchema: { symbol: sym, side: z.enum(["buy", "sell"]), amount: dec.describe("USDG to spend (buy) or tokens to sell (sell)") } },
  wrap(async ({ symbol, side, amount }) => {
    market(symbol);
    const q = await privo.spot.quote(symbol, side, amount);
    const outDec = side === "buy" ? Swap.decimalsOf(symbol) : 6;
    return { symbol, side, amountIn: amount, inToken: side === "buy" ? "USDG" : symbol, estimatedOut: q.out, minimumOut: minOut(q, outDec), outToken: side === "buy" ? symbol : "USDG", privoFeeUsdg: q.feeUsdg, route: q.route, slippageBps: SLIP };
  }));

  const legsSchema = z.union([z.array(z.string()).min(2).max(8), z.array(z.object({ sym: z.string(), pct: z.number().positive() })).min(2).max(8), z.string().url()])
    .describe("2 to 8 stock symbols for equal shares, [{ sym, pct }] with pct adding up to 100, or a PRIVO basket share link");
  server.registerTool("privo_quote_basket", { title: "Quote a basket buy", annotations: RO,
    description: "Quote spending one USDG amount across 2 to 8 stock tokens in one transaction, with the PRIVO fee taken once.",
    inputSchema: { legs: legsSchema, amount: dec.describe("USDG to spend in total") } },
  wrap(async ({ legs, amount }) => { const q = await privo.baskets.quote({ legs, amount }); return { amount, privoFeeUsdg: q.feeUsdg, legs: q.out }; }));

  /* ----- trading ----- */
  if (trading) {
    server.registerTool("privo_buy", { title: "Buy on spot", annotations: RW,
      description: "Spend USDG on a spot market through Uniswap from this agent's wallet (real, on chain). Approves Permit2 once per token if needed. Quote first with privo_quote.",
      inputSchema: { symbol: sym, usdg: dec.describe("USDG to spend") } },
    wrap(async ({ symbol, usdg }) => {
      market(symbol); capCheck(usdg, LIMITS.maxUsdg, "This buy");
      const r = await privo.spot.buy(symbol, usdg);
      return { ...tx(r.hash), symbol, side: "buy", spentUsdg: usdg, quotedOut: r.quotedOut, privoFeeUsdg: r.feeUsdg, route: r.route };
    }));

    server.registerTool("privo_sell", { title: "Sell on spot", annotations: RW,
      description: "Sell tokens for USDG through Uniswap from this agent's wallet (real, on chain). amount is tokens, or \"all\" for the whole balance.",
      inputSchema: { symbol: sym, amount: z.union([dec, z.literal("all")]).describe("Tokens to sell, or \"all\"") } },
    wrap(async ({ symbol, amount }) => {
      const m = market(symbol);
      if (amount === "all") {
        if (m.native) throw new Error("Give an ETH amount: \"all\" would leave nothing for gas");
        const b = await Swap.balances(privo.client, me);
        if (!(b[symbol] > 0n)) throw new Error("This wallet holds no " + symbol);
        amount = formatUnits(b[symbol], Swap.decimalsOf(symbol));
      }
      const q = await privo.spot.quote(symbol, "sell", amount);
      capCheck(q.out, LIMITS.maxUsdg, "This sale");
      const r = await privo.spot.sell(symbol, amount);
      return { ...tx(r.hash), symbol, side: "sell", sold: amount, quotedUsdg: r.quotedOut, privoFeeUsdg: r.feeUsdg, route: r.route };
    }));

    server.registerTool("privo_basket_buy", { title: "Buy a basket", annotations: RW,
      description: "Spend one USDG amount across 2 to 8 stock tokens in one transaction (real, on chain). Each stock has its own slippage floor; if any cannot fill, nothing is bought.",
      inputSchema: { legs: legsSchema, amount: dec.describe("USDG to spend in total") } },
    wrap(async ({ legs, amount }) => {
      capCheck(amount, LIMITS.maxUsdg, "This basket");
      const r = await privo.baskets.buy({ legs, amount });
      return { ...tx(r.hash), spentUsdg: amount, privoFeeUsdg: r.feeUsdg, legs: r.legs };
    }));

    server.registerTool("privo_basket_sell", { title: "Sell a basket", annotations: RW,
      description: "Sell a share of several stock tokens for USDG in one transaction under one Permit2 signature (real, on chain). If any stock cannot fill, nothing is sold.",
      inputSchema: { symbols: z.array(z.string()).min(2).max(8).describe("Stock symbols held by this wallet"), pct: z.number().positive().max(100).default(100).describe("Percent of each balance to sell") } },
    wrap(async ({ symbols, pct }) => {
      const q = await privo.baskets.quoteSell({ legs: symbols, pct });
      capCheck(q.outUsdg, LIMITS.maxUsdg, "This basket sale");
      const r = await privo.baskets.sell({ legs: symbols, pct });
      return { ...tx(r.hash), quotedUsdg: r.quotedUsdg, privoFeeUsdg: r.feeUsdg, legs: r.legs };
    }));

    const rebalIn = { legs: z.union([z.array(z.string()).min(2).max(8), z.array(z.object({ sym: z.string(), pct: z.number().positive(), qty: dec.optional().describe("Tokens of this stock in the basket (default: the wallet's whole balance)") })).min(2).max(8), z.string().url()])
        .describe("The target shares: 2 to 8 stock symbols for equal shares, [{ sym, pct, qty? }] with pct adding up to 100, or a basket share link"),
      min_drift_pct: z.number().min(0.01).max(20).default(0.5).describe("Only stocks off target by more than this share of the basket are traded") };
    const rebalQuote = async ({ legs, min_drift_pct }) => {
      const q = await privo.baskets.quoteRebalance({ legs, minDriftBps: Math.round(min_drift_pct * 100) });
      return { q, view: { sold: q.sold, bought: q.bought, shares: q.shares, proceedsUsdg: q.proceedsUsdg, spentOnBuysUsdg: q.buysUsdg, privoFeeUsdg: q.feeUsdg, slippageBps: SLIP } };
    };
    server.registerTool("privo_quote_rebalance", { title: "Quote a basket rebalance", annotations: RO,
      description: "Quote bringing stock tokens this wallet holds back to target shares, without trading: what would be sold, what bought, and each share now and after.",
      inputSchema: rebalIn }, wrap(async a => (await rebalQuote(a)).view));
    server.registerTool("privo_basket_rebalance", { title: "Rebalance a basket", annotations: RW,
      description: "Bring stock tokens this wallet holds back to target shares in one transaction (real, on chain): sells what is above target, takes the 0.15% PRIVO fee once on the proceeds, and buys what is below target with them. If any stock cannot fill, nothing changes.",
      inputSchema: rebalIn },
    wrap(async a => {
      const { q } = await rebalQuote(a);
      capCheck(q.proceedsUsdg, LIMITS.maxUsdg, "This rebalance");
      const r = await privo.baskets.rebalance({ legs: a.legs, minDriftBps: Math.round(a.min_drift_pct * 100) });
      return { ...tx(r.hash), sold: r.sold, bought: r.bought, shares: r.shares, privoFeeUsdg: r.feeUsdg };
    }));

    const orderIn = { symbol: sym.describe("A stock token symbol (limit and TWAP take stock tokens only)"), side: z.enum(["buy", "sell"]),
      amount: dec.describe("USDG to spend (buy) or stock tokens to sell (sell)"), price: z.number().positive().describe("Worst USDG per stock token you accept: a buy never pays more, a sell never gets less"),
      days: z.number().positive().max(30).default(7).describe("How long the order stays open, up to 30 days") };
    const place = async ({ symbol, side, amount, price, slices = 1, every_minutes = 15, days }) => {
      const m = market(symbol);
      if (m.kind !== "stock") throw new Error("Limit and TWAP orders take stock tokens only");
      capCheck(side === "buy" ? amount : Number(amount) * price, LIMITS.maxUsdg, "This order");
      const rec = await (slices > 1 ? privo.orders.twap({ sym: symbol, side, amount, price, slices, every: Math.round(every_minutes * 60), days }) : privo.orders.limit({ sym: symbol, side, amount, price, days }));
      const list = orders(); list.push({ ...rec, sym: symbol, side, amount, price, slices, placedAt: new Date().toISOString() }); save("orders", me, list);
      return { orderId: String(rec.order.nonce), symbol, side, amount, price, slices, approvalHash: rec.hash || null, note: "Signed and handed to PRIVO's keeper. Your tokens stay in your wallet until a slice fills." };
    };
    server.registerTool("privo_limit_order", { title: "Place a limit order", annotations: RW,
      description: "Buy or sell a stock token at your price through the PrivoOrders contract. Approves the contract for the amount (one transaction), then signs the order with no gas. PRIVO's keeper fills it when the pool allows, never worse than price.",
      inputSchema: orderIn }, wrap(a => place(a)));
    server.registerTool("privo_twap_order", { title: "Place a TWAP order", annotations: RW,
      description: "Split a stock token buy or sell into slices over time through the PrivoOrders contract. Every slice fills at or better than price.",
      inputSchema: { ...orderIn, slices: z.number().int().min(2).max(100), every_minutes: z.number().min(1).describe("Minutes between slices, at least 1") } }, wrap(a => place(a)));

    server.registerTool("privo_orders", { title: "List my orders", annotations: RO,
      description: "Limit and TWAP orders this server placed, with how much has filled and whether each is open, done, cancelled or expired." },
    wrap(async () => Promise.all(orders().map(async r => {
      let state; try { state = await privo.orders.state(r); } catch (e) { state = { error: e.message }; }
      return { orderId: String(r.order.nonce), symbol: r.sym, side: r.side, amount: r.amount, price: r.price, slices: r.slices, placedAt: r.placedAt, state };
    }))));

    server.registerTool("privo_cancel_order", { title: "Cancel an order", annotations: RW,
      description: "Cancel a limit or TWAP order (one transaction). Unfilled slices can no longer fill.",
      inputSchema: { orderId: z.string().describe("orderId from privo_orders") } },
    wrap(async ({ orderId }) => {
      const r = orders().find(o => String(o.order.nonce) === orderId);
      if (!r) throw new Error("No order " + orderId + " placed from this server");
      return { ...tx(await privo.orders.cancel(r)), orderId, cancelled: true };
    }));

    /* ----- perps (Orderly) ----- */
    server.registerTool("privo_perps_connect", { title: "Connect perps", annotations: RW,
      description: "Register this wallet for PRIVO perps on Orderly (if needed) and add a 30-day trading key. The key can place and cancel orders, never withdraw; it is saved on this machine and never shown." },
    wrap(async () => {
      const r = await privo.perps.connect(perpsKey ? { key: perpsKey } : {});
      perpsKey = r.key; save("perps-key", me, r.key);
      return { accountId: r.accountId, connected: true };
    }));

    server.registerTool("privo_perps_deposit", { title: "Deposit perps margin", annotations: RW,
      description: "Move USDG from this wallet into perps margin at Orderly (real, on chain).",
      inputSchema: { usdg: dec.describe("USDG to deposit") } },
    wrap(async ({ usdg }) => { capCheck(usdg, LIMITS.maxUsdg, "This deposit"); return { ...tx(await privo.perps.deposit(usdg)), depositedUsdg: usdg }; }));

    server.registerTool("privo_perps_order", { title: "Place a perps order", annotations: RW,
      description: "Place a perps order on Orderly. qty is in the base asset (for example 0.01 ETH). Leveraged trades can lose all margin.",
      inputSchema: { symbol: sym, side: z.enum(["BUY", "SELL"]), qty: z.number().positive(), type: z.enum(["MARKET", "LIMIT", "POST_ONLY", "IOC"]).default("MARKET"),
        price: z.number().positive().optional().describe("Needed for LIMIT, POST_ONLY and IOC"), reduceOnly: z.boolean().default(false) } },
    wrap(async ({ symbol, side, qty, type, price, reduceOnly }) => {
      if (type !== "MARKET" && !price) throw new Error(type + " orders need a price");
      const f = await Perps.futures(Perps.perpSymbol(symbol));
      const mark = +(f.mark_price ?? f.markPrice);
      if (!reduceOnly) capCheck(qty * Math.max(mark, price || 0), LIMITS.maxPerps, "This perps order's notional");
      return { order: await privo.perps.order({ sym: symbol, side, qty, type, price, reduceOnly }), markPrice: mark };
    }));

    server.registerTool("privo_perps_account", { title: "Perps account", annotations: RO,
      description: "Perps positions, open orders and margin holdings at Orderly." },
    wrap(async () => ({ positions: await privo.perps.positions(), openOrders: await privo.perps.openOrders(), holdings: await privo.perps.holdings() })));

    server.registerTool("privo_perps_cancel", { title: "Cancel a perps order", annotations: RW,
      description: "Cancel an open perps order on Orderly.",
      inputSchema: { orderId: z.union([z.string(), z.number()]), symbol: sym } },
    wrap(async ({ orderId, symbol }) => privo.perps.cancel(Number(orderId), symbol)));
  }
  return server;
}

/* ---------- run over stdio ---------- */
if (!E.PRIVO_MCP_NO_START) { // tests import buildServer with PRIVO_MCP_NO_START=1
  const privo = makePrivo();
  const server = buildServer(privo);
  await server.connect(new StdioServerTransport());
  console.error(`PRIVO MCP ${VERSION} on Robinhood Chain: ${privo.address ? "trading from " + getAddress(privo.address) + ", up to " + LIMITS.maxUsdg + " USDG per trade" : "read-only"}`);
}
