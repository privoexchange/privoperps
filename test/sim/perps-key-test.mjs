// L-2 (HEY Research review): the Orderly trading key is a non-extractable WebCrypto Ed25519 key, old hex keys
// still sign correctly, and sign-out revokes the key at Orderly with a request the key signs itself.
// Offline: Orderly is replaced by a fake fetch, nothing is sent anywhere.
import * as ed from "@noble/ed25519";
import { newOrderlyKey, signedHeaders, wsAuthParams, revokeKey, saveKey, loadKey, forgetKey } from "../../src/privo-perps.js";

let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const unb58 = s => { let n = 0n; for (const c of s) n = n * 58n + BigInt(B58.indexOf(c)); const out = []; while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; } return new Uint8Array([...Array(32 - out.length).fill(0), ...out]); };
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const pubOf = k => unb58(k.orderlyKey.slice(8));
const verifies = async (k, h, msg) => ed.verifyAsync(unb64url(h["orderly-signature"]), new TextEncoder().encode(h["orderly-timestamp"] + msg), pubOf(k));

// 1. new keys are WebCrypto and cannot be exported
const k = await newOrderlyKey();
check(!!k.ck && !k.secret && k.ck.extractable === false, "new trading key is a non-extractable WebCrypto key (no secret string)");
let exported = true; try { await crypto.subtle.exportKey("pkcs8", k.ck); } catch { exported = false; }
check(!exported, "the private key cannot be exported");
const path = "/v1/order", body = JSON.stringify({ symbol: "PERP_ETH_USDC" });
const h = await signedHeaders(k, "0xacct", "POST", path, body);
check(h["orderly-key"] === k.orderlyKey && await verifies(k, h, "POST" + path + body), "REST signature from the WebCrypto key verifies against its orderly key");
const w = await wsAuthParams(k);
check(await ed.verifyAsync(unb64url(w.sign), new TextEncoder().encode(w.timestamp), pubOf(k)), "websocket auth signature verifies");

// 2. fallback (no WebCrypto Ed25519) and old hex keys still work
const old = await newOrderlyKey({ webcrypto: false });
check(typeof old.secret === "string" && !old.ck, "fallback key is the old hex form");
const ho = await signedHeaders(old, "0xacct", "GET", "/v1/positions");
check(await verifies(old, ho, "GET/v1/positions"), "old hex key still signs correctly");
// the migration path: the same seed imported as non-extractable PKCS#8 gives the same public key's signatures
const ck = await crypto.subtle.importKey("pkcs8", Uint8Array.from(("302e020100300506032b657004220420" + old.secret).match(/../g).map(x => parseInt(x, 16))), { name: "Ed25519" }, false, ["sign"]);
const hm = await signedHeaders({ ck, orderlyKey: old.orderlyKey }, "0xacct", "GET", "/v1/positions");
check(ck.extractable === false && await verifies(old, hm, "GET/v1/positions"), "an old hex key moved into a non-extractable CryptoKey signs for the same orderly key");

// 3. storage without IndexedDB/localStorage (Node, like a private window): memory only, forget clears it
await saveKey("0xacct", k, Date.now() + 86400000);
check((await loadKey("0xacct"))?.orderlyKey === k.orderlyKey, "saved key loads back (memory fallback)");
await forgetKey("0xacct");
check((await loadKey("0xacct")) === null, "forgetKey removes it");

// 4. revoke on sign-out: one signed POST to /v1/client/remove_orderly_key naming this key
const sent = [];
globalThis.fetch = async (url, init) => { sent.push({ url: String(url), init }); return new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { "content-type": "application/json" } }); };
await saveKey("0xacct", k, Date.now() + 86400000);
const ok = await revokeKey(k, "0xacct");
const r = sent[0], rb = r?.init?.body || "";
check(ok && sent.length === 1 && r.url.endsWith("/v1/client/remove_orderly_key") && r.init.method === "POST", "revokeKey POSTs /v1/client/remove_orderly_key");
check(JSON.parse(rb).orderly_key === k.orderlyKey && r.init.headers["orderly-key"] === k.orderlyKey && await verifies(k, r.init.headers, "POST/v1/client/remove_orderly_key" + rb), "the removal names this key and is signed by it");
check((await loadKey("0xacct")) === null, "the local copy is gone after revoking");
globalThis.fetch = async () => { throw new Error("offline"); };
await saveKey("0xacct", k, Date.now() + 86400000);
check((await revokeKey(k, "0xacct")) === false && (await loadKey("0xacct")) === null, "if Orderly cannot be reached, the local copy is still deleted");

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
