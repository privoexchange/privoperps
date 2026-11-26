# Limit orders and TWAP

PRIVO's spot ticket can place a **limit order** (buy at or below a price, or sell at or above it) or a **TWAP**: the same order split into equal slices filled over time. Both run through the `PrivoOrders` contract on Robinhood Chain at [`0x18dA607Db67Bc9Cc4F2F5a4b26d09788b47Cf60A`](https://robinhoodchain.blockscout.com/address/0x18dA607Db67Bc9Cc4F2F5a4b26d09788b47Cf60A).

## How an order works

1. **The trader approves and signs.** They approve the contract for the amount, then sign an EIP-712 `Order`. The order names:
   - the maker and the filler;
   - both tokens;
   - the total in, and the least the maker must receive overall (`minAmountOut`, after the fee);
   - the number of slices, the time between them, the start, the deadline and a nonce.

   Signing costs no gas. Nothing moves yet, and the tokens stay in the trader's wallet.
2. **The order waits off chain.** PRIVO's server keeps the signed order for its keeper. It is not on the public chain.
3. **The keeper fills when the price allows.** Every minute, PRIVO's keeper checks each due slice. It quotes the best Uniswap pool and calls `fill` only when the pool can pay at least that slice's share of `minAmountOut`. Its route goes through that pool with a 0.5% slippage bound, never below the slice's limit.

   `fill` does the following, in one transaction:
   - takes the 0.15% fee on the USDG side;
   - sends the slice from the maker straight into the Universal Router and runs the route;
   - pays the output to the maker.
4. **Cancel at any time.** `cancel(nonce)` stops every unfilled slice. Nothing is held for the trader, so there is nothing to withdraw.

## What the keeper can and cannot do

| Rule in `PrivoOrders.fill` | Effect |
|---|---|
| Only the `filler` the maker signed may fill (or anyone, if the maker signed `address(0)`) | PRIVO's app and SDK always name PRIVO's keeper, pinned in `src/privo-orders.js`, and refuse any other address. `newOrder()` refuses `address(0)` unless the caller passes `open: true`. The filler picks the route and the moment, and with them the price inside your limit (see below) |
| The EIP-712 signature covers every field | A filler cannot change the limit, the size, the schedule or the tokens (`BadSignature`) |
| Slice *i* fills only after `start + i × interval`, once, and never after the deadline | No early or repeated slices, and none after the deadline (`TooEarly`, `OrderDone`, `Expired`). The contract does not stop overdue slices from filling close together: spacing after the due time is up to the keeper (see below) |
| The maker must receive at least the slice's share of `minAmountOut`, rounded up, after the fee | No fill below the maker's own price (`BelowLimit`) |
| The route must spend the whole slice: the router's balance of the input token may not grow | Nothing of the slice is left in the router for someone else to sweep (`InputLeftInRouter`) |
| `cancel(nonce)` by the maker | Every later fill reverts (`OrderCancelledError`) |
| No owner, admin, upgrade or pause; the contract never holds funds between transactions | There is no key that can move users' tokens |

### Your limit is the worst price you accept

The contract guarantees that every fill pays at least your limit. It does not tie a fill to the pool's price. The filler supplies the route, so a fill can land anywhere between the market and your limit: a hostile filler could pay you exactly your limit and keep the difference. Set your limit at the worst price you are willing to get, not at a price far from the market "just to make sure it fills". This matters most on a TWAP, where the worst price is usually set well away from the market.

PRIVO's keeper always routes each slice through the best Uniswap pool with a 0.5% slippage bound. The keeper wallet ([`0x4170…3a3f`](https://robinhoodchain.blockscout.com/address/0x41700141DAFd7d043c8FC8b7f55e2Fc1dF503a3f)) holds only ETH for gas and can never move your tokens outside a fill. It is a Privy server wallet: its private key stays inside Privy and cannot be exported, and a policy lets it sign exactly one kind of transaction, `PrivoOrders.fill` on Robinhood Chain with no ETH attached. PRIVO's server holds only a signer key bound to that policy. The policy and the wallet are owned by a separate key kept offline. Orders signed before 26 Nov 2026 name the previous keeper ([`0x30fe…48de`](https://robinhoodchain.blockscout.com/address/0x30feed4ee19955b50c1794e0f8da23804ca548de)), which fills only those until they end. If its key were stolen, the thief could fill open orders at each maker's limit (never below it) and keep the gap to the market. To catch that, PRIVO's keeper checks every `Filled` event after each pass and raises an alert on any fill it did not send itself, and on any of its own fills that came in more than 1% under its quote.

### TWAP pacing

The contract only refuses a slice *before* its due time. If slices pile up, for example after a keeper outage, it would accept them all in one block. PRIVO's keeper never catches up in a burst. It keeps the order's interval between its own fills. It shortens that gap only as far as needed to fit the remaining slices before the deadline, and never below 60 seconds.

A v2 contract would enforce both rules on chain: a route limited to swaps on allow-listed pools paying the contract, and a minimum time between fills. The deployed v1 is immutable, so for v1 these rules live in the keeper and the docs.

## Limits

Enforced by the contract:

- USDG must be one side of the order.
- At most 100 slices.
- A slice fills only if the maker still holds and has approved the amount.

Enforced by PRIVO's app, SDK and order API (`newOrder()` and the server), not by the contract:

- Stock tokens only (18-decimal stock tokens, like the Block desk).
- At least 60 seconds between slices.
- An order lives at most 30 days.
- The filler is PRIVO's keeper.

An order signed through another client can step outside these, so use PRIVO's code or check them yourself.

Amounts and prices are per stock token. Some stock tokens stand for more or less than one share: their ERC-8056 `uiMultiplier()` is not 1. Convert a share price with that multiplier before you set a limit.

## Smart wallets and EIP-7702

The contract checks a signature with ECDSA only when the maker's address has no code. Any address with code is checked through ERC-1271 `isValidSignature`, including an EOA delegated through EIP-7702 (code starting `0xef0100`). If that account's code does not confirm the order, the order can never fill.

PRIVO's app, SDK and order API run the same check before they accept an order (`signatureFillable()` in `src/privo-orders.js`), and refuse it with a clear reason. The app and SDK sign first and check before asking for any approval, so no approval is spent on an order that could not fill.

## Approvals

Each order approves the contract for its amount on top of what is already approved. Cancelling or letting an order expire leaves that approval in place. Only the filler you named can use it, and only inside a signed order, but you can lower it at any time:

- In the app, the order list shows any approval left beyond what your open orders still need, with a button to lower it to that amount, or to revoke it.
- In the SDK, `orders.approval(token)` reads it and `orders.revoke(token, keep)` sets it to `keep` (default 0).

Lowering it below what an open order needs stops that order from filling.

## Contract notes

The deployed v1 is immutable. Three behaviours worth knowing:

- **Tokens sent to the contract by mistake cannot be recovered.** It has no owner and no sweep function. Never send tokens to it directly; approve it instead.
- **The minimum is checked on what the contract receives, not on what reaches the maker.** With today's stock tokens these are the same amount. If a stock token ever added a transfer fee, a buyer could receive slightly less than the slice minimum.
- **The buy-side fee rounds down to 0 for slices under 0.000667 USDG.** Such slices are far below any real order size.

A v2 contract would add the route and spacing rules above, check the maker's balance change, and accept an EIP-7702 account's own ECDSA signature.

## Fee

0.15% of the USDG side of each fill (`FEE_BIPS = 15`, a constant), the same as PRIVO spot. It is sent to the PRIVO fee Safe `0xCc05…1418`.

- On a buy, the fee comes out of the USDG the maker spends.
- On a sell, it comes out of the USDG the maker receives.

## Tests

`test/orders/orders-test.mjs` runs the contract against Robinhood Chain mainnet state, with the real USDG, stock tokens, Uniswap pools and Universal Router. It uses `eth_call` and state overrides, so nothing is sent. It checks:

- limit buys and sells on v3 and v4 pools, with exact fees;
- TWAP slices, their timing and the remainder in the last slice;
- every refusal in the table above;
- that `hashOrder` matches the EIP-712 hash wallets sign;
- that the published artifact and address match the source.

`test/orders/deploy-test.mjs` checks that the code on chain is exactly `contracts/out/PrivoOrders.json`.

The first live fill was on 25 Nov 2026: slice 1 of a 6-slice TSLA TWAP, filled by PRIVO's keeper.

Orders are dated from the chain head, so the test holds on an RPC whose head lags or leads the wall clock.

## Review

HEY Research Lab reviewed v1.4.0 at PRIVO's request: nothing Medium or higher. They found two Lows. The first was the price-inside-the-limit point above, which these docs had described wrongly. The second was TWAP slices catching up in one block. Both are now handled in the keeper and described here.
