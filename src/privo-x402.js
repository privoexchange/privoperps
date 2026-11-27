// PRIVO x402: pay a PRIVO API request with one signed USDG authorization, the HTTP 402 way.
// Used by the server (netlify/lib/aipro.mjs), the SDK (privo.ai.ask), the MCP server (privo_ai) and the tests.
//
// How it works (x402 version 1, scheme "exact"):
//   1. The client POSTs without payment. The server answers 402 with { x402Version, error, accepts: [requirements] }:
//      the price in USDG (6 decimals), the receiver (the PRIVO fee wallet) and the token's EIP-712 domain.
//   2. The client signs an EIP-3009 TransferWithAuthorization for that price (one signature, no gas, no approval) and
//      sends the same request again with the header X-PAYMENT: base64(JSON { x402Version, scheme, network, payload }).
//   3. The server checks the signature and simulates the transfer, does the work, then submits the transfer on chain
//      and pays the gas. Only once the transfer is confirmed does the client get the answer, with X-PAYMENT-RESPONSE.
//      If the work fails, nothing is submitted and the same signed payment can be sent again.
// USDG on Robinhood Chain (0x5fc5…d168) implements EIP-3009 with the EIP-712 domain { name "Global Dollar", version "1" }.
import { getAddress, isAddress } from "viem";

export const X402_VERSION = 1;
export const CHAIN_ID = 4663;
export const NETWORK = "eip155:4663";                 // Robinhood Chain, CAIP-2
export const USDG_ADDRESS = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDG_DOMAIN = { name: "Global Dollar", version: "1", chainId: CHAIN_ID, verifyingContract: USDG_ADDRESS };
export const MAX_TIMEOUT_S = 600;                     // how long a signed payment stays valid
export const MIN_LEFT_S = 90;                         // the server needs at least this long to answer and settle
export const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};
export const USDG_3009_ABI = [
  { type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable", outputs: [], inputs: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
  { type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ type: "bool" }] },
];

// What the server asks for in its 402 answer. price is in USDG micro-units (6 decimals), so 2000 = $0.002.
export function requirements({ price, payTo, resource, description = "" }) {
  return {
    scheme: "exact", network: NETWORK, maxAmountRequired: String(BigInt(price)), resource, description,
    mimeType: "application/json", payTo: getAddress(payTo), maxTimeoutSeconds: MAX_TIMEOUT_S, asset: USDG_ADDRESS,
    extra: { name: USDG_DOMAIN.name, version: USDG_DOMAIN.version },
  };
}

const b64 = {
  enc: s => (typeof Buffer !== "undefined" ? Buffer.from(s, "utf8").toString("base64") : btoa(unescape(encodeURIComponent(s)))),
  dec: s => (typeof Buffer !== "undefined" ? Buffer.from(s, "base64").toString("utf8") : decodeURIComponent(escape(atob(s)))),
};
export const encodeHeader = obj => b64.enc(JSON.stringify(obj, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
export function decodeHeader(s) {
  try { const o = JSON.parse(b64.dec(String(s || "").trim())); return o && typeof o === "object" ? o : null; } catch { return null; }
}

function randomNonce() {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return "0x" + Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

// The authorization a client signs for one set of requirements.
export function authorizationFor({ from, req, now = Date.now(), nonce = randomNonce() }) {
  const t = Math.floor(now / 1000);
  const timeout = Math.min(Number(req.maxTimeoutSeconds) || MAX_TIMEOUT_S, MAX_TIMEOUT_S);
  return { from: getAddress(from), to: getAddress(req.payTo), value: String(BigInt(req.maxAmountRequired)),
    validAfter: String(t - 60), validBefore: String(t + timeout), nonce };
}
export const typedData = auth => ({
  domain: USDG_DOMAIN, types: TYPES, primaryType: "TransferWithAuthorization",
  message: { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
});

// Client side: sign one payment. signTypedData is viem's ({ domain, types, primaryType, message }) -> signature.
export async function signPayment({ signTypedData, from, req, now }) {
  const authorization = authorizationFor({ from, req, now });
  const signature = await signTypedData(typedData(authorization));
  return encodeHeader({ x402Version: X402_VERSION, scheme: "exact", network: NETWORK, payload: { signature, authorization } });
}

// Client side: fetch a PRIVO endpoint, paying the 402 once if its price is within maxPrice (micro-USDG).
// Returns { res, body, paid: { price, transaction } | null }. Throws if the price is above maxPrice or the terms are not USDG.
export async function payFetch(url, init, { signTypedData, from, maxPrice, fetchFn = fetch }) {
  let res = await fetchFn(url, init);
  if (res.status !== 402) return { res, body: await res.json().catch(() => null), paid: null };
  const ask = await res.json().catch(() => null);
  const req = (ask?.accepts || []).find(a => a.scheme === "exact" && a.network === NETWORK && String(a.asset).toLowerCase() === USDG_ADDRESS.toLowerCase());
  if (!req) throw new Error(ask?.error || "The server asked for a payment this client cannot make");
  const price = BigInt(req.maxAmountRequired);
  if (maxPrice != null && price > BigInt(maxPrice)) throw new Error(`The price is $${fmt(price)} USDG, above this client's limit of $${fmt(BigInt(maxPrice))}. Nothing was signed.`);
  const header = await signPayment({ signTypedData, from, req });
  res = await fetchFn(url, { ...init, headers: { ...(init?.headers || {}), "X-PAYMENT": header } });
  const body = await res.json().catch(() => null);
  const receipt = decodeHeader(res.headers.get("x-payment-response"));
  return { res, body, paid: res.ok ? { price: Number(price), transaction: receipt?.transaction || null } : null };
}
const fmt = micro => (Number(micro) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");

// Server side: read an X-PAYMENT header and check it against the requirements, without touching the chain.
// -> { ok, from, auth, signature } or { error }. The signature itself is checked by the caller (recoverTypedDataAddress).
export function readPayment(header, req, now = Date.now()) {
  const p = decodeHeader(header);
  if (!p) return { error: "The X-PAYMENT header is not base64 JSON" };
  if (Number(p.x402Version) !== X402_VERSION || p.scheme !== "exact") return { error: "Only x402 version 1, scheme exact is accepted" };
  if (p.network !== NETWORK) return { error: "Pay on Robinhood Chain (" + NETWORK + ")" };
  const a = p.payload?.authorization, signature = p.payload?.signature;
  if (!a || typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return { error: "The payment has no authorization or no 65-byte signature" };
  if (![a.from, a.to].every(x => isAddress(String(x || ""))) || !/^0x[0-9a-fA-F]{64}$/.test(String(a.nonce || ""))) return { error: "The authorization is malformed" };
  let value, after, before;
  try { value = BigInt(a.value); after = BigInt(a.validAfter); before = BigInt(a.validBefore); } catch { return { error: "The authorization is malformed" }; }
  if (getAddress(a.to) !== getAddress(req.payTo)) return { error: "The payment must go to the PRIVO fee wallet " + getAddress(req.payTo) };
  if (value < BigInt(req.maxAmountRequired)) return { error: `The payment is less than the price ($${fmt(BigInt(req.maxAmountRequired))} USDG)` };
  if (value > BigInt(req.maxAmountRequired) * 2n) return { error: "The payment is more than twice the price; sign the exact price" };
  const t = BigInt(Math.floor(now / 1000));
  if (after > t) return { error: "The payment is not valid yet" };
  if (before < t + BigInt(MIN_LEFT_S)) return { error: "The payment expires too soon; sign a new one" };
  if (before > t + BigInt(MAX_TIMEOUT_S) + 60n) return { error: "The payment stays valid too long; at most " + MAX_TIMEOUT_S + " seconds" };
  const auth = { from: getAddress(a.from), to: getAddress(a.to), value: String(value), validAfter: String(after), validBefore: String(before), nonce: a.nonce.toLowerCase() };
  return { ok: true, from: auth.from, auth, signature };
}
