// PRIVO spot routing on Robinhood Chain through the Uniswap Universal Router.
// Pure logic: quotes, Permit2 checks and calldata. No wallet code here, so it runs in the browser and in Node.
// Flow tested in test/sim (eth_call with state overrides on mainnet state):
//   buy  : [PERMIT2_PERMIT] PERMIT2_TRANSFER_FROM(USDG -> router) [PAY_PORTION fee] swap(router balance) -> trader
//   sell : [PERMIT2_PERMIT] PERMIT2_TRANSFER_FROM(stock -> router) swap -> router [PAY_PORTION fee] SWEEP(USDG) -> trader
import { createPublicClient, http, fallback, parseAbi, encodeAbiParameters, encodePacked, encodeFunctionData, concatHex, toHex } from "viem";

/* ---------- config ---------- */
export const CONFIG = {
  // PRIVO fee in bips (1 bip = 0.01%). The router accepts up to 10000, so PRIVO caps it itself.
  FEE_BIPS: 15,
  MAX_FEE_BIPS: 100,
  // Wallet that receives the fee. Empty means no fee is taken and PAY_PORTION is left out.
  // PRIVO fee Safe on Robinhood Chain: Safe L2 1.4.1, 2 of 3 signers, created 19 Nov 2026,
  // It is a Safe multisig and exists only on chain 4663.
  FEE_WALLET: "0xCc051cf47547386bA147FDDfcBCFE00E791C1418",
};

export const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  // The official RPC is unreachable on some networks, so a second public RPC is listed first for reads.
  rpcUrls: { default: { http: ["https://robinhood-rpc.publicnode.com", "https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  // Multicall3 at its standard address (code checked on chain 4663); viem needs it for balances().
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
};
export const EXPLORER = CHAIN.blockExplorers.default.url;

export const ADDR = {
  ROUTER: "0x8876789976decbfcbbbe364623c63652db8c0904",
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  QUOTER_V3: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  QUOTER_V4: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
};

export const USDG = { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 };

export const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"; // WETH9 of the Uniswap routers on this chain

// Markets and their pools, verified on chain on 19 Nov 2026.
// Stocks: Robinhood stock tokens (18 decimals) against USDG.
// Crypto: ETH is traded as native ETH (wrapped to WETH inside the router); BTC is cbBTC (8 decimals).
// v3 routes: fees[] with via[] for multi-hop (USDG -> via... -> asset). v4: single pool (fee, ts).
// id: v3 pool address or v4 pool id, used for price data only.
const ZERO = "0x0000000000000000000000000000000000000000";
export const MARKETS = {
  TSLA: { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", pools: [{ v: 3, fee: 3000, id: "0xf4ACdAEEB7022862A763C9B1B885e11191c889E3" }, { v: 4, fee: 3000, ts: 60, id: "0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e" }] },
  NVDA: { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", pools: [{ v: 3, fee: 500, id: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3" }] },
  AAPL: { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", pools: [{ v: 4, fee: 3000, ts: 60, id: "0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb" }] },
  AMZN: { address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", pools: [{ v: 3, fee: 3000, id: "0x8AC92DA74AB5F3b1d024Dc1943Ad7e15Dc4179Ef" }] },
  PLTR: { address: "0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A", pools: [{ v: 4, fee: 10000, ts: 200, id: "0xee430ee1003e1985e1828a01b9a20dad67ad4302994fe2abb4a173de4ac54623" }] },
  NFLX: { address: "0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8", pools: [{ v: 3, fee: 3000, id: "0x59895C0302F41aEaa129D2fa2442CEc01E7eF45E" }, { v: 4, fee: 10000, ts: 100, id: "0xe4930a6215f21aa3b37c01adbded3362f56ae31b9a60066f5f9641e601d5111f" }] },
  AMD:  { address: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", pools: [{ v: 3, fee: 3000, id: "0x48D284A2A4d3DC1b3Da08231Fe44317e7e7Aa51f" }, { v: 4, fee: 10000, ts: 200, id: "0xde9f85fdd9e05a943a52f2c69ffafe3064a3287df03d02c9b431bc92d4781274" }] },
  // Added 20 Nov 2026: more Robinhood stock tokens (SPCX = SpaceX, ANTHROPIC = Anthropic PBC Class A, token symbol ANT). Pools checked on chain,
  // each one quotes through the Universal Router with the PRIVO fee (checked against mainnet state).
  SPCX:      { address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", pools: [{ v: 3, fee: 500, id: "0xc61284332117c3FB23A2A56cceFFD07F7aF60029" }, { v: 3, fee: 3000, id: "0xEb07d9587eFD1778dFb9c385Ec43EF6d5F9fE401" }] },
  ANTHROPIC: { address: "0xbbB6c29bCc3a1028A2B54310DF73F4F7A3bcB373", token: "ANT", label: "NEW", pools: [{ v: 3, fee: 500, id: "0x75aE79FD767A7cC410AB4EED13f8d3498e878d6A" }, { v: 3, fee: 3000, id: "0x0Ff3e9A6114a1C1E7a6490a5d9bc250990046400" }] },
  MSFT:      { address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", pools: [{ v: 3, fee: 3000, id: "0xeb60bCD1D920ad6E102690CCFC6fB488899E1510" }, { v: 4, fee: 3000, ts: 60, id: "0x9194a557b6a6bb2236b49ea7e2bbccec5d3eeb705aef00903be4b3de1d949579" }] },
  GOOGL:     { address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", pools: [{ v: 3, fee: 500, id: "0x34D0dC122CF9A8Eb296fC5e0D3A233625D7d19b7" }, { v: 4, fee: 3000, ts: 60, id: "0xd4ecb79fdc521d7725d22b33ed43cb4e47aa96bfad76aa29577e3151f723ac5e" }] },
  META:      { address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", pools: [{ v: 4, fee: 3000, ts: 60, id: "0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36" }, { v: 3, fee: 3000, id: "0x107a7Cb40d8665360ba10E59471Af06150A50922" }] },
  COIN:      { address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", pools: [{ v: 4, fee: 10000, ts: 200, id: "0x007a13fa152f6dc383cad20a8eaab4e1e2538b606936eae2a424f8aa47d6db31" }, { v: 3, fee: 500, id: "0x3a6eC0aa6C702323414d449B5F60f4B742A82dED" }] },
  MSTR:      { address: "0xec262a75e413fAfD0dF80480274532C79D42da09", pools: [{ v: 3, fee: 10000, id: "0x17578C0e0D15da44f31677263114F71aE76653EA" }] },
  CRCL:      { address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", pools: [{ v: 3, fee: 3000, id: "0x654E4143e82a5824445Ade0824351C2A9ACD95a8" }] },
  SPY:       { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", pools: [{ v: 4, fee: 3000, ts: 60, id: "0xfe2a80bb5618fd14984b92ca6d45bf5ba67443ddb1435e28b2e48df2fc1526cd" }] },
  QQQ:       { address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", pools: [{ v: 3, fee: 500, id: "0xD60A5d14dB690B7Afad71F76B108071D7175597d" }, { v: 3, fee: 3000, id: "0xEbD78dcfc8a6b3A696f1E191aD1ff321f9579f79" }] },
  TSM:       { address: "0x58FfE4a942d3885bAa22D7520691F611EF09e7AA", pools: [{ v: 3, fee: 10000, id: "0x07e8Ea83D4C1340774c8965125e26e12bf943bf1" }] },
  MU:        { address: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", pools: [{ v: 3, fee: 3000, id: "0xd057B1Bc54917855BBee58eAd58647f47caB35E5" }, { v: 4, fee: 10000, ts: 200, id: "0x6fa3ee0048e78bf0a513eb0ab56f482944a767c21db990fcf555605e69f05659" }] },
  INTC:      { address: "0xc72b96e0E48ecd4DC75E1e45396e26300BC39681", pools: [{ v: 3, fee: 3000, id: "0x2e5a92f5013a64661A49312111be2e8aBd33F56a" }, { v: 4, fee: 10000, ts: 200, id: "0xf2e329e631d0fb315a5c563ee3a9120f24822b5ef6c502a91cb56b174d5d8c22" }] },
  GME:       { address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", pools: [{ v: 3, fee: 10000, id: "0xE9713f453aDB9245B19559790c96F470a18F2fDF" }, { v: 3, fee: 500, id: "0xE2b46c905E12Ab8E2f864e4821a4325884C1B126" }] },
  // Added 25 Nov 2026: 11 more Robinhood stock tokens with USDG pools on Uniswap (same token contract as TSLA, pools checked
  // on chain, each quotes through the Universal Router with the PRIVO fee).
  USO:  { address: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", pools: [{ v: 3, fee: 3000, id: "0x02175608F1b5E6b5ed221cCFdC7Be197D111D915" }, { v: 3, fee: 10000, id: "0x6ED11C7DfD8e2ca5620eed29a7B9b53AE90dD0D2" }] },
  GLD:  { address: "0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e", pools: [{ v: 3, fee: 3000, id: "0x7A6A053eCCf1446A2633E05aA6D40D09381997ec" }, { v: 3, fee: 500, id: "0xBA2f1ed4cEB2169D538d1e614D847E83C5A55913" }] },
  TTWO: { address: "0x5e81213613b6B86EaB4c6c50d718d34359459786", pools: [{ v: 3, fee: 3000, id: "0xD9Ab4b7fAe6DC2f7020134Ec744A8F53Ef3E5E24" }] },
  DELL: { address: "0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd", pools: [{ v: 3, fee: 10000, id: "0xc30c89cB7815A1488b7998D15eEC73961707Fc5a" }] },
  AVGO: { address: "0x156E175DD063a8cE274C50654eF40e0032b3fbcF", pools: [{ v: 3, fee: 3000, id: "0x5B7C404f1d7d77F9f3885aB13d7764F8a173028c" }] },
  COST: { address: "0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2", pools: [{ v: 3, fee: 3000, id: "0x0a2121A50A09eD0796ae81F9c53fF9398355a398" }] },
  AMC:  { address: "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B", pools: [{ v: 4, fee: 1000, ts: 10, id: "0x7499938c352d5b5b8f0c648722aca5ee964ef9b85c3a3041f1ec379726291d9d" }, { v: 3, fee: 3000, id: "0xaA34feA710a1A737840329051D81D3B0B7C564d5" }] },
  HIMS: { address: "0xCceE82fE024c36fA15E1005edE3E9e4787e23D09", pools: [{ v: 3, fee: 3000, id: "0xC8C90d3a1c1a24967E773ac2aD0d456BA3E31F64" }] },
  CBRS: { address: "0x5c90450Bbb4273D7b2f17CF6917AEB237A569679", pools: [{ v: 3, fee: 3000, id: "0xD5ed9A6c9DF23f10EEcab73635912c5547fd9185" }] },
  BE:   { address: "0x822CC93fFD030293E9842c30BBD678F530701867", pools: [{ v: 3, fee: 3000, id: "0x1baD145C8F06444E0dF81c28257cd20231Bd1f16" }] },
  MRNA: { address: "0x43B07D15cE533bEc5476d70C22a78a1B2B662155", pools: [{ v: 3, fee: 3000, id: "0xB40196272A6d2EB5edF6d93bc4DC39856AD95E0E" }, { v: 3, fee: 10000, id: "0xA34d0667334074DF2d5BfD259e79E6B9cf1fA8Bf" }] },
  // Added 26 Nov 2026: 8 more Robinhood stock tokens (same beacon proxy as TSLA) with USDG pools on Uniswap; pools checked on
  // chain, each buy and sell simulated through the Universal Router with the PRIVO fee. CRWV and NBIS are left out: their
  // only deep pools are v4 pools with hooks.
  TTEQ: { address: "0x80E10255A83B257F5A8674D363F547842aa53b8e", pools: [{ v: 3, fee: 500, id: "0x59848647Aff854D7ea97A9FF955653dA178E8677" }] },
  RDDT: { address: "0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C", pools: [{ v: 3, fee: 10000, id: "0xa8744E76aED23B05F0126335E7BD38f7935D19fe" }, { v: 4, fee: 10000, ts: 200, id: "0xec481672a94cfe42e2d8c996b7eaeee8a93093d56bd01c1714341971e3f406c1" }] },
  SNDK: { address: "0xB90A19fF0Af67f7779afF50A882A9CfF42446400", pools: [{ v: 4, fee: 10000, ts: 200, id: "0x2707cb88a6a40fa0f948f58958051ba097d6f6a3cf7f87929bd68ccc5becea24" }, { v: 3, fee: 10000, id: "0xA1e1C9519cD5ae47e9A935645E1A7b935b944559" }] },
  SLV:  { address: "0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f", pools: [{ v: 3, fee: 3000, id: "0x8cB787e6c315D464775289BaD00FDD67d53Ecb3D" }] },
  ORCL: { address: "0xb0992820E760d836549ba69BC7598b4af75dEE03", pools: [{ v: 4, fee: 10000, ts: 200, id: "0xc2ce4784e1e72cf0221b51b30c8aaadf6c0b12863cf03ab3687854fb7b1d850a" }] },
  GLXY: { address: "0x2D427692E928fa156ec22acfaBaFA0447C5805B7", pools: [{ v: 3, fee: 3000, id: "0xC67C2D200E0b7E5D99F4CFBede8CB09B48892f2c" }] },
  USAR: { address: "0xd917B029C761D264c6A312BBbcDA868658eF86a6", pools: [{ v: 3, fee: 3000, id: "0x04391780F519B7d3ba59c9590459D76e23d225C4" }] },
  LLY:  { address: "0x8005d266423c7ea827372c9c864491e5786600ea", pools: [{ v: 3, fee: 10000, id: "0xF4274130137eeE20bAD928B593d992716516CEB9" }] },
  ETH:  { kind: "crypto", native: true, address: WETH, pools: [
    { v: 3, fee: 100, id: "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca" },
    { v: 3, fee: 500, id: "0x69BfaF19C9f377BB306a89aEd9F6B07e2c1a8d9a" },
    { v: 3, fee: 3000, id: "0xa9188730Fe85Be88ad499D7d52B099e800fB0334" }] },
  BTC:  { kind: "crypto", decimals: 8, address: "0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4", token: "cbBTC", pools: [
    { v: 3, fee: 500, id: "0x9664D869540E9D0a76f12C6623946C6D5d201e09" },
    { v: 3, fees: [100, 500], via: [WETH], id: "0x934e60D1C6C34242b92159A5Bcc710FAFa50AD87" }] },
};
for (const m of Object.values(MARKETS)) { m.kind = m.kind || "stock"; m.decimals = m.decimals || 18; }
export const STOCK_DECIMALS = 18;
export const decimalsOf = sym => MARKETS[sym]?.decimals ?? 18;
export const isNative = sym => !!MARKETS[sym]?.native;
// v3 path bytes for one route, from tokenIn to tokenOut.
export function v3Path(sym, pool, buy) {
  const fees = pool.fees || [pool.fee], via = pool.via || [];
  const tokens = [USDG.address, ...via, MARKETS[sym].address];
  const t = buy ? tokens : [...tokens].reverse(), f = buy ? fees : [...fees].reverse();
  const types = [], vals = [];
  t.forEach((tok, i) => { types.push("address"); vals.push(tok); if (i < f.length) { types.push("uint24"); vals.push(f[i]); } });
  return encodePacked(types, vals);
}
// v3 swap commands for a route. Multi-hop routes are sent as consecutive single-hop swaps through the router
// (this router build reverts with SliceOutOfBounds on multi-hop paths; single hops work). Intermediate output
// stays in the router and the next hop spends the router balance; only the last hop carries the minimum.
function v3Swaps(sym, pool, buy, recipient, minOut) {
  const fees = pool.fees || [pool.fee], via = pool.via || [];
  const tokens = [USDG.address, ...via, MARKETS[sym].address];
  const t = buy ? tokens : [...tokens].reverse(), f = buy ? fees : [...fees].reverse();
  return f.map((fee, i) => {
    const last = i === f.length - 1;
    return enc(["address", "uint256", "uint256", "bytes", "bool"], [last ? recipient : ADDRESS_THIS, CONTRACT_BALANCE, last ? minOut : 0n, encodePacked(["address", "uint24", "address"], [t[i], fee, t[i + 1]]), false]);
  });
}
export const routeLabel = pool => (pool.via?.length ? "via ETH, " : "") + "pool fee " + (pool.fees || [pool.fee]).map(f => (f / 10000).toFixed(2) + "%").join(" + ");

/* ---------- helpers ---------- */
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const CONTRACT_BALANCE = 1n << 255n;
const MAX_UINT160 = (1n << 160n) - 1n;
const CMD = { V3_SWAP_EXACT_IN: 0x00, PERMIT2_TRANSFER_FROM: 0x02, SWEEP: 0x04, PAY_PORTION: 0x06, PERMIT2_PERMIT: 0x0a, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 };
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, TAKE: 0x0e, TAKE_ALL: 0x0f };

const enc = (types, vals) => encodeAbiParameters(types.map(t => typeof t === "string" ? { type: t } : t), vals);
const bytes1 = (...xs) => concatHex(xs.map(x => toHex(x, { size: 1 })));
const KEY_T = { type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] };

export function feeBips() {
  if (!CONFIG.FEE_WALLET) return 0n;
  const b = BigInt(CONFIG.FEE_BIPS);
  if (b < 0n || b > BigInt(CONFIG.MAX_FEE_BIPS)) throw new Error("PRIVO fee is outside the allowed range");
  return b;
}
// Same rounding as the router's BipsLibrary: amount * bips / 10000, rounded down.
export const portion = (amount, bips) => amount * bips / 10000n;
export const applySlippage = (amount, slipBps) => amount * (10000n - BigInt(slipBps)) / 10000n;

function poolKey(stock, pool) {
  const [c0, c1] = BigInt(USDG.address) < BigInt(stock) ? [USDG.address, stock] : [stock, USDG.address];
  return { currency0: c0, currency1: c1, fee: pool.fee, tickSpacing: pool.ts, hooks: ZERO };
}

export function makeClient(urls = CHAIN.rpcUrls.default.http) {
  return createPublicClient({ chain: CHAIN, transport: fallback(urls.map(u => http(u, { retryCount: 1, timeout: 20000 }))) });
}

/* ---------- quotes ---------- */
const QV3 = parseAbi(["function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"]);
const QV4 = [{ type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [{ name: "poolKey", ...KEY_T }, { name: "zeroForOne", type: "bool" }, { name: "exactAmount", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
  outputs: [{ name: "amountOut", type: "uint256" }, { name: "gasEstimate", type: "uint256" }] }];

async function quotePool(client, stock, pool, tokenIn, tokenOut, amountIn, sym, buy) {
  if (pool.v === 3) {
    const { result } = await client.simulateContract({ address: ADDR.QUOTER_V3, abi: QV3, functionName: "quoteExactInput", args: [v3Path(sym, pool, buy), amountIn] });
    return result[0];
  }
  const key = poolKey(stock, pool);
  const { result } = await client.simulateContract({ address: ADDR.QUOTER_V4, abi: QV4, functionName: "quoteExactInputSingle", args: [{ poolKey: key, zeroForOne: key.currency0.toLowerCase() === tokenIn.toLowerCase(), exactAmount: amountIn, hookData: "0x" }] });
  return result[0];
}

// Quotes every known pool of a market for swapIn and returns the one that pays most: { best: { pool, out }, all }.
async function bestPool(client, sym, buy, swapIn) {
  const m = MARKETS[sym];
  const [tokenIn, tokenOut] = buy ? [USDG.address, m.address] : [m.address, USDG.address];
  const tries = await Promise.allSettled(m.pools.map(p => quotePool(client, m.address, p, tokenIn, tokenOut, swapIn, sym, buy)));
  const all = tries.map((t, i) => ({ pool: m.pools[i], out: t.status === "fulfilled" ? t.value : null, error: t.status === "rejected" ? (t.reason?.shortMessage || t.reason?.message) : null }));
  const ok = all.filter(q => q.out && q.out > 0n).sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
  if (!ok.length) throw new Error("No pool can fill this size right now (" + sym + ")");
  return { best: ok[0], all };
}

// side "buy": amount is USDG to spend (6 decimals). side "sell": amount of the asset to sell (its own decimals).
// Every known pool is quoted and the one that pays the trader most wins.
export async function quote(client, { sym, side, amount }) {
  const m = MARKETS[sym];
  if (!m) throw new Error("No live market for " + sym);
  if (amount <= 0n) throw new Error("Enter an amount");
  const bips = feeBips();
  const fee = side === "buy" ? portion(amount, bips) : 0n;
  const swapIn = amount - fee;
  const { best, all } = await bestPool(client, sym, side === "buy", swapIn);
  const sellFee = side === "sell" ? portion(best.out, bips) : 0n;
  return { sym, side, amount, bips, pool: best.pool, swapIn, grossOut: best.out, fee: side === "buy" ? fee : sellFee,
    netOut: side === "buy" ? best.out : best.out - sellFee, all };
}

/* ---------- baskets: one USDG amount spread over several stock tokens, in one transaction ---------- */
export const BASKET_MAX = 8;
// legs: [{ sym, w }] with w the share in basis points (summing to 10000); amount: USDG to spend in total (6 decimals).
// The PRIVO fee is taken once on the total; what is left is split by weight (the last leg takes the rounding) and each
// leg is quoted on its best pool. Returns { amount, bips, fee, swapIn, legs: [{ sym, w, swapIn, pool, grossOut }] }.
export function splitBasket(legs, amount) {
  if (!Array.isArray(legs) || legs.length < 2 || legs.length > BASKET_MAX) throw new Error("A basket holds 2 to " + BASKET_MAX + " stock tokens");
  const seen = new Set();
  for (const l of legs) {
    const m = MARKETS[l.sym];
    if (!m || m.kind !== "stock" || m.native) throw new Error("Baskets take stock tokens only (" + l.sym + ")");
    if (seen.has(l.sym)) throw new Error(l.sym + " is in the basket twice");
    if (!Number.isInteger(l.w) || l.w <= 0) throw new Error("Each stock needs a share above 0");
    seen.add(l.sym);
  }
  if (legs.reduce((a, l) => a + l.w, 0) !== 10000) throw new Error("The shares must add up to 100%");
  if (amount <= 0n) throw new Error("Enter an amount");
  const bips = feeBips(), fee = portion(amount, bips), swapIn = amount - fee;
  let left = swapIn;
  const out = legs.map((l, i) => {
    const part = i === legs.length - 1 ? left : swapIn * BigInt(l.w) / 10000n;
    left -= part;
    return { sym: l.sym, w: l.w, swapIn: part };
  });
  if (out.some(l => l.swapIn <= 0n)) throw new Error("The amount is too small to split");
  return { amount, bips, fee, swapIn, legs: out };
}
export async function quoteBasket(client, { legs, amount }) {
  const b = splitBasket(legs, amount);
  const qs = await Promise.all(b.legs.map(l => bestPool(client, l.sym, true, l.swapIn)));
  b.legs = b.legs.map((l, i) => ({ ...l, pool: qs[i].best.pool, grossOut: qs[i].best.out }));
  return b;
}
// qb: result of quoteBasket(). One router call under one Permit2 signature for the total: the PRIVO fee goes from the
// trader straight to the fee Safe, then for each leg the router pulls exactly that leg's USDG and swaps its whole balance
// (this router reverts on explicit v3 input amounts, so every swap spends the router balance, as a single trade does),
// sending the tokens to the trader with that leg's own slippage floor. If any leg falls short, the whole call reverts.
export function buildBasket(qb, { slippageBps = 50, permit = null, deadlineSec = 1200 } = {}) {
  if (slippageBps < 1 || slippageBps > 500) throw new Error("Slippage must be between 0.01% and 5%");
  if (BigInt(qb.bips ?? 0) < 0n || BigInt(qb.bips ?? 0) > BigInt(CONFIG.MAX_FEE_BIPS)) throw new Error("PRIVO fee is outside the allowed range");
  if (qb.legs.reduce((a, l) => a + l.swapIn, 0n) + qb.fee !== qb.amount) throw new Error("Basket legs do not add up");
  const cmds = [], inputs = [];
  if (permit) { cmds.push(CMD.PERMIT2_PERMIT); inputs.push(enc([PERMIT_T, "bytes"], [permit.message, permit.signature])); }
  if (qb.fee > 0n && CONFIG.FEE_WALLET) { cmds.push(CMD.PERMIT2_TRANSFER_FROM); inputs.push(enc(["address", "address", "uint160"], [USDG.address, CONFIG.FEE_WALLET, qb.fee])); }
  const mins = [];
  for (const l of qb.legs) {
    const m = MARKETS[l.sym], minOut = applySlippage(l.grossOut, slippageBps);
    mins.push(minOut);
    cmds.push(CMD.PERMIT2_TRANSFER_FROM); inputs.push(enc(["address", "address", "uint160"], [USDG.address, ADDRESS_THIS, l.swapIn]));
    if (l.pool.v === 3) for (const inp of v3Swaps(l.sym, l.pool, true, MSG_SENDER, minOut)) { cmds.push(CMD.V3_SWAP_EXACT_IN); inputs.push(inp); }
    else { cmds.push(CMD.V4_SWAP); inputs.push(v4Swap(m.address, l.pool, poolKey(m.address, l.pool).currency0 === USDG.address, minOut, USDG.address, m.address, false)); }
  }
  return { ...finish(cmds, inputs, deadlineSec, 0n), mins };
}

// Live mid price of a market straight from its pool (no indexer delay): quote a small buy, sell the
// tokens back, and take the geometric mean of the two prices so the pool fee cancels out.
// Returns USDG per token, or null when the pool cannot quote.
export async function midPrice(client, sym, poolId) {
  const m = MARKETS[sym]; if (!m) return null;
  const pool = m.pools.find(p => p.id.toLowerCase() === String(poolId || "").toLowerCase()) || m.pools[0];
  const usdIn = 10n ** BigInt(USDG.decimals) * 5n; // 5 USDG
  const got = await quotePool(client, m.address, pool, USDG.address, m.address, usdIn, sym, true);
  if (!got || got <= 0n) return null;
  const back = await quotePool(client, m.address, pool, m.address, USDG.address, got, sym, false);
  const d = 10 ** decimalsOf(sym), tok = Number(got) / d, buyPx = 5 / tok, sellPx = Number(back) / 10 ** USDG.decimals / tok;
  const mid = Math.sqrt(buyPx * sellPx);
  return mid > 0 && isFinite(mid) ? mid : null;
}

/* ---------- approvals ---------- */
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const P2 = parseAbi(["function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)"]);

export async function balances(client, owner) {
  // Native ETH is the wallet's ETH balance (also used for gas), so it is not read as a token.
  const list = [["USDG", USDG.address], ...Object.entries(MARKETS).filter(([, v]) => !v.native).map(([k, v]) => [k, v.address])];
  const res = await client.multicall({ contracts: list.map(([, a]) => ({ address: a, abi: ERC20, functionName: "balanceOf", args: [owner] })), allowFailure: true });
  const eth = await client.getBalance({ address: owner });
  return Object.fromEntries([["ETH", eth], ...list.map(([k], i) => [k, res[i].status === "success" ? res[i].result : 0n])]);
}

// What the trader still needs before the swap: an ERC-20 approval to Permit2 (one transaction, once per token),
// and a Permit2 signature for the router (free, inside the swap) unless a live allowance already covers it.
export async function approvalState(client, owner, token, amount) {
  const [erc, p2] = await Promise.all([
    client.readContract({ address: token, abi: ERC20, functionName: "allowance", args: [owner, ADDR.PERMIT2] }),
    client.readContract({ address: ADDR.PERMIT2, abi: P2, functionName: "allowance", args: [owner, token, ADDR.ROUTER] }),
  ]);
  const now = Math.floor(Date.now() / 1000);
  return { needErc20Approve: erc < amount, needPermit: !(p2[0] >= amount && p2[1] > now + 120), nonce: Number(p2[2]) };
}

export function approveTx(token) {
  return { to: token, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [ADDR.PERMIT2, (1n << 256n) - 1n] }) };
}

// EIP-712 PermitSingle for Permit2. Exact amount, short expiry: each trade asks only for what it spends.
export function permitTypedData({ token, amount, nonce, ttl = 1800 }) {
  const t = Math.floor(Date.now() / 1000) + ttl;
  if (amount > MAX_UINT160) throw new Error("Amount too large");
  const message = { details: { token, amount, expiration: t, nonce }, spender: ADDR.ROUTER, sigDeadline: BigInt(t) };
  return {
    domain: { name: "Permit2", chainId: CHAIN.id, verifyingContract: ADDR.PERMIT2 },
    types: {
      PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
      PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
    },
    primaryType: "PermitSingle",
    message,
  };
}

/* ---------- calldata ---------- */
const UR = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);
const PERMIT_T = { type: "tuple", components: [{ name: "details", type: "tuple", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }] }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }] };

function v4Swap(stock, pool, zeroForOne, minOut, settleCurrency, takeCurrency, takeToRouter) {
  const swap = enc([{ type: "tuple", components: [{ name: "poolKey", ...KEY_T }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" },
    // Newer v4-periphery layout used by this router: one uint256 before hookData. 0 leaves it off. See docs/mainnet-plan.md.
    { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" }] }],
    [{ poolKey: poolKey(stock, pool), zeroForOne, amountIn: 0n, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }]);
  const settle = enc(["address", "uint256", "bool"], [settleCurrency, CONTRACT_BALANCE, false]);
  const take = takeToRouter ? enc(["address", "address", "uint256"], [takeCurrency, ADDRESS_THIS, 0n]) : enc(["address", "uint256"], [takeCurrency, minOut]);
  return enc(["bytes", "bytes[]"], [bytes1(ACT.SETTLE, ACT.SWAP_EXACT_IN_SINGLE, takeToRouter ? ACT.TAKE : ACT.TAKE_ALL), [settle, swap, take]]);
}

// q: result of quote(). permit: { message, signature } or null. Returns { to, data, value, minOut }.
export function buildSwap(q, { slippageBps = 50, permit = null, deadlineSec = 1200 } = {}) {
  if (slippageBps < 1 || slippageBps > 500) throw new Error("Slippage must be between 0.01% and 5%");
  // Re-check the fee here too: q may have been stored or rebuilt since quote() checked it.
  if (BigInt(q.bips ?? 0) < 0n || BigInt(q.bips ?? 0) > BigInt(CONFIG.MAX_FEE_BIPS)) throw new Error("PRIVO fee is outside the allowed range");
  const m = MARKETS[q.sym], stock = m.address, pool = q.pool, buy = q.side === "buy", native = !!m.native;
  const tokenIn = buy ? USDG.address : stock;
  const cmds = [], inputs = [];
  let value = 0n;
  if (!buy && native) {
    // Selling native ETH: the ETH comes with the call and is wrapped inside the router. No approval or permit.
    value = q.amount;
    cmds.push(CMD.WRAP_ETH); inputs.push(enc(["address", "uint256"], [ADDRESS_THIS, q.amount]));
  } else {
    if (permit) { cmds.push(CMD.PERMIT2_PERMIT); inputs.push(enc([PERMIT_T, "bytes"], [permit.message, permit.signature])); }
    cmds.push(CMD.PERMIT2_TRANSFER_FROM); inputs.push(enc(["address", "address", "uint160"], [tokenIn, ADDRESS_THIS, q.amount]));
  }
  const feeOn = q.bips > 0n && CONFIG.FEE_WALLET;
  if (buy) {
    if (feeOn) { cmds.push(CMD.PAY_PORTION); inputs.push(enc(["address", "address", "uint256"], [USDG.address, CONFIG.FEE_WALLET, q.bips])); }
    const minOut = applySlippage(q.grossOut, slippageBps);
    if (pool.v === 3) for (const inp of v3Swaps(q.sym, pool, true, native ? ADDRESS_THIS : MSG_SENDER, minOut)) { cmds.push(CMD.V3_SWAP_EXACT_IN); inputs.push(inp); }
    else { cmds.push(CMD.V4_SWAP); inputs.push(v4Swap(stock, pool, poolKey(stock, pool).currency0 === USDG.address, minOut, USDG.address, stock, false)); }
    // Buying ETH: the WETH stays in the router and is unwrapped straight to the trader as native ETH.
    if (native) { cmds.push(CMD.UNWRAP_WETH); inputs.push(enc(["address", "uint256"], [MSG_SENDER, minOut])); }
    return finish(cmds, inputs, deadlineSec, minOut, value);
  }
  const minGross = applySlippage(q.grossOut, slippageBps);
  if (pool.v === 3) for (const inp of v3Swaps(q.sym, pool, false, ADDRESS_THIS, minGross)) { cmds.push(CMD.V3_SWAP_EXACT_IN); inputs.push(inp); }
  else { cmds.push(CMD.V4_SWAP); inputs.push(v4Swap(stock, pool, poolKey(stock, pool).currency0 === stock, minGross, stock, USDG.address, true)); }
  if (feeOn) { cmds.push(CMD.PAY_PORTION); inputs.push(enc(["address", "address", "uint256"], [USDG.address, CONFIG.FEE_WALLET, q.bips])); }
  const minNet = minGross - portion(minGross, feeOn ? q.bips : 0n);
  cmds.push(CMD.SWEEP); inputs.push(enc(["address", "address", "uint160"], [USDG.address, MSG_SENDER, minNet]));
  return finish(cmds, inputs, deadlineSec, minNet, value);
}

// Route for a PrivoOrders fill: the slice is already in the router (sent by the Orders contract), so the swap spends
// the router's own balance, takes no fee (the contract takes it) and sends the output to the caller, the Orders contract.
// q: result of quote() for the slice (stock markets only). Returns { commands, inputs, minOut }.
export function fillRoute(q, { slippageBps = 50, floor = 0n } = {}) {
  if (slippageBps < 1 || slippageBps > 500) throw new Error("Slippage must be between 0.01% and 5%");
  const m = MARKETS[q.sym];
  if (!m || m.native) throw new Error("Orders take stock markets only");
  const stock = m.address, pool = q.pool, buy = q.side === "buy", slipped = applySlippage(q.grossOut, slippageBps);
  const minOut = slipped > floor ? slipped : floor; // never below the order's own limit for this slice
  const cmds = [], inputs = [];
  if (pool.v === 3) for (const inp of v3Swaps(q.sym, pool, buy, MSG_SENDER, minOut)) { cmds.push(CMD.V3_SWAP_EXACT_IN); inputs.push(inp); }
  else {
    const usdgIs0 = poolKey(stock, pool).currency0 === USDG.address;
    cmds.push(CMD.V4_SWAP); inputs.push(v4Swap(stock, pool, buy ? usdgIs0 : !usdgIs0, minOut, buy ? USDG.address : stock, buy ? stock : USDG.address, false));
  }
  return { commands: bytes1(...cmds), inputs, minOut };
}

function finish(cmds, inputs, deadlineSec, minOut, value = 0n) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec);
  return { to: ADDR.ROUTER, value, minOut, data: encodeFunctionData({ abi: UR, functionName: "execute", args: [bytes1(...cmds), inputs, deadline] }) };
}
