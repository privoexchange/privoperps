# Block desk

A sealed-quote OTC desk for trades that would move a thin pool.

- **Contract:** [`contracts/PrivoBlockDesk.sol`](../contracts/PrivoBlockDesk.sol) (Solidity 0.8.26)
- **Deployed on Robinhood Chain:** [`0x8D94fCe2925EBA2448DA28f9461c8b644c26b8e7`](https://robinhoodchain.blockscout.com/address/0x8D94fCe2925EBA2448DA28f9461c8b644c26b8e7)
- **Values read from chain:**
  - `FEE_WALLET` = PRIVO fee Safe `0xCc05…1418`
  - `USDG` = `0x5fc5…d168`
  - `FEE_BIPS` = 10

## How it works

1. **The maker asks privately**, for example "sell 1,000 TSLA". The request is a link (`#block/pv_…`) that the maker sends only to the takers they choose. Nothing is posted anywhere.
2. **Takers answer** by signing a `Quote` (EIP-712) in their own wallet. The quote binds:
   - the maker,
   - both tokens and amounts,
   - the block ID,
   - a nonce,
   - a deadline.

   The quote travels back to the maker as a code, off chain.
3. **The maker settles the best quote** with `settle(quote, signature)`. Both legs move in **one transaction**: all or nothing.
4. **Losing quotes stay off chain unless the maker fills them.** A signed quote is valid until its deadline (at most 24 hours), and the contract keeps one nonce per taker, not per request, so a maker could still settle a losing quote later at that taker's signed price. The app tracks this: once a request settles with another quote, it asks each losing taker to withdraw theirs with `cancel(nonce)`, and takers can sign quotes that end sooner than the request.

## Rules enforced by the contract

| Rule | Effect |
|---|---|
| Only the maker named in the quote can `settle` | A copied quote is useless to anyone else |
| The signature must come from the named taker | Smart-contract wallets work through ERC-1271. Malleable (high-s) signatures are rejected |
| Every amount is signed | The maker cannot change the numbers |
| One-time nonces per taker; the taker can `cancel(nonce)` | A quote cannot be used twice and can be withdrawn before it is used |
| Deadline | Expired quotes are rejected |
| Fee of 0.10% (`FEE_BIPS = 10`) to the PRIVO fee Safe | When the taker pays USDG, the fee comes out of what the maker receives. When the maker pays USDG, the maker pays the fee on top. **The taker always gives and receives exactly what they signed.** |
| No owner, admin, upgrade or pause | Fee, fee address and rules cannot change after deployment. The contract never holds funds |

## Tests

`node test/blockdesk/desk-test.mjs` runs the contract on Robinhood Chain mainnet state through `eth_call` and state overrides, with **real USDG and TSLA**. The maker is the test contract [`DeskProbe.sol`](../test/blockdesk/DeskProbe.sol), and the taker signs with a throwaway key. It checks the following:

- **The maker sells 2 TSLA for 770 USDG:**
  - The taker gives exactly 770 USDG and receives exactly 2 TSLA.
  - 0.77 USDG goes to the fee Safe.
  - The maker receives 769.23 USDG.
- **The maker buys 2 TSLA for 760 USDG:**
  - The taker receives exactly 760 USDG.
  - The maker pays 760.76 USDG, fee included.
- **These are rejected:**
  - Reusing a quote.
  - Amounts changed by the maker.
  - A quote signed by someone else.
  - An expired quote.
  - A caller who is not the maker.
  - A cancelled nonce.
  - High-s signatures.
  - The same token on both sides.
- **Not enough balance or allowance:** the whole settle reverts and no token moves.
- **Hashing:** `hashQuote()` equals the EIP-712 hash that wallets sign.

`node test/blockdesk/ui-core-test.mjs` drives the client library ([`src/privo-desk.js`](../src/privo-desk.js)) against the **deployed** contract. It covers:

- Request links and quote codes round-trip.
- Bad quotes are flagged.
- The best quote settles at the real address.
- A taker cannot settle on their own.

The ERC-1271 path (a smart-contract wallet as taker) is not covered by a test yet.

## Deployment

The contract was deployed through the standard CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C` with salt `keccak256("PRIVO Block Desk v1")`, so the address follows from the bytecode alone. `node test/blockdesk/deploy-test.mjs` checks that the code on chain matches `contracts/out/PrivoBlockDesk.json`. Changing the contract changes the address; rebuild with `npm run compile`.

## Known risks

- **No external audit yet.** The tests cover the main flows and common attacks, but they are not a substitute for an audit. Keep block sizes modest until it has one.
- **Both sides approve the contract.** Approve the exact block amount, not unlimited amounts. The PRIVO app requests exact approvals.
- **Immutable.** A bug fix means deploying a new version at a new address.
- **Stock tokens** may carry their issuer's own transfer or regional rules.
