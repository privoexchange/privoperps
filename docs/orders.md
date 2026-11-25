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
3. **The keeper fills when the price allows.** Every minute, PRIVO's keeper checks each due slice. It quotes the best Uniswap pool and calls `fill` only when the pool can pay at least that slice's share of `minAmountOut`.

   `fill` does the following, in one transaction:
   - takes the 0.15% fee on the USDG side;
   - sends the slice from the maker straight into the Universal Router and runs the route;
   - pays the output to the maker.
4. **Cancel at any time.** `cancel(nonce)` stops every unfilled slice. Nothing is held for the trader, so there is nothing to withdraw.

## What the keeper can and cannot do

| Rule in `PrivoOrders.fill` | Effect |
|---|---|
| Only the `filler` the maker signed may fill (or anyone, if the maker signed `address(0)`) | PRIVO's app names PRIVO's keeper, so no one else can pick the moment or the route |
| The EIP-712 signature covers every field | A filler cannot change the limit, the size, the schedule or the tokens (`BadSignature`) |
| Slice *i* fills only after `start + i × interval`, once, and never after the deadline | No early, repeated or late slices (`TooEarly`, `OrderDone`, `Expired`) |
| The maker must receive at least the slice's share of `minAmountOut`, rounded up, after the fee | No fill below the maker's own price (`BelowLimit`) |
| The route must spend the whole slice: the router's balance of the input token may not grow | Nothing of the slice is left in the router for someone else to sweep (`InputLeftInRouter`) |
| `cancel(nonce)` by the maker | Every later fill reverts (`OrderCancelledError`) |
| No owner, admin, upgrade or pause; the contract never holds funds between transactions | There is no key that can move users' tokens |

The keeper wallet ([`0x30fe…48de`](https://robinhoodchain.blockscout.com/address/0x30feed4ee19955b50c1794e0f8da23804ca548de)) holds only ETH for gas. If its key were stolen, the thief could only fill orders at or better than each maker's price, at the slice times the makers chose. They could pick the route and the moment within those limits, but never the price.

## Limits

- Stock tokens against USDG only (18-decimal stock tokens, like the Block desk).
- At most 100 slices, at least 60 seconds apart; an order lives at most 30 days.
- A slice fills only if the maker still holds and has approved the amount.

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

The first live fill was on 25 Nov 2026: slice 1 of a 6-slice TSLA TWAP, filled exactly at the maker's limit.
