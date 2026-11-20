// Checks privo-perps.js without creating any Orderly account and without sending anything.
//  - account ID formula against real deposit() calls on the Orderly vault (same address on Arbitrum)
//  - deposit fee and deposit call as eth_call (balance and allowance faked by state override),
//    with an existing builder (passes) and with "privo" while it is not active (should be refused)
//  - Orderly key: ed25519 signing, base58 key format, and the EIP-712 messages
import { createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionData, encodeAbiParameters, keccak256, toBytes, pad, toHex, parseUnits, getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as ed from "@noble/ed25519";
import { PERPS_CONFIG as C, accountId, brokerHash, tokenHash, depositFee, depositTx, newOrderlyKey, signedHeaders, addKeyTypedData, base58, brokerActive, VAULT_ABI } from "../../src/privo-perps.js";

const pub = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { timeout: 30000 }) });
let bad = 0;
const check = (cond, msg) => { console.log((cond ? "  ok    " : "  FAIL  ") + msg); if (!cond) bad++; };

// 1. Account ID formula: decode real deposit() calls on the same vault on Arbitrum (busier than 4663)
//    and recompute each account ID from the sender and the builder hash in the call.
const arb = createPublicClient({ transport: http("https://arb1.arbitrum.io/rpc", { timeout: 30000 }) });
{
  let to = await arb.getBlockNumber(), n = 0, ok = 0; const seen = new Set();
  for (let i = 0; i < 40 && n < 3; i++, to -= 2000n) for (const l of await arb.getLogs({ address: C.VAULT, fromBlock: to - 1999n, toBlock: to })) {
    if (n >= 3 || seen.has(l.transactionHash)) continue; seen.add(l.transactionHash);
    const tx = await arb.getTransaction({ hash: l.transactionHash });
    let d; try { d = decodeFunctionData({ abi: VAULT_ABI, data: tx.input }); } catch { continue; }
    if (d.functionName !== "deposit") continue;
    n++; if (keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [tx.from, d.args[0].brokerHash])) === d.args[0].accountId) ok++;
  }
  check(n > 0 && ok === n, `account ID = keccak(abi.encode(wallet, keccak(builderId))) matches ${ok} of ${n} real vault deposits`);
  check(accountId("0x0000000000000000000000000000000000000001", "woofi_pro") === keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], ["0x0000000000000000000000000000000000000001", keccak256(toBytes("woofi_pro"))])), "accountId() helper uses that formula");
}

// 2. Deposit as eth_call with an existing builder and with "privo".
const user = privateKeyToAccount(generatePrivateKey()).address;
const amount = parseUnits("25", 6);
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
async function slot(data, want = 7n) {
  const al = await pub.request({ method: "eth_createAccessList", params: [{ to: C.TOKEN_ADDRESS, data }, "latest"] });
  for (const e of al.accessList) for (const k of e.storageKeys) {
    try { const r = await pub.request({ method: "eth_call", params: [{ to: C.TOKEN_ADDRESS, data }, "latest", { [e.address]: { stateDiff: { [k]: pad(toHex(want)) } } }] }); if (r !== "0x" && BigInt(r) === want) return { a: e.address, k }; } catch {}
  }
  throw new Error("slot not found");
}
const b = await slot(encodeFunctionData({ abi: erc, functionName: "balanceOf", args: [user] }));
const a = await slot(encodeFunctionData({ abi: erc, functionName: "allowance", args: [user, getAddress(C.VAULT)] }));
const ov = { [b.a]: { stateDiff: { [b.k]: pad(toHex(amount)), ...(a.a === b.a ? { [a.k]: pad(toHex(amount)) } : {}) } }, [user]: { balance: toHex(10n ** 18n) } };
if (a.a !== b.a) ov[a.a] = { stateDiff: { [a.k]: pad(toHex(amount)) } };
async function simDeposit(broker) {
  let fee;
  try { fee = await depositFee(pub, user, amount, broker); } catch (e) { return { ok: false, why: "fee: " + (e.shortMessage || e.message).slice(0, 70) }; }
  const tx = depositTx(user, amount, fee, broker);
  try { await pub.request({ method: "eth_call", params: [{ from: user, to: tx.to, data: tx.data, value: toHex(fee), gas: toHex(2_000_000n) }, "latest", ov] }); return { ok: true, fee }; }
  catch (e) { return { ok: false, fee, why: (e.details || e.shortMessage || e.message).slice(0, 90) }; }
}
const known = "woofi_pro";
const r1 = await simDeposit(known);
check(r1.ok, `deposit of 25 USDG under an active builder (${known}) goes through: fee ${r1.fee ?? "?"} wei${r1.ok ? "" : " | " + r1.why}`);
const active = await brokerActive();
const onchain = await pub.readContract({ address: C.VAULT, abi: parseAbi(["function getAllowedBroker(bytes32) view returns (bool)"]), functionName: "getAllowedBroker", args: [brokerHash()] });
const r2 = await simDeposit(C.BROKER_ID);
check(onchain ? r2.ok : !r2.ok, `builder "${C.BROKER_ID}": Orderly API active ${active}, vault allows it ${onchain}; deposit ${r2.ok ? "goes through" : "refused (" + r2.why + ")"}`);
const r3 = await simDeposit("zz_not_a_builder");
check(!r3.ok, "deposit under an unknown builder is refused: " + (r3.why || ""));

// 3. Orderly key and messages.
const key = await newOrderlyKey();
check(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(key.orderlyKey), "Orderly key is ed25519:<base58 public key> " + key.orderlyKey.slice(0, 20) + "…");
check(base58(new Uint8Array([0, 0, 1])) === "112", "base58 keeps leading zero bytes");
const h = await signedHeaders(key, "0xabc", "POST", "/v1/order", '{"a":1}');
const msg = new TextEncoder().encode(h["orderly-timestamp"] + "POST/v1/order" + '{"a":1}');
const sig = Uint8Array.from(atob(h["orderly-signature"].replace(/-/g, "+").replace(/_/g, "/") + "=="), c => c.charCodeAt(0));
const pubKey = await ed.getPublicKeyAsync(Uint8Array.from(key.secret.match(/../g).map(x => parseInt(x, 16))));
check(await ed.verifyAsync(sig, msg, pubKey), "request signature verifies over timestamp + method + path + body (base64url)");
const td = addKeyTypedData(key.orderlyKey);
const wallet = privateKeyToAccount(generatePrivateKey());
const s712 = await wallet.signTypedData(td);
check(s712.length === 132 && td.message.scope === "read,trading" && td.message.expiration - td.message.timestamp === C.KEY_DAYS * 86400000, `AddOrderlyKey message signs; scope read,trading; expires in ${C.KEY_DAYS} days`);
console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
