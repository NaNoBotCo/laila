// parties.mjs — customers and suppliers, and what a customer implies about an
// invoice.
//
// Nine customers in ten at a Chiang Mai desk are foreign: they read English,
// they think in their own currency, they pay from abroad, and — the part that
// matters for the arithmetic — they do NOT withhold tax. Withholding is what a
// Thai company does to a Thai supplier. Defaulting every service invoice to 3%
// withheld is wrong for most of the book and produces an expected payment that
// never arrives.
//
// So the customer carries the answer, and the invoice reads it:
//
//   withholds        1 = this payer withholds at source; 0 = they do not
//   tax_treatment    standard | zero_rated | exempt
//   locale           what they read
//   currency         what they think in
//   note_tax         why, in one line, on the invoice
//
// Left blank, `withholds` is inferred once: a company registered in the same
// country as the books withholds, anybody else does not. The inference is
// shown as a default, never written silently — set it on the customer and it
// stops being a guess.

import { uid } from '../lib/ids.mjs'
import { jurisdictionFor } from '../lib/jurisdictions/index.mjs'

const TREATMENTS = new Set(['standard', 'zero_rated', 'exempt'])

export async function addParty(db, {
  entity_id, code = null, name_en, name_th = null, name_km = null, kind = 'both',
  tax_id = null, branch = '00000', is_company = 1, address_en = null, address_th = null,
  email = null, phone = null, country = null, currency = null, terms_days = 0,
  locale = null, withholds = null, tax_treatment = null, note_tax = null, note = null,
}) {
  if (tax_treatment && !TREATMENTS.has(tax_treatment)) {
    throw new Error(`unknown tax treatment: ${tax_treatment}`)
  }
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entity_id)
  const id = uid()
  await db.run(
    `INSERT INTO party(id, entity_id, code, name_en, name_th, name_km, kind, tax_id, branch,
       is_company, address_en, address_th, email, phone, country, currency, terms_days,
       locale, withholds, tax_treatment, note_tax, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, code || `p-${id.slice(0, 8)}`, name_en, name_th, name_km, kind, tax_id, branch,
    is_company ? 1 : 0, address_en, address_th, email, phone,
    (country || entity?.country || 'TH').toUpperCase(), currency, terms_days,
    locale, withholds == null ? null : (withholds ? 1 : 0),
    tax_treatment, note_tax, note)
  return db.get('SELECT * FROM party WHERE id = ?', id)
}

const EDITABLE = new Set([
  'name_en', 'name_th', 'name_km', 'kind', 'tax_id', 'branch', 'is_company',
  'address_en', 'address_th', 'email', 'phone', 'country', 'currency', 'terms_days',
  'locale', 'withholds', 'tax_treatment', 'note_tax', 'note', 'status',
])

export async function updateParty(db, id, patch = {}) {
  const fields = Object.keys(patch).filter((k) => EDITABLE.has(k))
  if (!fields.length) return db.get('SELECT * FROM party WHERE id = ?', id)
  if (patch.tax_treatment && !TREATMENTS.has(patch.tax_treatment)) {
    throw new Error(`unknown tax treatment: ${patch.tax_treatment}`)
  }
  const sets = fields.map((f) => `${f} = ?`).join(', ')
  await db.run(`UPDATE party SET ${sets} WHERE id = ?`, ...fields.map((f) => patch[f]), id)
  return db.get('SELECT * FROM party WHERE id = ?', id)
}

/**
 * What this customer implies about a document, before anybody types anything.
 *
 * Returns the defaults and, separately, where each one came from — `set` when
 * the customer says so, `inferred` when it was read off their country, so the
 * app can show a guess as a guess.
 */
export async function invoiceDefaults(db, { entity_id, party_id, party = null, entity = null }) {
  const p = party || (party_id ? await db.get('SELECT * FROM party WHERE id = ?', party_id) : null)
  const e = entity || await db.get('SELECT * FROM entity WHERE id = ?', entity_id ?? p?.entity_id)
  const home = String(e?.country || 'TH').toUpperCase()
  const theirs = String(p?.country || home).toUpperCase()
  const foreign = theirs !== home
  const pack = jurisdictionFor(home)

  const withholdsSet = p && p.withholds != null
  const withholds = withholdsSet ? Boolean(p.withholds) : Boolean(p?.is_company) && !foreign

  const treatmentSet = Boolean(p?.tax_treatment)
  const treatment = treatmentSet ? p.tax_treatment : 'standard'

  return {
    foreign,
    country: theirs,
    // The customer's own currency when they have one, otherwise the books'.
    currency: p?.currency || e?.currency || pack.CURRENCY,
    currency_from: p?.currency ? 'set' : 'books',
    locale: p?.locale || (foreign ? 'en' : e?.locale || 'en'),
    locale_from: p?.locale ? 'set' : 'inferred',
    withholds,
    withholds_from: withholdsSet ? 'set' : 'inferred',
    // Nobody withholds from a foreign payer, so the invoice expects the whole
    // amount and the bank statement agrees with it.
    wht_applies: withholds,
    tax_treatment: treatment,
    tax_treatment_from: treatmentSet ? 'set' : 'default',
    // Zero-rated and exempt both charge nothing; they differ in what the
    // return says, which is why the word is kept rather than a rate.
    charges_vat: treatment === 'standard',
    note_tax: p?.note_tax || null,
    needs_swift: foreign,
  }
}

/** The line the payer sees when the invoice charges no VAT. */
export function treatmentNote(treatment, locale = 'en') {
  const notes = {
    zero_rated: {
      en: 'Zero-rated: services exported outside Thailand.',
      th: 'อัตราภาษีศูนย์: บริการส่งออกนอกประเทศไทย',
      km: 'អត្រាសូន្យ៖ សេវាកម្មនាំចេញ',
    },
    exempt: {
      en: 'Exempt from VAT.',
      th: 'ได้รับยกเว้นภาษีมูลค่าเพิ่ม',
      km: 'លើកលែងពន្ធលើតម្លៃបន្ថែម',
    },
  }
  return notes[treatment]?.[locale] || notes[treatment]?.en || null
}

export const partyById = (db, id) => db.get('SELECT * FROM party WHERE id = ?', id)

export const partiesFor = (db, entityId, kind = null) => (kind
  ? db.all(`SELECT * FROM party WHERE entity_id = ? AND kind IN (?, 'both')
            AND status = 'active' ORDER BY name_en`, entityId, kind)
  : db.all(`SELECT * FROM party WHERE entity_id = ? AND status = 'active' ORDER BY name_en`, entityId))
