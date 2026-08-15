import Decimal from 'decimal.js';
import { Transaction, TransactionType, VATCalculation, VAT201FieldSet } from '../domain/models';

/**
 * Compute the [start, end) date boundary for a SARS filing period string
 * like "2026-Q3". SARS VAT periods are calendar quarters: Q1 = Jan-Mar,
 * Q2 = Apr-Jun, Q3 = Jul-Sep, Q4 = Oct-Dec.
 */
export function periodBoundary(period: string): { start: Date; end: Date } {
  const match = period.match(/^(\d{4})-Q([1-4])$/);
  if (!match) {
    throw new Error(`Invalid period format: "${period}" (expected YYYY-QN, e.g. 2026-Q3)`);
  }
  const year = parseInt(match[1], 10);
  const quarter = parseInt(match[2], 10);
  const startMonth = (quarter - 1) * 3; // 0-indexed: Q1->0(Jan), Q2->3(Apr), Q3->6(Jul), Q4->9(Oct)
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 1)); // exclusive upper bound
  return { start, end };
}

export interface TransactionSetIssue {
  transactionId: string;
  message: string;
}

/**
 * Validate a full set of transactions against a stated filing period:
 * flags duplicate transaction IDs and transactions whose date falls
 * outside the stated quarter. This is separate from per-transaction
 * schema validation (Zod) — it's cross-transaction and period-aware,
 * which a per-field schema can't express.
 */
export function validateTransactionSet(transactions: Transaction[], period: string): TransactionSetIssue[] {
  const issues: TransactionSetIssue[] = [];

  const seenIds = new Set<string>();
  for (const tx of transactions) {
    if (seenIds.has(tx.id)) {
      issues.push({ transactionId: tx.id, message: `Duplicate transaction ID "${tx.id}" — each transaction must have a unique ID` });
    }
    seenIds.add(tx.id);
  }

  let boundary: { start: Date; end: Date };
  try {
    boundary = periodBoundary(period);
  } catch {
    // Malformed period is already caught by the Zod regex upstream of this call
    // in normal API usage; if it somehow gets here, skip the date-range check
    // rather than throwing and losing the duplicate-ID findings above.
    return issues;
  }

  for (const tx of transactions) {
    if (tx.date < boundary.start || tx.date >= boundary.end) {
      issues.push({
        transactionId: tx.id,
        message: `Transaction date ${tx.date.toISOString().split('T')[0]} falls outside stated period ${period}`
      });
    }
  }

  return issues;
}

export class VATCalculator {
  constructor() {
    // Set precision for tax calculations (2 decimal places minimum)
    Decimal.set({ precision: 18, rounding: Decimal.ROUND_HALF_UP });
  }

  /**
   * Classify transaction and extract VAT components
   */
  classifyTransaction(tx: Transaction): {
    baseAmount: Decimal;
    vatAmount: Decimal;
    category: string;
  } {
    const base = new Decimal(tx.amount);
    const vat = new Decimal(tx.vatAmount);

    let category = '';

    switch (tx.type) {
      case TransactionType.TAXABLE_SALE:
        category = 'taxable_supplies';
        break;
      case TransactionType.EXEMPT_SALE:
        category = 'exempt_supplies';
        break;
      case TransactionType.TAXABLE_PURCHASE:
        category = 'taxable_acquisitions';
        break;
      case TransactionType.EXEMPT_PURCHASE:
        category = 'exempt_acquisitions';
        break;
      case TransactionType.IMPORT:
        category = 'imports';
        break;
      case TransactionType.EXPORT:
        category = 'exports';
        break;
      case TransactionType.CAPITAL_ASSET:
        category = 'capital_goods';
        break;
      case TransactionType.BAD_DEBT:
        category = 'bad_debt_allowance';
        break;
      case TransactionType.VAT_RECOVERY:
        category = 'vat_recovery';
        break;
      default:
        category = 'adjustments';
    }

    return { baseAmount: base, vatAmount: vat, category };
  }

  /**
   * Calculate total VAT position from transaction list
   */
  calculateVATPosition(transactions: Transaction[]): VATCalculation {
    const position = {
      totalSupplies: new Decimal(0),
      totalSuppliesVAT: new Decimal(0),
      totalAcquisitions: new Decimal(0),
      totalAcquisitionsVAT: new Decimal(0),
      totalImports: new Decimal(0),
      totalImportsVAT: new Decimal(0),
      totalExports: new Decimal(0),
      totalExportsVAT: new Decimal(0),
      exemptSupplies: new Decimal(0),
      exemptAcquisitions: new Decimal(0),
      capitalGoods: new Decimal(0),
      capitalGoodsVAT: new Decimal(0),
      badDebtAllowance: new Decimal(0),
      vatRecoveryAdjustment: new Decimal(0),
      categories: {} as Record<string, Decimal>
    };

    for (const tx of transactions) {
      const { baseAmount, vatAmount, category } = this.classifyTransaction(tx);

      if (!position.categories[category]) {
        position.categories[category] = new Decimal(0);
      }
      position.categories[category] = position.categories[category].plus(baseAmount);

      switch (category) {
        case 'taxable_supplies':
          position.totalSupplies = position.totalSupplies.plus(baseAmount);
          position.totalSuppliesVAT = position.totalSuppliesVAT.plus(vatAmount);
          break;
        case 'taxable_acquisitions':
          position.totalAcquisitions = position.totalAcquisitions.plus(baseAmount);
          position.totalAcquisitionsVAT = position.totalAcquisitionsVAT.plus(vatAmount);
          break;
        case 'imports':
          position.totalImports = position.totalImports.plus(baseAmount);
          position.totalImportsVAT = position.totalImportsVAT.plus(vatAmount);
          break;
        case 'exports':
          // Exports are zero-rated under SARS VAT201 — base value is reported,
          // but VAT is always 0 regardless of what a caller sends. Don't trust vatAmount here.
          position.totalExports = position.totalExports.plus(baseAmount);
          break;
        case 'exempt_supplies':
          position.exemptSupplies = position.exemptSupplies.plus(baseAmount);
          break;
        case 'exempt_acquisitions':
          position.exemptAcquisitions = position.exemptAcquisitions.plus(baseAmount);
          break;
        case 'capital_goods':
          // Capital asset input VAT is recoverable, same as any other taxable acquisition —
          // previously this was classified but never folded into vatRecoverable, silently
          // dropping legitimate input tax deductions from the net VAT result.
          position.capitalGoods = position.capitalGoods.plus(baseAmount);
          position.capitalGoodsVAT = position.capitalGoodsVAT.plus(vatAmount);
          break;
        case 'bad_debt_allowance':
          // Bad debt relief reduces output tax previously accounted for — treat as a
          // reduction to VAT payable, not silently discarded.
          position.badDebtAllowance = position.badDebtAllowance.plus(vatAmount);
          break;
        case 'vat_recovery':
          position.vatRecoveryAdjustment = position.vatRecoveryAdjustment.plus(vatAmount);
          break;
        // 'adjustments' (default/ADJUSTMENT type) has no defined SARS box mapping yet —
        // intentionally excluded from totals until that mapping is confirmed, but still
        // visible in position.categories for audit/debugging.
      }
    }

    const vatPayable = position.totalSuppliesVAT.minus(position.badDebtAllowance);
    const vatRecoverable = position.totalAcquisitionsVAT
      .plus(position.totalImportsVAT)
      .plus(position.capitalGoodsVAT)
      .plus(position.vatRecoveryAdjustment);
    const netVAT = vatPayable.minus(vatRecoverable);

    return {
      period: new Date().toISOString().split('T')[0],
      totalSupplies: parseFloat(position.totalSupplies.toString()),
      totalSuppliesVAT: parseFloat(position.totalSuppliesVAT.toString()),
      totalAcquisitions: parseFloat(position.totalAcquisitions.toString()),
      totalAcquisitionsVAT: parseFloat(position.totalAcquisitionsVAT.toString()),
      totalImports: parseFloat(position.totalImports.toString()),
      totalImportsVAT: parseFloat(position.totalImportsVAT.toString()),
      totalExports: parseFloat(position.totalExports.toString()),
      totalExportsVAT: 0,
      exemptSupplies: parseFloat(position.exemptSupplies.toString()),
      exemptAcquisitions: parseFloat(position.exemptAcquisitions.toString()),
      capitalGoods: parseFloat(position.capitalGoods.toString()),
      capitalGoodsVAT: parseFloat(position.capitalGoodsVAT.toString()),
      badDebtAllowance: parseFloat(position.badDebtAllowance.toString()),
      vatRecoveryAdjustment: parseFloat(position.vatRecoveryAdjustment.toString()),
      vatPayable: parseFloat(vatPayable.toString()),
      vatRecoverable: parseFloat(vatRecoverable.toString()),
      netVAT: parseFloat(netVAT.toString())
    };
  }

  /**
   * Map calculation to SARS VAT 201 boxes
   */
  mapToVAT201(calculation: VATCalculation): VAT201FieldSet {
    return {
      box1: calculation.totalSupplies, // Taxable supplies
      box2: calculation.exemptSupplies, // Exempt supplies
      box3: calculation.totalSuppliesVAT, // VAT on taxable supplies
      box4: calculation.totalAcquisitionsVAT, // Tax on acquisitions
      box5: calculation.vatRecoverable, // VAT recovery
      box6: 0, // Previous period VAT owed
      box7: calculation.netVAT, // Net VAT payable
      box8: calculation.totalImports, // Imports
      box9: calculation.totalExports, // Exports
      box10: calculation.capitalGoods, // Capital goods
      box11: calculation.badDebtAllowance, // Bad debt allowance
      box12: calculation.vatRecoveryAdjustment, // Adjustments
      box13: calculation.totalExports, // Zero-rated supplies
      box14: calculation.totalSupplies + calculation.totalExports + calculation.exemptSupplies // Total supplies
    };
  }

  /**
   * Validate VAT calculation for SARS compliance.
   * `errors` are genuine problems that should block the calculation from being used.
   * `warnings` are informational — the calculation is valid, but the caller should know.
   */
  validateCompliance(calculation: VATCalculation): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (isNaN(calculation.netVAT) || !isFinite(calculation.netVAT)) {
      errors.push('Invalid VAT calculation result');
    }

    if (calculation.totalSuppliesVAT < 0) {
      errors.push('Output VAT (VAT on supplies) cannot be negative');
    }

    if (calculation.vatRecoverable < 0) {
      errors.push('Recoverable VAT cannot be negative');
    }

    // A large net VAT payable is not itself invalid — this is informational only.
    // Previously this blocked /calculate entirely for any legitimately large VAT bill.
    if (calculation.netVAT > 50000) {
      warnings.push('Net VAT payable exceeds R50,000 — client may want to discuss a payment arrangement with SARS');
    }

    // Net VAT refund (recoverable > payable) is normal and valid, but worth surfacing
    // since large refunds sometimes trigger SARS verification/audit.
    if (calculation.netVAT < 0 && Math.abs(calculation.netVAT) > 50000) {
      warnings.push('Net VAT refund exceeds R50,000 — may be subject to SARS verification before payout');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }
}
