// render_docs.mjs — an invoice and a payslip as text, in one language or both.
//
// Bilingual here means BOTH LABELS ON ONE DOCUMENT, not two documents: the
// Thai office reads the Thai label and the foreign customer reads the English
// one off the same piece of paper, and there is no second copy to keep in
// step. `locale` picks which label leads.

import { makeT, pick } from '../i18n/index.mjs'
import { jurisdictionFor } from '../lib/jurisdictions/index.mjs'
import { rateOn as fxRateOn, convert as fxConvert, fromPpm } from '../lib/fx.mjs'
import { format } from '../lib/money.mjs'
import { formatDate, amountInWords } from '../lib/be.mjs'
import { table, fields, heading, rule } from '../lib/render.mjs'

/**
 * Both languages on one document, the reader's first.
 *
 * Bilingual here means one piece of paper: the office reads its own label and
 * the foreign customer reads the English one off the same line, so there is no
 * second copy to keep in step. `local` is whichever of Thai or Khmer the
 * document is being issued in.
 */
const both = (en, local, locale) =>
  (locale !== 'en' && local ? `${local} / ${en}` : local ? `${en} / ${local}` : en)

/** The label in the document's own language, whatever that is. */
const localLabel = (locale, key, fallbacks) => fallbacks[locale] ?? fallbacks.th ?? key

/**
 * A sales document. The Thai heading is the one that matters to the Revenue
 * Department — a full tax invoice has to say ใบกำกับภาษี — so the heading
 * carries both names whichever language is leading.
 */
export async function renderDoc(db, docId, { locale = 'en' } = {}) {
  const t = makeT(locale)
  const doc = await db.get('SELECT * FROM doc WHERE id = ?', docId)
  if (!doc) return ''
  const lines = await db.all('SELECT * FROM doc_line WHERE doc_id = ? ORDER BY seq', docId)
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', doc.entity_id)
  const party = await db.get('SELECT * FROM party WHERE id = ?', doc.party_id)
  const ccy = doc.currency
  const money = (n) => format(n, ccy)

  const titleKey = `doc.${doc.kind}`
  const out = []
  const localPack = locale === 'en' ? (entity.second_locale || 'th') : locale
  out.push(heading(both(makeT('en')(titleKey), makeT(localPack)(titleKey), locale)))

  out.push(fields([
    [both('Seller', makeT(localPack)('doc.seller'), locale), pick(entity, 'name', locale)],
    ...(entity.tax_id
      ? [[both('Tax ID', makeT(localPack)('entity.tax_id'), locale), entity.tax_id]] : []),
    ...(pick(entity, 'address', locale) ? [['', pick(entity, 'address', locale)]] : []),
  ]))
  out.push('')
  out.push(fields([
    [both('Buyer', makeT(localPack)('doc.buyer'), locale), pick(party, 'name', locale)],
    ...(party.tax_id
      ? [[both('Tax ID', makeT(localPack)('entity.tax_id'), locale),
        `${party.tax_id}  (${party.branch === '00000' ? t('doc.head_office') : party.branch})`]]
      : []),
    ...(pick(party, 'address', locale) ? [['', pick(party, 'address', locale)]] : []),
  ]))
  out.push('')
  out.push(fields([
    [t('doc.number'), doc.number],
    [t('doc.issue_date'), formatDate(doc.issue_date, locale)],
    ...(doc.due_date ? [[t('doc.due_date'), formatDate(doc.due_date, locale)]] : []),
    ...(pick(doc, 'subject', locale) ? [[t('doc.subject'), pick(doc, 'subject', locale)]] : []),
  ]))
  out.push('')

  out.push(table(lines.map((l, i) => ({
    n: String(i + 1),
    desc: pick(l, 'desc', locale) || l.desc_en,
    qty: (l.qty_milli / 1000).toString(),
    price: format(l.unit_price, ccy, { plain: true }),
    amount: format(l.net, ccy, { plain: true }),
  })), [
    { key: 'n', label: '#', align: 'right' },
    { key: 'desc', label: t('doc.description') },
    { key: 'qty', label: t('doc.qty'), align: 'right' },
    { key: 'price', label: t('doc.unit_price'), align: 'right' },
    { key: 'amount', label: t('doc.amount'), align: 'right' },
  ]))
  out.push('')

  const totals = [[t('doc.net'), money(doc.net)]]
  if (doc.vat) {
    // The rate this document was issued at, not the rate today.
    const pct = doc.vat_bp ? doc.vat_bp / 100 : Math.round((doc.vat / doc.net) * 100)
    totals.push([t('doc.vat', { pct }), money(doc.vat)])
  }
  totals.push([t('doc.gross'), money(doc.gross)])
  if (doc.wht) {
    totals.push([t('doc.wht', { pct: doc.wht_bp / 100 }), `-${money(doc.wht)}`])
    totals.push([t('doc.expect_paid'), money(doc.expect_paid)])
  }
  if (doc.paid || doc.wht_credited) {
    totals.push([t('doc.paid'), money(doc.paid + doc.wht_credited)])
    totals.push([t('doc.balance'), money(doc.gross - doc.paid - doc.wht_credited)])
  }
  out.push(fields(totals))

  // THE SECOND CURRENCY ON THE PAPER. Where the trade is in one currency and
  // the country counts in another — dollars across the counter in Phnom Penh,
  // riel on the return — the invoice carries both, with the rate it was worked
  // out at. It is what the tax office expects to see and what the customer
  // expects to read.
  const pack = jurisdictionFor(entity?.country)
  const second = pack.SECOND_CURRENCY
  if (second && second !== ccy) {
    const rate = await fxRateOn(db, ccy, second, doc.issue_date, { through: ccy })
    if (rate) {
      out.push('')
      out.push(fields([[
        t('doc.equivalent'),
        `${format(fxConvert(doc.gross, rate.rate_ppm, {
          fromMinor: 2, toMinor: second === 'KHR' ? 0 : 2,
        }), second)}  ·  ${fromPpm(rate.rate_ppm).toLocaleString('en-US')} ${second}/${ccy} · ${rate.on_date}`,
      ]]))
    }
  }

  out.push('')
  out.push(fields([[t('doc.in_words'),
    amountInWords(doc.gross, ccy, locale)]]))
  if (doc.note_en || doc.note_th) {
    out.push('')
    out.push(pick(doc, 'note', locale))
  }
  return out.join('\n')
}

/** A payslip. Earnings, then what came off, then what was paid — and the
 *  employer's own cost below the line, where it informs without confusing the
 *  person reading their own net pay. */
export async function renderPayslip(db, payslipId, { locale = 'en' } = {}) {
  const t = makeT(locale)
  const slip = await db.get(
    `SELECT s.*, r.ym, r.pay_date, r.entity_id FROM payslip s
       JOIN pay_run r ON r.id = s.pay_run_id WHERE s.id = ?`, payslipId)
  if (!slip) return ''
  const person = await db.get('SELECT * FROM person WHERE id = ?', slip.person_id)
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', slip.entity_id)
  const lines = await db.all(
    'SELECT * FROM payslip_line WHERE payslip_id = ? ORDER BY seq', payslipId)
  const money = (n) => format(n, 'THB')

  const localPack = locale === 'en' ? (entity.second_locale || 'th') : locale
  const local = makeT(localPack)
  const out = []
  out.push(heading(both('Payslip', local('pay.slip'), locale)))
  out.push(fields([
    [both('Employer', local('payroll.employer'), locale), pick(entity, 'name', locale)],
    [both('Employee', local('payroll.employee'), locale), pick(person, 'name', locale)],
    [t('payroll.period'), slip.ym],
    [both('Pay date', local('ask.pay_date'), locale), formatDate(slip.pay_date, locale)],
  ]))
  out.push('')
  out.push(table(
    lines.filter((l) => l.kind !== 'employer_cost').map((l) => ({
      desc: pick(l, 'desc', locale) || l.desc_en,
      amount: format(l.amount, 'THB', { plain: true }),
    })),
    [{ key: 'desc', label: t('doc.description') }, { key: 'amount', label: t('doc.amount'), align: 'right' }]))
  out.push('')
  out.push(fields([[t('payroll.net'), money(slip.net)]]))
  out.push(rule(40))
  out.push(fields([
    [t('payroll.sso_employer'), money(slip.sso_employer)],
    [t('payroll.employer_cost'), money(slip.gross + slip.sso_employer)],
  ]))
  return out.join('\n')
}
