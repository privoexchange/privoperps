# PRIVO Perps

Open-source core of [PRIVO](https://privoexchange.com), a trading layer for stock tokens and crypto on **Robinhood Chain** (chain ID 4663):

- **Spot** trades route to Uniswap pools, with a small PRIVO fee taken on chain.
- **Perps** run on [Orderly Network](https://orderly.network) through PRIVO's builder account (`privo`), margined in USDG.
- **The Block desk** is a sealed-quote OTC contract: takers sign quotes off chain, the maker settles the best one in a single transaction, and losing quotes stay off chain unless the maker fills them (the app and SDK settle at most once per request and ask losing takers to withdraw).

This repository holds the smart contract, the wallet-free client libraries the app uses, and the tests that check them against Robinhood Chain mainnet state. It does not contain the website, servers or any keys.

## Contents

| Path | What it is |
|---|---|
| [`contracts/PrivoBlockDesk.sol`](contracts/PrivoBlockDesk.sol) | Block desk settlement contract (Solidity 0.8.26). No owner, no admin, no upgrade, no pause. |
| [`contracts/out/PrivoBlockDesk.json`](contracts/out/PrivoBlockDesk.json) | Compiled ABI and bytecode (the deployed build). |
| [`src/privo-swap.js`](src/privo-swap.js) | Spot: quotes (Uniswap v3/v4 quoters), Permit2 signing and Universal Router calldata with the PRIVO fee (`PAY_PORTION`). |
| [`src/privo-perps.js`](src/privo-perps.js) | Perps on Orderly: account ID, EIP-712 registration and trading-key messages, ed25519 request signing with a non-extractable WebCrypto trading key (revoked at Orderly on sign-out), market, limit, stop, TP/SL and bracket orders, per-market leverage (up to Orderly's cap: 20x stocks, up to 100x major crypto), sizing checks, position history, referral codes and rebates (Orderly referral program), vault deposits, withdrawals and PnL settlement. |
| [`src/privo-desk.js`](src/privo-desk.js) | Block desk client: request links (stock markets, 24-hour cap), EIP-712 quotes, quote codes, checks of both tokens against the request, settle/cancel calldata, a one-settlement-per-request check, and a status check (by the quote's own nonce) that tells a taker to withdraw a losing quote. Settlement logs are read from the desk's deployment block. |
| [`src/privo-journal.js`](src/privo-journal.js) | Spot trade journal: trades from receipts or the Blockscout API, average-cost book and realized PnL per sale. |
| [`src/privo-feed.js`](src/privo-feed.js) | Read-only market data: pool prices and candles (GeckoTerminal), Orderly perp stats, candles and max leverage per market. |
| [`src/privo-sdk.js`](src/privo-sdk.js) | SDK for bots and AI agents: the `Privo` class over the modules above (spot buy/sell, perps connect/deposit/order, block request/answer/check/settle, read API). |
| [`examples/`](examples) | Example bots, starting with a dip buyer. |
| [`test/`](test) | Tests that run against mainnet state with `eth_call` and state overrides. They send no transactions. |
| [`docs/block-desk.md`](docs/block-desk.md) | How the Block desk works, its rules and test results. |

## SDK for bots and agents

Bots trade on PRIVO with their own wallet. There are no API keys, and PRIVO never holds a bot's keys or funds.

```bash
npm install github:privoexchange/privoperps viem
```

```js
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Privo, Swap } from "privoperps";

const wallet = createWalletClient({ account: privateKeyToAccount(process.env.PRIVATE_KEY), chain: Swap.CHAIN, transport: http() });
const privo = new Privo({ wallet });

await privo.spot.quote("TSLA", "buy", "100");        // 100 USDG in, with the 0.15% PRIVO fee
await privo.spot.buy("TSLA", "100");
const { key } = await privo.perps.connect();          // once; store key.secret privately, pass it back as perpsKey
await privo.perps.order({ sym: "ETH", side: "BUY", qty: 0.01 });
```

Read-only data, no key: `GET https://privoexchange.com/api/v1/markets`, `/api/v1/prices` and `/api/v1/arena`.

The perps trading key places and cancels orders for 30 days and cannot withdraw. Use a separate bot wallet that holds only what the bot may trade. See [`examples/dip-buyer.mjs`](examples/dip-buyer.mjs) (start with `DRY_RUN=1`).

## Deployed

| | Address (Robinhood Chain) |
|---|---|
| PrivoBlockDesk | [`0x8D94fCe2925EBA2448DA28f9461c8b644c26b8e7`](https://robinhoodchain.blockscout.com/address/0x8D94fCe2925EBA2448DA28f9461c8b644c26b8e7) |
| $PRIVO token (ERC-20, 18 decimals) | [`0xD5eE65798eb4E0528CdF9B6C23b663d8a2276dA0`](https://robinhoodchain.blockscout.com/token/0xD5eE65798eb4E0528CdF9B6C23b663d8a2276dA0) |
| PRIVO fee wallet (Safe multisig) | [`0xCc051cf47547386bA147FDDfcBCFE00E791C1418`](https://robinhoodchain.blockscout.com/address/0xCc051cf47547386bA147FDDfcBCFE00E791C1418) |
| Orderly vault | [`0x816f722424b49cf1275cc86da9840fbd5a6167e9`](https://robinhoodchain.blockscout.com/address/0x816f722424b49cf1275cc86da9840fbd5a6167e9) |
| Uniswap Universal Router | [`0x8876789976decbfcbbbe364623c63652db8c0904`](https://robinhoodchain.blockscout.com/address/0x8876789976decbfcbbbe364623c63652db8c0904) |
| USDG | [`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) |

The Block desk was deployed with the standard CREATE2 deployer (`0x4e59…956C`) and salt `keccak256("PRIVO Block Desk v1")`. The bytecode on chain matches `contracts/out/PrivoBlockDesk.json`; `test/blockdesk/deploy-test.mjs` checks it.

## Fees

| Product | Fee | Where it is enforced |
|---|---|---|
| Spot | 0.15% of the USDG side (`FEE_BIPS = 15`, capped at 1%) | Universal Router `PAY_PORTION`, inside the signed swap |
| Block desk | 0.10% of the USDG leg (`FEE_BIPS = 10`, a constant) | `PrivoBlockDesk.settle` |
| Perps | Orderly's trading fees, including PRIVO's builder share; 1 USDG per withdrawal (Orderly) | Orderly |

## Run the tests

Node 22 or newer (WebCrypto Ed25519).

```bash
npm install
npm test                      # offline only: journal, perps order messages and trading-key handling (Orderly stubbed)
npm run test:chain            # reads live data: perps sizing (Orderly public API), the SDK, spot swaps and Orderly accounts
node test/blockdesk/desk-test.mjs      # contract on mainnet state: settle, fees, signatures, nonces
node test/blockdesk/ui-core-test.mjs   # client library against the deployed contract
node test/blockdesk/deploy-test.mjs    # deployed bytecode matches this build
node test/sim/livetest.mjs             # spot swaps with the PRIVO fee for every market
node test/sim/perpstest.mjs            # Orderly account IDs, vault deposits, key and request signing
node test/sim/perps-pro-test.mjs       # stop, TP/SL, bracket, post-only/IOC and websocket auth (Orderly stubbed)
node test/sim/perps-key-test.mjs       # non-extractable trading key, old keys revoked for every wallet, hex keys memory-only, revoke on sign-out (Orderly stubbed)
```

The chain tests read from a public Robinhood Chain RPC and use throwaway keys. Nothing is broadcast.

## Security

- The contract holds no funds between transactions and has no privileged role. Fees and the fee address cannot change after deployment.
- Quotes are EIP-712 signatures bound to the maker, both token amounts, a nonce and a deadline. ERC-1271 wallets are supported, and malleable (high-s) signatures are rejected.
- Orderly trading keys are short-lived (30 days), stay in the user's browser and cannot withdraw. Withdrawals always need the wallet's EIP-712 signature.

The contract has not had an external audit. If you find a problem, please open a private security advisory on this repository instead of a public issue.

## Disclaimer

This software is provided as is, without warranty. Stock tokens follow a price and are not shares. Leveraged trading can lose all margin. Nothing here is financial advice.

## License

[MIT](LICENSE)
