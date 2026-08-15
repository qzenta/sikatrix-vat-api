# Sikatrix VAT 201 API

x402-paid VAT validation, calculation, and SARS VAT201 filing-prep service. Built as Sikatrix's first agent-commerce offering — targeting SARS compliance agents ahead of South Africa's 2028 e-invoicing/compliance mandate.

**Scope boundary:** this service validates VAT data, calculates a VAT position, and maps it to SARS VAT201 field boxes. It does **not** submit anything to SARS. SARS submission is an explicit Phase 2 item, gated on revenue validation and legal review.

## Endpoints

| Endpoint | Method | Cost | Purpose |
|---|---|---|---|
| `/health` | GET | free | Liveness check |
| `/openapi.json` | GET | free | OpenAPI 3.0 spec for agent discovery |
| `/validate` | POST | free | Validate transaction data before paying |
| `/calculate` | POST | **$3 USDC** | Compute VAT position from transactions |
| `/prepare` | POST | **$3 USDC** | Map a VAT calculation to SARS VAT201 boxes |

`/validate` and discovery endpoints are free by design — an agent should be able to check its data is well-formed before spending on `/calculate` or `/prepare`.

## Payment (x402)

Paid endpoints are gated by [x402](https://x402.org) via `x402-hono`. An unpaid request receives HTTP 402 with the full payment spec (network, asset, payTo address, amount). Staging runs on Base Sepolia testnet; production will run on Base mainnet with a separate payout wallet (see `wrangler.toml` — production `PAYTO_ADDRESS` is deliberately left blank until a real mainnet wallet is set).

## Local development

```bash
npm install
npm run dev          # wrangler dev, local Miniflare simulation
npm test              # vitest — unit tests for the calculation engine
npm run build          # typecheck + esbuild bundle
```

**Sandbox/CI note:** Miniflare's local dev mode fetches Cloudflare's `cf.json` geo-metadata over the network by default. In network-restricted environments this fails with a `SyntaxError` on startup. Fix: drop a static `node_modules/.mf/cf.json` (relative to project root) with placeholder geo data before running `wrangler dev`.

## Deployment

See `DEPLOY.md` for the full staging deployment walkthrough (Cloudflare auth, secrets, verification steps).

```bash
npx wrangler login
npx wrangler deploy --env staging
```

## Architecture notes

- **Money math:** all VAT calculations use `decimal.js`, not native JS floats, to avoid cent-level rounding drift across large transaction volumes.
- **Transaction classification:** 10 SARS-relevant transaction types (taxable/exempt sales and purchases, imports, exports, capital assets, bad debt, VAT recovery adjustments, generic adjustments) are classified and folded into VAT201's 14 field boxes.
- **Exports are always zero-rated:** `/calculate` ignores any `vatAmount` a caller sends on an EXPORT transaction and hard-codes it to 0 — this is a legal fact, not something to trust from client input.
- **`/prepare` consistency guard:** rejects a `calculation` object where `netVAT` doesn't arithmetically match `vatPayable - vatRecoverable`, to catch hand-crafted or corrupted input that never actually passed through `/calculate`.

## Testing

Current unit test suite covers the calculation engine's core logic, all 10 transaction-type classifications, rounding/precision under volume, and SARS VAT201 box mapping — including regression tests for two bugs found during development (see git log for details). This is **not yet** the 100+ golden-case suite from real anonymized practice data called for in the original test strategy — that requires Sikatrix's actual historical VAT201 filings and is pending.

```bash
npm test
```
