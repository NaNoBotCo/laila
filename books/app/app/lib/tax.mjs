// tax.mjs — reading the rate table, and the arithmetic that hangs off it.
//
// Every rate this file uses comes from a dated row in the `rate` table, never
// from a constant here; the defaults below are only what `seedRates()` writes
// on a fresh database, each with the provision it came from. A rate changes by
// decree more often than code ships, and a payslip for March has to stay
// reproducible in December, so the rate used is frozen onto the document that
// used it.
//
// The figures this produces are what goes on a form. A bookkeeper's eye before
// filing is part of the process, not a failure of it.

import { pct, onBands } from './money.mjs'

// ---- rate table access -----------------------------------------------------

/**
 * The rate in force on a date, under one country's law.
 *
 * Rows are dated and the latest one that started on or before the date and has
 * not ended wins. `jur` is not optional in spirit: two sets of books in the
 * same file can be in different countries, and reading Thailand's VAT into a
 * Cambodian invoice is the kind of mistake nobody notices until a return is
 * wrong. It defaults to Thailand because that is where the first books were.
 */
export async function rateOn(db, scope, code, onDate, jur = 'TH') {
  return db.get(
    `SELECT * FROM rate
      WHERE jur = ? AND scope = ? AND code = ? AND from_date <= ?
        AND (to_date IS NULL OR to_date >= ?)
      ORDER BY from_date DESC LIMIT 1`,
    jur, scope, code, onDate, onDate)
}

/** Every rate in force on a date, as a lookup a jurisdiction pack can read. */
export async function ratesInForce(db, onDate, jur = 'TH') {
  const rows = await db.all(
    `SELECT * FROM rate
      WHERE jur = ? AND from_date <= ? AND (to_date IS NULL OR to_date >= ?)
      ORDER BY scope, code, from_date DESC`, jur, onDate, onDate)
  const map = new Map()
  for (const r of rows) {
    const key = `${r.scope}:${r.code}`
    if (!map.has(key)) map.set(key, r)
  }
  return (scope, code) => map.get(`${scope}:${code}`) ?? null
}

export const DEFAULT_RATES = [
  // VAT. The Revenue Code sets 10%; royal decrees have kept it at 7% and are
  // renewed, so the rate lives in a dated row and the renewal is a new row.
  { scope: 'vat', code: 'standard', value_bp: 700, from_date: '2000-01-01',
    source: 'Royal Decree reducing the s.80 rate' },
  { scope: 'vat', code: 'registration_threshold', value_satang: 180_000_000,
    from_date: '2000-01-01', source: 'Revenue Code s.81/1 — ฿1.8m turnover' },

  // Withholding on payments for services, by payee type. The payer withholds
  // and files: PND3 when the payee is an individual, PND53 for a company.
  { scope: 'wht', code: 'service', value_bp: 300, from_date: '2000-01-01',
    source: 'Revenue Code s.3 tredecim — services, 3%' },
  { scope: 'wht', code: 'professional', value_bp: 300, from_date: '2000-01-01',
    source: 'professional fees, 3%' },
  { scope: 'wht', code: 'rent', value_bp: 500, from_date: '2000-01-01',
    source: 'rent of property, 5%' },
  { scope: 'wht', code: 'advertising', value_bp: 200, from_date: '2000-01-01',
    source: 'advertising fees, 2%' },
  { scope: 'wht', code: 'transport', value_bp: 100, from_date: '2000-01-01',
    source: 'transport, 1%' },
  { scope: 'wht', code: 'none', value_bp: 0, from_date: '2000-01-01', source: 'goods' },

  // Social security: 5% of wage from the employee, matched by the employer,
  // computed on a wage band, so the monthly contribution tops out.
  { scope: 'sso', code: 'employee_bp', value_bp: 500, from_date: '2000-01-01',
    source: 'Social Security Act s.46' },
  { scope: 'sso', code: 'employer_bp', value_bp: 500, from_date: '2000-01-01',
    source: 'Social Security Act s.46' },
  { scope: 'sso', code: 'wage_floor', value_satang: 165_000, from_date: '2000-01-01',
    source: '฿1,650 monthly wage floor' },
  { scope: 'sso', code: 'wage_cap', value_satang: 1_500_000, from_date: '2000-01-01',
    source: '฿15,000 monthly wage ceiling — ฿750 maximum each side' },

  // Personal income tax: the deductions an employer applies when estimating
  // withholding, and the bands.
  { scope: 'pit', code: 'expense_bp', value_bp: 5000, from_date: '2000-01-01',
    source: 'employment income expense deduction, 50%' },
  { scope: 'pit', code: 'expense_cap', value_satang: 10_000_000, from_date: '2000-01-01',
    source: 'capped at ฿100,000' },
  { scope: 'pit', code: 'personal_allowance', value_satang: 6_000_000,
    from_date: '2000-01-01', source: '฿60,000' },
  { scope: 'pit', code: 'spouse_allowance', value_satang: 6_000_000,
    from_date: '2000-01-01', source: '฿60,000, spouse without income' },
  { scope: 'pit', code: 'child_allowance', value_satang: 3_000_000,
    from_date: '2000-01-01', source: '฿30,000 per child' },
  { scope: 'pit', code: 'sso_deduction_cap', value_satang: 900_000,
    from_date: '2000-01-01', source: 'contributions deductible up to ฿9,000' },

  // The income tax schedule, one row per band: `value_satang` is the top of
  // the band and `value_bp` the rate inside it. The last band has no top.
  { scope: 'pit_band', code: '1', value_satang: 15_000_000, value_bp: 0,
    from_date: '2000-01-01', source: 'up to ฿150,000 — nil' },
  { scope: 'pit_band', code: '2', value_satang: 30_000_000, value_bp: 500,
    from_date: '2000-01-01', source: 'to ฿300,000 — 5%' },
  { scope: 'pit_band', code: '3', value_satang: 50_000_000, value_bp: 1000,
    from_date: '2000-01-01', source: 'to ฿500,000 — 10%' },
  { scope: 'pit_band', code: '4', value_satang: 75_000_000, value_bp: 1500,
    from_date: '2000-01-01', source: 'to ฿750,000 — 15%' },
  { scope: 'pit_band', code: '5', value_satang: 100_000_000, value_bp: 2000,
    from_date: '2000-01-01', source: 'to ฿1,000,000 — 20%' },
  { scope: 'pit_band', code: '6', value_satang: 200_000_000, value_bp: 2500,
    from_date: '2000-01-01', source: 'to ฿2,000,000 — 25%' },
  { scope: 'pit_band', code: '7', value_satang: 500_000_000, value_bp: 3000,
    from_date: '2000-01-01', source: 'to ฿5,000,000 — 30%' },
  { scope: 'pit_band', code: '8', value_satang: null, value_bp: 3500,
    from_date: '2000-01-01', source: 'above ฿5,000,000 — 35%' },
]

/**
 * Progressive bands, in satang, with the marginal rate in basis points.
 *
 * These are the DEFAULTS written on a fresh database. The bands the arithmetic
 * actually uses come from the rate table (`scope = 'pit_band'`), so a change to
 * the schedule is a row with a start date, not a new version of this file.
 */
export const PIT_BANDS = [
  { upTo: 15_000_000, bp: 0 },
  { upTo: 30_000_000, bp: 500 },
  { upTo: 50_000_000, bp: 1000 },
  { upTo: 75_000_000, bp: 1500 },
  { upTo: 100_000_000, bp: 2000 },
  { upTo: 200_000_000, bp: 2500 },
  { upTo: 500_000_000, bp: 3000 },
  { upTo: Infinity, bp: 3500 },
]

export async function seedRates(db, insert) {
  for (const r of DEFAULT_RATES) await insert(r)
}

/** The ladder in force on a date, or the defaults when none are recorded. */
export async function bandsOn(db, onDate, jur = 'TH') {
  const rows = await db.all(
    `SELECT * FROM rate WHERE jur = ? AND scope = 'pit_band' AND from_date <= ?
       AND (to_date IS NULL OR to_date >= ?) ORDER BY CAST(code AS INTEGER)`,
    jur, onDate, onDate)
  if (!rows.length) return PIT_BANDS
  return rows.map((r) => ({
    upTo: r.value_satang == null ? Infinity : r.value_satang,
    bp: r.value_bp ?? 0,
  }))
}

/** The VAT rate to charge on a document dated `onDate`, in basis points. */
export async function vatBpOn(db, onDate, jur = 'TH') {
  const row = await rateOn(db, 'vat', 'standard', onDate, jur)
  return row?.value_bp ?? (jur === 'KH' ? 1000 : 700)
}

/** The withholding rate for a kind of payment, in basis points. */
export async function whtBpOn(db, code, onDate, jur = 'TH') {
  const row = await rateOn(db, 'wht', code, onDate, jur)
  return row?.value_bp ?? 0
}

// ---- VAT -------------------------------------------------------------------

/** VAT added to a net amount. Thai practice rounds to the satang. */
export const vatOn = (net, bp = 700) => pct(net, bp)

// ---- withholding on a supplier payment ------------------------------------

/**
 * What a payer withholds from a service payment. Withholding is computed on
 * the amount BEFORE VAT — a ฿100 service invoice with ฿7 VAT is settled by
 * ฿104: ฿107 less ฿3 withheld.
 */
export function withholdingOn(net, bp) {
  return pct(net, bp)
}

/** The form the payer files for this payee: individuals PND3, companies PND53. */
export const whtForm = (isCompany) => (isCompany ? 'PND53' : 'PND3')

// ---- social security -------------------------------------------------------

/**
 * One month's contribution, each side. The rate applies to the wage clamped
 * into the band, which is why ฿40,000 and ฿15,000 both give ฿750.
 */
export function ssoContribution(monthlyWage, { bp = 500, floor = 165_000, cap = 1_500_000 } = {}) {
  // The base is the wage brought inside the band at both ends: a wage under
  // the floor contributes on the floor, one over the ceiling on the ceiling.
  const base = Math.min(Math.max(Math.max(monthlyWage, 0), floor), cap)
  // Contributions are rounded to the baht.
  return Math.round(pct(base, bp) / 100) * 100
}

// ---- personal income tax ---------------------------------------------------

/** Tax on a taxable income, walking whichever ladder it is given. */
export const pitOn = (taxable, bands = PIT_BANDS) => onBands(taxable, bands)

/**
 * Monthly withholding on employment income, s.50(1): project the year from
 * what is being paid, compute the year's tax, divide by the pay periods left.
 *
 * `periodsInYear` is the number of pay periods THIS EMPLOYMENT has in the
 * calendar year, not always twelve. Someone hired in September earns four
 * months this year, and annualising their salary as if they had earned it all
 * year withholds several times what they will owe — the employee carries the
 * difference until they file for it back.
 *
 * Returns the working as well as the number. A payslip stores this object, so
 * the deduction can be explained to the person it came out of without
 * recomputing it against rates that have since changed.
 */
export function withholdingForMonth({
  monthlyGross,
  periodsInYear = 12,
  periodsRemaining = 12,
  taxPaidSoFar = 0,
  ssoAnnual = 0,
  expenseBp = 5000,
  expenseCap = 10_000_000,
  personalAllowance = 6_000_000,
  spouseAllowance = 0,
  children = 0,
  childAllowance = 3_000_000,
  ssoDeductionCap = 900_000,
  otherDeductions = 0,
  bands = PIT_BANDS,
}) {
  const annualGross = monthlyGross * periodsInYear
  const expense = Math.min(pct(annualGross, expenseBp), expenseCap)
  const ssoDeduct = Math.min(ssoAnnual, ssoDeductionCap)
  const allowances = personalAllowance + spouseAllowance + children * childAllowance +
    ssoDeduct + otherDeductions
  const taxable = Math.max(0, annualGross - expense - allowances)
  const annualTax = pitOn(taxable, bands)
  const left = Math.max(1, periodsRemaining)
  const thisPeriod = Math.max(0, Math.round((annualTax - taxPaidSoFar) / left))
  return {
    annualGross, expense, allowances, taxable, annualTax,
    monthly: thisPeriod,
    periodsInYear,
    working: { periodsInYear, periodsRemaining: left, taxPaidSoFar },
  }
}
