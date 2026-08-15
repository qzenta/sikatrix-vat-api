import { z } from 'zod';

// Transaction Types
export enum TransactionType {
  TAXABLE_SALE = 'TAXABLE_SALE',
  EXEMPT_SALE = 'EXEMPT_SALE',
  TAXABLE_PURCHASE = 'TAXABLE_PURCHASE',
  EXEMPT_PURCHASE = 'EXEMPT_PURCHASE',
  IMPORT = 'IMPORT',
  EXPORT = 'EXPORT',
  CAPITAL_ASSET = 'CAPITAL_ASSET',
  ADJUSTMENT = 'ADJUSTMENT',
  BAD_DEBT = 'BAD_DEBT',
  VAT_RECOVERY = 'VAT_RECOVERY'
}

// Zod Schemas
export const TransactionSchema = z.object({
  id: z.string().uuid(),
  type: z.nativeEnum(TransactionType),
  date: z.coerce.date(),
  description: z.string().min(1).max(500),
  amount: z.number().positive(),
  vatRate: z.enum(['0%', '15%', 'exempt']),
  vatAmount: z.number().nonnegative(),
  notes: z.string().optional()
});

export const VATPeriodSchema = z.object({
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  transactions: z.array(TransactionSchema),
  taxableSupplies: z.number().nonnegative(),
  taxableSuppliesVAT: z.number().nonnegative(),
  exemptSupplies: z.number().nonnegative(),
  taxableAcquisitions: z.number().nonnegative(),
  taxableAcquisitionsVAT: z.number().nonnegative(),
  exemptAcquisitions: z.number().nonnegative(),
  imports: z.number().nonnegative(),
  importsVAT: z.number().nonnegative(),
  exports: z.number().nonnegative(),
  exportsVAT: z.number().nonnegative()
});

export const VATCalculationSchema = z.object({
  period: z.string(),
  totalSupplies: z.number(),
  totalSuppliesVAT: z.number(),
  totalAcquisitions: z.number(),
  totalAcquisitionsVAT: z.number(),
  totalImports: z.number(),
  totalImportsVAT: z.number(),
  totalExports: z.number(),
  totalExportsVAT: z.number(),
  exemptSupplies: z.number(),
  exemptAcquisitions: z.number(),
  capitalGoods: z.number(),
  capitalGoodsVAT: z.number(),
  badDebtAllowance: z.number(),
  vatRecoveryAdjustment: z.number(),
  vatPayable: z.number(),
  vatRecoverable: z.number(),
  netVAT: z.number()
});

export const VAT201FieldSetSchema = z.object({
  box1: z.number().describe('Taxable supplies (15%)'),
  box2: z.number().describe('Exempt supplies'),
  box3: z.number().describe('VAT on taxable supplies'),
  box4: z.number().describe('Tax on acquisitions'),
  box5: z.number().describe('VAT recovery'),
  box6: z.number().describe('Previous period VAT owed'),
  box7: z.number().describe('Net VAT payable'),
  box8: z.number().describe('Imports'),
  box9: z.number().describe('Exports'),
  box10: z.number().describe('Capital goods'),
  box11: z.number().describe('Bad debt allowance'),
  box12: z.number().describe('Adjustments'),
  box13: z.number().describe('Zero-rated supplies'),
  box14: z.number().describe('Total supplies')
});

export const ValidateRequestSchema = z.object({
  period: z.string().regex(/^\d{4}-Q[1-4]$/),
  transactions: z.array(TransactionSchema),
  x402PaymentHandle: z.string().optional()
});

export const CalculateRequestSchema = z.object({
  period: z.string(),
  vatPeriod: VATPeriodSchema,
  x402PaymentHandle: z.string().optional()
});

export const PrepareRequestSchema = z.object({
  period: z.string(),
  calculation: VATCalculationSchema,
  x402PaymentHandle: z.string().optional()
});

export const ResponseSchema = z.object({
  success: z.boolean(),
  data: z.record(z.unknown()).optional(),
  errors: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  x402PaymentStatus: z.enum(['pending', 'success', 'failed']).optional(),
  timestamp: z.date()
});

// Types
export type Transaction = z.infer<typeof TransactionSchema>;
export type VATPeriod = z.infer<typeof VATPeriodSchema>;
export type VATCalculation = z.infer<typeof VATCalculationSchema>;
export type VAT201FieldSet = z.infer<typeof VAT201FieldSetSchema>;
export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;
export type CalculateRequest = z.infer<typeof CalculateRequestSchema>;
export type PrepareRequest = z.infer<typeof PrepareRequestSchema>;
export type Response = z.infer<typeof ResponseSchema>;
