// mm.mjs — Myanmar: a skeleton, honestly labelled.
//
// Same rule as the Lao pack, and more so: the rules here have changed often and
// enforcement varies. Every rate is marked `unconfirmed` and the salary ladder
// is empty, so nothing produces a number that looks authoritative. What the
// pack does give is a working set of books in kyat — a chart, a currency, the
// shape of the monthly and annual filings — for work that is real whatever the
// tax position turns out to be.
//
// Anyone filing here sets the rates from local advice, with the date and the
// source, the same way a Thai VAT change is entered.

export const CURRENCY = 'MMK'
export const CHANGE_CURRENCY = 'MMK'
export const REPORT_CURRENCY = 'MMK'
export const STATUTORY_CURRENCY = 'MMK'
export const CHANGE_ROUNDING = 5000          // kyat: small notes are scarce
export const SECOND_CURRENCY = 'USD'         // quoted routinely in border trade

export const RATES = [
  { scope: 'vat', code: 'standard', value_bp: 500, from_date: '2000-01-01',
    unconfirmed: true,
    source: 'commercial tax headline rate — confirm the rate, the base and the date' },
  { scope: 'wht', code: 'service', value_bp: 0, from_date: '2000-01-01',
    unconfirmed: true, source: 'set from local advice' },
]

export const SALARY_BANDS = []

export const OBLIGATIONS = [
  { code: 'CT', name_en: 'Commercial tax return', authority: 'tax', frequency: 'monthly',
    due_rule: 'day:10', efile_bonus_days: 0, applies_when: 'vat_registered',
    source: 'shape only — confirm the day and the form locally' },
  { code: 'PAYE', name_en: 'Salary tax', authority: 'tax', frequency: 'monthly',
    due_rule: 'day:15', efile_bonus_days: 0, applies_when: 'has_employees',
    source: 'shape only — confirm locally' },
  { code: 'ANNUAL', name_en: 'Annual income tax return', authority: 'tax', frequency: 'annual',
    due_rule: 'months:3', efile_bonus_days: 0, applies_when: 'company',
    source: 'shape only — confirm the year end and the deadline locally' },
]

/** Shape only, like everything else in this pack. */
export const FILING_SETTLEMENT = {
  CT: { nets: ['vat_out', 'vat_in'], payable: '2150', office_en: 'Internal Revenue Department' },
  PAYE: { payable: '2200', office_en: 'Internal Revenue Department' },
}

export const CHART = [
  ['1000', 'Cash on hand', 'လက်ကျန်ငွေသား', 'asset', 'cash'],
  ['1010', 'Bank account', 'ဘဏ်စာရင်း', 'asset', 'cash'],
  ['1100', 'Trade receivables', 'ရရန်ရှိငွေ', 'asset', 'ar'],
  ['1200', 'Stock', 'ကုန်ပစ္စည်းလက်ကျန်', 'asset', 'stock'],
  ['1300', 'Input tax', 'ဝယ်ယူခွန်', 'asset', 'vat_in'],
  ['1310', 'Withholding tax suffered', 'ဖြတ်တောက်ခံခွန်', 'asset', 'wht_recv'],
  ['1500', 'Equipment', 'စက်ပစ္စည်း', 'asset', null],
  ['2000', 'Trade payables', 'ပေးရန်ရှိငွေ', 'liability', 'ap'],
  ['2100', 'Output tax', 'ရောင်းချခွန်', 'liability', 'vat_out'],
  ['2200', 'Withholding tax payable', 'ပေးရန်ဖြတ်တောက်ခွန်', 'liability', 'wht_pay'],
  ['2300', 'Social security payable', 'လူမှုဖူလုံရေးပေးရန်', 'liability', 'sso'],
  ['2400', 'Wages payable', 'လုပ်ခပေးရန်', 'liability', null],
  ['3000', 'Capital', 'မတည်ငွေ', 'equity', 'equity_partner'],
  ['3100', 'Drawings', 'ထုတ်ယူငွေ', 'equity', 'equity_partner'],
  ['3200', 'Retained earnings', 'စုဆောင်းအမြတ်', 'equity', null],
  ['4000', 'Sales', 'ရောင်းရငွေ', 'income', null],
  ['4100', 'Services', 'ဝန်ဆောင်မှုဝင်ငွေ', 'income', null],
  ['4900', 'Other income', 'အခြားဝင်ငွေ', 'income', null],
  ['5000', 'Cost of goods sold', 'ရောင်းကုန်ကုန်ကျစရိတ်', 'expense', 'cogs'],
  ['6000', 'Wages', 'လစာ', 'expense', null],
  ['6100', 'Rent', 'ငှားရမ်းခ', 'expense', null],
  ['6200', 'Hosting and software', 'ဆော့ဖ်ဝဲစရိတ်', 'expense', null],
  ['6300', 'Travel and transport', 'ခရီးစရိတ်', 'expense', null],
  ['6400', 'Professional fees', 'အတိုင်ပင်ခံခ', 'expense', null],
  ['6500', 'Bank charges', 'ဘဏ်ဝန်ဆောင်ခ', 'expense', null],
  ['6900', 'Sundry', 'အထွေထွေ', 'expense', null],
  ['7000', 'Exchange difference', 'ငွေလဲနှုန်းကွာခြား', 'expense', null],
]

export const INVOICE_FIELDS = {
  title_en: 'Invoice',
  title_local: 'ပြေစာ',
  needs_buyer_tax_id: true,
  needs_seller_tax_id: true,
  vat_shown_separately: true,
  note_en: 'Rates in this pack are unconfirmed until somebody local sets them.',
}

export const HABITS = { scan_to_pay: 'qr', chat: 'chat', chat_label: 'Viber', era: 'CE' }

export const HOLIDAYS = [
  ['01-04', 'Independence Day', 'လွတ်လပ်ရေးနေ့'],
  ['02-12', 'Union Day', 'ပြည်ထောင်စုနေ့'],
  ['03-02', "Peasants' Day", 'တောင်သူလယ်သမားနေ့'],
  ['04-13', 'Thingyan', 'သင်္ကြန်'],
  ['04-14', 'Thingyan', 'သင်္ကြန်'],
  ['04-15', 'Thingyan', 'သင်္ကြန်'],
  ['04-16', 'Thingyan', 'သင်္ကြန်'],
  ['04-17', 'Myanmar New Year', 'နှစ်သစ်ကူး'],
  ['05-01', 'Labour Day', 'အလုပ်သမားနေ့'],
  ['07-19', "Martyrs' Day", 'အာဇာနည်နေ့'],
  ['12-25', 'Christmas Day', 'ခရစ္စမတ်နေ့'],
]

/** No ladder recorded, so no salary tax is invented. */
export function payrollDeductions({ gross, employment, rate, bands }) {
  const bp = (scope, code, fallback) => rate(scope, code)?.value_bp ?? fallback
  const registered = Boolean(employment.sso_registered)
  return {
    social_employee: registered
      ? Math.round((gross * bp('sso', 'employee_bp', 0)) / 10000) : 0,
    social_employer: registered
      ? Math.round((gross * bp('sso', 'employer_bp', 0)) / 10000) : 0,
    tax: 0,
    working: { gross, unconfigured: 'no salary ladder recorded for these books' },
    social_rate_bp: bp('sso', 'employee_bp', 0),
    social_cap: null,
  }
}
