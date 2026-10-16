// la.mjs — Laos: a skeleton, honestly labelled.
//
// WHAT THIS PACK IS. Enough for a set of books to work in Lao kip — a chart of
// accounts, a currency, the shape of the filings — WITHOUT pretending to know
// the current rates. Every figure below is marked `unconfirmed`, which the app
// shows on screen and which nothing hides: a headline rate read once is not a
// basis for filing a return, and rates here move by decree.
//
// The right way to use it: open the books, do the work, and have whoever signs
// the return set each rate with the date it takes effect and where it came
// from. That takes minutes and it is recorded; guessing takes seconds and is
// wrong for a year.

export const CURRENCY = 'LAK'
export const CHANGE_CURRENCY = 'LAK'
export const REPORT_CURRENCY = 'LAK'
export const STATUTORY_CURRENCY = 'LAK'
export const CHANGE_ROUNDING = 500          // kip: the smallest note in daily use
export const SECOND_CURRENCY = 'THB'        // baht and dollars both circulate near the border

export const RATES = [
  { scope: 'vat', code: 'standard', value_bp: 1000, from_date: '2000-01-01',
    unconfirmed: true,
    source: 'headline VAT rate — confirm the rate and its date before filing' },
  { scope: 'wht', code: 'service', value_bp: 0, from_date: '2000-01-01',
    unconfirmed: true, source: 'set from local advice' },
  { scope: 'wht', code: 'rent', value_bp: 0, from_date: '2000-01-01',
    unconfirmed: true, source: 'set from local advice' },
]

// The income tax ladder is deliberately empty: a wrong ladder is worse than no
// ladder, because it produces a number that looks like an answer.
export const SALARY_BANDS = []

export const OBLIGATIONS = [
  { code: 'VAT', name_en: 'VAT return', authority: 'tax', frequency: 'monthly',
    due_rule: 'day:20', efile_bonus_days: 0, applies_when: 'vat_registered',
    source: 'shape only — confirm the day and the form locally' },
  { code: 'PIT', name_en: 'Salary tax', authority: 'tax', frequency: 'monthly',
    due_rule: 'day:20', efile_bonus_days: 0, applies_when: 'has_employees',
    source: 'shape only — confirm the day and the form locally' },
  { code: 'ANNUAL', name_en: 'Annual return', authority: 'tax', frequency: 'annual',
    due_rule: 'months:3', efile_bonus_days: 0, applies_when: 'company',
    source: 'shape only — confirm the deadline locally' },
]

/** Shape only, like everything else in this pack. */
export const FILING_SETTLEMENT = {
  VAT: { nets: ['vat_out', 'vat_in'], payable: '2150', office_en: 'Tax Department' },
  PIT: { payable: '2200', office_en: 'Tax Department' },
}

export const CHART = [
  ['1000', 'Cash on hand', 'ເງິນສົດ', 'asset', 'cash'],
  ['1010', 'Bank account', 'ບັນຊີທະນາຄານ', 'asset', 'cash'],
  ['1100', 'Trade receivables', 'ລູກໜີ້ການຄ້າ', 'asset', 'ar'],
  ['1200', 'Stock', 'ສິນຄ້າຄົງຄັງ', 'asset', 'stock'],
  ['1300', 'Input VAT', 'ອາກອນຊື້', 'asset', 'vat_in'],
  ['1310', 'Withholding tax suffered', 'ອາກອນຖືກຫັກ', 'asset', 'wht_recv'],
  ['1500', 'Equipment', 'ອຸປະກອນ', 'asset', null],
  ['2000', 'Trade payables', 'ເຈົ້າໜີ້ການຄ້າ', 'liability', 'ap'],
  ['2100', 'Output VAT', 'ອາກອນຂາຍ', 'liability', 'vat_out'],
  ['2200', 'Withholding tax payable', 'ອາກອນຫັກ ຄ້າງຈ່າຍ', 'liability', 'wht_pay'],
  ['2300', 'Social security payable', 'ປະກັນສັງຄົມຄ້າງຈ່າຍ', 'liability', 'sso'],
  ['2400', 'Wages payable', 'ຄ່າແຮງຄ້າງຈ່າຍ', 'liability', null],
  ['3000', 'Capital', 'ທຶນ', 'equity', 'equity_partner'],
  ['3100', 'Drawings', 'ເງິນຖອນ', 'equity', 'equity_partner'],
  ['3200', 'Retained earnings', 'ກຳໄລສະສົມ', 'equity', null],
  ['4000', 'Sales', 'ລາຍຮັບຈາກການຂາຍ', 'income', null],
  ['4100', 'Services', 'ລາຍຮັບຄ່າບໍລິການ', 'income', null],
  ['4900', 'Other income', 'ລາຍຮັບອື່ນ', 'income', null],
  ['5000', 'Cost of goods sold', 'ຕົ້ນທຶນຂາຍ', 'expense', 'cogs'],
  ['6000', 'Wages', 'ເງິນເດືອນ', 'expense', null],
  ['6100', 'Rent', 'ຄ່າເຊົ່າ', 'expense', null],
  ['6200', 'Hosting and software', 'ຄ່າຊອບແວ', 'expense', null],
  ['6300', 'Travel and transport', 'ຄ່າເດີນທາງ', 'expense', null],
  ['6400', 'Professional fees', 'ຄ່າທີ່ປຶກສາ', 'expense', null],
  ['6500', 'Bank charges', 'ຄ່າທຳນຽມທະນາຄານ', 'expense', null],
  ['6900', 'Sundry', 'ຄ່າໃຊ້ຈ່າຍອື່ນ', 'expense', null],
  ['7000', 'Exchange difference', 'ຜົນຕ່າງອັດຕາແລກປ່ຽນ', 'expense', null],
]

export const INVOICE_FIELDS = {
  title_en: 'Invoice',
  title_local: 'ໃບແຈ້ງໜີ້',
  needs_buyer_tax_id: true,
  needs_seller_tax_id: true,
  vat_shown_separately: true,
  note_en: 'Rates in this pack are unconfirmed until somebody local sets them.',
}

export const HABITS = { scan_to_pay: 'qr', chat: 'chat', chat_label: 'WhatsApp', era: 'CE' }

export const HOLIDAYS = [
  ['01-01', 'International New Year', 'ປີໃໝ່ສາກົນ'],
  ['03-08', "International Women's Day", 'ວັນແມ່ຍິງສາກົນ'],
  ['04-14', 'Lao New Year', 'ປີໃໝ່ລາວ'],
  ['04-15', 'Lao New Year', 'ປີໃໝ່ລາວ'],
  ['04-16', 'Lao New Year', 'ປີໃໝ່ລາວ'],
  ['05-01', 'International Labour Day', 'ວັນກຳມະບານສາກົນ'],
  ['12-02', 'National Day', 'ວັນຊາດ'],
]

/**
 * With no ladder recorded, no salary tax is computed and the slip says so
 * rather than showing a zero that looks like an answer.
 */
export function payrollDeductions({ gross, employment, rate, bands }) {
  const bp = (scope, code, fallback) => rate(scope, code)?.value_bp ?? fallback
  const registered = Boolean(employment.sso_registered)
  const social = registered ? Math.round((gross * bp('sso', 'employee_bp', 0)) / 10000) : 0
  return {
    social_employee: social,
    social_employer: registered
      ? Math.round((gross * bp('sso', 'employer_bp', 0)) / 10000) : 0,
    tax: bands.length && employment.tax_withheld ? bandsTax(gross, bands) : 0,
    working: bands.length
      ? { gross }
      : { gross, unconfigured: 'no salary ladder recorded for these books' },
    social_rate_bp: bp('sso', 'employee_bp', 0),
    social_cap: null,
  }
}

function bandsTax(taxable, bands) {
  let left = Math.max(0, taxable)
  let last = 0
  let tax = 0
  for (const band of bands) {
    const slice = Math.min(left, band.upTo - last)
    if (slice <= 0) break
    tax += Math.round((slice * band.bp) / 10000)
    left -= slice
    last = band.upTo
  }
  return tax
}
