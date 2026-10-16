// kh.mjs — Cambodia: the rates, the filing calendar and the chart of accounts.
//
// Everything here is DATA. It is written as the rows a fresh set of Cambodian
// books starts with, and every one of them is editable in the app with the date
// it takes effect — the same as the Thai pack beside it. A change of rate is a
// row, not a release.
//
// The figures are the general-regime ones a self-assessed taxpayer meets:
// value added tax at ten percent, salary tax on a monthly ladder in riel,
// withholding on payments to residents and non-residents, the National Social
// Security Fund, the one percent prepayment of income tax, and the annual
// return. Each row carries the provision it came from. A Cambodian accountant's
// eye before the first filing is part of the process, not a failure of it —
// thresholds move by prakas more often than software ships.

// THE BOOKS ARE KEPT IN DOLLARS. Most of the trade is priced, invoiced and
// settled in dollars; riel turns up as change, in small purchases, and — this
// is the part software usually gets wrong — in what the tax office wants. So:
//
//   CURRENCY        what the books add up in, and what an invoice says
//   CHANGE_CURRENCY what comes back across the counter, and what a market stall
//                   or a tuk-tuk is paid in
//   REPORT_CURRENCY what a return is filed in, converted at the official rate
//
// A set of books that insists on riel because the country's currency is riel
// makes every number a conversion of something nobody quoted.
export const CURRENCY = 'USD'
export const CHANGE_CURRENCY = 'KHR'
export const REPORT_CURRENCY = 'KHR'
export const SECOND_CURRENCY = 'KHR'   // shown beside the dollar figure on paper

// Change comes back in riel and there are no small coins: it is rounded to the
// nearest hundred, which is what happens at the counter whatever the till says.
// Riel is counted in whole riel — it has no minor unit — so a hundred riel is
// a hundred here, not ten thousand.

// What the law counts in: the ladder, the reliefs and the fund's floors are written in riel, whatever the payroll is paid in.
export const STATUTORY_CURRENCY = 'KHR'
export const CHANGE_ROUNDING = 100      // ៛100, the smallest note in daily use

export const RATES = [
  // Value added tax. Ten percent on taxable supplies, zero on exports.
  { scope: 'vat', code: 'standard', value_bp: 1000, from_date: '2000-01-01',
    source: 'Law on Taxation art. 61 — 10%' },
  { scope: 'vat', code: 'zero_rated', value_bp: 0, from_date: '2000-01-01',
    source: 'exports and international transport' },
  { scope: 'vat', code: 'registration_threshold', value_satang: 250_000_000,
    from_date: '2000-01-01',
    source: 'Prakas 009 — small taxpayer floor, KHR 250 million of turnover' },

  // Withholding on payments made by a registered taxpayer.
  { scope: 'wht', code: 'service', value_bp: 1500, from_date: '2000-01-01',
    source: 'art. 25 — services to a resident physical person, 15%' },
  { scope: 'wht', code: 'professional', value_bp: 1500, from_date: '2000-01-01',
    source: 'management and technical services, 15%' },
  { scope: 'wht', code: 'rent', value_bp: 1000, from_date: '2000-01-01',
    source: 'rent of movable or immovable property, 10%' },
  { scope: 'wht', code: 'royalty', value_bp: 1500, from_date: '2000-01-01',
    source: 'royalties and intangibles, 15%' },
  { scope: 'wht', code: 'interest_nonbank', value_bp: 1500, from_date: '2000-01-01',
    source: 'interest paid to a resident other than a bank, 15%' },
  { scope: 'wht', code: 'non_resident', value_bp: 1400, from_date: '2000-01-01',
    source: 'art. 26 — payments to a non-resident, 14%' },
  { scope: 'wht', code: 'none', value_bp: 0, from_date: '2000-01-01', source: 'goods' },

  // The National Social Security Fund. Contributions are worked out on the
  // average monthly wage brought inside a band, so they stop rising with pay.
  { scope: 'nssf', code: 'occupational_risk_bp', value_bp: 80, from_date: '2000-01-01',
    source: 'occupational risk, 0.8%, employer' },
  { scope: 'nssf', code: 'health_care_bp', value_bp: 260, from_date: '2000-01-01',
    source: 'health care, 2.6%, employer' },
  { scope: 'nssf', code: 'pension_employee_bp', value_bp: 200, from_date: '2022-10-01',
    source: 'pension scheme phase one, 2% employee' },
  { scope: 'nssf', code: 'pension_employer_bp', value_bp: 200, from_date: '2022-10-01',
    source: 'pension scheme phase one, 2% employer' },
  { scope: 'nssf', code: 'wage_floor', value_satang: 400_000, from_date: '2000-01-01',
    source: 'contribution wage floor, KHR 400,000' },
  { scope: 'nssf', code: 'wage_cap', value_satang: 1_200_000, from_date: '2000-01-01',
    source: 'contribution wage ceiling, KHR 1,200,000' },

  // Tax on salary: the monthly ladder, and what comes off before it.
  { scope: 'tos', code: 'dependant_relief', value_satang: 150_000, from_date: '2023-01-01',
    source: 'KHR 150,000 a month per dependant child or supported spouse' },
  { scope: 'tos', code: 'non_resident_bp', value_bp: 2000, from_date: '2000-01-01',
    source: 'non-resident employment income, flat 20%' },
  { scope: 'tos', code: 'fringe_benefit_bp', value_bp: 2000, from_date: '2000-01-01',
    source: 'fringe benefits, 20% of the value' },

  // Income tax: the monthly prepayment and the annual rate.
  { scope: 'toi', code: 'prepayment_bp', value_bp: 100, from_date: '2000-01-01',
    source: 'monthly prepayment, 1% of turnover including all taxes but VAT' },
  { scope: 'toi', code: 'standard_bp', value_bp: 2000, from_date: '2000-01-01',
    source: 'annual tax on income, 20%' },
  { scope: 'toi', code: 'minimum_bp', value_bp: 100, from_date: '2000-01-01',
    source: 'minimum tax, 1% of annual turnover, unless exempted by a proper audit' },
]

/** Monthly tax on salary, in whole riel. The top of each band and its rate. */
export const SALARY_BANDS = [
  { upTo: 1_500_000, bp: 0 },
  { upTo: 2_000_000, bp: 500 },
  { upTo: 8_500_000, bp: 1000 },
  { upTo: 12_500_000, bp: 1500 },
  { upTo: Infinity, bp: 2000 },
]

/**
 * What is owed to an office and when.
 *
 * Monthly returns are due on the twentieth of the following month, and filing
 * through the tax administration's own system carries five more days. Social
 * security contributions run on their own date, which is why they are their own
 * row rather than a line on the tax return.
 */
export const OBLIGATIONS = [
  { code: 'VAT', name_en: 'VAT return', name_km: 'លិខិតប្រកាសអាករលើតម្លៃបន្ថែម',
    authority: 'gdt', frequency: 'monthly', due_rule: 'day:20', efile_bonus_days: 5,
    applies_when: 'vat_registered', source: 'monthly return, by the 20th' },
  { code: 'TOS', name_en: 'Tax on salary', name_km: 'ពន្ធលើប្រាក់បៀវត្ស',
    authority: 'gdt', frequency: 'monthly', due_rule: 'day:20', efile_bonus_days: 5,
    applies_when: 'has_employees', source: 'withheld from salary, paid monthly' },
  { code: 'WHT', name_en: 'Withholding tax return', name_km: 'លិខិតប្រកាសពន្ធកាត់ទុក',
    authority: 'gdt', frequency: 'monthly', due_rule: 'day:20', efile_bonus_days: 5,
    applies_when: 'withholds', source: 'art. 25 and 26 withholding, paid monthly' },
  { code: 'PTOI', name_en: 'Prepayment of income tax', name_km: 'ប្រាក់រំដោះពន្ធលើប្រាក់ចំណូល',
    authority: 'gdt', frequency: 'monthly', due_rule: 'day:20', efile_bonus_days: 5,
    applies_when: 'company', source: '1% of monthly turnover' },
  { code: 'NSSF', name_en: 'Social security contribution', name_km: 'វិភាគទានបេឡាជាតិសន្តិសុខសង្គម',
    authority: 'nssf', frequency: 'monthly', due_rule: 'day:15', efile_bonus_days: 0,
    applies_when: 'has_employees', source: 'by the 15th of the following month' },
  { code: 'TOI', name_en: 'Annual tax on income', name_km: 'ពន្ធលើប្រាក់ចំណូលប្រចាំឆ្នាំ',
    authority: 'gdt', frequency: 'annual', due_rule: 'months:3', efile_bonus_days: 0,
    applies_when: 'company', source: 'within three months of the year end' },
  { code: 'PATENT', name_en: 'Patent tax', name_km: 'ពន្ធប៉ាតង់',
    authority: 'gdt', frequency: 'annual', due_rule: 'months:3', efile_bonus_days: 0,
    applies_when: 'always', source: 'annual registration tax, by 31 March' },
  { code: 'ACAR', name_en: 'Financial statements', name_km: 'របាយការណ៍ហិរញ្ញវត្ថុ',
    authority: 'acar', frequency: 'annual', due_rule: 'months:3', efile_bonus_days: 0,
    applies_when: 'company', source: 'filed with the accounting regulator' },
]

/** The chart a Cambodian set of books starts with. */
/** Filing nets the VAT period; the rest already carry their liability. */
export const FILING_SETTLEMENT = {
  VAT: { nets: ['vat_out', 'vat_in'], payable: '2150', office_en: 'General Department of Taxation' },
  TOS: { payable: '2210', office_en: 'General Department of Taxation' },
  WHT: { payable: '2200', office_en: 'General Department of Taxation' },
  NSSF: { payable: '2300', office_en: 'NSSF' },
}

export const CHART = [
  ['1000', 'Cash on hand', 'សាច់ប្រាក់ក្នុងដៃ', 'asset', 'cash'],
  ['1010', 'Bank account', 'គណនីធនាគារ', 'asset', 'cash'],
  ['1020', 'Wallet / mobile money', 'កាបូបអេឡិចត្រូនិក', 'asset', 'cash'],
  ['1030', 'Petty cash', 'សាច់ប្រាក់រង', 'asset', 'cash'],
  ['1100', 'Trade receivables', 'គណនីអតិថិជន', 'asset', 'ar'],
  ['1200', 'Stock', 'ទំនិញក្នុងស្តុក', 'asset', 'stock'],
  ['1300', 'Input VAT', 'អាករបានបង់', 'asset', 'vat_in'],
  ['1310', 'Withholding tax suffered', 'ពន្ធកាត់ទុកដែលត្រូវបានកាត់', 'asset', 'wht_recv'],
  ['1320', 'Prepayment of income tax', 'ប្រាក់រំដោះពន្ធលើប្រាក់ចំណូល', 'asset', null],
  ['1400', 'Prepayments', 'ការបង់ប្រាក់ជាមុន', 'asset', null],
  ['1500', 'Equipment', 'បរិក្ខារ', 'asset', null],
  ['1510', 'Accumulated depreciation', 'រំលស់បង្គរ', 'asset', null],

  ['2000', 'Trade payables', 'គណនីអ្នកផ្គត់ផ្គង់', 'liability', 'ap'],
  ['2100', 'Output VAT', 'អាករត្រូវបង់', 'liability', 'vat_out'],
  ['2150', 'VAT payable', 'អាករត្រូវបង់ជំពាក់', 'liability', 'tax_pay'],
  ['2200', 'Withholding tax payable', 'ពន្ធកាត់ទុកត្រូវបង់', 'liability', 'wht_pay'],
  ['2210', 'Tax on salary payable', 'ពន្ធលើប្រាក់បៀវត្សត្រូវបង់', 'liability', 'wht_pay'],
  ['2300', 'Social security payable', 'វិភាគទាន បសស ត្រូវបង់', 'liability', 'sso'],
  ['2400', 'Wages payable', 'ប្រាក់ឈ្នួលត្រូវបង់', 'liability', null],
  ['2500', 'Deferred income', 'ចំណូលទទួលមុន', 'liability', null],
  ['2900', 'Owed to the owner', 'បំណុលជំពាក់ម្ចាស់', 'liability', null],

  ['3000', 'Capital', 'ដើមទុន', 'equity', 'equity_partner'],
  ['3100', 'Drawings', 'ការដកដើមទុន', 'equity', 'equity_partner'],
  ['3200', 'Retained earnings', 'ចំណេញរក្សាទុក', 'equity', null],

  ['4000', 'Sales', 'ចំណូលពីការលក់', 'income', null],
  ['4100', 'Services', 'ចំណូលពីសេវាកម្ម', 'income', null],
  ['4200', 'Subscriptions and seats', 'ចំណូលពីសមាជិកភាព', 'income', null],
  ['4300', 'Licensing', 'ចំណូលពីអាជ្ញាបណ្ណ', 'income', null],
  ['4900', 'Other income', 'ចំណូលផ្សេងៗ', 'income', null],

  ['5000', 'Cost of goods sold', 'តម្លៃដើមទំនិញលក់', 'expense', 'cogs'],
  ['5100', 'Freight and postage', 'ការដឹកជញ្ជូន', 'expense', null],
  ['6000', 'Wages', 'ប្រាក់បៀវត្សនិងឈ្នួល', 'expense', null],
  ['6010', 'Social security — employer', 'វិភាគទាន បសស — និយោជក', 'expense', null],
  ['6020', 'Contractors', 'ថ្លៃម៉ៅការ', 'expense', null],
  ['6100', 'Rent', 'ថ្លៃជួល', 'expense', null],
  ['6110', 'Utilities', 'ថ្លៃទឹកភ្លើង', 'expense', null],
  ['6200', 'Hosting and software', 'ថ្លៃម៉ាស៊ីនមេនិងកម្មវិធី', 'expense', null],
  ['6210', 'Domains', 'ថ្លៃដូមេន', 'expense', null],
  ['6300', 'Travel and transport', 'ថ្លៃធ្វើដំណើរ', 'expense', null],
  ['6310', 'Meals with clients', 'ថ្លៃទទួលភ្ញៀវ', 'expense', null],
  ['6400', 'Professional fees', 'ថ្លៃសេវាវិជ្ជាជីវៈ', 'expense', null],
  ['6410', 'Government fees', 'ថ្លៃរដ្ឋបាល', 'expense', null],
  ['6500', 'Bank charges', 'ថ្លៃសេវាធនាគារ', 'expense', null],
  ['6600', 'Marketing', 'ថ្លៃទីផ្សារ', 'expense', null],
  ['6700', 'Equipment and supplies', 'សម្ភារៈប្រើប្រាស់', 'expense', null],
  ['6800', 'Depreciation', 'រំលស់', 'expense', null],
  ['6900', 'Sundry', 'ចំណាយផ្សេងៗ', 'expense', null],
  ['7000', 'Exchange difference', 'លម្អៀងអត្រាប្តូរប្រាក់', 'expense', null],
]

/** What a compliant invoice has to carry, for the document renderer. */
/**
 * The fixed-date public holidays. Cambodia's calendar also carries the lunar
 * ones — Khmer New Year's own observances, Pchum Ben, Visak Bochea, the Water
 * Festival, the Royal Ploughing Ceremony — which move each year and are added
 * when the annual sub-decree names them.
 */
export const HOLIDAYS = [
  ['01-01', 'International New Year', 'ចូលឆ្នាំសាកល'],
  ['01-07', 'Victory over Genocide Day', 'ទិវាជ័យជម្នះលើរបបប្រល័យពូជសាសន៍'],
  ['03-08', "International Women's Day", 'ទិវានារីអន្តរជាតិ'],
  ['04-14', 'Khmer New Year', 'ចូលឆ្នាំខ្មែរ'],
  ['04-15', 'Khmer New Year', 'ចូលឆ្នាំខ្មែរ'],
  ['04-16', 'Khmer New Year', 'ចូលឆ្នាំខ្មែរ'],
  ['05-01', 'International Labour Day', 'ទិវាពលកម្មអន្តរជាតិ'],
  ['05-14', "King Sihamoni's Birthday", 'ព្រះរាជពិធីចម្រើនព្រះជន្ម'],
  ['06-18', "Queen Mother's Birthday", 'ព្រះរាជពិធីចម្រើនព្រះជន្មព្រះវររាជមាតា'],
  ['09-24', 'Constitution Day', 'ទិវារដ្ឋធម្មនុញ្ញ'],
  ['10-15', 'Commemoration Day of King Sihanouk', 'ទិវាប្រារព្ធព្រះបរមរតនកោដ្ឋ'],
  ['10-23', 'Paris Peace Agreement Day', 'ទិវាសន្ធិសញ្ញាសន្តិភាពទីក្រុងប៉ារីស'],
  ['10-29', "King's Coronation Day", 'ព្រះរាជពិធីគ្រងព្រះបរមរាជសម្បត្តិ'],
  ['11-09', 'Independence Day', 'ទិវាឯករាជ្យជាតិ'],
  ['12-10', 'International Human Rights Day', 'ទិវាសិទ្ធិមនុស្សអន្តរជាតិ'],
]

/** How people here expect to pay and to be reached. */
export const HABITS = {
  // KHQR is issued by the bank rather than built from an id, so the payload is
  // pasted in and rendered rather than generated.
  scan_to_pay: 'qr',
  chat: 'chat',
  chat_label: 'Telegram',
  era: 'CE',                       // Khmer BE exists and is not what an invoice carries
}

export const INVOICE_FIELDS = {
  title_en: 'Tax invoice',
  title_local: 'វិក្កយបត្រពន្ធ',
  needs_buyer_tax_id: true,
  needs_seller_tax_id: true,
  vat_shown_separately: true,
  note_en: 'VAT registration number and the invoice number run in sequence.',
}

import { onBands } from '../money.mjs'

/**
 * What comes off a month's pay in Cambodia.
 *
 * Simpler than the Thai side in one way and harder in another: salary tax is
 * charged on the MONTH rather than annualised, so nothing has to be projected —
 * but the social security fund runs three schemes at once, two of which the
 * employer carries alone, and all of them on a wage clamped into a band.
 *
 * Relief for dependants comes off before the ladder is walked.
 */
export function payrollDeductions({ gross, employment, allowances = {}, rate, bands }) {
  const bp = (scope, code, fallback) => rate(scope, code)?.value_bp ?? fallback
  const amt = (scope, code, fallback) => rate(scope, code)?.value_satang ?? fallback
  const share = (amount, points) => Math.round((amount * points) / 10000)

  const floor = amt('nssf', 'wage_floor', 400_000)
  const cap = amt('nssf', 'wage_cap', 1_200_000)
  const base = Math.min(Math.max(Math.max(gross, 0), floor), cap)

  const registered = Boolean(employment.sso_registered)
  const pensionEmployee = registered ? share(base, bp('nssf', 'pension_employee_bp', 200)) : 0
  const pensionEmployer = registered ? share(base, bp('nssf', 'pension_employer_bp', 200)) : 0
  const risk = registered ? share(base, bp('nssf', 'occupational_risk_bp', 80)) : 0
  const health = registered ? share(base, bp('nssf', 'health_care_bp', 260)) : 0

  let tax = 0
  let working = null
  if (employment.tax_withheld) {
    if (allowances.non_resident) {
      tax = share(gross, bp('tos', 'non_resident_bp', 2000))
      working = { non_resident: true, gross }
    } else {
      const relief = (allowances.dependants || 0) * amt('tos', 'dependant_relief', 150_000)
      const taxable = Math.max(0, gross - relief)
      tax = onBands(taxable, bands)
      working = { gross, relief, taxable, monthly: true }
    }
  }

  return {
    social_employee: pensionEmployee,
    // Occupational risk and health care are the employer's alone; the pension
    // is matched. All three are the cost of employing somebody and belong on
    // the employer's side of the slip.
    social_employer: pensionEmployer + risk + health,
    tax,
    working: { ...working, pension: pensionEmployee, risk, health },
    social_rate_bp: bp('nssf', 'pension_employee_bp', 200),
    social_cap: cap,
  }
}
