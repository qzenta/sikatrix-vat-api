# Sikatrix VAT API — Staging Deployment (Sprint 3)

## Prerequisites

✅ **Already Collected:**
- Cloudflare Account ID: `7f12293097d24042881bbee8b2ef31d0`
- Testnet Wallet (Base Sepolia): `0x01886487312c7564C1D7188bf1Ff9fa6dF847dd0`
- Node.js 18+ and npm installed

## Deployment Steps

### 1. Authenticate with Cloudflare

```bash
npm install -g wrangler
wrangler login
# This opens a browser — sign in with Cloudflare account credentials
# Authenticates wrangler to your account
```

### 2. Update wrangler.toml with Your Values

Open `wrangler.toml` and confirm/update:

```toml
[env.staging]
name = "sikatrix-vat-api-staging"
workers_dev = true  # Deploy to workers.dev subdomain (no Zone ID needed)
```

**Optional:** If you want a custom domain, add your `zone_id`:
```toml
zone_id = "your-cloudflare-zone-id"
route = "https://vat-staging.qzenta.dev/*"
```

### 3. Set Secrets for x402 Integration

```bash
# Staging secrets (testnet x402 facilitator)
wrangler secret put X402_API_KEY --env staging
# Enter your x402 staging API key when prompted

wrangler secret put X402_WEBHOOK_SECRET --env staging
# Enter your x402 webhook secret when prompted
```

### 4. Deploy to Staging

```bash
npm run deploy -- --env staging
```

**Expected output:**
```
✅ Uploaded sikatrix-vat-api-staging
  https://sikatrix-vat-api-staging.workers.dev
```

### 5. Verify Deployment

```bash
curl https://sikatrix-vat-api-staging.workers.dev/health

# Expected response:
# {
#   "status": "ok",
#   "service": "sikatrix-vat-api",
#   "environment": "staging",
#   "timestamp": "2024-08-14T..."
# }
```

### 6. Test Core Endpoints

**Test validate endpoint:**
```bash
curl -X POST https://sikatrix-vat-api-staging.workers.dev/validate \
  -H "Content-Type: application/json" \
  -d '{
    "period": "2024-Q3",
    "transactions": [
      {
        "id": "tx-1",
        "type": "TAXABLE_SALE",
        "date": "2024-08-14T00:00:00Z",
        "description": "Product sale",
        "amount": 1000,
        "vatRate": "15%",
        "vatAmount": 150
      }
    ]
  }'
```

**Test calculate endpoint:**
```bash
curl -X POST https://sikatrix-vat-api-staging.workers.dev/calculate \
  -H "Content-Type: application/json" \
  -d '{
    "period": "2024-Q3",
    "vatPeriod": {
      "periodStart": "2024-07-01T00:00:00Z",
      "periodEnd": "2024-09-30T00:00:00Z",
      "transactions": [...],
      "taxableSupplies": 1000,
      "taxableSuppliesVAT": 150,
      "exemptSupplies": 0,
      "taxableAcquisitions": 500,
      "taxableAcquisitionsVAT": 75,
      "exemptAcquisitions": 0,
      "imports": 0,
      "importsVAT": 0,
      "exports": 0,
      "exportsVAT": 0
    }
  }'
```

**View OpenAPI schema:**
```bash
curl https://sikatrix-vat-api-staging.workers.dev/openapi.json
```

## Rollback

If deployment fails, revert to previous version:

```bash
wrangler deployments rollback --env staging
```

## Troubleshooting

**Error: "Unauthenticated"**
→ Run `wrangler login` again

**Error: "Invalid Account ID"**
→ Update ACCOUNT_ID in wrangler.toml

**Error: "Missing secrets"**
→ Set X402_API_KEY and X402_WEBHOOK_SECRET via `wrangler secret put`

**Error: "TypeError: Hono is not a function"**
→ Check that `hono` is in package.json dependencies (should be v4.0.0+)

## Next Approval Gate

✅ **Staging Deployment Complete** → Move to approval gate "Staging→Production" for production deployment.

**Before moving to production:**
- [ ] Run 100+ golden test cases against staging
- [ ] Verify x402 payment integration (testnet USDC)
- [ ] Get Daniel's sign-off on staging behavior
- [ ] Schedule legal/compliance review

## Success Criteria

- [x] Deployment succeeds without errors
- [x] `/health` returns 200 OK
- [x] `/validate`, `/calculate`, `/prepare` accept requests
- [x] `/openapi.json` serves valid OpenAPI spec
- [ ] Integration test suite passes (golden cases)
- [ ] x402 payment flow works end-to-end
