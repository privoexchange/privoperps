// PRIVO gifts: send tokens as a link. The sender's browser makes a fresh one-time wallet (the "gift wallet"), sends it the
// tokens plus a little ETH for gas, and puts the gift wallet's key in the link after "#", which browsers never send to a
// server. Whoever opens the link can claim: the gift wallet sends everything it holds to the claimer's wallet, so the claimer
// signs nothing and pays no gas. Until then the sender can take it back with the same key. Like cash: anyone with the link
// can claim it. No contract; PRIVO never holds the gift or the key.
import { encodeFunctionData, parseAbi, formatUnits, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDG, MARKETS, decimalsOf, isNative, balances } from "./privo-swap.js";

const ERC20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);
export const GIFT_MIN_GAS = 20000000000000n;   // 0.00002 ETH: at least this much ETH rides along for the claim's gas
const PER_TOKEN_GAS = 90000n, SWEEP_GAS = 60000n;

/* ---------- the link: g1.<key, base64url>[.<message, base64url>] ---------- */
const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
export function encodeGift({ key, msg = "" }) {
  if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error("Bad gift key");
  const k = Uint8Array.from(key.slice(2).match(/.{2}/g).map(h => parseInt(h, 16)));
  const m = cleanMsg(msg);
  return "g1." + b64u(k) + (m ? "." + b64u(new TextEncoder().encode(m)) : "");
}
export function decodeGift(frag) {
  const s = String(frag || "").replace(/^#/, "").trim();
  const p = s.split(".");
  if (p[0] !== "g1" || !p[1]) return null;
  try {
    const k = unb64u(p[1]); if (k.length !== 32) return null;
    const key = "0x" + [...k].map(b => b.toString(16).padStart(2, "0")).join("");
    const msg = p[2] ? cleanMsg(new TextDecoder().decode(unb64u(p[2]))) : "";
    return { key, msg, address: privateKeyToAccount(key).address };
  } catch { return null; }
}
export const cleanMsg = s => String(s || "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
export const giftUrl = (origin, gift) => origin + "/app/gift#" + encodeGift(gift);

/* ---------- what a gift wallet holds ---------- */
// { eth, items: [{ sym, amount, decimals }] } with ETH listed only when it is a real gift (above the gas the claim needs).
export async function readGift(client, address) {
  const b = await balances(client, address);
  const items = [];
  for (const [sym, v] of Object.entries(b)) {
    if (sym === "ETH" || !(v > 0n)) continue;
    items.push({ sym, amount: v, decimals: sym === "USDG" ? USDG.decimals : decimalsOf(sym) });
  }
  return { eth: b.ETH || 0n, items };
}

/* ---------- gas the gift wallet needs to send everything out ---------- */
export async function gasBudget(client, tokens = 1) {
  const gp = await client.getGasPrice();
  const need = (PER_TOKEN_GAS * BigInt(tokens) + SWEEP_GAS) * gp * 3n;   // 3x headroom for a busier chain
  return need > GIFT_MIN_GAS ? need : GIFT_MIN_GAS;
}

/* ---------- funding: the sender's transactions ---------- */
// { sym: "USDG" | a market | "ETH", amount (raw), to: gift wallet, gas: ETH for the claim } -> [{ to, data, value }]
export function fundTxs({ sym, amount, to, gas }) {
  if (!(amount > 0n)) throw new Error("Enter an amount");
  to = getAddress(to);
  if (sym === "ETH") return [{ to, data: "0x", value: amount + gas }];
  const token = sym === "USDG" ? USDG.address : MARKETS[sym]?.address;
  if (!token || isNative(sym)) throw new Error("Unknown token " + sym);
  return [
    { to: token, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, amount] }), value: 0n },
    { to, data: "0x", value: gas },
  ];
}

/* ---------- claim or take back: the gift wallet sends everything to `dest` ---------- */
// wallet: a viem WalletClient for the gift key. Sends each token, then the ETH left after gas. Returns the transaction hashes.
export async function sweep(client, wallet, dest, { onStep = () => {} } = {}) {
  dest = getAddress(dest);
  const from = wallet.account.address;
  if (dest.toLowerCase() === from.toLowerCase()) throw new Error("Pick another wallet to receive the gift");
  const { items } = await readGift(client, from);
  const gasPrice = (await client.getGasPrice()) * 2n;
  const hashes = [];
  for (const it of items) {
    onStep("Sending " + formatUnits(it.amount, it.decimals) + " " + it.sym + "…");
    const token = it.sym === "USDG" ? USDG.address : MARKETS[it.sym].address;
    const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [dest, it.amount] });
    const gas = (await client.estimateGas({ account: from, to: token, data })) * 13n / 10n;
    const h = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, to: token, data, gas, gasPrice, type: "legacy" });
    const rc = await client.waitForTransactionReceipt({ hash: h });
    if (rc.status !== "success") throw new Error("Sending " + it.sym + " failed on chain");
    hashes.push(h);
  }
  // the ETH that is left, less this last transfer's gas
  const bal = await client.getBalance({ address: from });
  const gas = (await client.estimateGas({ account: from, to: dest, value: 1n })) * 13n / 10n;
  const cost = gas * gasPrice;
  if (bal > cost * 2n) {
    onStep("Sending the ETH…");
    const h = await wallet.sendTransaction({ account: wallet.account, chain: wallet.chain, to: dest, value: bal - cost, gas, gasPrice, type: "legacy" });
    const rc = await client.waitForTransactionReceipt({ hash: h });
    if (rc.status !== "success") throw new Error("Sending the ETH failed on chain");
    hashes.push(h);
  }
  return hashes;
}
