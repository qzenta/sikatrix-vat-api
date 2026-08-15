import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import { ZodError } from 'zod';
import { paymentMiddleware } from 'x402-hono';
import { VATCalculator, validateTransactionSet } from './engine/calculator';
import { LLMS_TXT } from './llms-txt';
import {
  ValidateRequestSchema,
  CalculateRequestSchema,
  PrepareRequestSchema
} from './domain/models';

/**
 * Turn a ZodError into plain-English messages instead of the raw stringified
 * issue array (e.g. `[{"code":"invalid_type","path":["transactions",0,"date"]...}]`),
 * which is what error.message returns by default and is useless to an API caller.
 */
function formatZodError(error: ZodError): string[] {
  return error.errors.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}

function errorsFromCaught(error: unknown, fallback: string): string[] {
  if (error instanceof ZodError) {
    return formatZodError(error);
  }
  if (error instanceof SyntaxError) {
    return ['Request body is not valid JSON'];
  }
  return [error instanceof Error ? error.message : fallback];
}

type Bindings = {
  ENVIRONMENT: string;
  PRICE_USDC: string;
  X402_NETWORK: string;
  X402_FACILITATOR: string;
  PAYTO_ADDRESS: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Middleware
app.use(logger());
app.use(cors());

// x402 payment gate — applied per-request via env bindings so staging/production
// can use different networks (base-sepolia testnet vs base mainnet) without code changes.
// /health and /openapi.json stay free so agents can discover + probe the service.
app.use('/calculate', async (c, next) => {
  const middleware = paymentMiddleware(
    c.env.PAYTO_ADDRESS as `0x${string}`,
    {
      '/calculate': {
        price: `$${c.env.PRICE_USDC || '3.00'}`,
        network: (c.env.X402_NETWORK || 'base-sepolia') as 'base-sepolia' | 'base'
      }
    },
    {
      url: (c.env.X402_FACILITATOR || 'https://x402.org/facilitator') as `${string}://${string}`
    }
  );
  return middleware(c, next);
});

app.use('/prepare', async (c, next) => {
  const middleware = paymentMiddleware(
    c.env.PAYTO_ADDRESS as `0x${string}`,
    {
      '/prepare': {
        price: `$${c.env.PRICE_USDC || '3.00'}`,
        network: (c.env.X402_NETWORK || 'base-sepolia') as 'base-sepolia' | 'base'
      }
    },
    {
      url: (c.env.X402_FACILITATOR || 'https://x402.org/facilitator') as `${string}://${string}`
    }
  );
  return middleware(c, next);
});

const calculator = new VATCalculator();

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'sikatrix-vat-api',
    environment: c.env.ENVIRONMENT || 'unknown',
    timestamp: new Date().toISOString()
  });
});

// Agent discovery — plain-text service description per the llms.txt convention
app.get('/llms.txt', (c) => {
  return c.text(LLMS_TXT);
});

// Validation endpoint
app.post('/validate', async (c) => {
  try {
    const body = await c.req.json();
    const validated = ValidateRequestSchema.parse(body);

    // Per-transaction sanity checks
    const errors: string[] = [];
    for (const tx of validated.transactions) {
      if (tx.amount <= 0) {
        errors.push(`Transaction ${tx.id}: amount must be positive`);
      }
      if (tx.vatAmount < 0) {
        errors.push(`Transaction ${tx.id}: VAT amount cannot be negative`);
      }
    }

    // Cross-transaction checks: duplicate IDs, dates outside the stated period.
    // These can't be expressed in the per-field Zod schema since they depend on
    // the whole transaction set and the period string together.
    const setIssues = validateTransactionSet(validated.transactions, validated.period);
    for (const issue of setIssues) {
      errors.push(issue.message);
    }

    return c.json({
      success: errors.length === 0,
      data: { transactionCount: validated.transactions.length },
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date()
    }, errors.length > 0 ? 400 : 200);
  } catch (error) {
    return c.json({
      success: false,
      errors: errorsFromCaught(error, 'Validation failed'),
      timestamp: new Date()
    }, 400);
  }
});

// Calculate endpoint
app.post('/calculate', async (c) => {
  try {
    const body = await c.req.json();
    const request = CalculateRequestSchema.parse(body);

    // Map VAT period to calculation
    const calculation = calculator.calculateVATPosition(request.vatPeriod.transactions);

    // Validate compliance
    const compliance = calculator.validateCompliance(calculation);
    if (!compliance.valid) {
      return c.json({
        success: false,
        data: calculation,
        errors: compliance.errors,
        timestamp: new Date()
      }, 400);
    }

    return c.json({
      success: true,
      data: calculation,
      warnings: compliance.warnings.length > 0 ? compliance.warnings : undefined,
      timestamp: new Date()
    });
  } catch (error) {
    return c.json({
      success: false,
      errors: errorsFromCaught(error, 'Calculation failed'),
      timestamp: new Date()
    }, 400);
  }
});

// Prepare endpoint (map to VAT 201)
app.post('/prepare', async (c) => {
  try {
    const body = await c.req.json();
    const request = PrepareRequestSchema.parse(body);

    // Guard against a hand-crafted or corrupted calculation object being prepared
    // for filing without ever having passed through calculateVATPosition — e.g. a
    // caller that computed netVAT themselves and got the arithmetic wrong. /prepare
    // trusts its input's shape (via Zod) but not its internal consistency, so check
    // that here before mapping to SARS boxes.
    const expectedNetVAT = request.calculation.vatPayable - request.calculation.vatRecoverable;
    const netVATDelta = Math.abs(request.calculation.netVAT - expectedNetVAT);
    if (netVATDelta > 0.01) {
      return c.json({
        success: false,
        errors: [
          `Calculation is internally inconsistent: netVAT (${request.calculation.netVAT}) does not equal vatPayable - vatRecoverable (${expectedNetVAT}). Re-run /calculate rather than constructing this object manually.`
        ],
        timestamp: new Date()
      }, 400);
    }

    // Map to VAT 201 field set
    const vat201FieldSet = calculator.mapToVAT201(request.calculation);

    return c.json({
      success: true,
      data: {
        calculation: request.calculation,
        vat201FieldSet,
        filableFormat: {
          period: request.period,
          boxes: vat201FieldSet
        }
      },
      timestamp: new Date()
    });
  } catch (error) {
    return c.json({
      success: false,
      errors: errorsFromCaught(error, 'Preparation failed'),
      timestamp: new Date()
    }, 400);
  }
});

// OpenAPI schema endpoint
app.get('/openapi.json', (c) => {
  return c.json({
    openapi: '3.0.0',
    info: {
      title: 'Sikatrix VAT 201 API',
      version: '1.0.0',
      description: 'VAT 201 validation & filing-prep service (x402-enabled)'
    },
    servers: [
      { url: 'https://vat-staging.qzenta.dev', description: 'Staging' },
      { url: 'https://vat-api.sikatrix.co.za', description: 'Production' }
    ],
    paths: {
      '/health': {
        get: {
          summary: 'Health check',
          responses: { '200': { description: 'Service healthy' } }
        }
      },
      '/llms.txt': {
        get: {
          summary: 'Agent-readable service description (llms.txt convention)',
          responses: { '200': { description: 'Plain-text service description' } }
        }
      },
      '/validate': {
        post: {
          summary: 'Validate VAT transactions',
          requestBody: { required: true, content: { 'application/json': {} } },
          responses: { '200': { description: 'Validation result' } }
        }
      },
      '/calculate': {
        post: {
          summary: 'Calculate VAT position',
          requestBody: { required: true, content: { 'application/json': {} } },
          responses: { '200': { description: 'VAT calculation' } }
        }
      },
      '/prepare': {
        post: {
          summary: 'Prepare VAT 201 filing data',
          requestBody: { required: true, content: { 'application/json': {} } },
          responses: { '200': { description: 'VAT 201 field set' } }
        }
      }
    }
  });
});

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Application error:', err);
  return c.json({
    success: false,
    errors: ['Internal server error'],
    timestamp: new Date()
  }, 500);
});

export default app;
