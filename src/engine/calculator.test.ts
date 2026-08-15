import { describe, it, expect } from 'vitest';
import { VATCalculator, periodBoundary, validateTransactionSet } from './calculator';
import { TransactionType, type Transaction, type VATCalculation } from '../domain/models';

const calculator = new VATCalculator();

let txCounter = 0;
function makeTx(overrides: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'vatAmount'>): Transaction {
  txCounter += 1;
  return {
    id: `00000000-0000-0000-0000-${String(txCounter).padStart(12, '0')}`,
    date: new Date('2026-08-14T00:00:00Z'),
    description: 'Test transaction',
    vatRate: '15%',
    ...overrides
  };
}

function makeCalculation(overrides: Partial<VATCalculation> = {}): VATCalculation {
  return {
    period: '2026-Q3',
    totalSupplies: 0,
    totalSuppliesVAT: 0,
    totalAcquisitions: 0,
    totalAcquisitionsVAT: 0,
    totalImports: 0,
    totalImportsVAT: 0,
    totalExports: 0,
    totalExportsVAT: 0,
    exemptSupplies: 0,
    exemptAcquisitions: 0,
    capitalGoods: 0,
    capitalGoodsVAT: 0,
    badDebtAllowance: 0,
    vatRecoveryAdjustment: 0,
    vatPayable: 0,
    vatRecoverable: 0,
    netVAT: 0,
    ...overrides
  };
}

describe('VATCalculator.classifyTransaction', () => {
  it('classifies a taxable sale as taxable_supplies', () => {
    const result = calculator.classifyTransaction(
      makeTx({ type: TransactionType.TAXABLE_SALE, amount: 1000, vatAmount: 150 })
    );
    expect(result.category).toBe('taxable_supplies');
    expect(result.baseAmount.toNumber()).toBe(1000);
    expect(result.vatAmount.toNumber()).toBe(150);
  });

  it('classifies an exempt sale as exempt_supplies', () => {
    const result = calculator.classifyTransaction(
      makeTx({ type: TransactionType.EXEMPT_SALE, amount: 2000, vatAmount: 0, vatRate: 'exempt' })
    );
    expect(result.category).toBe('exempt_supplies');
  });

  it('classifies an exempt purchase as exempt_acquisitions', () => {
    const result = calculator.classifyTransaction(
      makeTx({ type: TransactionType.EXEMPT_PURCHASE, amount: 500, vatAmount: 0, vatRate: 'exempt' })
    );
    expect(result.category).toBe('exempt_acquisitions');
  });

  it('classifies a capital asset purchase as capital_goods', () => {
    const result = calculator.classifyTransaction(
      makeTx({ type: TransactionType.CAPITAL_ASSET, amount: 50000, vatAmount: 7500 })
    );
    expect(result.category).toBe('capital_goods');
  });

  it('classifies bad debt as bad_debt_allowance', () => {
    const result = calculator.classifyTransaction(
      makeTx({ type: TransactionType.BAD_DEBT, amount: 1000, vatAmount: 150 })
    );
    expect(result.category).toBe('bad_debt_allowance');
  });

  it('classifies an unrecognised/adjustment type as adjustments', () => {
    const result = calculator.classifyTransaction(
      makeTx({ type: TransactionType.ADJUSTMENT, amount: 100, vatAmount: 15 })
    );
    expect(result.category).toBe('adjustments');
  });
});

describe('VATCalculator.calculateVATPosition — core cases', () => {
  it('computes a simple output-vs-input VAT position', () => {
    const result = calculator.calculateVATPosition([
      makeTx({ type: TransactionType.TAXABLE_SALE, amount: 1000, vatAmount: 150 }),
      makeTx({ type: TransactionType.TAXABLE_PURCHASE, amount: 500, vatAmount: 75 })
    ]);

    expect(result.totalSupplies).toBe(1000);
    expect(result.totalSuppliesVAT).toBe(150);
    expect(result.totalAcquisitions).toBe(500);
    expect(result.totalAcquisitionsVAT).toBe(75);
    expect(result.netVAT).toBe(75);
  });

  it('returns an all-zero position for an empty transaction list', () => {
    const result = calculator.calculateVATPosition([]);
    expect(result.totalSupplies).toBe(0);
    expect(result.totalAcquisitions).toBe(0);
    expect(result.netVAT).toBe(0);
    expect(result.vatPayable).toBe(0);
    expect(result.vatRecoverable).toBe(0);
  });

  it('produces a refund position when input VAT exceeds output VAT', () => {
    const result = calculator.calculateVATPosition([
      makeTx({ type: TransactionType.TAXABLE_SALE, amount: 1000, vatAmount: 150 }),
      makeTx({ type: TransactionType.TAXABLE_PURCHASE, amount: 10000, vatAmount: 1500 })
    ]);

    expect(result.vatPayable).toBe(150);
    expect(result.vatRecoverable).toBe(1500);
    expect(result.netVAT).toBe(-1350);
  });
});

describe('VATCalculator.calculateVATPosition — previously-dropped categories (regression coverage)', () => {
  it('includes capital asset input VAT in vatRecoverable and netVAT', () => {
    const result = calculator.calculateVATPosition([
      makeTx({ type: TransactionType.TAXABLE_SALE, amount: 10000, vatAmount: 1500 }),
      makeTx({ type: TransactionType.CAPITAL_ASSET, amount: 50000, vatAmount: 7500 })
    ]);

    expect(result.capitalGoods).toBe(50000);
    expect(result.capitalGoodsVAT).toBe(7500);
    expect(result.vatRecoverable).toBe(7500);
    expect(result.netVAT).toBe(1500 - 7500);
  });

  it('reduces vatPayable by bad debt allowance', () => {
    const result = calculator.calculateVATPosition([
      makeTx({ type: TransactionType.TAXABLE_SALE, amount: 10000, vatAmount: 1500 }),
      makeTx({ type: TransactionType.BAD_DEBT, amount: 2000, vatAmount: 300 })
    ]);

    expect(result.badDebtAllowance).toBe(300);
    expect(result.vatPayable).toBe(1200);
    expect(result.netVAT).toBe(1200);
  });

  it('folds a VAT_RECOVERY adjustment into vatRecoverable', () => {
    const result = calculator.calculateVATPosition([
      makeTx({ type: TransactionType.TAXABLE_SALE, amount: 10000, vatAmount: 1500 }),
      makeTx({ type: TransactionType.VAT_RECOVERY, amount: 1000, vatAmount: 150 })
    ]);

    expect(result.vatRecoveryAdjustment).toBe(150);
    expect(result.vatRecoverable).toBe(150);
    expect(result.netVAT).toBe(1350);
  });

  it('tracks exempt supplies and acquisitions separately without touching taxable totals or netVAT', () => {
    const result = calculator.calculateVATPosition([
      makeTx({ type: TransactionType.TAXABLE_SALE, amount: 10000, vatAmount: 1500 }),
      makeTx({ type: TransactionType.EXEMPT_SALE, amount: 3000, vatAmount: 0, vatRate: 'exempt' }),
      makeTx({ type: TransactionType.EXEMPT_PURCHASE, amount: 800, vatAmount: 0, vatRate: 'exempt' })
    ]);

    expect(result.exemptSupplies).toBe(3000);
    expect(result.exemptAcquisitions).toBe(800);
    expect(result.totalSupplies).toBe(10000);
    expect(result.netVAT).toBe(1500);
  });
});

describe('VATCalculator.calculateVATPosition — exports (zero-rated)', () => {
  it('never charges VAT on exports even if a caller mistakenly sends a non-zero vatAmount', () => {
    const result = calculator.calculateVATPosition([
      makeTx({ type: TransactionType.EXPORT, amount: 5000, vatAmount: 750, vatRate: '15%' })
    ]);

    expect(result.totalExports).toBe(5000);
    expect(result.totalExportsVAT).toBe(0);
    expect(result.netVAT).toBe(0);
  });
});

describe('VATCalculator.calculateVATPosition — rounding and precision', () => {
  it('holds cent-level precision across many small transactions without float drift', () => {
    const transactions: Transaction[] = [];
    for (let i = 0; i < 100; i++) {
      transactions.push(
        makeTx({ type: TransactionType.TAXABLE_SALE, amount: 10.1, vatAmount: 1.515 })
      );
    }
    const result = calculator.calculateVATPosition(transactions);

    expect(result.totalSupplies).toBeCloseTo(1010, 8);
    expect(result.totalSuppliesVAT).toBeCloseTo(151.5, 8);
  });

  it('handles a large volume of mixed transactions without losing precision', () => {
    const transactions: Transaction[] = [];
    for (let i = 0; i < 50; i++) {
      transactions.push(makeTx({ type: TransactionType.TAXABLE_SALE, amount: 333.33, vatAmount: 49.9995 }));
      transactions.push(makeTx({ type: TransactionType.TAXABLE_PURCHASE, amount: 111.11, vatAmount: 16.6665 }));
    }
    const result = calculator.calculateVATPosition(transactions);

    expect(result.totalSupplies).toBeCloseTo(50 * 333.33, 6);
    expect(result.totalAcquisitions).toBeCloseTo(50 * 111.11, 6);
  });
});

describe('VATCalculator.mapToVAT201', () => {
  it('maps a full calculation (including previously-hardcoded boxes) to the correct SARS boxes', () => {
    const calculation = makeCalculation({
      totalSupplies: 10000,
      totalSuppliesVAT: 1500,
      totalAcquisitions: 5000,
      totalAcquisitionsVAT: 750,
      totalImports: 2000,
      totalImportsVAT: 300,
      totalExports: 1000,
      exemptSupplies: 400,
      capitalGoods: 20000,
      badDebtAllowance: 50,
      vatRecoveryAdjustment: 25,
      vatPayable: 1450,
      vatRecoverable: 1075,
      netVAT: 375
    });

    const vat201 = calculator.mapToVAT201(calculation);

    expect(vat201.box1).toBe(10000);
    expect(vat201.box2).toBe(400);
    expect(vat201.box3).toBe(1500);
    expect(vat201.box4).toBe(750);
    expect(vat201.box5).toBe(1075);
    expect(vat201.box7).toBe(375);
    expect(vat201.box8).toBe(2000);
    expect(vat201.box9).toBe(1000);
    expect(vat201.box10).toBe(20000);
    expect(vat201.box11).toBe(50);
    expect(vat201.box12).toBe(25);
    expect(vat201.box13).toBe(1000);
    expect(vat201.box14).toBe(11400);
  });
});

describe('VATCalculator.validateCompliance', () => {
  it('passes a normal, moderate VAT calculation with no warnings', () => {
    const calculation = makeCalculation({
      totalSupplies: 10000,
      totalSuppliesVAT: 1500,
      totalAcquisitions: 5000,
      totalAcquisitionsVAT: 750,
      vatPayable: 1500,
      vatRecoverable: 750,
      netVAT: 750
    });

    const result = calculator.validateCompliance(calculation);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('flags NaN/Infinity results as a hard error', () => {
    const calculation = makeCalculation({ netVAT: NaN });
    const result = calculator.validateCompliance(calculation);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid VAT calculation result');
  });

  it('treats a large net VAT payable as a warning, not a blocking error', () => {
    const calculation = makeCalculation({
      totalSupplies: 400000,
      totalSuppliesVAT: 60000,
      totalAcquisitions: 100,
      totalAcquisitionsVAT: 15,
      vatPayable: 60000,
      vatRecoverable: 15,
      netVAT: 59985
    });

    const result = calculator.validateCompliance(calculation);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some(w => w.includes('R50,000'))).toBe(true);
  });

  it('treats a large VAT refund as a warning, not an error', () => {
    const calculation = makeCalculation({
      totalSupplies: 1000,
      totalSuppliesVAT: 150,
      totalAcquisitions: 500000,
      totalAcquisitionsVAT: 75000,
      vatPayable: 150,
      vatRecoverable: 75000,
      netVAT: -74850
    });

    const result = calculator.validateCompliance(calculation);
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.toLowerCase().includes('refund'))).toBe(true);
  });

  it('does not warn on a moderate refund under the R50,000 threshold', () => {
    const calculation = makeCalculation({
      totalSupplies: 1000,
      totalSuppliesVAT: 150,
      totalAcquisitions: 5000,
      totalAcquisitionsVAT: 750,
      vatPayable: 150,
      vatRecoverable: 750,
      netVAT: -600
    });

    const result = calculator.validateCompliance(calculation);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('VATCalculator — end-to-end realistic period', () => {
  it('correctly nets a mixed real-world VAT period (sales, purchases, imports, exports, capital asset, bad debt, exempt)', () => {
    const transactions: Transaction[] = [
      makeTx({ type: TransactionType.TAXABLE_SALE, amount: 200000, vatAmount: 30000, description: 'Q3 sales' }),
      makeTx({ type: TransactionType.TAXABLE_PURCHASE, amount: 80000, vatAmount: 12000, description: 'Stock purchases' }),
      makeTx({ type: TransactionType.IMPORT, amount: 15000, vatAmount: 2250, description: 'Imported equipment components' }),
      makeTx({ type: TransactionType.EXPORT, amount: 40000, vatAmount: 0, vatRate: '0%', description: 'Export sale' }),
      makeTx({ type: TransactionType.CAPITAL_ASSET, amount: 60000, vatAmount: 9000, description: 'New delivery vehicle' }),
      makeTx({ type: TransactionType.BAD_DEBT, amount: 5000, vatAmount: 750, description: 'Written-off invoice, client liquidated' }),
      makeTx({ type: TransactionType.EXEMPT_SALE, amount: 10000, vatAmount: 0, vatRate: 'exempt', description: 'Exempt financial service' })
    ];

    const result = calculator.calculateVATPosition(transactions);

    expect(result.vatPayable).toBe(29250);
    expect(result.vatRecoverable).toBe(23250);
    expect(result.netVAT).toBe(6000);

    const vat201 = calculator.mapToVAT201(result);
    expect(vat201.box7).toBe(6000);
    expect(vat201.box9).toBe(40000);
    expect(vat201.box10).toBe(60000);
    expect(vat201.box2).toBe(10000);

    const compliance = calculator.validateCompliance(result);
    expect(compliance.valid).toBe(true);
    expect(compliance.warnings).toHaveLength(0);
  });
});

describe('periodBoundary', () => {
  it('computes correct boundaries for each quarter', () => {
    expect(periodBoundary('2026-Q1')).toEqual({
      start: new Date(Date.UTC(2026, 0, 1)),
      end: new Date(Date.UTC(2026, 3, 1))
    });
    expect(periodBoundary('2026-Q2')).toEqual({
      start: new Date(Date.UTC(2026, 3, 1)),
      end: new Date(Date.UTC(2026, 6, 1))
    });
    expect(periodBoundary('2026-Q3')).toEqual({
      start: new Date(Date.UTC(2026, 6, 1)),
      end: new Date(Date.UTC(2026, 9, 1))
    });
    expect(periodBoundary('2026-Q4')).toEqual({
      start: new Date(Date.UTC(2026, 9, 1)),
      end: new Date(Date.UTC(2027, 0, 1)) // rolls into next year correctly
    });
  });

  it('throws a clear error for a malformed period string', () => {
    expect(() => periodBoundary('not-a-period')).toThrow(/Invalid period format/);
    expect(() => periodBoundary('2026-Q5')).toThrow(/Invalid period format/);
    expect(() => periodBoundary('26-Q1')).toThrow(/Invalid period format/);
  });
});

describe('validateTransactionSet', () => {
  it('returns no issues for a clean, in-period, unique-ID transaction set', () => {
    const transactions: Transaction[] = [
      { id: 'a', type: TransactionType.TAXABLE_SALE, date: new Date('2026-08-01T00:00:00Z'), description: 'x', amount: 100, vatRate: '15%', vatAmount: 15 },
      { id: 'b', type: TransactionType.TAXABLE_SALE, date: new Date('2026-09-15T00:00:00Z'), description: 'y', amount: 200, vatRate: '15%', vatAmount: 30 }
    ];
    const issues = validateTransactionSet(transactions, '2026-Q3');
    expect(issues).toHaveLength(0);
  });

  it('flags a duplicate transaction ID', () => {
    const transactions: Transaction[] = [
      { id: 'dup', type: TransactionType.TAXABLE_SALE, date: new Date('2026-08-01T00:00:00Z'), description: 'x', amount: 100, vatRate: '15%', vatAmount: 15 },
      { id: 'dup', type: TransactionType.TAXABLE_SALE, date: new Date('2026-08-02T00:00:00Z'), description: 'y', amount: 200, vatRate: '15%', vatAmount: 30 }
    ];
    const issues = validateTransactionSet(transactions, '2026-Q3');
    expect(issues.some(i => i.message.includes('Duplicate transaction ID'))).toBe(true);
  });

  it('flags a transaction dated before the stated period', () => {
    const transactions: Transaction[] = [
      { id: 'a', type: TransactionType.TAXABLE_SALE, date: new Date('2026-06-30T23:59:59Z'), description: 'x', amount: 100, vatRate: '15%', vatAmount: 15 }
    ];
    const issues = validateTransactionSet(transactions, '2026-Q3'); // Q3 starts 1 Jul
    expect(issues.some(i => i.message.includes('falls outside stated period'))).toBe(true);
  });

  it('flags a transaction dated after the stated period', () => {
    const transactions: Transaction[] = [
      { id: 'a', type: TransactionType.TAXABLE_SALE, date: new Date('2026-10-01T00:00:00Z'), description: 'x', amount: 100, vatRate: '15%', vatAmount: 15 }
    ];
    const issues = validateTransactionSet(transactions, '2026-Q3'); // Q3 ends before 1 Oct
    expect(issues.some(i => i.message.includes('falls outside stated period'))).toBe(true);
  });

  it('accepts a transaction dated exactly on the period start boundary', () => {
    const transactions: Transaction[] = [
      { id: 'a', type: TransactionType.TAXABLE_SALE, date: new Date('2026-07-01T00:00:00Z'), description: 'x', amount: 100, vatRate: '15%', vatAmount: 15 }
    ];
    const issues = validateTransactionSet(transactions, '2026-Q3');
    expect(issues).toHaveLength(0);
  });

  it('rejects a transaction dated exactly on the period end boundary (exclusive upper bound)', () => {
    const transactions: Transaction[] = [
      { id: 'a', type: TransactionType.TAXABLE_SALE, date: new Date('2026-10-01T00:00:00Z'), description: 'x', amount: 100, vatRate: '15%', vatAmount: 15 }
    ];
    const issues = validateTransactionSet(transactions, '2026-Q3');
    expect(issues.some(i => i.message.includes('falls outside stated period'))).toBe(true);
  });

  it('reports both a duplicate ID and an out-of-period date in the same call when both apply', () => {
    const transactions: Transaction[] = [
      { id: 'dup', type: TransactionType.TAXABLE_SALE, date: new Date('2026-01-01T00:00:00Z'), description: 'x', amount: 100, vatRate: '15%', vatAmount: 15 },
      { id: 'dup', type: TransactionType.TAXABLE_SALE, date: new Date('2026-08-01T00:00:00Z'), description: 'y', amount: 100, vatRate: '15%', vatAmount: 15 }
    ];
    const issues = validateTransactionSet(transactions, '2026-Q3');
    expect(issues.some(i => i.message.includes('Duplicate'))).toBe(true);
    expect(issues.some(i => i.message.includes('falls outside stated period'))).toBe(true);
  });
});
