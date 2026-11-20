// Spot journal: receipt parsing, Blockscout backfill grouping, and average-cost PnL.
//   node test/sim/journal-test.mjs
import { encodeEventTopics, encodeAbiParameters, parseAbiItem, parseUnits } from "viem";
import { fromReceipt, backfill, book, merge } from "../../src/privo-journal.js";
import { USDG, WETH, MARKETS } from "../../src/privo-swap.js";

let fail = 0;
const ok = (c, m) => { console.log((c ? "  ok    " : "  FAIL  ") + m); if (!c) fail++; };
const near = (a, b) => Math.abs(a - b) < 1e-9;
const me = "0x1111111111111111111111111111111111111111", pool = "0x00000000000000000000000000000000000000aa", fee = "0xCc051cf47547386bA147FDDfcBCFE00E791C1418";
const T = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const W = parseAbiItem("event Withdrawal(address indexed src, uint256 wad)");
const tr = (token, from, to, v) => ({ address: token, topics: encodeEventTopics({ abi: [T], args: { from, to } }), data: encodeAbiParameters([{ type: "uint256" }], [v]) });

// buy 0.25 TSLA for 100 USDG (fee 0.15 inside)
const buy = fromReceipt({ transactionHash: "0x01", logs: [tr(USDG.address, me, "0x000000000022D473030F116dDEE9F6B43aC78BA3", 100_000000n), tr(USDG.address, pool, fee, 150000n), tr(MARKETS.TSLA.address, pool, me, parseUnits("0.25", 18))] }, me, "TSLA", { ts: 1 });
ok(buy?.side === "buy" && near(buy.qty, 0.25) && near(buy.usdg, 100), "TSLA buy from receipt: 0.25 for 100 USDG");
const sell = fromReceipt({ transactionHash: "0x02", logs: [tr(MARKETS.TSLA.address, me, pool, parseUnits("0.1", 18)), tr(USDG.address, pool, me, 45_000000n)] }, me, "TSLA", { ts: 2 });
ok(sell?.side === "sell" && near(sell.qty, 0.1) && near(sell.usdg, 45), "TSLA sell from receipt: 0.1 for 45 USDG");
const ethBuy = fromReceipt({ transactionHash: "0x03", logs: [tr(USDG.address, me, pool, 50_000000n), { address: WETH, topics: encodeEventTopics({ abi: [W], args: { src: "0x8876789976decbfcbbbe364623c63652db8c0904" } }), data: encodeAbiParameters([{ type: "uint256" }], [parseUnits("0.02", 18)]) }] }, me, "ETH", { ts: 3 });
ok(ethBuy?.side === "buy" && near(ethBuy.qty, 0.02) && near(ethBuy.usdg, 50), "native ETH buy: amount from the WETH unwrap");
const ethSell = fromReceipt({ transactionHash: "0x04", logs: [tr(USDG.address, pool, me, 24_000000n)] }, me, "ETH", { value: parseUnits("0.01", 18), ts: 4 });
ok(ethSell?.side === "sell" && near(ethSell.qty, 0.01) && near(ethSell.usdg, 24), "native ETH sell: amount from the transaction value");
ok(fromReceipt({ transactionHash: "0x05", logs: [tr(USDG.address, me, "0x0000000000000000000000000000000000000bbb", 5n)] }, me, "TSLA") === null, "a plain transfer is not a trade");

const b = book([buy, sell, ethBuy, ethSell]);
ok(near(b.TSLA.qty, 0.15) && near(b.TSLA.avg, 400) && near(b.TSLA.realized, 45 - 40), "TSLA: 0.15 left at 400 avg, realized +5");
ok(near(b.ETH.qty, 0.01) && near(b.ETH.realized, 24 - 25), "ETH: 0.01 left, realized -1");

// backfill: grouping, look-alike token ignored, pagination
const pages = [
  { items: [
    { transaction_hash: "0xa1", timestamp: "2026-11-19T10:00:00Z", token: { address_hash: USDG.address }, total: { value: "20000000" }, from: { hash: me }, to: { hash: pool } },
    { transaction_hash: "0xa1", timestamp: "2026-11-19T10:00:00Z", token: { address_hash: MARKETS.NVDA.address }, total: { value: parseUnits("0.1", 18).toString() }, from: { hash: pool }, to: { hash: me } },
    { transaction_hash: "0xa2", timestamp: "2026-11-19T11:00:00Z", token: { address_hash: "0xfBB4000000000000000000000000000000000000", symbol: "USDG" }, total: { value: "25000000000000000000" }, from: { hash: pool }, to: { hash: me } },
  ], next_page_params: { block_number: 5, index: 1 } },
  { items: [
    { transaction_hash: "0xa3", timestamp: "2026-11-19T12:00:00Z", token: { address_hash: USDG.address }, total: { value: "2000000" }, from: { hash: me }, to: { hash: "0x816f722424b49cf1275cc86da9840fbd5a6167e9" } },
  ], next_page_params: null },
];
let call = 0; const urls = [];
const fake = async u => { urls.push(u); return { ok: true, json: async () => pages[call++] }; };
const got = await backfill(me, { fetchFn: fake });
ok(got.length === 1 && got[0].sym === "NVDA" && got[0].side === "buy" && near(got[0].usdg, 20) && near(got[0].qty, 0.1), "backfill: one NVDA buy; fake USDG and the perps deposit are ignored");
ok(urls.length === 2 && urls[1].includes("block_number=5"), "backfill follows Blockscout pages");
const j = merge({ trades: [buy] }, [buy, sell]);
ok(j.trades.length === 2, "merge skips trades already in the journal");

console.log(fail ? `\n${fail} check(s) failed` : "\nall checks passed");
process.exit(fail ? 1 : 0);
