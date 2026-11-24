// PRIVO perps through Orderly (builder model), collateral in USDG on Robinhood Chain.
// Wallet-free logic: account ID, EIP-712 messages, Orderly key signing, vault deposit calldata, REST calls.
// Sources: orderly.network/docs build-on-omnichain/user-flows/{accounts,wallet-authentication,withdrawal-deposit}
// and api-authentication (read 19 Nov 2026).
import { keccak256, encodeAbiParameters, toBytes, parseAbi, encodeFunctionData, getAddress } from "viem";
import * as ed from "@noble/ed25519";

export const PERPS_CONFIG = {
  BROKER_ID: "privo",
  API: "https://api.orderly.org",
  CHAIN_ID: 4663,
  // Orderly Vault on Robinhood Chain (from /v1/public/chain_info, contract checked on chain).
  VAULT: "0x816f722424b49cf1275cc86da9840fbd5a6167e9",
  TOKEN: "USDG",
  TOKEN_ADDRESS: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  TOKEN_DECIMALS: 6,
  // Builder ID privo is active on Orderly (20 Nov 2026).
  TRADING_ENABLED: true,
  KEY_DAYS: 30, // Orderly allows up to 365; PRIVO keeps trading keys short-lived.
  // Orderly's public websocket only accepts an existing account id in its URL; this is PRIVO's own (public) account.
  WS_ACCOUNT: "0x4f46f028a1f4ee6730edb7635ab5da91bd9bc94ab2ec3089ea00ac160e783dc4",
};
const C = PERPS_CONFIG;
const OFFCHAIN = "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC";
// Orderly ledger: verifying contract for withdraw and settle messages (Orderly js-sdk mainnetVerifyAddress).
export const LEDGER = "0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203";

/* ---------- ids and hashes ---------- */
export const brokerHash = (id = C.BROKER_ID) => keccak256(toBytes(id));
export const tokenHash = (t = C.TOKEN) => keccak256(toBytes(t));
export function accountId(address, broker = C.BROKER_ID) {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [getAddress(address), brokerHash(broker)]));
}

/* ---------- public REST ---------- */
async function api(path, init) {
  const r = await fetch(C.API + path, init);
  let j; try { j = await r.json(); } catch { throw new Error("Orderly returned HTTP " + r.status); }
  return j;
}
export async function brokerActive(id = C.BROKER_ID) {
  const j = await api("/v1/public/broker/name?broker_id=" + encodeURIComponent(id));
  return !!(j.success && j.data?.rows?.some(r => r.broker_id === id));
}
// { registered, accountId } for this wallet under the PRIVO builder.
export async function accountStatus(address) {
  const j = await api(`/v1/get_account?address=${getAddress(address)}&broker_id=${encodeURIComponent(C.BROKER_ID)}`);
  if (j.success) return { registered: true, accountId: j.data.account_id };
  if (j.code === -1607) return { registered: false, accountId: accountId(address) };
  throw new Error(j.message || "Could not check the Orderly account");
}

/* ---------- EIP-712 messages the wallet signs ---------- */
const domain = () => ({ name: "Orderly", version: "1", chainId: C.CHAIN_ID, verifyingContract: OFFCHAIN });
export async function registrationTypedData() {
  const j = await api("/v1/registration_nonce");
  if (!j.success) throw new Error(j.message || "No registration nonce");
  return { domain: domain(), primaryType: "Registration",
    types: { Registration: [{ name: "brokerId", type: "string" }, { name: "chainId", type: "uint256" }, { name: "timestamp", type: "uint64" }, { name: "registrationNonce", type: "uint256" }] },
    message: { brokerId: C.BROKER_ID, chainId: C.CHAIN_ID, timestamp: Date.now(), registrationNonce: String(j.data.registration_nonce) } };
}
export async function register(td, signature, userAddress) {
  const j = await api("/v1/register_account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: td.message, signature, userAddress }) });
  if (!j.success) throw new Error(j.message || "Registration failed");
  return j.data.account_id;
}

/* ---------- Orderly key (ed25519), kept in this browser only ---------- */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, "0")).join("");
const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const b64url = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function newOrderlyKey() {
  const secret = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(secret);
  return { secret: hex(secret), orderlyKey: "ed25519:" + base58(pub) };
}
export function addKeyTypedData(orderlyKey, days = C.KEY_DAYS) {
  const now = Date.now();
  return { domain: domain(), primaryType: "AddOrderlyKey",
    types: { AddOrderlyKey: [{ name: "brokerId", type: "string" }, { name: "chainId", type: "uint256" }, { name: "orderlyKey", type: "string" }, { name: "scope", type: "string" }, { name: "timestamp", type: "uint64" }, { name: "expiration", type: "uint64" }] },
    message: { brokerId: C.BROKER_ID, chainId: C.CHAIN_ID, orderlyKey, scope: "read,trading", timestamp: now, expiration: now + days * 86400000 } };
}
export async function addKey(td, signature, userAddress) {
  const j = await api("/v1/orderly_key", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: td.message, signature, userAddress }) });
  if (!j.success) throw new Error(j.message || "Adding the trading key failed");
  return j.data;
}

// Signed request: message = timestamp + METHOD + path(with query) + body; ed25519; base64url.
export async function signedHeaders(key, acctId, method, path, body = "") {
  const ts = Date.now();
  const sig = await ed.signAsync(new TextEncoder().encode(ts + method.toUpperCase() + path + body), unhex(key.secret));
  return { "Content-Type": method === "GET" || method === "DELETE" ? "application/x-www-form-urlencoded" : "application/json",
    "orderly-account-id": acctId, "orderly-key": key.orderlyKey, "orderly-timestamp": String(ts), "orderly-signature": b64url(sig) };
}
// Private websocket auth: the trading key signs the timestamp alone (same encoding as REST).
export async function wsAuthParams(key) {
  const ts = Date.now();
  const sig = await ed.signAsync(new TextEncoder().encode(String(ts)), unhex(key.secret));
  return { orderly_key: key.orderlyKey, sign: b64url(sig), timestamp: String(ts) };
}
export const PRIVATE_WS = "wss://ws-private-evm.orderly.org/v2/ws/private/stream/";
async function priv(key, acctId, method, path, bodyObj) {
  const body = bodyObj ? JSON.stringify(bodyObj) : "";
  const j = await api(path, { method, headers: await signedHeaders(key, acctId, method, path, body), body: body || undefined });
  if (!j.success) { const e = new Error(j.message || "Orderly request failed"); e.code = j.code; throw e; }
  return j.data;
}
export const holdings = (key, id) => priv(key, id, "GET", "/v1/client/holding");
// Deposits and withdrawals with their status (NEW, CONFIRM, PROCESSING, COMPLETED, FAILED…).
export const assetHistory = (key, id, side) => priv(key, id, "GET", "/v1/asset/history" + (side ? "?side=" + side : ""));
export const positions = (key, id) => priv(key, id, "GET", "/v1/positions");
export function marketOrder(key, id, { symbol, side, qty, reduceOnly = false }) {
  if (!C.TRADING_ENABLED) throw new Error("Perps order entry is not enabled yet");
  return priv(key, id, "POST", "/v1/order", { symbol, order_type: "MARKET", side, order_quantity: qty, reduce_only: reduceOnly });
}

/* ---------- order sizing ---------- */
export const perpSymbol = sym => "PERP_" + sym + "_USDC";
const infoCache = {};
export async function symbolInfo(symbol) {
  if (infoCache[symbol]) return infoCache[symbol];
  const j = await api("/v1/public/info/" + symbol);
  if (!j.success) throw new Error(j.message || "No market info for " + symbol);
  return (infoCache[symbol] = { baseTick: +j.data.base_tick, baseMin: +j.data.base_min, baseMax: +j.data.base_max, minNotional: +j.data.min_notional, quoteTick: +j.data.quote_tick, mmr: +j.data.base_mmr || 0.05, maxLev: Math.max(1, Math.floor(1 / (+j.data.base_imr || 1) + 1e-9)) });
}
export function roundPrice(px, info) {
  const dec = Math.max(0, Math.round(-Math.log10(info.quoteTick)));
  return +(Math.round(px / info.quoteTick) * info.quoteTick).toFixed(dec);
}
// Rough liquidation price for a new position on this collateral alone (cross margin, one position).
export function liqEstimate({ side, qty, entry, collateral, mmr }) {
  if (!(qty > 0) || !(entry > 0)) return null;
  const p = side === "BUY" ? (entry * qty - collateral) / (qty * (1 - mmr)) : (entry * qty + collateral) / (qty * (1 + mmr));
  return p > 0 ? p : null;
}
export function limitOrder(key, id, { symbol, side, qty, price, reduceOnly = false }) {
  if (!C.TRADING_ENABLED) throw new Error("Perps order entry is not enabled yet");
  return priv(key, id, "POST", "/v1/order", { symbol, order_type: "LIMIT", side, order_price: price, order_quantity: qty, reduce_only: reduceOnly });
}
// Any regular order: MARKET, LIMIT, POST_ONLY (maker only) or IOC (fill now, cancel the rest).
export function placeOrder(key, id, { symbol, side, qty, type = "MARKET", price, reduceOnly = false }) {
  if (!C.TRADING_ENABLED) throw new Error("Perps order entry is not enabled yet");
  const body = { symbol, order_type: type, side, order_quantity: qty, reduce_only: reduceOnly };
  if (type !== "MARKET") body.order_price = price;
  return priv(key, id, "POST", "/v1/order", body);
}
export const openOrders = (key, id) => priv(key, id, "GET", "/v1/orders?status=INCOMPLETE");
export const cancelAll = (key, id, symbol) => priv(key, id, "DELETE", "/v1/orders" + (symbol ? "?symbol=" + symbol : ""));

/* ---------- algo orders: stop, take profit / stop loss, bracket (trigger on Orderly's mark price) ---------- */
// Stop market (or stop limit when price is given): fires once the mark crosses trigger.
export function stopOrder(key, id, { symbol, side, qty, trigger, price, reduceOnly = false }) {
  const body = { symbol, algo_type: "STOP", type: price ? "LIMIT" : "MARKET", side, quantity: qty, trigger_price: trigger, trigger_price_type: "MARK_PRICE", reduce_only: reduceOnly };
  if (price) body.price = price;
  return priv(key, id, "POST", "/v1/algo/order", body);
}
// Children that close the whole position at the take-profit and/or stop-loss trigger. closeSide is the opposite of the position.
export function tpslChildren(symbol, closeSide, { tp, sl }) {
  const out = [];
  if (tp) out.push({ symbol, algo_type: "TAKE_PROFIT", side: closeSide, type: "CLOSE_POSITION", trigger_price_type: "MARK_PRICE", trigger_price: tp, reduce_only: true });
  if (sl) out.push({ symbol, algo_type: "STOP_LOSS", side: closeSide, type: "CLOSE_POSITION", trigger_price_type: "MARK_PRICE", trigger_price: sl, reduce_only: true });
  return out;
}
// TP/SL on an open position (covers the full position, whatever its size later).
export function positionTpSl(key, id, { symbol, closeSide, tp, sl }) {
  return priv(key, id, "POST", "/v1/algo/order", { symbol, algo_type: "POSITIONAL_TP_SL", trigger_price_type: "MARK_PRICE", child_orders: tpslChildren(symbol, closeSide, { tp, sl }) });
}
// Limit order that arms TP/SL on the resulting position once it fills.
export function bracketOrder(key, id, { symbol, side, qty, price, tp, sl }) {
  const closeSide = side === "BUY" ? "SELL" : "BUY";
  return priv(key, id, "POST", "/v1/algo/order", { symbol, algo_type: "BRACKET", side, type: "LIMIT", price, quantity: qty,
    child_orders: [{ symbol, algo_type: "POSITIONAL_TP_SL", child_orders: tpslChildren(symbol, closeSide, { tp, sl }) }] });
}
export const algoOrders = (key, id) => priv(key, id, "GET", "/v1/algo/orders?status=INCOMPLETE");
export const cancelAlgo = (key, id, orderId, symbol) => priv(key, id, "DELETE", "/v1/algo/order?order_id=" + orderId + "&symbol=" + symbol);
export const cancelAllAlgo = (key, id, symbol) => priv(key, id, "DELETE", "/v1/algo/orders" + (symbol ? "?symbol=" + symbol : ""));
// Flattens one algo order into the parts the UI shows: { kind: "TP"|"SL"|"STOP"|"BRACKET", trigger, price, side, qty }.
export function algoParts(o) {
  const kids = [], walk = x => { for (const c of x.child_orders || []) { kids.push(c); walk(c); } };
  walk(o);
  const pick = t => kids.find(c => c.algo_type === t);
  const tp = pick("TAKE_PROFIT"), sl = pick("STOP_LOSS");
  return { tp: tp ? +tp.trigger_price : null, sl: sl ? +sl.trigger_price : null, trigger: o.trigger_price != null ? +o.trigger_price : null };
}
// Closed (and partly closed) positions with realized PnL, average open/close price and leverage.
export const positionHistory = (key, id, limit = 50) => priv(key, id, "GET", "/v1/position_history?limit=" + limit);
export const fundingHistory = (key, id) => priv(key, id, "GET", "/v1/funding_fee/history");
export const cancelOrder = (key, id, orderId, symbol) => priv(key, id, "DELETE", "/v1/order?order_id=" + orderId + "&symbol=" + symbol);
export const tradeHistory = (key, id) => priv(key, id, "GET", "/v1/trades");
export const clientInfo = (key, id) => priv(key, id, "GET", "/v1/client/info");
// Leverage per market (cross margin): list [{ symbol, leverage }] and set one. Orderly caps it at 1 / base_imr.
export const leverages = (key, id) => priv(key, id, "GET", "/v1/client/leverages");
export const setLeverage = (key, id, symbol, leverage) => priv(key, id, "POST", "/v1/client/leverage", { symbol, leverage });
export async function futures(symbol) {
  const j = await api("/v1/public/futures/" + symbol);
  if (!j.success) throw new Error(j.message || "No data for " + symbol);
  return j.data;
}
// Size in USDG at the mark price -> base quantity rounded down to the market's tick.
export function sizeToQty(notional, mark, info) {
  if (!(notional > 0) || !(mark > 0)) return 0;
  const dec = Math.max(0, Math.round(-Math.log10(info.baseTick)));
  const q = Math.floor(notional / mark / info.baseTick + 1e-9) * info.baseTick;
  return +q.toFixed(dec);
}
// Checks a new order against the market rules and the free margin at the chosen leverage. Returns an error text or "".
export function checkOrder({ qty, mark, info, avail, lev }) {
  if (!(qty > 0)) return "Enter a size";
  if (qty < info.baseMin) return "Smallest size is " + info.baseMin;
  if (qty > info.baseMax) return "Largest size is " + info.baseMax;
  if (qty * mark < info.minNotional) return "Smallest order is " + info.minNotional + " USDG";
  if (qty * mark > avail + 1e-9) return "At " + lev + "x you can open up to " + Math.max(0, avail).toFixed(2) + " USDG more";
  return "";
}

/* ---------- withdraw and settle (signed by the wallet, ledger domain) ---------- */
const ledgerDomain = () => ({ name: "Orderly", version: "1", chainId: C.CHAIN_ID, verifyingContract: LEDGER });
export async function tokenFees(token = C.TOKEN) {
  const j = await api("/v1/public/token");
  const t = j.data?.rows?.find(r => r.token === token);
  const c = t?.chain_details?.find(x => String(x.chain_id) === String(C.CHAIN_ID));
  return { withdrawFee: c ? +c.withdrawal_fee : 1, minWithdraw: t ? +t.minimum_withdraw_amount : 0 };
}
export async function withdrawTypedData(key, id, receiver, amount) {
  const d = await priv(key, id, "GET", "/v1/withdraw_nonce");
  return { domain: ledgerDomain(), primaryType: "Withdraw",
    types: { Withdraw: [{ name: "brokerId", type: "string" }, { name: "chainId", type: "uint256" }, { name: "receiver", type: "address" }, { name: "token", type: "string" }, { name: "amount", type: "uint256" }, { name: "withdrawNonce", type: "uint64" }, { name: "timestamp", type: "uint64" }] },
    message: { brokerId: C.BROKER_ID, chainId: BigInt(C.CHAIN_ID), receiver: getAddress(receiver), token: C.TOKEN, amount: BigInt(amount), withdrawNonce: BigInt(d.withdraw_nonce), timestamp: BigInt(Date.now()) } };
}
export function withdrawBody(td, signature, userAddress) {
  const m = td.message;
  return { message: { brokerId: m.brokerId, chainId: Number(m.chainId), receiver: m.receiver, token: m.token, amount: m.amount.toString(), withdrawNonce: Number(m.withdrawNonce), timestamp: Number(m.timestamp), chainType: "EVM" },
    signature, userAddress: getAddress(userAddress), verifyingContract: LEDGER };
}
export const withdraw = (key, id, td, signature, userAddress) => priv(key, id, "POST", "/v1/withdraw_request", withdrawBody(td, signature, userAddress));

export async function settleTypedData(key, id) {
  const d = await priv(key, id, "GET", "/v1/settle_nonce");
  return { domain: ledgerDomain(), primaryType: "SettlePnl",
    types: { SettlePnl: [{ name: "brokerId", type: "string" }, { name: "chainId", type: "uint256" }, { name: "settleNonce", type: "uint64" }, { name: "timestamp", type: "uint64" }] },
    message: { brokerId: C.BROKER_ID, chainId: BigInt(C.CHAIN_ID), settleNonce: BigInt(d.settle_nonce), timestamp: BigInt(Date.now()) } };
}
export function settleBody(td, signature, userAddress) {
  const m = td.message;
  return { message: { brokerId: m.brokerId, chainId: Number(m.chainId), settleNonce: Number(m.settleNonce), timestamp: Number(m.timestamp), chainType: "EVM" },
    signature, userAddress: getAddress(userAddress), verifyingContract: LEDGER };
}
export const settlePnl = (key, id, td, signature, userAddress) => priv(key, id, "POST", "/v1/settle_pnl", settleBody(td, signature, userAddress));

/* ---------- deposit into the Orderly vault on Robinhood Chain ---------- */
export const VAULT_ABI = parseAbi([
  "function getDepositFee(address receiver, (bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) data) view returns (uint256)",
  "function deposit((bytes32 accountId, bytes32 brokerHash, bytes32 tokenHash, uint128 tokenAmount) data) payable",
]);
export function depositData(address, amount, broker = C.BROKER_ID) {
  return { accountId: accountId(address, broker), brokerHash: brokerHash(broker), tokenHash: tokenHash(), tokenAmount: amount };
}
export async function depositFee(client, address, amount, broker) {
  return client.readContract({ address: C.VAULT, abi: VAULT_ABI, functionName: "getDepositFee", args: [getAddress(address), depositData(address, amount, broker)] });
}
export function depositTx(address, amount, fee, broker) {
  return { to: getAddress(C.VAULT), value: fee, data: encodeFunctionData({ abi: VAULT_ABI, functionName: "deposit", args: [depositData(address, amount, broker)] }) };
}

/* ---------- key storage (per wallet, this browser) ---------- */
const KEY_PREFIX = "privo-orderly-key:";
export function loadKey(acctId) {
  try { const k = JSON.parse(localStorage.getItem(KEY_PREFIX + acctId) || "null"); return k && k.expires > Date.now() + 60000 ? k : null; } catch { return null; }
}
export function saveKey(acctId, key, expires) { try { localStorage.setItem(KEY_PREFIX + acctId, JSON.stringify({ ...key, expires })); } catch {} }
export function forgetKey(acctId) { try { localStorage.removeItem(KEY_PREFIX + acctId); } catch {} }
