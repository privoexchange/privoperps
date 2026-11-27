// PRIVO x402 client tests: the payment format (EIP-3009 USDG authorization, x402 version 1, scheme exact), privo.ai.ask
// against a small stand-in 402 server, and (live, read-only) that the real USDG contract on Robinhood Chain accepts the
// signature. Nothing is sent on chain: the live check is an eth_call of a 0-USDG transferWithAuthorization from a throwaway key.
//   node test/ai/x402-test.mjs          (add --offline to skip the live eth_call)
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseSignature, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { requirements, signPayment, readPayment, decodeHeader, encodeHeader, typedData, authorizationFor, USDG_ADDRESS, USDG_3009_ABI, NETWORK } from "../../src/privo-x402.js";
import { Privo } from "../../src/privo-sdk.js";

let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };
const FEE = "0xCc051cf47547386bA147FDDfcBCFE00E791C1418";   // the PRIVO fee wallet
const payer = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
const URL_ = "https://privoexchange.com/api/ai-pro/x402";
const sign = (req, acct = payer) => signPayment({ signTypedData: td => acct.signTypedData(td), from: acct.address, req });

console.log("payment format:");
const req = requirements({ price: 40000, payTo: FEE, resource: URL_ });
{
  check(req.scheme === "exact" && req.network === "eip155:4663" && req.maxAmountRequired === "40000" && req.asset === USDG_ADDRESS && req.extra.name === "Global Dollar" && req.extra.version === "1", "402 terms: exact, Robinhood Chain, USDG, price in 6-decimal units, the token's EIP-712 domain");
  const h = await sign(req), p = readPayment(h, req);
  check(p.ok && p.from === payer.address && p.auth.value === "40000", "a signed payment reads back: payer, fee wallet, exact price");
  check((await recoverTypedDataAddress({ ...typedData(p.auth), signature: p.signature })) === payer.address, "the signature recovers to the payer");
  check(decodeHeader(encodeHeader({ a: 1n })).a === "1" && decodeHeader("%%%") === null, "headers are base64 JSON; garbage is refused");
  check(!readPayment(await sign({ ...req, payTo: other.address }), req).ok, "a payment to anyone but the fee wallet is refused");
  check(!readPayment(await sign({ ...req, maxAmountRequired: "39999" }), req).ok, "a payment under the price is refused");
  const old = encodeHeader({ ...decodeHeader(h), payload: { ...decodeHeader(h).payload, authorization: authorizationFor({ from: payer.address, req, now: Date.now() - 700_000 }) } });
  check(/expires/.test(readPayment(old, req).error), "an expired or nearly expired payment is refused");
}

console.log("SDK client (privo.ai.ask against a stand-in server):");
{
  const seen = [];
  const server = async (u, init) => {
    const h = new Headers(init?.headers).get("x-payment");
    if (!h) return new Response(JSON.stringify({ x402Version: 1, error: "Pay for this message", accepts: [{ ...req, maxAmountRequired: JSON.parse(init.body).model === "fable" ? "150000" : "40000" }] }), { status: 402 });
    const p = readPayment(h, req); seen.push(p);
    return new Response(JSON.stringify({ say: "NVDA is up 1.5% today.", intents: [], model: "sonnet", paid: 40000 }), { status: 200,
      headers: { "x-payment-response": encodeHeader({ success: true, transaction: "0x" + "ab".repeat(32), network: NETWORK, payer: p.from }) } });
  };
  const realFetch = globalThis.fetch; globalThis.fetch = server;
  try {
    const privo = new Privo({ wallet: createWalletClient({ account: payer, transport: http("http://127.0.0.1:1") }), client: {}, logClient: {} });
    const a = await privo.ai.ask("how is NVDA doing?", { model: "sonnet", maxUsdg: 0.05 });
    check(/NVDA/.test(a.say) && a.paidUsdg === 0.04 && a.tx === "0x" + "ab".repeat(32) && seen[0]?.ok && seen[0].from === payer.address, "privo.ai.ask signs one $0.04 authorization from the bot's wallet and returns the answer and the settlement tx");
    let err = "";
    try { await privo.ai.ask("hi", { model: "fable", maxUsdg: 0.05 }); } catch (e) { err = e.message; }
    check(/above this client's limit/.test(err) && seen.length === 1, "a price above maxUsdg is refused before anything is signed");
  } finally { globalThis.fetch = realFetch; }
}

if (!process.argv.includes("--offline")) {
  console.log("live (Robinhood Chain, eth_call only):");
  const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com", { timeout: 20000 }) });
  const r0 = requirements({ price: 0, payTo: FEE, resource: URL_ });
  const p = readPayment(await sign(r0), r0);
  const { r, s, yParity } = parseSignature(p.signature);
  const data = (auth, v = 27 + yParity) => encodeFunctionData({ abi: USDG_3009_ABI, functionName: "transferWithAuthorization", args: [auth.from, auth.to, BigInt(auth.value), BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, v, r, s] });
  const call = d => client.call({ account: other.address, to: USDG_ADDRESS, data: d }).then(() => true, () => false);
  try {
    check(await call(data(p.auth)), "USDG accepts a privo-x402 signature (0-USDG transferWithAuthorization from a fresh key, simulated)");
    check(!(await call(data({ ...p.auth, to: other.address }))), "USDG rejects the same signature with another receiver");
    check(!(await call(data(p.auth, yParity ? 27 : 28))), "USDG rejects a tampered signature");
  } catch (e) { console.log("  skip  live check: " + e.message); }
}

console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
