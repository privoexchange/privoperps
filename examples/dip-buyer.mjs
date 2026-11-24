// Example bot: buys a stock token on PRIVO Spot when its pool price drops a set % below where the bot started.
// It signs with its own wallet; PRIVO never holds the key. Start with DRY_RUN=1 to see what it would do.
//
//   PRIVATE_KEY=0x... MARKET=TSLA DROP_PCT=2 SPEND_USDG=25 DRY_RUN=1 node examples/dip-buyer.mjs
//
// Use a separate wallet that holds only what the bot may spend, plus a little ETH for gas on Robinhood Chain.
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Privo, Swap } from "../src/privo-sdk.js";

const { PRIVATE_KEY, MARKET = "TSLA", DROP_PCT = "2", SPEND_USDG = "25", DRY_RUN = "1", EVERY_S = "30" } = process.env;
if (!PRIVATE_KEY) throw new Error("Set PRIVATE_KEY (a bot wallet, never your main one)");
const wallet = createWalletClient({ account: privateKeyToAccount(PRIVATE_KEY), chain: Swap.CHAIN, transport: http(Swap.CHAIN.rpcUrls.default.http[1]) });
const privo = new Privo({ wallet, slippageBps: 50 });

const priceNow = async () => (await privo.prices()).prices[MARKET]?.pool?.px;
const start = await priceNow();
if (!(start > 0)) throw new Error("No pool price for " + MARKET);
const target = start * (1 - DROP_PCT / 100);
console.log(`${MARKET} at ${start.toFixed(2)}; buying ${SPEND_USDG} USDG worth at or below ${target.toFixed(2)}${DRY_RUN === "1" ? " (dry run)" : ""}`);

for (;;) {
  const px = await priceNow().catch(() => null);
  if (px > 0 && px <= target) {
    const q = await privo.spot.quote(MARKET, "buy", SPEND_USDG);
    console.log(`${MARKET} ${px.toFixed(2)}: quote ${q.out} ${MARKET} for ${SPEND_USDG} USDG (fee ${q.feeUsdg} USDG, ${q.route})`);
    if (DRY_RUN !== "1") { const r = await privo.spot.buy(MARKET, SPEND_USDG); console.log("bought:", Swap.EXPLORER + "/tx/" + r.hash); }
    break;
  }
  await new Promise(r => setTimeout(r, +EVERY_S * 1000));
}
