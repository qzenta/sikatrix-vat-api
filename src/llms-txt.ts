// Served at GET /llms.txt — kept in sync with the repo-root llms.txt by hand.
// (Workers can't read arbitrary files off disk at runtime; this needs to be bundled code.)
export const LLMS_TXT = `# Sikatrix VAT 201 API

> x402-paid VAT validation, calculation, and SARS VAT201 filing-prep service for South African VAT vendors. Built by Sikatrix Business Accountants, a SARS-registered tax practice (PR-0104889).

This service helps AI agents acting on behalf of South African VAT-registered businesses validate transaction data, compute a VAT position for a filing period, and map the result to SARS VAT201 field boxes — the same 14-box structure used on the actual SARS VAT201 return.

**This service does not submit anything to SARS.** It produces filing-ready numbers; submission remains the taxpayer's or their agent's responsibility via SARS eFiling. This boundary is intentional and will not change without explicit notice at this URL.

## Discovery

- OpenAPI spec: /openapi.json
- Health check: /health (free, no payment required)

## Endpoints

- POST /validate — free. Validates transaction data shape and basic sanity (positive amounts, non-negative VAT) before you commit to paying for /calculate.
- POST /calculate — $3.00 USDC (x402, Base network). Computes a full VAT position from a list of classified transactions: output VAT, input VAT (including capital goods and imports), bad debt relief, net VAT payable or refundable.
- POST /prepare — $3.00 USDC (x402, Base network). Takes a VAT calculation (typically the output of /calculate) and maps it to the 14 SARS VAT201 field boxes, ready for manual entry into eFiling.

## Payment

Payment is handled via x402 (https://x402.org) — an unpaid POST to a paid endpoint returns HTTP 402 with the exact payment requirements (asset, network, amount, payTo address) in the response body. No account or API key required; pay per call.

## Supported transaction types

Taxable sale, exempt sale, taxable purchase, exempt purchase, import, export (always zero-rated regardless of input), capital asset acquisition, bad debt write-off, VAT recovery adjustment, generic adjustment.

## Data handling

This service does not store submitted transaction data beyond the request/response cycle. No persistent database. Calculations are stateless and deterministic — the same input will always produce the same output.

## Contact

Operated by Qzenta (Pty) Ltd on behalf of Sikatrix Business Accountants, Alberton, South Africa.
`;
