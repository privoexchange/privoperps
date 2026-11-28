# PRIVO Perps

Open-source core of [PRIVO](https://privoexchange.com), a trading layer for stock tokens and crypto on **Robinhood Chain** (chain ID 4663):

- **Spot** trades route to Uniswap pools, with a small PRIVO fee taken on chain.
- **Perps** run on [Orderly Network](https://orderly.network) through PRIVO's builder account (`privo`), margined in USDG.
- **Baskets** on spot: one USDG amount spread over 2 to 8 stock tokens in a single Universal Router call under one Permit2 signature, each bought on its best pool with its own slippage floor; all or nothing, with the PRIVO fee taken once. A basket sells the same way: 2 to 8 stock tokens to USDG in one call under one Permit2 PermitBatch signature, each leg with its own floor, all or nothing (`quoteBasketSell`, `buildBasketSell`). A basket rebalances the same way: what is above its target share sells, the fee is taken once on the proceeds, and what is below target is bought with the worst-case proceeds, in one call under one PermitBatch signature (`quoteRebalance`, `buildRebalance`).
- **$PRIVO** on spot: its only pool is the Pons launch pool (Uniswap v4 against native ETH, with a hook that keeps 3% of every swap), so pools marked hop: "ETH" route USDG -> ETH -> PRIVO and back in one Universal Router call with the PRIVO fee.
- **Limit orders and TWAP** on spot: the trader signs an order off chain, and PRIVO's keeper fills it through the PrivoOrders contract, never below the trader's limit, in one go or in slices over time.
- **PRIVO AI** reads a request typed or spoken in plain English ("buy 20 dollars of Tesla", "sell half my NVDA") and turns it into order tickets the trader reviews and signs. The parser runs in the browser; anything else goes to an AI model, and every ticket the model proposes is checked against PRIVO's markets before it is used. Pro chats on one of 11 models and is paid per message from the trader's wallet, in USDG or in $PRIVO at 20% off.
- **Gift links** send stock tokens, crypto or USDG as a link: a one-time gift wallet holds the gift and a little gas, its key lives only after the "#" of the link, and the claimer receives everything without signing or paying gas.
- **The Block desk** is a sealed-quote OTC contract: takers sign quotes off chain, the maker settles the best one in a single transaction, and losing quotes stay off chain unless the maker fills them (the app and SDK settle at most once per request and ask losing takers to withdraw).

This repository holds the smart contract, the wallet-free client libraries the app uses, and the tests that check them against Robinhood Chain mainnet state. It does not contain the website, servers or any keys.

## Contents

| Path | What it is |
|---|---|
| [`contracts/PrivoBlockDesk.sol`](contracts/PrivoBlockDesk.sol) | Block desk settlement contract (Solidity 0.8.26). No owner, no admin, no upgrade, no pause. |
| [`contracts/out/PrivoBlockDesk.json`](contracts/out/PrivoBlockDesk.json) | Compiled ABI and bytecode (the deployed build). |
| [`contracts/PrivoOrders.sol`](contracts/PrivoOrders.sol) | Limit order and TWAP contract (Solidity 0.8.26). No owner, no admin, no upgrade, no pause; never holds funds between transactions. |
| [`contracts/out/PrivoOrders.json`](contracts/out/PrivoOrders.json) | Compiled ABI and bytecode (the deployed build). |
| [`src/privo-swap.js`](src/privo-swap.js) | Spot: quotes (Uniswap v3/v4 quoters), Permit2 signing and Universal Router calldata with the PRIVO fee (`PAY_PORTION`). |
| [`src/privo-perps.js`](src/privo-perps.js) | Perps on Orderly: account ID, EIP-712 registration and trading-key messages, ed25519 request signing with a non-extractable WebCrypto trading key (revoked at Orderly on sign-out), market, limit, stop, TP/SL and bracket orders, per-market leverage (up to Orderly's cap: 20x stocks, up to 100x major crypto), sizing checks, position history, referral codes and rebates (Orderly referral program), vault deposits, withdrawals and PnL settlement. |
| [`src/privo-desk.js`](src/privo-desk.js) | Block desk client: request links (stock markets, 24-hour cap), EIP-712 quotes, quote codes, checks of both tokens against the request, settle/cancel calldata, a one-settlement-per-request check, and a status check (by the quote's own nonce) that tells a taker to withdraw a losing quote. Settlement logs are read from the desk's deployment block. |
| [`src/privo-orders.js`](src/privo-orders.js) | Limit orders and TWAP: EIP-712 orders, slice math (same as the contract), limit price to minimum output, order state, and the fill call a keeper sends (best pool quote, route never below the order's limit). |
| [`src/privo-journal.js`](src/privo-journal.js) | Spot trade journal: trades from receipts or the Blockscout API, average-cost book and realized PnL per sale. |
| [`src/privo-feed.js`](src/privo-feed.js) | Read-only market data: pool prices and candles (GeckoTerminal), Orderly perp stats, candles and max leverage per market. |
| [`src/privo-sdk.js`](src/privo-sdk.js) | SDK for bots and AI agents: the `Privo` class over the modules above (spot buy/sell, baskets buy/sell/rebalance/share links, limit and TWAP orders, perps connect/deposit/order, block request/answer/check/settle, read API). |
| [`src/privo-copilot-core.js`](src/privo-copilot-core.js) | PRIVO AI ticket parser and checker: plain English to spot, limit, TWAP, basket and rebalance intents, and the validator every AI-proposed ticket must pass. |
| [`src/privo-voice-core.js`](src/privo-voice-core.js) | Voice: cleans what a speech recognizer heard (spoken numbers and prices, misheard buy/sell, spelled tickers, company names) into the text the parser reads, and the short reply read back. |
| [`src/privo-aipro-core.js`](src/privo-aipro-core.js) | PRIVO AI chat core: the answer-anything prompt with a live market snapshot, conversation history, reply parsing (up to 4 checked tickets), the 11 Pro models with their prices, and per-message payment math (USDG, or $PRIVO at 1.25x its pool sale value). |
| [`src/privo-gift-core.js`](src/privo-gift-core.js) | Gift links: the `g1.` link format (key after "#"), funding transactions (gas first), the gas budget, and the sweep that sends every token and then the leftover ETH to the claimer. |
| [`src/privo-x402.js`](src/privo-x402.js) | x402 payments on Robinhood Chain: the 402 terms, the EIP-3009 USDG authorization (domain "Global Dollar", version 1), the `X-PAYMENT` header, and `payFetch`, which pays one 402 within a price cap. Used by `privo.ai.ask()` and the MCP tool `privo_ai`. |
| [`src/privo-burn.js`](src/privo-burn.js) | $PRIVO buyback & burn from the PRIVO fee Safe: one MultiSend batch (USDG to the router, swap swept to 0x…dEaD, held $PRIVO to 0x…dEaD), its decoder, and a byte-for-byte check against its parameters. |
| [`mcp/privo-mcp.mjs`](mcp/privo-mcp.mjs) | MCP server (`privo-mcp`) so any MCP-capable AI agent can read PRIVO markets and trade with its own wallet, with a per-trade USDG limit. |
| [`examples/`](examples) | Example bots, starting with a dip buyer. |
| [`test/`](test) | Tests that run against mainnet state with `eth_call` and state overrides. They send no transactions. |
| [`docs/block-desk.md`](docs/block-desk.md) | How the Block desk works, its rules and test results. |
| [`docs/orders.md`](docs/orders.md) | How limit orders and TWAP work, what the keeper can and cannot do, and test results. |

## MCP server for AI agents

Any agent that speaks the [Model Context Protocol](https://modelcontextprotocol.io) (Claude, Cursor and other MCP clients) can trade on PRIVO through `privo-mcp`. It runs on the agent's machine over stdio and signs with the agent's own wallet key, which never leaves that machine and is never returned to the model. Without a key it is read-only.

```bash
# Claude Code (Node 22+)
claude mcp add privo -e PRIVO_PRIVATE_KEY=0x... -e PRIVO_MAX_USDG=50 -- npx -y -p github:privoexchange/privoperps privo-mcp

# faster start: install once, then the command is just privo-mcp (run the install again to update)
npm install -g github:privoexchange/privoperps
claude mcp add privo -e PRIVO_PRIVATE_KEY=0x... -e PRIVO_MAX_USDG=50 -- privo-mcp
```

Through `npx`, the first run downloads the package from GitHub, which can take a while; if the client gives up before the server is ready, start it again or install it globally.

Other clients (Claude Desktop, Cursor and so on) take the same command in their `mcpServers` config:

```json
{ "mcpServers": { "privo": {
  "command": "npx", "args": ["-y", "-p", "github:privoexchange/privoperps", "privo-mcp"],
  "env": { "PRIVO_PRIVATE_KEY": "0x...", "PRIVO_MAX_USDG": "50" } } } }
```

| Tool | What it does |
|---|---|
| `privo_markets`, `privo_prices`, `privo_arena` | Markets, pool and perps prices, Arena leaderboard (read API) |
| `privo_wallet` | The agent's address, non-zero balances and limits |
| `privo_quote`, `privo_quote_basket` | Spot and basket quotes: estimated and minimum output, PRIVO fee, route |
| `privo_buy`, `privo_sell` | Spot through Uniswap with the 0.15% PRIVO fee (`sell` takes `"all"`) |
| `privo_basket_buy`, `privo_basket_sell` | 2 to 8 stock tokens in one transaction, all or nothing |
| `privo_quote_rebalance`, `privo_basket_rebalance` | Back to target shares in one transaction: sell what is above target, buy what is below |
| `privo_limit_order`, `privo_twap_order`, `privo_orders`, `privo_cancel_order` | Limit and TWAP through PrivoOrders, filled by PRIVO's keeper, never worse than the price |
| `privo_perps_connect`, `privo_perps_deposit`, `privo_perps_order`, `privo_perps_account`, `privo_perps_cancel` | Orderly perps; the 30-day trading key is saved on the agent's machine and cannot withdraw |
| `privo_ai` | Ask PRIVO AI Pro; each message is paid from the agent's wallet over x402 (one USDG signature, no gas). Suggested tickets are never sent for you |

| Setting | Default | |
|---|---|---|
| `PRIVO_PRIVATE_KEY` | none (read-only) | The agent's own wallet key |
| `PRIVO_MAX_USDG` | 100 | Largest trade, in USDG: what a buy spends, what a sale is quoted to bring back, a perps deposit. Larger trades are refused before anything is signed |
| `PRIVO_MAX_PERPS_USDG` | 5 x `PRIVO_MAX_USDG` | Largest perps order notional at the mark price |
| `PRIVO_MAX_AI_USDG` | 0.05 | Most one PRIVO AI Pro message may cost, in USDG (models cost $0.002 to $0.15) |
| `PRIVO_SLIPPAGE_BPS` | 50 | Spot and basket slippage limit, 1 to 500 |
| `PRIVO_READ_ONLY` | off | `1` offers only the read tools, even with a key |
| `PRIVO_RPC` | PRIVO's list | Comma-separated Robinhood Chain RPC URLs |
| `PRIVO_DATA_DIR` | `~/.privo-mcp` | Where the perps trading key and placed orders are kept (files readable only by you) |

Use a separate wallet that holds only what the agent may trade, plus a little ETH for gas. Every trade is real and on chain. Trading tools are marked destructive, so MCP clients ask before running them unless you allow them.

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
await privo.baskets.buy({ legs: ["AAPL", "MSFT", "NVDA"], amount: "90" });  // one transaction, fee once
await privo.baskets.sell({ legs: ["AAPL", "MSFT", "NVDA"], pct: 50 });       // half of each, to USDG
await privo.baskets.rebalance({ legs: ["AAPL", "MSFT", "NVDA"] });           // back to a third each, one transaction
const { key } = await privo.perps.connect();          // once; store key.secret privately, pass it back as perpsKey
await privo.perps.order({ sym: "ETH", side: "BUY", qty: 0.01 });
```

Read-only data, no key: `GET https://privoexchange.com/api/v1/markets`, `/api/v1/prices` and `/api/v1/arena`.

The perps trading key places and cancels orders for 30 days and cannot withdraw. Use a separate bot wallet that holds only what the bot may trade. See [`examples/dip-buyer.mjs`](examples/dip-buyer.mjs) (start with `DRY_RUN=1`).

## Deployed

| | Address (Robinhood Chain) |
|---|---|
| PrivoBlockDesk | [`0x8D94fCe2925EBA2448DA28f9461c8b644c26b8e7`](https://robinhoodchain.blockscout.com/address/0x8D94fCe2925EBA2448DA28f9461c8b644c26b8e7) |
| PrivoOrders | [`0x18dA607Db67Bc9Cc4F2F5a4b26d09788b47Cf60A`](https://robinhoodchain.blockscout.com/address/0x18dA607Db67Bc9Cc4F2F5a4b26d09788b47Cf60A) |
| PRIVO keeper (fills orders, holds only gas ETH; Privy server wallet that may only sign `PrivoOrders.fill`) | [`0x41700141DAFd7d043c8FC8b7f55e2Fc1dF503a3f`](https://robinhoodchain.blockscout.com/address/0x41700141DAFd7d043c8FC8b7f55e2Fc1dF503a3f) |
| Previous keeper (fills only orders signed before 26 Nov 2026) | [`0x30feed4ee19955b50c1794e0f8da23804ca548de`](https://robinhoodchain.blockscout.com/address/0x30feed4ee19955b50c1794e0f8da23804ca548de) |
| $PRIVO token (ERC-20, 18 decimals) | [`0xD5eE65798eb4E0528CdF9B6C23b663d8a2276dA0`](https://robinhoodchain.blockscout.com/token/0xD5eE65798eb4E0528CdF9B6C23b663d8a2276dA0) |
| PRIVO fee wallet (Safe multisig) | [`0xCc051cf47547386bA147FDDfcBCFE00E791C1418`](https://robinhoodchain.blockscout.com/address/0xCc051cf47547386bA147FDDfcBCFE00E791C1418) |
| Orderly vault | [`0x816f722424b49cf1275cc86da9840fbd5a6167e9`](https://robinhoodchain.blockscout.com/address/0x816f722424b49cf1275cc86da9840fbd5a6167e9) |
| Uniswap Universal Router | [`0x8876789976decbfcbbbe364623c63652db8c0904`](https://robinhoodchain.blockscout.com/address/0x8876789976decbfcbbbe364623c63652db8c0904) |
| USDG | [`0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`](https://robinhoodchain.blockscout.com/address/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168) |

The Block desk was deployed with the standard CREATE2 deployer (`0x4e59…956C`) and salt `keccak256("PRIVO Block Desk v1")`. The bytecode on chain matches `contracts/out/PrivoBlockDesk.json`; `test/blockdesk/deploy-test.mjs` checks it. PrivoOrders was deployed the same way with salt `keccak256("PRIVO Orders v1")`; its bytecode matches `contracts/out/PrivoOrders.json` (`test/orders/deploy-test.mjs`).

## Fees

| Product | Fee | Where it is enforced |
|---|---|---|
| Spot | 0.15% of the USDG side (`FEE_BIPS = 15`, capped at 1%) | Universal Router `PAY_PORTION`, inside the signed swap |
| Limit orders and TWAP | 0.15% of the USDG leg of each fill (`FEE_BIPS = 15`, a constant) | `PrivoOrders.fill` |
| Block desk | 0.10% of the USDG leg (`FEE_BIPS = 10`, a constant) | `PrivoBlockDesk.settle` |
| Perps | Orderly's trading fees, including PRIVO's builder share; 1 USDG per withdrawal (Orderly) | Orderly |

Fees paid to the PRIVO fee Safe (`0xCc051cf47547386bA147FDDfcBCFE00E791C1418`, 2 of 3) buy back $PRIVO and send it to the burn address `0x000000000000000000000000000000000000dEaD`. A buyback is one Safe transaction through MultiSendCallOnly 1.4.1: the Safe's USDG goes to the Universal Router, which buys $PRIVO on its Pons pool through ETH (no PRIVO fee) and sweeps it straight to the burn address with a minimum, and $PRIVO the Safe holds goes to the burn address in the same batch. [`src/privo-burn.js`](src/privo-burn.js) builds the batch and rebuilds it from its parameters so a second owner can check the bytes; `test/sim/burn-test.mjs` simulates it on mainnet state. Totals and every buyback: https://privoexchange.com/token and `GET https://privoexchange.com/api/v1/burn`.

## Run the tests

Node 22 or newer (WebCrypto Ed25519).

```bash
npm install
npm test                      # offline only: journal, perps order messages and trading-key handling (Orderly stubbed)
npm run test:chain            # reads live data: perps sizing (Orderly public API), the SDK, spot swaps and Orderly accounts
npm run test:ai                       # offline: PRIVO AI parser and checker, voice clean-up, chat core and payment math
node test/sim/gift-test.mjs            # gift links: format, funding, sweep, and a claim simulated on mainnet state with fees validated
node test/blockdesk/desk-test.mjs      # contract on mainnet state: settle, fees, signatures, nonces
node test/blockdesk/ui-core-test.mjs   # client library against the deployed contract
node test/blockdesk/deploy-test.mjs    # deployed bytecode matches this build
node test/orders/orders-test.mjs       # PrivoOrders on mainnet state: limit buy/sell, v3 and v4 pools, TWAP slices and timing, every refusal
node test/orders/deploy-test.mjs       # PrivoOrders bytecode on chain matches this build
node test/sim/rebalance-test.mjs       # basket rebalances on mainnet state: lopsided baskets back to target, fee once, router keeps nothing, journal and positions
node test/ai/x402-test.mjs             # x402: payment format, privo.ai.ask within its cap, and a live eth_call that USDG accepts the signature
node test/sim/burn-test.mjs            # $PRIVO buyback: a 2-of-3 Safe batch simulated on mainnet state (eth_simulateV1), every token followed to the burn address
node test/mcp/mcp-test.mjs             # MCP server over stdio: read tools, limits and refusals, and privo_buy / privo_basket_buy transactions simulated on mainnet state
node test/sim/privo-token-test.mjs     # $PRIVO round trips through ETH on mainnet state: fee, floors, router keeps nothing, Pons 3%
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
- Apps built on `src/privo-perps.js` should call `sweepLegacyKeys()` when they load and after a wallet connects (PRIVO's app does both), and `revokePending(key, accountId)` once the account has a valid key, so old hex keys from earlier versions are revoked at Orderly and deleted.

The contract has not had an external audit. If you find a problem, please open a private security advisory on this repository instead of a public issue.

## Disclaimer

This software is provided as is, without warranty. Stock tokens follow a price and are not shares. Leveraged trading can lose all margin. Nothing here is financial advice.

## License

[MIT](LICENSE)
