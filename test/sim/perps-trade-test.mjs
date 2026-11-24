// Checks PRIVO's Orderly order sizing, withdraw and settle messages without real funds.
//   node test/sim/perps-trade-test.mjs
// Uses a throwaway local key to sign; Orderly's private endpoints are stubbed, public ones are real.
import { recoverTypedDataAddress, getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as ed from "@noble/ed25519";
import * as P from "../../src/privo-perps.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ok    " : "  FAIL  ") + m); if (!c) fail++; };

// 1. market rules from the real API
for (const s of ["TSLA", "NVDA", "ETH", "BTC"]) {
  const i = await P.symbolInfo(P.perpSymbol(s));
  ok(i.baseTick > 0 && i.baseMin > 0 && i.minNotional > 0, `${s}: tick ${i.baseTick}, min ${i.baseMin}, min notional ${i.minNotional}`);
}
const tsla = await P.symbolInfo("PERP_TSLA_USDC"), btc = await P.symbolInfo("PERP_BTC_USDC");
ok(P.sizeToQty(20, 391.44, tsla) === 0.05, "20 USDC of TSLA at 391.44 -> 0.05 (rounded down to tick)");
ok(P.sizeToQty(20, 92000, btc) === 0.00021, "20 USDC of BTC at 92,000 -> 0.00021");
ok(P.checkOrder({ qty: 0.02, mark: 391.44, info: tsla, avail: 100, lev: 2 }).includes("Smallest order"), "under 10 USDC notional is refused");
ok(P.checkOrder({ qty: 0.3, mark: 391.44, info: tsla, avail: 100, lev: 2 }).includes("At 2x"), "117 USDC with 50 free margin at 2x is refused");
ok(P.checkOrder({ qty: 0.2, mark: 391.44, info: tsla, avail: 100, lev: 2 }) === "", "78 USDC with 50 free margin at 2x is allowed");
ok(P.checkOrder({ qty: 0.1, mark: 391.44, info: tsla, avail: 30, lev: 2 }).includes("At 2x"), "margin already used by positions lowers what can be opened");

const fees = await P.tokenFees();
ok(fees.withdrawFee === 1, "USDG withdraw fee on Robinhood Chain from the API: " + fees.withdrawFee + " USDG");

// 2. withdraw + settle against stubbed private endpoints
const acct = privateKeyToAccount(generatePrivateKey());
const key = await P.newOrderlyKey();
const id = P.accountId(acct.address);
const seen = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const path = String(url).replace(P.PERPS_CONFIG.API, "");
  if (!/withdraw|settle/.test(path)) return realFetch(url, init);
  seen.push({ path, init });
  const h = init.headers;
  const msg = h["orderly-timestamp"] + (init.method || "GET") + path + (init.body || "");
  const sig = Uint8Array.from(atob(h["orderly-signature"].replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const pub = await ed.getPublicKeyAsync(Uint8Array.from(key.secret.match(/../g).map(x => parseInt(x, 16))));
  const good = await ed.verifyAsync(sig, new TextEncoder().encode(msg), pub);
  const data = path === "/v1/withdraw_nonce" ? { withdraw_nonce: 7 } : path === "/v1/settle_nonce" ? { settle_nonce: 3 } : path === "/v1/withdraw_request" ? { withdraw_id: 99 } : {};
  return new Response(JSON.stringify(good ? { success: true, data } : { success: false, message: "bad request signature" }));
};

const td = await P.withdrawTypedData(key, id, acct.address, 25_000_000n);
ok(td.domain.verifyingContract === P.LEDGER && td.domain.chainId === 4663, "withdraw domain: Orderly ledger, chain 4663");
ok(td.message.withdrawNonce === 7n && td.message.amount === 25_000_000n && td.message.token === "USDG" && td.message.brokerId === "privo", "withdraw message: nonce from API, 25 USDG raw, token USDG, broker privo");
const sig = await acct.signTypedData(td);
ok(getAddress(await recoverTypedDataAddress({ ...td, signature: sig })) === acct.address, "withdraw signature recovers to the wallet");
const r = await P.withdraw(key, id, td, sig, acct.address);
ok(r.withdraw_id === 99, "withdraw request accepted by the stub with a valid request signature");
const body = JSON.parse(seen.at(-1).init.body);
ok(body.verifyingContract === P.LEDGER && body.userAddress === acct.address && body.signature === sig, "body has signature, userAddress, verifyingContract");
ok(body.message.amount === "25000000" && body.message.withdrawNonce === 7 && body.message.chainId === 4663 && body.message.chainType === "EVM" && typeof body.message.timestamp === "number", "body message matches the Orderly SDK shape (amount string, chainType EVM)");

const st = await P.settleTypedData(key, id);
const ssig = await acct.signTypedData(st);
ok(getAddress(await recoverTypedDataAddress({ ...st, signature: ssig })) === acct.address && st.message.settleNonce === 3n, "settle PnL message signs and recovers, nonce from API");
await P.settlePnl(key, id, st, ssig, acct.address);
const sb = JSON.parse(seen.at(-1).init.body);
ok(seen.at(-1).path === "/v1/settle_pnl" && sb.message.settleNonce === 3 && sb.verifyingContract === P.LEDGER, "settle request body is well formed");

// 3. the real API refuses an unregistered account (no funds involved)
globalThis.fetch = realFetch;
try { await P.withdrawTypedData(key, id, acct.address, 1n); ok(false, "real API should refuse an unknown key"); }
catch (e) { ok(true, "real API refuses an unregistered key: " + e.message.slice(0, 80)); }

console.log(fail ? `\n${fail} check(s) failed` : "\nall checks passed");
process.exit(fail ? 1 : 0);
