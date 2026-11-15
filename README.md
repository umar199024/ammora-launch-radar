# GIWA Launch Radar

**Every new token on GIWA. One simple screen.**

Launch Radar is a lightweight launchpad terminal built on the [Ammora SDK](https://www.npmjs.com/package/@ammora-protocol/sdk) for **GIWA Sepolia** (chain 91342).

- **Find:** lists every token created by the Ammora V4 launch factory (`0x35353a2D…68fA`).
- **Check:** reads each bonding curve live with the SDK: ETH raised vs graduation target, tokens left, trading fee, price, status (Trading / Ready to graduate / Graduated).
- **Trade:** exact-input quotes, then buy or sell straight from the curve. The SDK plans the swap and its approvals; your wallet signs every step. ETH is auto-wrapped to WETH if needed. 1% max slippage.

Non-custodial and frontend only: no backend, no keys.

## SDK usage

```js
import { AmmoraV4LaunchCurveClient, classifyAmmoraV4ExactInputFill, giwaSepoliaAutoRoute } from "@ammora-protocol/sdk";

const factory = giwaSepoliaAutoRoute.factories.find((f) => f.kind === "dbc");
const core = { launchFactory: factory.address, feePolicy: factory.bindings.find((b) => b.name === "feePolicy").address };

const curve = new AmmoraV4LaunchCurveClient(publicClient, curveAddress, core);
const state = await curve.getState();                      // reserves, threshold, fee, status
const quote = await curve.quoteExactInput(amountIn, false); // WETH -> token
const fill  = classifyAmmoraV4ExactInputFill(quote, false); // handles the graduation boundary
const plan  = await curve.planSwapExactInput({
  includedAmountIn: amountIn, baseForQuote: false, allowPartialFill: fill.allowPartialFill,
  slippageBps: 100, recipient, deadline,
});
// plan.approvalRequirements -> approve, then send plan.transaction
```

## Run locally

```sh
npm install
npm run dev     # local dev server
npm run build   # static site in dist/
```

Stack: Vite + vanilla JS + viem + @ammora-protocol/sdk 0.3.9. Discovery uses the GIWA Blockscout API; all curve reads, quotes and swap plans go through the SDK over `https://sepolia-rpc.giwa.io`.

Testnet software. Not financial advice. Built by [@AzrarM](https://x.com/AzrarM) for the Ammora Builder Mission.
