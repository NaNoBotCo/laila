// th.mjs — Thailand: the rates, the filing calendar and the chart of accounts.
//
// Data, not code. Every row here is what a fresh set of Thai books starts with,
// and every one of them is editable in the app with the date it takes effect.
// The Cambodian pack beside it has the same shape, which is what lets one
// engine keep books in either country.

import { ssoContribution, withholdingForMonth } from '../tax.mjs'

export const CURRENCY = 'THB'
export const CHANGE_CURRENCY = 'THB'    // one currency across the counter
export const REPORT_CURRENCY = 'THB'

// What the law counts in: the bands and the fund are written in baht, whatever the payroll is paid in.
export const STATUTORY_CURRENCY = 'THB'
export const CHANGE_ROUNDING = 100      // satang: a one-baht coin is the floor

export const RATES = [
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


export const SALARY_BANDS = [
  { upTo: 15_000_000, bp: 0 },
  { upTo: 30_000_000, bp: 500 },
  { upTo: 50_000_000, bp: 1000 },
  { upTo: 75_000_000, bp: 1500 },
  { upTo: 100_000_000, bp: 2000 },
  { upTo: 200_000_000, bp: 2500 },
  { upTo: 500_000_000, bp: 3000 },
  { upTo: Infinity, bp: 3500 },
]


export const OBLIGATIONS = [
  { code: 'PND1', name_en: 'Payroll withholding return', name_th: 'ภ.ง.ด.1',
    authority: 'revenue', frequency: 'monthly', due_rule: 'day:7', efile_bonus_days: 8,
    applies_when: 'has_employees', source: 'Revenue Code s.59' },
  { code: 'PND3', name_en: 'Withholding return — individuals', name_th: 'ภ.ง.ด.3',
    authority: 'revenue', frequency: 'monthly', due_rule: 'day:7', efile_bonus_days: 8,
    applies_when: 'withholds', source: 'Revenue Code s.59' },
  { code: 'PND53', name_en: 'Withholding return — companies', name_th: 'ภ.ง.ด.53',
    authority: 'revenue', frequency: 'monthly', due_rule: 'day:7', efile_bonus_days: 8,
    applies_when: 'withholds', source: 'Revenue Code s.59' },
  { code: 'PP30', name_en: 'VAT return', name_th: 'ภ.พ.30',
    authority: 'revenue', frequency: 'monthly', due_rule: 'day:15', efile_bonus_days: 8,
    applies_when: 'vat_registered', source: 'Revenue Code s.83' },
  { code: 'SSO', name_en: 'Social security contribution', name_th: 'เงินสมทบประกันสังคม',
    authority: 'sso', frequency: 'monthly', due_rule: 'day:15', efile_bonus_days: 7,
    applies_when: 'has_employees', source: 'Social Security Act s.47' },
  { code: 'PND51', name_en: 'Half-year corporate return', name_th: 'ภ.ง.ด.51',
    authority: 'revenue', frequency: 'half_year', due_rule: 'months:2', efile_bonus_days: 8,
    applies_when: 'company', source: 'Revenue Code s.67 bis' },
  { code: 'PND50', name_en: 'Annual corporate return', name_th: 'ภ.ง.ด.50',
    authority: 'revenue', frequency: 'annual', due_rule: 'days:150', efile_bonus_days: 8,
    applies_when: 'company', source: 'Revenue Code s.68 — 150 days after year end' },
  { code: 'PND1K', name_en: 'Annual payroll summary', name_th: 'ภ.ง.ด.1ก',
    authority: 'revenue', frequency: 'annual', due_rule: 'months:2', efile_bonus_days: 8,
    applies_when: 'has_employees', source: 'due by the end of February' },
  { code: 'DBD', name_en: 'Financial statements filing', name_th: 'นำส่งงบการเงิน',
    authority: 'dbd', frequency: 'annual', due_rule: 'months:5', efile_bonus_days: 0,
    applies_when: 'company', source: 'within one month of the AGM, AGM within four months of year end' },
  { code: 'PND90', name_en: 'Personal income tax return', name_th: 'ภ.ง.ด.90/91',
    authority: 'revenue', frequency: 'annual', due_rule: 'months:3', efile_bonus_days: 8,
    applies_when: 'sole', source: 'by 31 March following the year' },
]


/**
 * What filing a return does to the books.
 *
 * A VAT return NETS the two control accounts for the period and leaves one
 * figure owed to the Revenue Department; the withholding and social security
 * returns have their liability already, and filing only names it. Paying is a
 * separate act, because the money leaves the bank on a different day and shows
 * up on the statement.
 */
export const FILING_SETTLEMENT = {
  PP30: { nets: ['vat_out', 'vat_in'], payable: '2150', office_en: 'Revenue Department' },
  PND1: { payable: '2210', office_en: 'Revenue Department' },
  PND3: { payable: '2200', office_en: 'Revenue Department' },
  PND53: { payable: '2200', office_en: 'Revenue Department' },
  SSO: { payable: '2300', office_en: 'Social Security Office' },
}

export const CHART = [
  ['1000', 'Cash on hand', 'เงินสด', 'asset', 'cash'],
  ['1010', 'Bank account', 'เงินฝากธนาคาร', 'asset', 'cash'],
  ['1020', 'PromptPay / e-wallet', 'พร้อมเพย์ / กระเป๋าเงินอิเล็กทรอนิกส์', 'asset', 'cash'],
  ['1030', 'Petty cash floats', 'เงินสดย่อย', 'asset', 'cash'],
  ['1100', 'Trade receivables', 'ลูกหนี้การค้า', 'asset', 'ar'],
  ['1200', 'Stock', 'สินค้าคงเหลือ', 'asset', 'stock'],
  ['1300', 'Input VAT', 'ภาษีซื้อ', 'asset', 'vat_in'],
  ['1310', 'Withholding tax suffered', 'ภาษีถูกหัก ณ ที่จ่าย', 'asset', 'wht_recv'],
  ['1400', 'Prepayments', 'ค่าใช้จ่ายจ่ายล่วงหน้า', 'asset', null],
  ['1500', 'Equipment', 'อุปกรณ์', 'asset', null],
  ['1510', 'Accumulated depreciation', 'ค่าเสื่อมราคาสะสม', 'asset', null],

  ['2000', 'Trade payables', 'เจ้าหนี้การค้า', 'liability', 'ap'],
  ['2100', 'Output VAT', 'ภาษีขาย', 'liability', 'vat_out'],
  ['2150', 'VAT payable', 'ภาษีมูลค่าเพิ่มค้างชำระ', 'liability', 'tax_pay'],
  ['2200', 'Withholding tax payable', 'ภาษีหัก ณ ที่จ่ายค้างจ่าย', 'liability', 'wht_pay'],
  ['2210', 'Payroll tax payable (PND1)', 'ภาษีเงินได้พนักงานค้างจ่าย (ภ.ง.ด.1)', 'liability', 'wht_pay'],
  ['2300', 'Social security payable', 'เงินสมทบประกันสังคมค้างจ่าย', 'liability', 'sso'],
  ['2400', 'Wages payable', 'ค่าจ้างค้างจ่าย', 'liability', null],
  ['2500', 'Deferred income', 'รายได้รับล่วงหน้า', 'liability', null],
  ['2900', 'Owed to the owner', 'เงินยืมจากผู้ถือหุ้น', 'liability', null],

  ['3000', 'Capital', 'ทุน', 'equity', 'equity_partner'],
  ['3100', 'Drawings', 'เงินถอนของผู้ถือหุ้น', 'equity', 'equity_partner'],
  ['3200', 'Retained earnings', 'กำไรสะสม', 'equity', null],

  ['4000', 'Sales', 'รายได้จากการขาย', 'income', null],
  ['4100', 'Services', 'รายได้ค่าบริการ', 'income', null],
  ['4200', 'Subscriptions and seats', 'รายได้ค่าสมาชิก', 'income', null],
  ['4300', 'Licensing and syndication', 'รายได้ค่าลิขสิทธิ์', 'income', null],
  ['4900', 'Other income', 'รายได้อื่น', 'income', null],

  ['5000', 'Cost of goods sold', 'ต้นทุนขาย', 'expense', 'cogs'],
  ['5100', 'Freight and postage', 'ค่าขนส่ง', 'expense', null],
  ['6000', 'Wages', 'เงินเดือนและค่าจ้าง', 'expense', null],
  ['6010', 'Social security — employer', 'เงินสมทบประกันสังคม — นายจ้าง', 'expense', null],
  ['6020', 'Contractors', 'ค่าจ้างผู้รับเหมา', 'expense', null],
  ['6100', 'Rent', 'ค่าเช่า', 'expense', null],
  ['6110', 'Utilities', 'ค่าสาธารณูปโภค', 'expense', null],
  ['6200', 'Hosting and software', 'ค่าโฮสติ้งและซอฟต์แวร์', 'expense', null],
  ['6210', 'Domains', 'ค่าโดเมน', 'expense', null],
  ['6300', 'Travel and transport', 'ค่าเดินทาง', 'expense', null],
  ['6310', 'Meals with clients', 'ค่ารับรอง', 'expense', null],
  ['6400', 'Professional fees', 'ค่าธรรมเนียมวิชาชีพ', 'expense', null],
  ['6410', 'Government fees', 'ค่าธรรมเนียมราชการ', 'expense', null],
  ['6500', 'Bank charges', 'ค่าธรรมเนียมธนาคาร', 'expense', null],
  ['6600', 'Marketing', 'ค่าการตลาด', 'expense', null],
  ['6700', 'Equipment and supplies', 'ค่าอุปกรณ์และวัสดุ', 'expense', null],
  ['6800', 'Depreciation', 'ค่าเสื่อมราคา', 'expense', null],
  ['6900', 'Sundry', 'ค่าใช้จ่ายเบ็ดเตล็ด', 'expense', null],
  ['7000', 'Exchange difference', 'ผลต่างอัตราแลกเปลี่ยน', 'expense', null],
]

/**
 * The filings each kind of entity owes. `applies_when` is read at generation
 * time against the entity as it is THEN — registering for VAT in March starts
 * PP30 in March without anyone editing a rule.
 *
 * Due dates: paper filing on the 7th of the following month for withholding,
 * the 15th for VAT and social security. Electronic filing adds days, which is
 * why the bonus is its own column rather than baked into the date.
 */

/** What a Thai full tax invoice has to carry, for the document renderer. */
/**
 * The days the offices are shut that fall on the same date every year.
 *
 * The lunar ones — Makha, Visakha, Asalha, Khao Phansa — and the substitute
 * days the cabinet announces move, so they are added as they are announced
 * rather than guessed at here.
 */
export const HOLIDAYS = [
  ['01-01', "New Year's Day", 'วันขึ้นปีใหม่'],
  ['04-06', 'Chakri Day', 'วันจักรี'],
  ['04-13', 'Songkran', 'วันสงกรานต์'],
  ['04-14', 'Songkran', 'วันสงกรานต์'],
  ['04-15', 'Songkran', 'วันสงกรานต์'],
  ['05-01', 'Labour Day', 'วันแรงงาน'],
  ['05-04', 'Coronation Day', 'วันฉัตรมงคล'],
  ['06-03', "Queen Suthida's Birthday", 'วันเฉลิมพระชนมพรรษาสมเด็จพระนางเจ้าฯ พระบรมราชินี'],
  ['07-28', "King Vajiralongkorn's Birthday", 'วันเฉลิมพระชนมพรรษา'],
  ['08-12', "Queen Mother's Birthday", 'วันแม่แห่งชาติ'],
  ['10-13', 'King Bhumibol Memorial Day', 'วันคล้ายวันสวรรคต ร.9'],
  ['10-23', 'Chulalongkorn Day', 'วันปิยมหาราช'],
  ['12-05', 'National Day', 'วันชาติ'],
  ['12-10', 'Constitution Day', 'วันรัฐธรรมนูญ'],
  ['12-31', "New Year's Eve", 'วันสิ้นปี'],
]

/** How people here expect to pay and to be reached. */
export const HABITS = {
  // A PromptPay QR is generated from the payee id and the amount, so the
  // payer has nothing to type.
  scan_to_pay: 'promptpay',
  chat: 'line',
  chat_label: 'LINE',
  era: 'BE',                       // a Thai document carries the Buddhist year
}

export const INVOICE_FIELDS = {
  title_en: 'Tax invoice',
  title_local: 'ใบกำกับภาษี',
  needs_buyer_tax_id: true,
  needs_seller_tax_id: true,
  vat_shown_separately: true,
  note_en: 'Revenue Code s.86/4 — the buyer\'s name, address and tax id, and the VAT as its own amount.',
}

/**
 * What comes off a month's pay in Thailand.
 *
 * Social security is a percentage of the wage brought inside a band, so it tops
 * out. Income tax is withheld by ANNUALISING what is being paid, taxing the
 * year, and dividing by the pay periods left — which is why a mid-year hire is
 * not taxed as though they had earned all year.
 *
 * `rate(scope, code)` hands back the dated row in force; the pack never reads
 * the database itself.
 */
export function payrollDeductions({
  gross, ym, employment, allowances = {}, rate, bands,
  tax_paid_so_far = 0, periods_remaining = null,
}) {
  const bp = (scope, code, fallback) => rate(scope, code)?.value_bp ?? fallback
  const amt = (scope, code, fallback) => rate(scope, code)?.value_satang ?? fallback

  const cap = amt('sso', 'wage_cap', 1_500_000)
  const floor = amt('sso', 'wage_floor', 165_000)
  const registered = Boolean(employment.sso_registered)
  const socialEmployee = registered
    ? ssoContribution(gross, { bp: bp('sso', 'employee_bp', 500), floor, cap }) : 0
  const socialEmployer = registered
    ? ssoContribution(gross, { bp: bp('sso', 'employer_bp', 500), floor, cap }) : 0

  let tax = 0
  let working = null
  if (employment.tax_withheld) {
    // Pay periods this employment actually has in the calendar year: a full
    // twelve, or fewer when it started or ended part way through.
    const month = Number(String(ym).slice(5, 7))
    const year = String(ym).slice(0, 4)
    const firstMonth = employment.start_date.slice(0, 4) === year
      ? Number(employment.start_date.slice(5, 7)) : 1
    const lastMonth = employment.end_date && employment.end_date.slice(0, 4) === year
      ? Number(employment.end_date.slice(5, 7)) : 12

    working = withholdingForMonth({
      monthlyGross: gross,
      periodsInYear: Math.max(1, lastMonth - firstMonth + 1),
      periodsRemaining: periods_remaining ?? Math.max(1, lastMonth - month + 1),
      taxPaidSoFar: tax_paid_so_far,
      ssoAnnual: socialEmployee * 12,
      expenseBp: bp('pit', 'expense_bp', 5000),
      expenseCap: amt('pit', 'expense_cap', 10_000_000),
      personalAllowance: amt('pit', 'personal_allowance', 6_000_000),
      spouseAllowance: allowances.spouse ? amt('pit', 'spouse_allowance', 6_000_000) : 0,
      children: allowances.children || 0,
      childAllowance: amt('pit', 'child_allowance', 3_000_000),
      ssoDeductionCap: amt('pit', 'sso_deduction_cap', 900_000),
      otherDeductions: allowances.other || 0,
      bands,
    })
    tax = working.monthly
  }

  return {
    social_employee: socialEmployee,
    social_employer: socialEmployer,
    tax,
    working,
    social_rate_bp: bp('sso', 'employee_bp', 500),
    social_cap: cap,
  }
}
