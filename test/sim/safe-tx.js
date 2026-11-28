// Move funds out of a Safe on Robinhood Chain (4663) without the Safe{Wallet} app.
// Owners sign the standard Safe EIP-712 "SafeTx" message one by one and pass a text code between them;
// the last owner sends execTransaction. Pure logic, used by safe-withdraw.html and the Node test.
import { parseAbi, encodeFunctionData, getAddress, isAddress, recoverTypedDataAddress, concatHex, pad, toHex, hashTypedData, parseUnits, formatUnits } from "viem";

export const CHAIN_ID = 4663;
const ZERO = "0x0000000000000000000000000000000000000000";
export const SAFE_ABI = parseAbi([
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function nonce() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
]);
const ERC20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

export async function safeInfo(client, safe) {
  const [owners, threshold, nonce, version] = await Promise.all(["getOwners", "getThreshold", "nonce", "VERSION"].map(f => client.readContract({ address: safe, abi: SAFE_ABI, functionName: f })));
  return { safe: getAddress(safe), owners: owners.map(getAddress), threshold: Number(threshold), nonce, version };
}

export async function tokenInfo(client, token, holder) {
  const [symbol, decimals, balance] = await Promise.all([
    client.readContract({ address: token, abi: ERC20, functionName: "symbol" }),
    client.readContract({ address: token, abi: ERC20, functionName: "decimals" }),
    client.readContract({ address: token, abi: ERC20, functionName: "balanceOf", args: [holder] }),
  ]);
  return { token: getAddress(token), symbol, decimals: Number(decimals), balance };
}

// Plain call only (operation 0). No refunds, no gas token: the sender pays gas themselves.
export function transferTx(token, recipient, amount) {
  if (!isAddress(recipient)) throw new Error("Recipient is not a valid address");
  if (amount <= 0n) throw new Error("Amount must be above zero");
  return { to: getAddress(token), value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [getAddress(recipient), amount] }), operation: 0 };
}

export function safeTxTypedData(safe, tx, nonce) {
  return {
    domain: { chainId: CHAIN_ID, verifyingContract: getAddress(safe) },
    types: { SafeTx: [
      { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }, { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" }, { name: "baseGas", type: "uint256" }, { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" }, { name: "refundReceiver", type: "address" }, { name: "nonce", type: "uint256" }] },
    primaryType: "SafeTx",
    message: { to: tx.to, value: tx.value, data: tx.data, operation: tx.operation, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: BigInt(nonce) },
  };
}
export const safeTxHash = (safe, tx, nonce) => hashTypedData(safeTxTypedData(safe, tx, nonce));

// The code owners pass to each other. It holds only public data: the transaction and signatures.
export function encodePackage(p) {
  // meta: optional public parameters a page uses to rebuild and check tx (e.g. a $PRIVO buyback); never trusted on its own.
  const json = JSON.stringify({ v: 1, chainId: CHAIN_ID, safe: p.safe, nonce: p.nonce.toString(), tx: { ...p.tx, value: p.tx.value.toString() }, sigs: p.sigs, ...(p.meta ? { meta: p.meta } : {}) }, null, 0);
  return "PRIVO-SAFETX:" + btoa(json);
}
export function decodePackage(code) {
  const raw = (code || "").trim();
  if (!raw.startsWith("PRIVO-SAFETX:")) throw new Error("This is not a PRIVO Safe transaction code");
  const j = JSON.parse(atob(raw.slice(13)));
  if (j.v !== 1 || j.chainId !== CHAIN_ID) throw new Error("Code is for another chain or version");
  return { safe: getAddress(j.safe), nonce: BigInt(j.nonce), tx: { ...j.tx, to: getAddress(j.tx.to), value: BigInt(j.tx.value) }, sigs: j.sigs || [], meta: j.meta || null };
}

// Checks every signature against the owner list. Returns the valid ones, one per owner.
export async function checkSignatures(p, owners) {
  const td = safeTxTypedData(p.safe, p.tx, p.nonce);
  const ownerSet = new Set(owners.map(o => o.toLowerCase()));
  const seen = new Set(), valid = [], problems = [];
  for (const s of p.sigs) {
    let who;
    try { who = await recoverTypedDataAddress({ ...td, signature: s.sig }); } catch { problems.push("Unreadable signature"); continue; }
    if (who.toLowerCase() !== (s.signer || "").toLowerCase()) { problems.push("Signature does not match its signer " + s.signer); continue; }
    if (!ownerSet.has(who.toLowerCase())) { problems.push(who + " is not an owner of this Safe"); continue; }
    if (seen.has(who.toLowerCase())) continue;
    seen.add(who.toLowerCase()); valid.push({ signer: getAddress(who), sig: s.sig });
  }
  return { valid, problems };
}

// Safe wants signatures sorted by signer address. If the sender is an owner who has not signed,
// it counts through an "approved by sender" entry (r = owner, s = 0, v = 1), so they sign nothing extra.
export function packSignatures(valid, sender) {
  const list = valid.map(v => ({ signer: v.signer, data: v.sig }));
  if (sender && !list.some(v => v.signer.toLowerCase() === sender.toLowerCase()))
    list.push({ signer: getAddress(sender), data: concatHex([pad(sender), pad("0x0"), "0x01"]) });
  list.sort((a, b) => (BigInt(a.signer) < BigInt(b.signer) ? -1 : 1));
  return concatHex(list.map(x => x.data));
}

export function execCall(p, signatures) {
  return { to: p.safe, data: encodeFunctionData({ abi: SAFE_ABI, functionName: "execTransaction", args: [p.tx.to, p.tx.value, p.tx.data, p.tx.operation, 0n, 0n, 0n, ZERO, ZERO, signatures] }) };
}

export { parseUnits, formatUnits };
