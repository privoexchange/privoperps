// PRIVO SDK for agents and bots on Robinhood Chain (chain 4663). Every trade is signed by the bot's own wallet:
// PRIVO never holds keys or funds. Spot swaps go through the Uniswap Universal Router with the 0.15% PRIVO fee set in
// the signed swap, perps through Orderly under PRIVO's builder account, block trades through the PrivoBlockDesk contract.
//
//   import { Privo } from "./privo-sdk.js";            // or from the privoperps package
//   const privo = new Privo({ wallet });                // wallet: a viem WalletClient with an account
//   await privo.spot.buy("TSLA", "100");                // spend 100 USDG on TSLA
//   const { key } = await privo.perps.connect();        // once; store key.secret somewhere safe
//   await privo.perps.order({ sym: "ETH", side: "BUY", qty: 0.01 });
//   await privo.orders.limit({ sym: "TSLA", side: "buy", amount: "100", price: 370 });  // never pays more than 370 per token
//   await privo.baskets.buy({ legs: ["AAPL", "MSFT", "NVDA"], amount: "90" });         // 30 USDG each, one transaction
//   await privo.baskets.sell({ legs: ["AAPL", "MSFT", "NVDA"], pct: 50 });              // half of each, to USDG
import { encodeFunctionData, getAddress, isAddress, parseAbi, parseUnits, formatUnits } from "viem";
import * as Swap from "./privo-swap.js";
import * as Perps from "./privo-perps.js";
import * as Desk from "./privo-desk.js";
import * as Orders from "./privo-orders.js";

export { Swap, Perps, Desk, Orders };
export const API = "https://privoexchange.com/api/v1";
const ERC20 = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "HTTP " + r.status + " from " + url);
  return j;
}

export class Privo {
  /**
   * @param {object} o
   * @param {import("viem").WalletClient} [o.wallet]  signs transactions and messages (needed for trading, not for reads)
   * @param {import("viem").PublicClient} [o.client]  reads chain state (default: PRIVO's RPC list)
   * @param {import("viem").PublicClient} [o.logClient]  reads Block desk settlement logs (default: Robinhood Chain's RPC)
   * @param {{orderlyKey: string, secret: string}} [o.perpsKey]  a trading key saved from perps.connect()
   * @param {number} [o.slippageBps]  spot slippage limit, 1..500 (default 50 = 0.5%)
   * @param {string} [o.api]  read API base (default https://privoexchange.com/api/v1)
   */
  constructor({ wallet = null, client = null, logClient = null, perpsKey = null, slippageBps = 50, api = API } = {}) {
    this.wallet = wallet;
    this.client = client || Swap.makeClient();
    this.logClient = logClient || Desk.makeLogClient();
    this._settling = new Set(); // block requests with a settle in flight or done, locked before the first await
    this.api = api;
    this.slippageBps = slippageBps;
    this._key = perpsKey;
    this._acct = null;
    this.spot = { quote: (s, side, amt) => this._quote(s, side, amt), buy: (s, usdg) => this._swap(s, "buy", usdg), sell: (s, qty) => this._swap(s, "sell", qty) };
    this.perps = { connect: o => this._perpsConnect(o), deposit: a => this._perpsDeposit(a), order: o => this._perpsOrder(o), positions: () => this._perps(Perps.positions),
      openOrders: () => this._perps(Perps.openOrders), cancel: (orderId, sym) => this._perps((k, id) => Perps.cancelOrder(k, id, orderId, Perps.perpSymbol(sym))),
      holdings: () => this._perps(Perps.holdings), revokeKey: () => this._perps((k, id) => Perps.revokeKey(k, id)) };
    this.orders = { limit: o => this._orderPlace({ ...o, slices: 1 }), twap: o => this._orderPlace(o), state: rec => Orders.orderState(this.client, Orders.fromJson(rec.order)), cancel: rec => this._send(Orders.cancelTx(rec.order.nonce)),
      // approval left to the PrivoOrders contract for a token (default USDG), and setting it to `keep` (default 0):
      // after a cancel or expiry, lower it to what the bot's still-open orders need
      approval: (token = Swap.USDG.address) => Orders.approval(this.client, this._need(), token),
      revoke: (token = Swap.USDG.address, keep = 0n) => this._send(Orders.approveTx(token, BigInt(keep))) };
    this.baskets = { quote: o => this._basketQuote(o), buy: o => this._basketBuy(o), quoteSell: o => this._basketSellQuote(o), sell: o => this._basketSell(o),
      link: (legs, name) => Swap.basketLink(this._legs(legs), { name }), parse: link => Swap.parseBasketLink(link) };
    this.block = { request: o => this._blockRequest(o), answer: (link, price, o) => this._blockAnswer(link, price, o), check: (req, codes) => this._blockCheck(req, codes), settle: (req, quote) => this._blockSettle(req, quote) };
  }

  get address() { return this.wallet?.account ? getAddress(this.wallet.account.address) : null; }
  _need() { if (!this.address) throw new Error("Pass a wallet (viem WalletClient with an account) to trade"); return this.address; }
  async _send(tx) {
    const from = this._need();
    const gas = await this.client.estimateGas({ account: from, to: tx.to, data: tx.data, value: tx.value || 0n });
    const hash = await this.wallet.sendTransaction({ account: this.wallet.account, chain: Swap.CHAIN, to: tx.to, data: tx.data, value: tx.value || 0n, gas: gas * 12n / 10n });
    const rc = await this.client.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("Transaction reverted: " + hash);
    return hash;
  }

  /* ---------- read API (no wallet needed) ---------- */
  markets() { return getJson(this.api + "/markets"); }
  prices() { return getJson(this.api + "/prices"); }
  arena() { return getJson(this.api + "/arena"); }

  /* ---------- spot (Uniswap, PRIVO fee in the signed swap) ---------- */
  // amount: USDG to spend when buying, tokens to sell when selling (decimal strings).
  async _quote(sym, side, amount) {
    if (!Object.hasOwn(Swap.MARKETS, sym)) throw new Error("Unknown spot market " + sym);
    const raw = parseUnits(String(amount), side === "buy" ? Swap.USDG.decimals : Swap.decimalsOf(sym));
    const q = await Swap.quote(this.client, { sym, side, amount: raw });
    const outDec = side === "buy" ? Swap.decimalsOf(sym) : Swap.USDG.decimals;
    return { ...q, out: formatUnits(q.netOut, outDec), feeUsdg: formatUnits(q.fee, Swap.USDG.decimals), route: Swap.routeLabel(q.pool) };
  }
  async _swap(sym, side, amount) {
    const me = this._need();
    const q = await this._quote(sym, side, amount);
    let permit = null;
    if (!(side === "sell" && Swap.isNative(sym))) {
      const token = side === "buy" ? Swap.USDG.address : Swap.MARKETS[sym].address;
      const st = await Swap.approvalState(this.client, me, token, q.amount);
      if (st.needErc20Approve) await this._send(Swap.approveTx(token)); // one time per token, to Permit2
      if (st.needPermit) {
        const td = Swap.permitTypedData({ token, amount: q.amount, nonce: st.nonce });
        permit = { message: td.message, signature: await this.wallet.signTypedData({ account: this.wallet.account, ...td }) };
      }
    }
    const tx = Swap.buildSwap(q, { slippageBps: this.slippageBps, permit });
    const hash = await this._send(tx);
    return { hash, sym, side, quotedOut: q.out, feeUsdg: q.feeUsdg, route: q.route };
  }

  /* ---------- baskets (2 to 8 stock tokens in one router call, PRIVO fee once) ---------- */
  // legs: ["AAPL", "MSFT"] for equal shares, [{ sym, pct }] with shares in percent adding up to 100, or a basket share link.
  _legs(legs) {
    if (typeof legs === "string") return Swap.parseBasketLink(legs).legs;
    if (!Array.isArray(legs) || !legs.length) throw new Error("legs: a list of stock symbols, [{ sym, pct }], or a basket link");
    if (legs.every(l => typeof l === "string")) {
      const b = Math.floor(10000 / legs.length), r = 10000 - b * legs.length;
      return legs.map((sym, i) => ({ sym, w: b + (i < r ? 1 : 0) }));
    }
    return legs.map(l => ({ sym: l.sym, w: l.w ?? Math.round(Number(l.pct) * 100) }));
  }
  // amount: USDG to spend in total (decimal string)
  async _basketQuote({ legs, amount }) {
    const q = await Swap.quoteBasket(this.client, { legs: this._legs(legs), amount: parseUnits(String(amount), Swap.USDG.decimals) });
    return { ...q, feeUsdg: formatUnits(q.fee, Swap.USDG.decimals),
      out: q.legs.map(l => ({ sym: l.sym, usdg: formatUnits(l.swapIn, Swap.USDG.decimals), tokens: formatUnits(l.grossOut, Swap.decimalsOf(l.sym)), route: Swap.routeLabel(l.pool) })) };
  }
  // One transaction: every stock lands in the wallet at or above its own slippage floor, or nothing is bought.
  async _basketBuy({ legs, amount }) {
    const me = this._need(), q = await this._basketQuote({ legs, amount });
    const st = await Swap.approvalState(this.client, me, Swap.USDG.address, q.amount);
    if (st.needErc20Approve) await this._send(Swap.approveTx(Swap.USDG.address));
    let permit = null;
    if (st.needPermit) {
      const td = Swap.permitTypedData({ token: Swap.USDG.address, amount: q.amount, nonce: st.nonce });
      permit = { message: td.message, signature: await this.wallet.signTypedData({ account: this.wallet.account, ...td }) };
    }
    const hash = await this._send(Swap.buildBasket(q, { slippageBps: this.slippageBps, permit }));
    return { hash, feeUsdg: q.feeUsdg, legs: q.out };
  }
  // legs: symbols (sells pct% of the wallet's balance of each, default 100) or [{ sym, qty }] with token amounts.
  async _sellLegs({ legs, pct = 100 }) {
    if (!(pct > 0 && pct <= 100)) throw new Error("pct is above 0 and at most 100");
    if (!Array.isArray(legs) || !legs.length) throw new Error("legs: stock symbols, or [{ sym, qty }]");
    const me = this._need();
    return Promise.all(legs.map(async l => {
      const sym = typeof l === "string" ? l : l.sym;
      if (!Object.hasOwn(Swap.MARKETS, sym)) throw new Error("Unknown spot market " + sym);
      if (typeof l !== "string" && l.qty != null) return { sym, amount: parseUnits(String(l.qty), Swap.decimalsOf(sym)) };
      const bal = await this.client.readContract({ address: Swap.MARKETS[sym].address, abi: ERC20, functionName: "balanceOf", args: [me] });
      return { sym, amount: bal * BigInt(Math.round(pct * 100)) / 10000n };
    }));
  }
  async _basketSellQuote(o) {
    const q = await Swap.quoteBasketSell(this.client, { legs: await this._sellLegs(o) });
    return { ...q, outUsdg: formatUnits(q.netOut, Swap.USDG.decimals), feeUsdg: formatUnits(q.fee, Swap.USDG.decimals),
      out: q.legs.map(l => ({ sym: l.sym, tokens: formatUnits(l.amount, Swap.decimalsOf(l.sym)), usdg: formatUnits(l.grossOut, Swap.USDG.decimals), route: Swap.routeLabel(l.pool) })) };
  }
  // One transaction under one Permit2 PermitBatch signature: each stock sells on its own pool with its own floor, the fee is
  // taken once, the rest of the USDG goes to the wallet, or nothing is sold. Each stock token is approved to Permit2 once.
  async _basketSell(o) {
    const me = this._need(), q = await this._basketSellQuote(o);
    const items = [];
    for (const l of q.legs) {
      const token = Swap.MARKETS[l.sym].address, st = await Swap.approvalState(this.client, me, token, l.amount);
      if (st.needErc20Approve) await this._send(Swap.approveTx(token));
      if (st.needPermit) items.push({ token, amount: l.amount, nonce: st.nonce });
    }
    let permit = null;
    if (items.length) {
      const td = Swap.permitBatchTypedData({ items });
      permit = { message: td.message, signature: await this.wallet.signTypedData({ account: this.wallet.account, ...td }) };
    }
    const hash = await this._send(Swap.buildBasketSell(q, { slippageBps: this.slippageBps, permit }));
    return { hash, quotedUsdg: q.outUsdg, feeUsdg: q.feeUsdg, legs: q.out };
  }

  /* ---------- perps (Orderly, PRIVO builder account) ---------- */
  // Registers the wallet under PRIVO if needed and adds a trading key (30 days, read + trading, cannot withdraw).
  // Returns { accountId, key }: keep key.secret private and pass it back as perpsKey next time.
  async _perpsConnect({ key = null } = {}) {
    const me = this._need();
    let st = await Perps.accountStatus(me);
    if (!st.registered) {
      const td = await Perps.registrationTypedData();
      const sig = await this.wallet.signTypedData({ account: this.wallet.account, ...td, message: { ...td.message, registrationNonce: BigInt(td.message.registrationNonce) } });
      await Perps.register(td, sig, me);
      st = await Perps.accountStatus(me);
    }
    if (!key) {
      key = await Perps.newOrderlyKey({ webcrypto: false }); // hex form, so a bot can store it
      const td = Perps.addKeyTypedData(key.orderlyKey);
      await Perps.addKey(td, await this.wallet.signTypedData({ account: this.wallet.account, ...td }), me);
    }
    this._key = key; this._acct = st.accountId;
    return { accountId: st.accountId, key };
  }
  async _perps(fn) {
    if (!this._key) throw new Error("Call perps.connect() first, or pass perpsKey");
    if (!this._acct) this._acct = (await Perps.accountStatus(this._need())).accountId;
    return fn(this._key, this._acct);
  }
  // Moves USDG from the wallet into perps margin (Orderly vault). amount: decimal string.
  async _perpsDeposit(amount) {
    const me = this._need(), C = Perps.PERPS_CONFIG;
    const raw = parseUnits(String(amount), C.TOKEN_DECIMALS);
    const have = await this.client.readContract({ address: C.TOKEN_ADDRESS, abi: ERC20, functionName: "allowance", args: [me, C.VAULT] });
    if (have < raw) await this._send({ to: C.TOKEN_ADDRESS, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [C.VAULT, raw] }) });
    const fee = await Perps.depositFee(this.client, me, raw);
    return this._send(Perps.depositTx(me, raw, fee));
  }
  // { sym: "ETH", side: "BUY"|"SELL", qty, type: "MARKET"|"LIMIT"|"POST_ONLY"|"IOC", price?, reduceOnly? }
  _perpsOrder({ sym, side, qty, type = "MARKET", price, reduceOnly = false }) {
    if (side !== "BUY" && side !== "SELL") throw new Error("side is BUY or SELL");
    if (!(+qty > 0)) throw new Error("qty must be above 0");
    return this._perps((k, id) => Perps.placeOrder(k, id, { symbol: Perps.perpSymbol(sym), side, qty: +qty, type, price, reduceOnly }));
  }

  /* ---------- limit orders and TWAP (PrivoOrders contract, filled by PRIVO's keeper) ---------- */
  // { sym, side: "buy"|"sell", amount (USDG to spend, or stock tokens to sell), price (worst USDG per stock token), slices?, every? (seconds), days? }
  // Approves the contract, signs the order (no gas) and hands it to PRIVO's keeper. Returns { hash, order, signature }: keep
  // it to check state or cancel. Every fill pays at least `price`; the keeper fills through the best pool, but the contract
  // lets the filler fill anywhere between the market and `price`, so set `price` to the worst price you accept. Prices and
  // amounts are per stock token. Nothing fills after the deadline. The filler is always PRIVO's keeper, pinned in privo-orders.js.
  async _orderPlace({ sym, side, amount, price, slices = 1, every = 900, days = 7 }) {
    const me = this._need();
    const url = this.api.replace(/\/v1\/?$/, "") + "/orders"; // https://privoexchange.com/api/orders
    const info = await getJson(url);
    if (!info.keeper) throw new Error("Limit orders are not live yet");
    if (!isAddress(info.keeper) || getAddress(info.keeper) !== Orders.KEEPER) throw new Error("The order API named an unexpected keeper; not signing");
    const amountIn = parseUnits(String(amount), side === "buy" ? Swap.USDG.decimals : Swap.STOCK_DECIMALS);
    const o = Orders.newOrder({ maker: me, filler: Orders.KEEPER, sym, side, amountIn, minAmountOut: Orders.minOutForPrice(side, amountIn, price), slices, interval: slices > 1 ? every : 0, hours: days * 24 });
    if (!(await this.client.getCode({ address: Orders.ORDERS }))) throw new Error("The PrivoOrders contract is not deployed yet");
    // sign first (no gas) and check it the way the contract will (ERC-1271 for wallets with code, EIP-7702 included)
    const signature = await this.wallet.signTypedData({ account: this.wallet.account, ...Orders.orderTypedData(o) });
    const sc = await Orders.signatureFillable(this.client, o, signature);
    if (!sc.ok) throw new Error(sc.reason);
    const allowance = await Orders.approval(this.client, me, o.tokenIn);
    if (allowance < (1n << 200n)) await this._send(Orders.approveTx(o.tokenIn, allowance + o.amountIn));
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ order: Orders.toJson(o), signature }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "PRIVO could not take the order");
    return { hash: j.hash, order: Orders.toJson(o), signature };
  }

  /* ---------- block desk (sealed quotes, one-transaction settlement) ---------- */
  // Maker: { side: "sell"|"buy", sym, qty, limit?, hours? } -> { request, link }
  _blockRequest(o) {
    const request = Desk.newRequest({ maker: this._need(), ...o });
    return { request, link: Desk.requestLink(request, "https://privoexchange.com/app.html") };
  }
  // Taker: approves the exact amount, signs a quote at `price` USDG per share, returns the code to send to the maker.
  async _blockAnswer(link, price, { hours } = {}) {
    const me = this._need(), r = Desk.parseRequest(link);
    const q = Desk.buildQuote(r, me, String(price), { hours });
    if (await Desk.needsApproval(this.client, me, q.takerToken, q.takerAmount)) await this._send(Desk.approveTx(q.takerToken, q.takerAmount));
    const sig = await this.wallet.signTypedData({ account: this.wallet.account, ...Desk.quoteTypedData(q) });
    return { quote: q, code: Desk.encodeQuote(q, sig) };
  }
  // Maker: checks every quote code against the request and the chain; best valid quote first.
  async _blockCheck(request, codes) {
    const qs = Desk.decodeQuotes(Array.isArray(codes) ? codes.join(" ") : codes);
    const [rows, done] = await Promise.all([Promise.all(qs.map(async x => ({ ...x, ...(await Desk.checkQuote(this.client, request, x)) }))), Desk.requestSettled(this.logClient, request.id)]);
    if (done) for (const r of rows) { r.ok = false; r.problems = ["This request already settled", ...r.problems]; }
    const better = (a, b) => request.side === "sell" ? b.terms.price - a.terms.price : a.terms.price - b.terms.price;
    return rows.sort((a, b) => (a.ok === b.ok ? better(a, b) : a.ok ? -1 : 1));
  }
  // Maker: settles one checked quote (both legs move in one transaction).
  async _blockSettle(request, quote) {
    // One settle per request from this instance, even when two calls start together: the lock is taken before any await.
    const id = request.id;
    if (this._settling.has(id)) throw new Error("This request is already being settled or has settled");
    this._settling.add(id);
    try { return await this._blockSettleOnce(request, quote); }
    catch (e) { this._settling.delete(id); throw e; }
  }
  async _blockSettleOnce(request, quote) {
    const c = await Desk.checkQuote(this.client, request, quote);
    if (!c.ok) throw new Error("Quote failed its checks: " + c.problems.join(", "));
    // The contract allows more than one settle per request; the SDK sends at most one.
    if (await Desk.requestSettled(this.logClient, request.id)) throw new Error("This request already settled. Only one quote can fill it.");
    const ap = Desk.makerApproval(quote.q, request.side);
    if (await Desk.needsApproval(this.client, this._need(), ap.token, ap.amount)) await this._send(Desk.approveTx(ap.token, ap.amount));
    return this._send(Desk.settleTx(quote));
  }
}
