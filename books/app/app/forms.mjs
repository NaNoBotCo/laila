// forms.mjs — the dialogs. Each one does a real thing to the books and then
// says, in one line, what moved.

import { h, mount, dataTable } from './dom.mjs'
import { pick } from './i18n/index.mjs'
import {
  S, t, p, money, when, nameOf, result, openDialog, closeDialog, field, select,
  input, btn, refresh, addDays, panel, head, whenShort, go, localOf, secondText,
  vatPct, whtPct, localeNames, secondLocale,
} from './shell.mjs'
import { parse, format } from './lib/money.mjs'
import { formatDate, bahtText, amountText } from './lib/be.mjs'
import {
  draft, issue, recordPayment, voidWithCreditNote, getDoc, documentTotals,
} from './modules/documents.mjs'
import { acquire, sell } from './modules/stock.mjs'
import { addPlan, subscribe } from './modules/subscriptions.mjs'
import { createPayRun, approvePayRun, payPayslip } from './modules/payroll.mjs'
import { markFiled, payFiling } from './modules/compliance.mjs'
import { qrToSvg } from './lib/qr.mjs'
import { receive, toDraft, rotateLink, intakeUrl, channelsFor } from './modules/intake.mjs'
import { setRate, setBands, setObligation } from './modules/policy.mjs'
import {
  setAgreement, addReferral, setStatus as setReferralStatus, billMonth, reconcile,
  pipeline as allReferrals, commissionFor, setServiceRate, billClient,
  rateCard, serviceRateOn,
} from './modules/referrals.mjs'
import {
  waysToPay, waysToPayThem, settleInFull, claimPaid, addMethod, takeCash,
} from './modules/paying.mjs'
import { changeFor, tenderedValue } from './lib/change.mjs'
import { rateOn as fxRateOn } from './lib/fx.mjs'
import {
  chatsFor, queue, handleEvent, digest as lineDigest, howToPayText, linkChat, KEYWORDS,
} from './modules/line.mjs'
import {
  amortise, flatRate, costPlus, lease, decliningShare, noChargeLoan, latePayment,
} from './lib/finance.mjs'
import {
  ASSETS, addWallet as addWalletRow, wallets as walletsFor, setAssetRate,
  receiveCrypto, spendCrypto, formatAsset, parseAsset, holdings, ensureCryptoAccounts,
} from './modules/crypto.mjs'
import { transfer, addBankAccount, balances as bankBalances } from './modules/banks.mjs'
import { invoiceDefaults, addParty, updateParty } from './modules/parties.mjs'
import {
  look, previewContacts, previewOpenInvoices, previewStatement,
  importContacts, importOpenInvoices, importStatement, undoContacts,
  suggestFor, applyLine, applyLineToFiling, ignoreLine, settleWhatIsClear,
  batches as importBatches,
} from './modules/importing.mjs'
import { setRate as setFxRate, toPpm } from './lib/fx.mjs'
import { CURRENCIES } from './lib/money.mjs'
import { uid } from './lib/ids.mjs'

const val = (id) => document.getElementById(id)?.value?.trim() ?? ''
const checked = (id) => Boolean(document.getElementById(id)?.checked)
const amount = (id) => parse(val(id)) ?? 0

const parties = (kind) => S.db.all(
  `SELECT * FROM party WHERE entity_id = ? AND status = 'active'
     ${kind ? "AND kind IN ('both', ?)" : ''} ORDER BY name_en`,
  ...(kind ? [S.entity.id, kind] : [S.entity.id]))

const projects = () => S.db.all(
  "SELECT * FROM project WHERE entity_id = ? AND status = 'live' ORDER BY name_en", S.entity.id)

const cashAccounts = () => S.db.all(
  "SELECT * FROM account WHERE entity_id = ? AND subtype = 'cash' ORDER BY code", S.entity.id)

const accountId = async (code) =>
  (await S.db.get('SELECT id FROM account WHERE entity_id = ? AND code = ?', S.entity.id, code))?.id

// ---- invoice ----------------------------------------------------------------

export async function openInvoiceForm(existing = null, partyId = null) {
  const people = await parties('customer')
  const lines = await projects()
  const existingLines = existing
    ? await S.db.all('SELECT * FROM doc_line WHERE doc_id = ? ORDER BY seq', existing.id)
    : []

  const rows = h('div', {})
  const totals = h('div', { class: 'totals' })
  // What picking a customer implies, shown where it was picked. A foreigner
  // pays from abroad and withholds nothing; the box moves itself and says so,
  // which is the whole explanation anyone needs.
  const said = h('div', { class: 'said' })

  async function applyParty() {
    const id = val('f-party')
    if (!id) return
    const who = await S.db.get('SELECT * FROM party WHERE id = ?', id)
    const d = await invoiceDefaults(S.db, { entity_id: S.entity.id, party: who, entity: S.entity })
    const wht = document.getElementById('f-wht')
    const vat = document.getElementById('f-vat')
    if (wht) wht.checked = d.withholds
    if (vat) vat.checked = Boolean(S.entity.vat_registered) && d.charges_vat
    // Their own credit terms, which is what was agreed with them — a fixed
    // fortnight for everybody is a made-up date on every other invoice.
    const due = document.getElementById('f-due')
    if (due && !existing) due.value = addDays(val('f-date') || S.today, who?.terms_days ?? 15)
    mount(said, ...[
      d.foreign
        ? h('div', {}, t('note.foreign', { name: nameOf(who), country: d.country }))
        : (d.withholds
          ? h('div', {}, t('note.withholds', { name: nameOf(who), pct: whtPct() }))
          : null),
      d.foreign && d.currency !== (S.entity.currency || 'THB')
        ? h('div', {}, t('note.foreign_ccy', { currency: d.currency })) : null,
      // Her own words if she wrote any, the general line if she did not.
      d.note_tax ? h('div', {}, d.note_tax)
        : (d.tax_treatment === 'zero_rated' ? h('div', {}, t('note.zero_rated'))
          : (d.tax_treatment === 'exempt' ? h('div', {}, t('note.exempt')) : null)),
    ].filter(Boolean))
    paintTotals()
  }

  const addRow = (line = {}) => {
    const row = h('div', { class: 'line-row' },
      input({ class: 'desc', value: line.desc_en || '', placeholder: t('form.description') }),
      input({
        class: 'qty', type: 'number', min: '0', step: '0.5',
        placeholder: t('form.qty'), value: (line.qty_milli ?? 1000) / 1000,
      }),
      input({ class: 'unit', placeholder: t('form.unit'), value: line.unit || 'item' }),
      input({
        class: 'price', inputmode: 'decimal', placeholder: t('form.price'),
        value: line.unit_price ? format(line.unit_price, 'THB', { plain: true }) : '',
      }),
      btn('✕', { small: true, onclick: () => { row.remove(); paintTotals() } }))
    row.querySelectorAll('input').forEach((i) => i.addEventListener('input', paintTotals))
    rows.append(row)
    paintTotals()
  }

  const readLines = () => Array.from(rows.querySelectorAll('.line-row')).map((row) => ({
    desc_en: row.querySelector('.desc').value.trim(),
    qty_milli: Math.round((Number(row.querySelector('.qty').value) || 0) * 1000),
    unit: row.querySelector('.unit').value.trim() || null,
    unit_price: parse(row.querySelector('.price').value) ?? 0,
    tax_code: checked('f-vat') ? 'VAT7' : 'NONE',
  })).filter((l) => l.desc_en && l.unit_price)

  function paintTotals() {
    const tot = documentTotals(readLines(), { vatBp: 700, whtBp: checked('f-wht') ? 300 : 0 })
    mount(totals,
      h('div', {}, h('span', {}, p('doc.net')), h('span', {}, money(tot.net))),
      tot.vat ? h('div', {}, h('span', {}, p('doc.vat', { pct: 7 })), h('span', {}, money(tot.vat))) : null,
      h('div', { class: 'big' }, h('span', {}, p('doc.gross')), h('span', {}, money(tot.gross))),
      tot.wht ? h('div', { class: 'note' },
        h('span', {}, p('doc.wht', { pct: 3 })), h('span', {}, `− ${money(tot.wht)}`)) : null,
      tot.wht ? h('div', { class: 'note' },
        h('span', {}, p('doc.expect_paid')), h('span', {}, money(tot.expect_paid))) : null)
  }

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('form.customer'), select(people.map((x) => [x.id, nameOf(x)]),
        { id: 'f-party', value: partyId || existing?.party_id, onchange: applyParty })),
      field(t('form.line'), select(lines.map((x) => [x.id, nameOf(x)]),
        { id: 'f-project', value: existing?.project_id }))),
    said,
    h('div', { class: 'row' },
      field(t('form.date'), input({ id: 'f-date', type: 'date', value: existing?.issue_date || S.today })),
      field(t('form.due'), input({ id: 'f-due', type: 'date', value: existing?.due_date || addDays(S.today, 15) }))),
    h('div', { class: 'lines-head' },
      h('span', {}, t('form.description')), h('span', {}, t('form.qty')),
      h('span', {}, t('form.unit')), h('span', {}, t('form.price')), h('span', {})),
    rows,
    btn(t('btn.add_line'), { small: true, onclick: () => addRow() }),
    h('div', { class: 'check', style: 'margin-top:14px' },
      input({ id: 'f-vat', type: 'checkbox', checked: Boolean(S.entity.vat_registered), onchange: paintTotals }),
      h('label', { for: 'f-vat' }, t('form.vat', { pct: vatPct() }))),
    h('div', { class: 'check' },
      input({ id: 'f-wht', type: 'checkbox', checked: (existing?.wht_bp ?? 0) > 0, onchange: paintTotals }),
      h('label', { for: 'f-wht' }, t('form.wht', { pct: whtPct() }))),
    totals)

  const build = async () => {
    const chosen = readLines()
    if (!chosen.length) return null
    const services = await accountId('4100')
    if (existing) await S.db.run("UPDATE doc SET status = 'void' WHERE id = ?", existing.id)
    return draft(S.db, {
      entity_id: S.entity.id,
      kind: S.entity.vat_registered && checked('f-vat') ? 'tax_invoice' : 'invoice',
      party_id: val('f-party'),
      project_id: val('f-project'),
      issue_date: val('f-date'),
      due_date: val('f-due'),
      wht_bp: checked('f-wht') ? whtBp() : 0,
      subject_en: chosen[0].desc_en,
      lines: chosen.map((l) => ({ ...l, account_id: services, project_id: val('f-project') })),
    })
  }

  openDialog(t('btn.new_invoice'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save_draft'), {
      onclick: async () => {
        const d = await build()
        if (!d) return
        closeDialog()
        result(t('result.draft_saved'))
        refresh()
      },
    }),
    btn(t('btn.issue'), {
      primary: true,
      onclick: async () => {
        const d = await build()
        if (!d) return
        const inv = await issue(S.db, d.id)
        const party = await S.db.get('SELECT * FROM party WHERE id = ?', inv.party_id)
        closeDialog()
        result(
          t('result.invoice_issued', {
            number: inv.number, party: nameOf(party),
            amount: money(inv.gross), due: when(inv.due_date),
          }),
          inv.vat ? t('result.vat_held', { amount: money(inv.vat) }) : null,
          inv.wht ? t('result.wht_expected', {
            amount: money(inv.wht), net: money(inv.expect_paid),
          }) : null)
        refresh()
        openDocView(inv.id)
      },
    }),
  ], { wide: true })

  if (existingLines.length) existingLines.forEach(addRow)
  else addRow()
  if (!existing) await applyParty()
}

// ---- bill -------------------------------------------------------------------

export async function openBillForm() {
  const people = await parties('supplier')
  const lines = await projects()
  const expenses = await S.db.all(
    `SELECT * FROM account WHERE entity_id = ? AND type = 'expense' AND is_active = 1
      ORDER BY code`, S.entity.id)

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('form.supplier'), select(people.map((x) => [x.id, nameOf(x)]), { id: 'b-party' })),
      field(t('form.line'), select(lines.map((x) => [x.id, nameOf(x)]), { id: 'b-project' }))),
    h('div', { class: 'row' },
      field(t('form.date'), input({ id: 'b-date', type: 'date', value: S.today })),
      field(t('form.due'), input({ id: 'b-due', type: 'date', value: addDays(S.today, 30) }))),
    field(t('form.description'), input({ id: 'b-desc', placeholder: t('form.description') })),
    h('div', { class: 'row' },
      field(t('col.account'), select(expenses.map((a) => [a.code, `${a.code} · ${nameOf(a)}`]),
        { id: 'b-account', value: '6900' })),
      field(t('form.price'), input({ id: 'b-amount', inputmode: 'decimal', placeholder: '0.00' }))),
    h('div', { class: 'check' },
      input({ id: 'b-vat', type: 'checkbox', checked: Boolean(S.entity.vat_registered) }),
      h('label', { for: 'b-vat' }, t('form.vat', { pct: vatPct() }))),
    h('div', { class: 'check' },
      input({ id: 'b-wht', type: 'checkbox' }),
      h('label', { for: 'b-wht' }, t('form.wht_supplier', { pct: whtPct() }))))

  openDialog(t('btn.new_bill'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const net = amount('b-amount')
        if (!net || !val('b-desc')) return
        const account = await accountId(val('b-account'))
        const d = await draft(S.db, {
          entity_id: S.entity.id,
          kind: 'bill',
          party_id: val('b-party'),
          project_id: val('b-project'),
          issue_date: val('b-date'),
          due_date: val('b-due'),
          wht_bp: checked('b-wht') ? whtBp() : 0,
          subject_en: val('b-desc'),
          lines: [{
            desc_en: val('b-desc'), unit_price: net,
            tax_code: checked('b-vat') ? 'VAT7' : 'NONE',
            account_id: account, project_id: val('b-project'),
          }],
        })
        const bill = await issue(S.db, d.id)
        const party = await S.db.get('SELECT * FROM party WHERE id = ?', bill.party_id)
        closeDialog()
        result(t('result.bill_added', {
          number: bill.number, party: nameOf(party),
          amount: money(bill.gross), due: when(bill.due_date),
        }))
        refresh()
      },
    }),
  ])
}

// ---- payment ----------------------------------------------------------------

export async function openPaymentForm(doc, direction) {
  const full = await getDoc(S.db, doc.id)
  const party = await S.db.get('SELECT * FROM party WHERE id = ?', full.party_id)
  const accounts = await cashAccounts()
  const outstanding = full.gross - full.paid - full.wht_credited
  const whtPart = Math.min(full.wht - full.wht_credited, outstanding)
  const cashPart = outstanding - whtPart

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('form.date'), input({ id: 'p-date', type: 'date', value: S.today })),
      field(direction === 'in' ? t('form.account') : t('form.account_out'),
        select(accounts.map((a) => [a.code, nameOf(a)]), { id: 'p-account', value: '1010' }))),
    h('div', { class: 'row' },
      field(t('form.amount_paid'), input({
        id: 'p-amount', inputmode: 'decimal', value: format(cashPart, full.currency, { plain: true }),
      })),
      field(t('form.slip'), input({ id: 'p-slip', placeholder: 'TRF-000000' }))),
    whtPart ? h('div', { class: 'totals' },
      h('div', { class: 'note' },
        h('span', {}, p('doc.wht', { pct: full.wht_bp / 100 })), h('span', {}, money(whtPart)))) : null)

  openDialog(direction === 'in' ? p('pay.received') : p('pay.made'), body, [
    btn(t('pay.paid_in_full'), {
      onclick: async () => {
        if (direction === 'in') {
          await settleInFull(S.db, full.id, {
            on_date: val('p-date'), account: val('p-account'),
            slip_ref: val('p-slip') || null,
          })
        } else {
          await recordPayment(S.db, {
            entity_id: S.entity.id, direction: 'out', on_date: val('p-date'),
            party_id: full.party_id, account: val('p-account'), method: 'transfer',
            amount: cashPart, wht_amount: whtPart, slip_ref: val('p-slip') || null,
            wht_cert_no: whtPart ? `WHT-${full.number}` : null,
            allocations: [{ doc_id: full.id, amount: cashPart, wht_amount: whtPart }],
          })
        }
        closeDialog()
        result(t('pay.settled', { number: full.number }))
        refresh()
      },
    }),
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const cash = amount('p-amount')
        if (!cash && !whtPart) return
        const wht = Math.min(whtPart, outstanding - cash)
        await recordPayment(S.db, {
          entity_id: S.entity.id,
          direction,
          on_date: val('p-date'),
          party_id: full.party_id,
          account: val('p-account'),
          method: 'transfer',
          amount: cash,
          wht_amount: Math.max(0, wht),
          wht_cert_no: wht ? `WHT-${full.number}` : null,
          slip_ref: val('p-slip') || null,
          allocations: [{ doc_id: full.id, amount: cash, wht_amount: Math.max(0, wht) }],
        })
        const after = await getDoc(S.db, full.id)
        const left = after.gross - after.paid - after.wht_credited
        closeDialog()
        result(
          left <= 0
            ? t('result.settled', { party: nameOf(party) })
            : t(direction === 'in' ? 'result.payment_in' : 'result.payment_out', {
              amount: money(cash), party: nameOf(party), left: money(left),
            }),
          direction === 'out' && wht > 0 ? t('result.wht_owed', { amount: money(wht) }) : null)
        refresh()
      },
    }),
  ])
}

// ---- contact ----------------------------------------------------------------

export async function openContactForm(existing = null) {
  const home = String(S.entity.country || 'TH').toUpperCase()
  // Only currencies this set of books can actually convert: a rate is what
  // makes a foreign invoice postable, so one without a rate is not offered.
  const priced = await S.db.all(
    'SELECT DISTINCT asset FROM asset_rate WHERE quote = ?', S.entity.currency)
  const money_options = [
    ['', S.entity.currency || 'THB'],
    // Coin is held, not billed in, so it is not offered as a billing currency.
    ...priced.filter((r) => CURRENCIES[r.asset] && r.asset !== S.entity.currency)
      .map((r) => [r.asset, r.asset]),
  ]
  const where = [...new Set([home, 'GB', 'US', 'AU', 'DE', 'FR', 'CN', 'JP', 'KR', 'SG',
    'KH', 'LA', 'MM', 'MY', 'VN', 'IN', 'RU', 'CH', 'NL', 'SE', 'CA'])]

  const said = h('div', { class: 'said' })

  const repaint = () => {
    const foreign = val('c-country') !== home
    const box = document.getElementById('c-withholds')
    if (box) box.checked = !foreign && val('c-company') === '1'
    mount(said, foreign
      ? h('div', {}, t('note.foreign', { name: val('c-en') || '—', country: val('c-country') }))
      : (box?.checked
        ? h('div', {}, t('note.withholds', { name: val('c-en') || '—', pct: whtPct() }))
        : null))
  }

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('form.name_en'), input({ id: 'c-en', value: existing?.name_en || '' })),
      field(t('form.name_th', { language: localeNames[secondLocale()] }),
        input({ id: 'c-th', value: existing?.name_th || '' }))),
    h('div', { class: 'row' },
      field(t('col.type'), select([['1', t('form.company')], ['0', t('form.person')]],
        { id: 'c-company', value: existing ? String(existing.is_company) : '1', onchange: repaint })),
      field(t('form.taxid'), input({ id: 'c-tax', value: existing?.tax_id || '' })),
      field(t('form.terms'),
        input({ id: 'c-terms', type: 'number', value: String(existing?.terms_days ?? 15) }))),
    h('div', { class: 'row' },
      field(t('form.country'), select(where.map((c) => [c, c]),
        { id: 'c-country', value: existing?.country || home, onchange: repaint })),
      field(t('form.bills_in'), select(money_options,
        { id: 'c-currency', value: existing?.currency || '' })),
      field(t('form.reads'), select([['en', 'English'], ['th', 'ไทย'], ['km', 'ខ្មែរ']],
        { id: 'c-locale', value: existing?.locale || 'en' }))),
    said,
    h('div', { class: 'check' },
      input({
        id: 'c-withholds', type: 'checkbox', onchange: repaint,
        checked: existing ? Boolean(existing.withholds) : true,
      }),
      h('label', { for: 'c-withholds' }, t('form.withholds'))),
    h('div', { class: 'row' },
      field(t('form.tax_treatment'), select([
        ['standard', t('form.treat_standard')],
        ['zero_rated', t('form.treat_zero')],
        ['exempt', t('form.treat_exempt')],
      ], { id: 'c-treat', value: existing?.tax_treatment || 'standard' })),
      field(t('form.note_tax'), input({ id: 'c-note-tax', value: existing?.note_tax || '' }))))

  openDialog(existing ? nameOf(existing) : t('btn.new_contact'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const name = val('c-en') || val('c-th')
        if (!name) return
        const fields = {
          name_en: name,
          name_th: val('c-th') || null,
          is_company: val('c-company') === '1' ? 1 : 0,
          tax_id: val('c-tax') || null,
          terms_days: Number(val('c-terms')) || 0,
          country: val('c-country'),
          currency: val('c-currency') || null,
          locale: val('c-locale') || null,
          // Recorded as an answer, not left as a guess: the invoice reads it.
          withholds: checked('c-withholds') ? 1 : 0,
          tax_treatment: val('c-treat') || 'standard',
          note_tax: val('c-note-tax') || null,
        }
        if (existing) await updateParty(S.db, existing.id, fields)
        else await addParty(S.db, { entity_id: S.entity.id, kind: 'both', ...fields })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ])
  repaint()
}

// ---- a piece on the shelf ---------------------------------------------------

export async function openPieceForm() {
  const lines = await projects()
  const accounts = await cashAccounts()
  const shop = lines.find((l) => l.code === 'shop') || lines[0]

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('form.sku'), input({ id: 'i-sku', value: `ITEM-${Math.floor(Math.random() * 900 + 100)}` })),
      field(t('form.line'), select(lines.map((x) => [x.id, nameOf(x)]), { id: 'i-project', value: shop?.id }))),
    h('div', { class: 'row' },
      field(t('form.item_name'), input({ id: 'i-en' })),
      field(t('form.name_th', { language: localeNames[secondLocale()] }), input({ id: 'i-th' }))),
    h('div', { class: 'row' },
      field(t('form.cost'), input({ id: 'i-cost', inputmode: 'decimal' })),
      field(t('form.ask'), input({ id: 'i-ask', inputmode: 'decimal' })),
      field(t('form.account_out'), select(accounts.map((a) => [a.code, nameOf(a)]), { id: 'i-paid', value: '1000' }))),
    field(t('form.where'), input({ id: 'i-where', value: 'shop floor' })))

  openDialog(t('btn.new_piece'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const name = val('i-en') || val('i-th')
        if (!name) return
        await acquire(S.db, {
          entity_id: S.entity.id,
          project_id: val('i-project'),
          sku: val('i-sku'),
          name_en: name,
          name_th: val('i-th') || null,
          category: 'consignment',
          acq_cost: amount('i-cost'),
          acq_date: S.today,
          ask_price: amount('i-ask') || null,
          location: val('i-where') || null,
          paid_from: val('i-paid'),
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ])
}

export async function openSellForm(item) {
  const people = await parties('customer')
  const accounts = await cashAccounts()
  const body = h('div', {},
    field(t('form.customer'), select(people.map((x) => [x.id, nameOf(x)]), { id: 's-party' })),
    h('div', { class: 'row' },
      field(t('form.price'), input({
        id: 's-price', inputmode: 'decimal',
        value: item.ask_price ? format(item.ask_price, 'THB', { plain: true }) : '',
      })),
      field(t('form.date'), input({ id: 's-date', type: 'date', value: S.today })),
      field(t('form.account'), select(
        [['', '—'], ...accounts.map((a) => [a.code, nameOf(a)])], { id: 's-paid', value: '1000' }))))

  openDialog(`${t('btn.sell_it')} · ${nameOf(item)}`, body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.sell_it'), {
      primary: true,
      onclick: async () => {
        const price = amount('s-price')
        if (!price) return
        const { doc } = await sell(S.db, item.id, {
          party_id: val('s-party'),
          price,
          on_date: val('s-date'),
          paid_to: val('s-paid') || null,
          method: val('s-paid') === '1000' ? 'cash' : 'transfer',
          kind: 'invoice',
          revenue_account: '4000',
        })
        const cost = item.acq_cost + item.prep_cost
        closeDialog()
        result(t('result.sold', {
          item: nameOf(item), price: money(price), cost: money(cost),
          margin: money(price - cost),
        }))
        refresh()
        openDocView(doc.id)
      },
    }),
  ])
}

// ---- repeating --------------------------------------------------------------

export async function openRepeatingForm() {
  const people = await parties('customer')
  const plans = await S.db.all(
    'SELECT * FROM plan WHERE entity_id = ? AND is_active = 1 ORDER BY name_en', S.entity.id)
  const lines = await projects()

  const body = h('div', {},
    field(t('form.customer'), select(people.map((x) => [x.id, nameOf(x)]), { id: 'r-party' })),
    field(t('form.plan'), select([
      ...plans.map((pl) => [pl.id, `${nameOf(pl)} · ${money(pl.price)} ${p('sub.interval.month')}`]),
      ['new', `+ ${t('btn.new_repeating')}`],
    ], {
      id: 'r-plan',
      onchange: (e) => { newPlan.hidden = e.target.value !== 'new' },
    })),
    h('div', { class: 'row' },
      field(t('form.seats'), input({ id: 'r-seats', type: 'number', min: '1', value: '1' })),
      field(t('form.starts'), input({ id: 'r-start', type: 'date', value: S.today }))))

  const newPlan = h('div', { hidden: true },
    h('div', { class: 'row' },
      field(t('form.description'), input({ id: 'r-name' })),
      field(t('form.price'), input({ id: 'r-price', inputmode: 'decimal' })),
      field(t('form.line'), select(lines.map((x) => [x.id, nameOf(x)]), { id: 'r-project' }))))
  body.append(newPlan)

  openDialog(t('btn.new_repeating'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        let planId = val('r-plan')
        if (planId === 'new') {
          const price = amount('r-price')
          if (!val('r-name') || !price) return
          const made = await addPlan(S.db, {
            entity_id: S.entity.id,
            project_id: val('r-project'),
            code: `plan-${Date.now().toString(36)}`,
            name_en: val('r-name'),
            price,
            interval: 'month',
            tax_code: S.entity.vat_registered ? 'VAT7' : 'NONE',
            account_id: await accountId('4200'),
          })
          planId = made.id
        }
        await subscribe(S.db, {
          entity_id: S.entity.id,
          party_id: val('r-party'),
          plan_id: planId,
          seats: Number(val('r-seats')) || 1,
          start_date: val('r-start'),
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ])
}

// ---- payroll ----------------------------------------------------------------

export async function openPayrollForm(staff) {
  const ym = S.today.slice(0, 7)
  const lastDay = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0))
    .toISOString().slice(0, 10)

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('form.month'), input({ id: 'y-ym', type: 'month', value: ym })),
      field(t('form.pay_date'), input({ id: 'y-date', type: 'date', value: lastDay }))),
    ...staff.map((e) => e.pay_unit === 'month' ? null : field(
      `${nameOf(e)} — ${t('form.units')} (${e.pay_unit})`,
      input({ id: `y-${e.id}`, type: 'number', min: '0', step: '0.5', value: '0' }))))

  openDialog(t('btn.run_payroll'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.approve'), {
      primary: true,
      onclick: async () => {
        const month = val('y-ym')
        const entries = staff.map((e) => ({
          employment_id: e.id,
          units_milli: e.pay_unit === 'month'
            ? 1000
            : Math.round((Number(document.getElementById(`y-${e.id}`)?.value) || 0) * 1000),
        })).filter((e) => e.units_milli > 0)
        if (!entries.length) return
        try {
          const { run, slips } = await createPayRun(S.db, {
            entity_id: S.entity.id, ym: month, pay_date: val('y-date'), entries,
          })
          await approvePayRun(S.db, run.id)
          for (const s of slips) {
            await payPayslip(S.db, s.id, { on_date: val('y-date'), account: '1010' })
          }
          const gross = slips.reduce((a, s) => a + s.gross, 0)
          const net = slips.reduce((a, s) => a + s.net, 0)
          const tax = slips.reduce((a, s) => a + s.sso_employee + s.sso_employer + s.wht, 0)
          closeDialog()
          result(t('result.payroll', {
            n: slips.length, gross: money(gross), net: money(net), tax: money(tax),
          }))
          refresh()
        } catch (err) {
          result(err.message)
        }
      },
    }),
  ])
}

export async function openPayslipView(payslipId) {
  const slip = await S.db.get(
    `SELECT s.*, r.ym, r.pay_date, pe.name_en, pe.name_th, e.title_en, e.title_th
       FROM payslip s JOIN pay_run r ON r.id = s.pay_run_id
       JOIN person pe ON pe.id = s.person_id
       JOIN employment e ON e.id = s.employment_id WHERE s.id = ?`, payslipId)
  const lines = await S.db.all(
    'SELECT * FROM payslip_line WHERE payslip_id = ? ORDER BY seq', payslipId)

  const doc = h('div', { class: 'doc' },
    h('div', { class: 'doc-head' },
      h('div', {},
        h('div', { class: 'strong' }, (pick(S.brand, 'name', S.locale) || S.brand.name_en)),
        h('div', { class: 'dim' }, S.entity.tax_id || '')),
      h('div', { class: 'doc-title' },
        h('div', { class: 'th' }, 'สลิปเงินเดือน'),
        h('div', { class: 'en' }, 'Payslip'))),
    h('div', { class: 'parties' },
      h('div', {}, h('h4', {}, 'ลูกจ้าง / Employee'), nameOf(slip), h('div', { class: 'dim' }, nameOf(slip, 'title'))),
      h('div', {}, h('h4', {}, 'งวด / Period'), slip.ym,
        h('div', { class: 'dim' }, when(slip.pay_date)))),
    h('table', {}, h('tbody', {}, lines.filter((l) => l.kind !== 'employer_cost').map((l) =>
      h('tr', {},
        h('td', {}, localOf(l, 'desc') || l.desc_en),
        h('td', { class: 'num' }, money(l.amount)))))),
    h('div', { class: 'doc-totals' },
      h('div', { class: 'grand' }, h('span', {}, p('payroll.net')), h('span', {}, money(slip.net))),
      h('div', {}, h('span', {}, p('payroll.sso_employer')), h('span', {}, money(slip.sso_employer)))))

  openDialog(`${p('pay.slip')} · ${slip.ym}`, doc, [
    btn(t('btn.print'), { onclick: () => window.print() }),
    btn(t('btn.close'), { primary: true, onclick: closeDialog }),
  ], { wide: true })
}

// ---- filings ----------------------------------------------------------------

export async function openFilingForm(filing) {
  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('form.filed_on'), input({ id: 'g-date', type: 'date', value: S.today })),
      field(t('form.ref'), input({ id: 'g-ref', placeholder: 'RD-000000' })),
      field(t('col.amount'), input({
        id: 'g-amount', inputmode: 'decimal',
        value: filing.amount != null ? format(filing.amount, 'THB', { plain: true }) : '',
      }))))

  openDialog(`${filing.code} · ${filing.period}`, body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.mark_filed'), {
      primary: true,
      onclick: async () => {
        const after = await markFiled(S.db, filing.id, {
          filed_on: val('g-date'),
          ref: val('g-ref') || null,
          amount: amount('g-amount') || filing.amount || null,
        })
        closeDialog()
        // Filing moved the month out of the control accounts; saying what is
        // now owed, and to whom, is the half people never see in a tax screen.
        result(t('result.filed', { form: filing.code, period: filing.period }),
          after?.amount
            ? t('result.filed_owed', { amount: money(after.amount), form: filing.code })
            : null)
        refresh()
      },
    }),
  ])
}

/** Paying an office: the money leaves the bank on the day it leaves. */
export async function openPayFilingForm(filing) {
  const accounts = await S.db.all(
    `SELECT code, name_en, name_th, name_km, bank_name FROM account
      WHERE entity_id = ? AND subtype = 'cash' AND is_active = 1
      ORDER BY is_bank DESC, code`, S.entity.id)

  const body = h('div', {},
    h('div', { class: 'field' },
      h('label', {}, t('col.form')),
      h('div', { class: 'strong' }, `${filing.code} · ${filing.period}`)),
    h('div', { class: 'row' },
      field(t('tax.paid_on'), input({ id: 'fp-date', type: 'date', value: S.today })),
      field(t('form.account_out'), select(
        accounts.map((a) => [a.code, [nameOf(a), a.bank_name].filter(Boolean).join(' · ')]),
        { id: 'fp-account', value: accounts[0]?.code })),
      field(t('col.amount'), input({
        id: 'fp-amount', inputmode: 'decimal',
        value: filing.amount != null ? format(filing.amount, 'THB', { plain: true }) : '',
      }))),
    field(t('form.ref'), input({ id: 'fp-ref', value: filing.ref || '' })))

  openDialog(t('tax.pay_it'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('tax.pay_it'), {
      primary: true,
      onclick: async () => {
        const paid = amount('fp-amount') || filing.amount
        if (!paid) return
        await payFiling(S.db, filing.id, {
          on_date: val('fp-date'),
          account: val('fp-account'),
          amount: paid,
          ref: val('fp-ref') || null,
        })
        closeDialog()
        result(t('tax.paid_said', {
          form: filing.code, period: filing.period, amount: money(paid),
        }))
        refresh()
      },
    }),
  ])
}

// ---- the document itself ----------------------------------------------------

const KIND_TH = {
  quote: 'ใบเสนอราคา', invoice: 'ใบแจ้งหนี้', tax_invoice: 'ใบกำกับภาษี',
  receipt: 'ใบเสร็จรับเงิน', bill: 'ใบวางบิล', credit_note: 'ใบลดหนี้', debit_note: 'ใบเพิ่มหนี้',
}
const KIND_EN = {
  quote: 'Quotation', invoice: 'Invoice', tax_invoice: 'Tax invoice',
  receipt: 'Receipt', bill: 'Supplier bill', credit_note: 'Credit note', debit_note: 'Debit note',
}

export async function openDocView(docId) {
  const doc = await getDoc(S.db, docId)
  const party = await S.db.get('SELECT * FROM party WHERE id = ?', doc.party_id)
  const seller = doc.direction === 'out' ? S.entity : party
  const buyer = doc.direction === 'out' ? party : S.entity
  const ccy = doc.currency
  const outstanding = doc.gross - doc.paid - doc.wht_credited

  const partyBlock = (who, label_th, label_en) => h('div', {},
    h('h4', {}, `${label_th} / ${label_en}`),
    h('div', { class: 'strong' }, nameOf(who)),
    who.tax_id ? h('div', {}, `${p('entity.tax_id')}: ${who.tax_id}`) : null,
    nameOf(who, 'address') ? h('div', { class: 'dim' }, nameOf(who, 'address')) : null)

  const view = h('div', { class: 'doc' },
    h('div', { class: 'doc-head' },
      h('div', {},
        h('div', { class: 'strong', style: 'font-size:17px' },
          (pick(S.brand, 'name', S.locale) || S.brand.name_en)),
        h('div', { class: 'dim' }, S.brand.city)),
      h('div', { class: 'doc-title' },
        h('div', { class: 'th' }, KIND_TH[doc.kind]),
        h('div', { class: 'en' }, KIND_EN[doc.kind]))),
    h('div', { class: 'parties' },
      partyBlock(seller, 'ผู้ขาย', 'Seller'),
      partyBlock(buyer, 'ผู้ซื้อ', 'Buyer')),
    h('div', { class: 'parties' },
      h('div', {}, h('h4', {}, 'เลขที่ / Number'), doc.status === 'draft' ? t('status.draft') : doc.number),
      h('div', {}, h('h4', {}, 'วันที่ / Date'), when(doc.issue_date),
        doc.due_date ? h('div', { class: 'dim' }, `${p('doc.due_date')}: ${when(doc.due_date)}`) : null)),
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, `${p('doc.description')}`),
        h('th', { class: 'num' }, p('doc.qty')),
        h('th', { class: 'num' }, p('doc.unit_price')),
        h('th', { class: 'num' }, p('doc.amount')))),
      h('tbody', {}, doc.lines.map((l) => h('tr', {},
        h('td', {}, localOf(l, 'desc') || l.desc_en,
          secondText(l, 'desc') ? h('div', { class: 'dim' }, secondText(l, 'desc')) : null),
        h('td', { class: 'num' }, String(l.qty_milli / 1000)),
        h('td', { class: 'num' }, format(l.unit_price, ccy, { plain: true })),
        h('td', { class: 'num' }, format(l.net, ccy, { plain: true })))))),
    h('div', { class: 'doc-totals' },
      h('div', {}, h('span', {}, p('doc.net')), h('span', {}, format(doc.net, ccy, { plain: true }))),
      doc.vat ? h('div', {}, h('span', {}, p('doc.vat', { pct: 7 })),
        h('span', {}, format(doc.vat, ccy, { plain: true }))) : null,
      h('div', { class: 'grand' }, h('span', {}, p('doc.gross')), h('span', {}, money(doc.gross, ccy))),
      doc.wht ? h('div', {}, h('span', {}, p('doc.wht', { pct: doc.wht_bp / 100 })),
        h('span', {}, `− ${format(doc.wht, ccy, { plain: true })}`)) : null,
      doc.wht ? h('div', { class: 'strong' }, h('span', {}, p('doc.expect_paid')),
        h('span', {}, money(doc.expect_paid, ccy))) : null,
      doc.paid || doc.wht_credited
        ? h('div', {}, h('span', {}, p('doc.paid')), h('span', {}, money(doc.paid + doc.wht_credited, ccy)))
        : null,
      outstanding > 0 && doc.status !== 'draft'
        ? h('div', { class: 'strong' }, h('span', {}, p('doc.balance')), h('span', {}, money(outstanding, ccy)))
        : null),
    h('div', { class: 'words' },
      `${p('doc.in_words')}: ${ccy === 'THB' ? bahtText(doc.gross) : amountText(doc.gross, ccy)}`),
    h('div', { class: 'sigs' },
      h('div', {}, 'ผู้รับเงิน / Received by'),
      h('div', {}, 'ผู้จ่ายเงิน / Paid by')))

  const actions = [btn(t('btn.print'), { onclick: () => window.print() })]
  const live = doc.status !== 'draft' && doc.status !== 'void' && doc.kind !== 'quote'
  if (live && outstanding > 0 && doc.direction === 'out') {
    // The first thing on an unpaid invoice is how to pay it, and the second is
    // getting that to the customer where they already are.
    actions.push(btn(t('pay.how'), { primary: true, onclick: () => openHowToPay(doc.id) }))
    actions.push(btn(t('cash.title'), { onclick: () => openCashForm(doc) }))
    actions.push(btn(t('line.send'), { onclick: () => openSendByLine(doc) }))
  }
  if (live && outstanding > 0 && doc.direction === 'in') {
    actions.push(btn(t('pay.them'), { primary: true, onclick: () => openPayThem(doc) }))
  }
  if (live && outstanding > 0) {
    actions.push(btn(t('btn.record_payment'), {
      onclick: () => openPaymentForm(doc, doc.direction === 'out' ? 'in' : 'out'),
    }))
  }
  if (doc.status !== 'void' && doc.status !== 'draft' && doc.kind !== 'quote') {
    actions.push(btn(t('btn.void'), {
      onclick: async () => {
        const cn = await voidWithCreditNote(S.db, doc.id, { issue_date: S.today })
        closeDialog()
        result(t('result.voided', { number: doc.number, credit: cn?.number ?? '' }))
        refresh()
      },
    }))
  }
  actions.push(btn(t('btn.close'), { onclick: closeDialog }))

  openDialog(`${KIND_EN[doc.kind]} · ${doc.status === 'draft' ? t('status.draft') : doc.number}`,
    view, actions, { wide: true })
}

// ---- the ways in ------------------------------------------------------------


/**
 * What a client can be given so that their receipts arrive without anyone being
 * trained: a link (with its QR, for printing or sending in a chat), an address
 * to forward to, a chat account, and the slip photo.
 */
export async function openWaysIn(channels) {
  const link = channels.find((c) => c.kind === 'link')
  const email = channels.find((c) => c.kind === 'email')
  const line = channels.find((c) => c.kind === 'line')
  const url = link ? intakeUrl(location.origin + location.pathname, link) : ''

  const copyRow = (label, value, note = null) => h('div', { class: 'field' },
    h('label', {}, label),
    h('div', { style: 'display:flex; gap:8px; align-items:center' },
      input({ value, readonly: true, onclick: (e) => e.target.select() }),
      btn(t('inbox.copy'), {
        small: true,
        onclick: async (e) => {
          try {
            await navigator.clipboard.writeText(value)
            e.target.textContent = t('inbox.copied')
          } catch { e.target.previousElementSibling?.select() }
        },
      })),
    note ? h('div', { class: 'dim' }, note) : null)

  const body = h('div', {},
    link ? h('div', { style: 'display:flex; gap:18px; flex-wrap:wrap; align-items:flex-start' },
      h('div', { class: 'qr', style: 'width:150px; flex:0 0 150px', html: qrToSvg(url, { scale: 4, border: 1 }) }),
      h('div', { style: 'flex:1 1 260px; min-width:240px' },
        copyRow(t('inbox.link'), url),
        h('div', { style: 'display:flex; gap:8px' },
          btn(t('inbox.try_it'), { primary: true, onclick: () => openClientSend(link) }),
          btn(t('inbox.new_link'), {
            onclick: async () => {
              await rotateLink(S.db, link.id)
              closeDialog()
              openWaysIn(await channelsFor(S.db, S.entity.id))
            },
          })))) : null,
    email ? copyRow(t('inbox.email'), email.address) : null,
    line ? copyRow(t('inbox.line'), line.address) : null,
    h('div', { class: 'dim' }, t('inbox.slip')))

  openDialog(t('inbox.ways_in'), body, [btn(t('btn.close'), { primary: true, onclick: closeDialog })],
    { wide: true })
}

/** The client's own screen: three fields and a photo. This is the whole of what
 *  the other side has to learn. */
export function openClientSend(channel) {
  let photoName = null
  const body = h('div', {},
    field(t('inbox.what'), input({ id: 'k-what', placeholder: t('inbox.what') })),
    h('div', { class: 'row' },
      field(t('inbox.who'), input({ id: 'k-who' })),
      field(t('inbox.how_much'), input({ id: 'k-amount', inputmode: 'decimal' }))),
    field(t('inbox.photo_add'), input({
      id: 'k-photo', type: 'file', accept: 'image/*',
      onchange: (e) => { photoName = e.target.files?.[0]?.name ?? null },
    })))

  openDialog(t('inbox.client_send'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('inbox.send'), {
      primary: true,
      onclick: async () => {
        const what = val('k-what')
        if (!what) return
        await receive(S.db, {
          entity_id: S.entity.id,
          channel_id: channel.id,
          source: channel.kind,
          from_ref: t('books.client'),
          on_date: S.today,
          kind: 'bill',
          description: what,
          amount: amount('k-amount'),
          party_hint: val('k-who'),
          photo_name: photoName,
        })
        closeDialog()
        result(t('inbox.sent'))
        refresh()
      },
    }),
  ])
}

/** One arrival, turned into a draft bill the bookkeeper can change. */
export async function openInboxItem(item) {
  // Suppliers first, and no default: the list used to open on whoever came
  // first alphabetically — a customer — so a fee paid to the immigration
  // office could be booked against a tour company by pressing Save.
  const people = [...await parties('supplier'), ...await parties('customer')]
    .filter((p, i, all) => all.findIndex((q) => q.id === p.id) === i)
  const expenses = await S.db.all(
    `SELECT * FROM account WHERE entity_id = ? AND type = 'expense' AND is_active = 1
      ORDER BY code`, S.entity.id)
  const lines = await projects()

  const body = h('div', {},
    h('div', { class: 'field' },
      h('label', {}, t('inbox.from')),
      h('div', {}, `${item.from_ref || '—'} · ${when(item.on_date || item.received_at.slice(0, 10))}`,
        item.photo_name ? h('div', { class: 'dim' }, item.photo_name) : null)),
    h('div', { class: 'row' },
      field(t('form.supplier'), select(
        [['', '—'], ...people.map((x) => [x.id, nameOf(x)])],
        { id: 'x-party', value: item.party_id || '' })),
      field(t('col.account'), select(
        expenses.map((a) => [a.code, `${a.code} · ${nameOf(a)}`]),
        { id: 'x-account', value: item.account_hint || '6900' }))),
    h('div', { class: 'row' },
      field(t('form.date'), input({ id: 'x-date', type: 'date', value: item.on_date || S.today })),
      field(t('form.price'), input({
        id: 'x-amount', inputmode: 'decimal',
        value: item.amount ? format(item.amount, item.currency, { plain: true }) : '',
      })),
      field(t('form.line'), select(
        [['', '—'], ...lines.map((x) => [x.id, nameOf(x)])],
        { id: 'x-project', value: '' }))),
    field(t('form.description'), input({ id: 'x-desc', value: item.description || '' })),
    item.party_id ? null : h('div', { class: 'dim' }, t('inbox.no_guess')))

  openDialog(t('inbox.make_bill'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        if (!val('x-party')) {
          document.getElementById('x-party').closest('.field').classList.add('bad')
          return
        }
        await S.db.run('UPDATE inbox_item SET description = ? WHERE id = ?', val('x-desc'), item.id)
        const d = await toDraft(S.db, item.id, {
          party_id: val('x-party'),
          account_code: val('x-account'),
          project_id: val('x-project') || null,
          issue_date: val('x-date'),
          amount: amount('x-amount') || item.amount,
        })
        const issued = await issue(S.db, d.id)
        const party = await S.db.get('SELECT * FROM party WHERE id = ?', issued.party_id)
        closeDialog()
        result(t('result.bill_added', {
          number: issued.number, party: nameOf(party),
          amount: money(issued.gross), due: when(issued.due_date),
        }))
        refresh()
      },
    }),
  ], { wide: true })
}

// ---- rates and rules --------------------------------------------------------

/** Change a rate from a date. The old value keeps its dates and its source. */
export async function openRateForm(rate, label) {
  const isPercent = rate.value_bp != null
  const history = await S.db.all(
    'SELECT * FROM rate WHERE scope = ? AND code = ? ORDER BY from_date DESC LIMIT 6',
    rate.scope, rate.code)

  const body = h('div', {},
    h('div', { class: 'row' },
      field(`${t('rules.new_value')} ${isPercent ? '(%)' : '(฿)'}`, input({
        id: 'r-value', inputmode: 'decimal',
        value: isPercent ? String(rate.value_bp / 100) : format(rate.value_satang, 'THB', { plain: true }),
      })),
      field(t('rules.starts'), input({ id: 'r-from', type: 'date', value: S.today }))),
    field(t('rules.why'), input({ id: 'r-why', placeholder: t('rules.source') })),
    history.length > 1 ? h('div', {},
      h('div', { class: 'dim', style: 'margin:14px 0 6px' }, t('rules.history')),
      h('table', {}, h('tbody', {}, history.map((r) => h('tr', {},
        h('td', {}, when(r.from_date), r.to_date ? ` → ${when(r.to_date)}` : ''),
        h('td', { class: 'num' }, r.value_bp != null ? `${r.value_bp / 100}%` : money(r.value_satang)),
        h('td', { class: 'dim' }, r.source || '')))))) : null)

  openDialog(`${label || rate.code} · ${t('rules.change')}`, body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const raw = val('r-value')
        const from = val('r-from')
        if (!raw || !from) return
        const value = isPercent
          ? { value_bp: Math.round(Number(raw.replace('%', '')) * 100) }
          : { value_satang: parse(raw) }
        if (isPercent ? !Number.isFinite(value.value_bp) : value.value_satang == null) return
        await setRate(S.db, {
          scope: rate.scope, code: rate.code, ...value,
          from_date: from, source: val('r-why') || rate.source,
        })
        closeDialog()
        result(t('rules.changed', {
          what: label || rate.code,
          value: isPercent ? `${value.value_bp / 100}%` : money(value.value_satang),
          date: when(from),
        }))
        refresh()
      },
    }),
  ])
}

/** The whole income tax ladder, edited as a ladder. */
export function openBandsForm(bands) {
  const rows = h('div', {})
  const addRow = (upTo, bp) => {
    const row = h('div', { class: 'line-row', style: 'grid-template-columns: 1fr 120px 40px' },
      input({ class: 'up', inputmode: 'decimal', placeholder: '—',
        value: upTo == null ? '' : format(upTo, 'THB', { plain: true }) }),
      input({ class: 'bp', inputmode: 'decimal', placeholder: '%', value: String(bp / 100) }),
      btn('✕', { small: true, onclick: () => row.remove() }))
    rows.append(row)
  }
  bands.forEach((b) => addRow(b.value_satang, b.value_bp))

  const body = h('div', {},
    h('div', { class: 'dim', style: 'margin-bottom:8px' }, `${t('rules.value')} · %`),
    rows,
    btn(t('btn.add_line'), { small: true, onclick: () => addRow(null, 0) }),
    h('div', { class: 'row', style: 'margin-top:14px' },
      field(t('rules.starts'), input({ id: 'bd-from', type: 'date', value: S.today })),
      field(t('rules.why'), input({ id: 'bd-why' }))))

  openDialog(t('rules.bands'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const next = Array.from(rows.querySelectorAll('.line-row')).map((row) => ({
          upTo: parse(row.querySelector('.up').value) ?? Infinity,
          bp: Math.round(Number(row.querySelector('.bp').value || 0) * 100),
        }))
        if (!next.length) return
        await setBands(S.db, {
          bands: next, from_date: val('bd-from'), source: val('bd-why') || null,
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ])
}

/** A filing rule: when it is due, what electronic filing adds, whether it
 *  applies at all. */
export function openObligationForm(o) {
  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('rules.due_rule'), input({ id: 'o-rule', value: o.due_rule })),
      field(t('rules.efile'), input({ id: 'o-efile', type: 'number', min: '0', value: o.efile_bonus_days }))),
    h('div', { class: 'row' },
      field(t('rules.applies'), select([
        ['always', 'always'], ['vat_registered', 'vat_registered'],
        ['has_employees', 'has_employees'], ['withholds', 'withholds'],
        ['company', 'company'], ['sole', 'sole'],
      ], { id: 'o-applies', value: o.applies_when || 'always' })),
      field(t('rules.starts'), input({ id: 'o-from', type: 'date', value: S.today }))),
    field(t('rules.why'), input({ id: 'o-why', value: o.source || '' })),
    h('div', { class: 'dim' }, 'day:7 · day:15 · days:150 · months:2'))

  openDialog(`${o.code} · ${t('rules.change')}`, body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.stop'), {
      onclick: async () => {
        await setObligation(S.db, {
          entity_id: S.entity.id, code: o.code, active_from: val('o-from'), active: false,
          source: val('o-why') || null,
        })
        closeDialog()
        result(t('result.stopped'))
        refresh()
      },
    }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        await setObligation(S.db, {
          entity_id: S.entity.id,
          code: o.code,
          due_rule: val('o-rule'),
          efile_bonus_days: Number(val('o-efile')) || 0,
          applies_when: val('o-applies'),
          active_from: val('o-from'),
          source: val('o-why') || null,
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ])
}

// ---- taking a copy away -----------------------------------------------------

const TABLES = [
  'entity', 'project', 'person', 'party', 'account', 'journal', 'journal_line',
  'doc', 'doc_line', 'payment', 'allocation', 'item', 'item_move', 'plan',
  'subscription', 'billed_period', 'employment', 'pay_run', 'payslip',
  'payslip_line', 'obligation', 'filing', 'rate', 'inbox_item', 'audit',
]

const csvCell = (v) => {
  if (v == null) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function saveFile(name, blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/**
 * The records, off the machine and into a folder: every table as CSV in one
 * text file, and the database itself. A set of books nobody can get out of the
 * software is not a set of books.
 */
export async function downloadRecords() {
  const parts = []
  for (const table of TABLES) {
    const rows = await S.db.all(`SELECT * FROM ${table}`)
    if (!rows.length) continue
    const cols = Object.keys(rows[0])
    parts.push(`# ${table}`)
    parts.push(cols.join(','))
    for (const r of rows) parts.push(cols.map((c) => csvCell(r[c])).join(','))
    parts.push('')
  }
  const stamp = S.today.replace(/-/g, '')
  saveFile(`books-${stamp}.csv`, new Blob([parts.join('\n')], { type: 'text/csv' }))
  if (S.database) {
    const bytes = S.database.export()
    setTimeout(() => saveFile(`books-${stamp}.sqlite`,
      new Blob([bytes], { type: 'application/octet-stream' })), 400)
  }
  result(t('records.done'))
}

// ---- work sent on -----------------------------------------------------------


/** A case sent somewhere else. Nothing is earned by adding one. */
export async function openReferralForm(live) {
  // The rate card of whichever arrangement is chosen: picking the service is
  // what tells a margin case what the other desk charges, and the two prices
  // are shown as they are picked so the earning is visible before it is saved.
  const serviceField = h('div', {})
  const chosen = () => live.find((a) => a.code === val('rf-code')) || live[0]

  async function paintServices() {
    const agreement = chosen()
    const card = agreement ? await rateCard(S.db, agreement.id, S.today) : []
    if (!card.length) { mount(serviceField); return }
    const paintPrices = () => {
      const row = card.find((c) => c.code === val('rf-service'))
      mount(prices, row
        ? h('div', { class: 'said' }, t('ref.card_line', {
          net: money(row.net_price, row.currency),
          retail: row.retail_price ? money(row.retail_price, row.currency) : '—',
          margin: row.retail_price ? money(row.retail_price - row.net_price, row.currency) : '—',
        }))
        : null)
      const fee = document.getElementById('rf-fee')
      if (row?.retail_price && fee && !fee.value) {
        fee.value = format(row.retail_price, row.currency, { plain: true })
      }
    }
    const prices = h('div', {})
    mount(serviceField,
      field(t('ref.service'), select(
        [['', '—'], ...card.map((c) => [c.code, nameOf(c)])],
        { id: 'rf-service', onchange: paintPrices })),
      prices)
    paintPrices()
  }

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('ref.code'), select(
        live.map((a) => [a.code, `${a.code} · ${nameOf(a, 'party_name')}`]),
        { id: 'rf-code', onchange: paintServices })),
      field(t('ref.date'), input({ id: 'rf-date', type: 'date', value: S.today }))),
    // The service off the rate card, because on a margin arrangement the pair
    // of prices IS the case: without it the earning cannot be worked out, and
    // a blank one silently became the whole fee.
    serviceField,
    field(t('ref.label'), input({ id: 'rf-label', placeholder: t('ref.label') })),
    h('div', { class: 'row' },
      field('#', input({ id: 'rf-ext', placeholder: 'ENQ-000' })),
      field(t('ref.case_fee'), input({ id: 'rf-fee', inputmode: 'decimal' }))))

  openDialog(t('ref.new'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const label = val('rf-label')
        if (!label) return
        await addReferral(S.db, {
          entity_id: S.entity.id,
          code: val('rf-code'),
          sent_on: val('rf-date'),
          label,
          service_code: val('rf-service') || null,
          external_id: val('rf-ext') || null,
          case_fee: amount('rf-fee') || null,
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ])
  await paintServices()
}

/** The case finished: what they charged, and what that earns. */
export async function openCompleteForm(r) {
  const agreement = r.agreement_id
    ? await S.db.get('SELECT * FROM referral_agreement WHERE id = ?', r.agreement_id)
    : null
  // What the other desk charges for this service, which is the whole of a
  // margin case: without it the preview showed the entire fee as the earning,
  // which is what the books would then have said.
  const card = agreement && r.service_code
    ? await serviceRateOn(S.db, agreement.id, r.service_code, r.completed_on || S.today)
    : null
  const netCost = r.net_cost ?? card?.net_price ?? null
  const preview = h('div', { class: 'totals' })
  const paint = () => {
    const fee = amount('rc-fee')
    const worked = commissionFor(agreement, { case_fee: fee, net_cost: netCost })
    const missing = agreement?.basis === 'margin' && netCost == null
    mount(preview,
      h('div', {}, h('span', {}, t('ref.case_fee')), h('span', {}, money(fee))),
      netCost != null
        ? h('div', { class: 'note' },
          h('span', {}, t('ref.net_cost')), h('span', {}, money(netCost)))
        : null,
      h('div', { class: 'big' },
        h('span', {}, t('ref.commission')),
        h('span', {}, missing ? '—' : money(worked.amount))),
      h('div', { class: 'note' },
        h('span', {}, t('ref.basis')), h('span', {}, t(`ref.basis.${worked.basis || 'percent_of_fee'}`))),
      // A margin case with no net price cannot be worked out, and saying so is
      // the only honest thing to show: the alternative was the whole fee.
      missing ? h('div', { class: 'note' }, h('span', {}, t('ref.no_net')), h('span', {})) : null)
  }

  const body = h('div', {},
    h('div', { class: 'field' },
      h('label', {}, t('ref.label')),
      h('div', { class: 'strong' }, r.label || r.service || r.external_id || '—')),
    h('div', { class: 'row' },
      field(t('ref.done_on'), input({ id: 'rc-date', type: 'date', value: S.today })),
      field(t('ref.case_fee'), input({
        id: 'rc-fee', inputmode: 'decimal', oninput: paint,
        value: r.case_fee ? format(r.case_fee, r.currency, { plain: true }) : '',
      }))),
    agreement ? preview : h('div', { class: 'dim' }, t('ref.no_terms')))

  openDialog(t('ref.mark_done'), body, [
    btn(t('ref.declined'), {
      onclick: async () => {
        await setReferralStatus(S.db, r.id, {
          status: 'declined', on_date: val('rc-date'), why: 'not taken on',
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('ref.mark_done'), {
      primary: true,
      onclick: async () => {
        const done = await setReferralStatus(S.db, r.id, {
          status: 'completed', on_date: val('rc-date'), case_fee: amount('rc-fee'),
        })
        closeDialog()
        result(`${done.label || done.external_id || ''} · ${t('ref.commission')} ${money(done.commission ?? 0)}`)
        refresh()
      },
    }),
  ])
  if (agreement) paint()
}

/** The terms, dated. Changing them leaves what was already earned alone. */
export async function openTermsForm(existing) {
  const people = await parties(null)
  const lines = await projects()
  const basisOptions = [
    ['percent_of_fee', t('ref.basis.percent_of_fee')],
    ['fixed_per_case', t('ref.basis.fixed_per_case')],
  ]

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('ref.code'), input({ id: 'tm-code', value: existing?.code || 'CMVD' })),
      field(t('ref.who_pays'), select(
        people.map((x) => [x.id, nameOf(x)]), { id: 'tm-party', value: existing?.party_id }))),
    field(t('form.description'), input({
      id: 'tm-name', value: existing?.name_en || 'Referral commission',
    })),
    h('div', { class: 'row' },
      field(t('ref.basis'), select(basisOptions, {
        id: 'tm-basis', value: existing?.basis || 'percent_of_fee',
        onchange: (e) => {
          document.getElementById('tm-rate').parentElement.hidden = e.target.value !== 'percent_of_fee'
          document.getElementById('tm-fixed').parentElement.hidden = e.target.value !== 'fixed_per_case'
        },
      })),
      field(`${t('ref.rate')} (%)`, input({
        id: 'tm-rate', inputmode: 'decimal',
        value: existing?.rate_bp != null ? String(existing.rate_bp / 100) : '',
      })),
      field(`${t('ref.rate')} (฿)`, input({
        id: 'tm-fixed', inputmode: 'decimal',
        value: existing?.fixed_amount != null
          ? format(existing.fixed_amount, 'THB', { plain: true }) : '',
      }))),
    h('div', { class: 'row' },
      field(p('doc.wht', { pct: 3 }) + ' (%)', input({
        id: 'tm-wht', inputmode: 'decimal', value: String((existing?.wht_bp ?? 300) / 100),
      })),
      field(t('form.terms'), input({
        id: 'tm-terms', type: 'number', value: String(existing?.terms_days ?? 15),
      })),
      field(t('form.line'), select(
        lines.map((x) => [x.id, nameOf(x)]), { id: 'tm-project', value: existing?.project_id }))),
    h('div', { class: 'row' },
      field(t('rules.starts'), input({ id: 'tm-from', type: 'date', value: S.today })),
      field(t('rules.source'), input({ id: 'tm-source', value: existing?.source || '' }))))

  openDialog(t('ref.terms'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const basis = val('tm-basis')
        await setAgreement(S.db, {
          entity_id: S.entity.id,
          party_id: val('tm-party'),
          code: val('tm-code'),
          name_en: val('tm-name') || 'Referral commission',
          basis,
          rate_bp: basis === 'percent_of_fee'
            ? Math.round(Number(val('tm-rate') || 0) * 100) : null,
          fixed_amount: basis === 'fixed_per_case' ? amount('tm-fixed') : null,
          wht_bp: Math.round(Number(val('tm-wht') || 0) * 100),
          terms_days: Number(val('tm-terms')) || 0,
          project_id: val('tm-project') || null,
          from_date: val('tm-from'),
          source: val('tm-source') || null,
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ], { wide: true })

  // Show only the field the chosen basis uses.
  const basis = existing?.basis || 'percent_of_fee'
  document.getElementById('tm-rate').parentElement.hidden = basis !== 'percent_of_fee'
  document.getElementById('tm-fixed').parentElement.hidden = basis !== 'fixed_per_case'
}

/** Everything finished in a month, on one invoice. */
export function openBillMonthForm(live) {
  const lastMonth = (() => {
    const [y, m] = S.today.split('-').map(Number)
    const t0 = y * 12 + (m - 1) - 1
    return `${Math.floor(t0 / 12)}-${String((t0 % 12) + 1).padStart(2, '0')}`
  })()

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('ref.code'), select(
        live.map((a) => [a.id, `${a.code} · ${nameOf(a, 'party_name')}`]), { id: 'bm-agreement' })),
      field(t('form.month'), input({ id: 'bm-month', type: 'month', value: lastMonth })),
      field(t('form.date'), input({ id: 'bm-date', type: 'date', value: S.today }))))

  openDialog(t('ref.bill_month'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('ref.bill_month'), {
      primary: true,
      onclick: async () => {
        const { doc, cases } = await billMonth(S.db, {
          entity_id: S.entity.id,
          agreement_id: val('bm-agreement'),
          period: val('bm-month'),
          issue_date: val('bm-date'),
        })
        closeDialog()
        if (!doc) { result(t('ref.none_due')); return }
        result(t('ref.billed_msg', {
          n: cases.length, number: doc.number,
          amount: money(doc.gross, doc.currency), net: money(doc.expect_paid, doc.currency),
        }))
        refresh()
        openDocView(doc.id)
      },
    }),
  ])
}

/**
 * Their statement against ours. Paste what they sent; the answer is four
 * lists, and the conversation that follows is about named rows.
 */
export async function openReconcileForm() {
  const ours = (await allReferrals(S.db, S.entity.id))
    .filter((r) => ['completed', 'billed', 'paid'].includes(r.status))
  const out = h('div', {})

  const body = h('div', {},
    field(t('ref.paste'), h('textarea', {
      id: 'rc-text', rows: 6, placeholder: 'ENQ-101, 15000, 1500',
      style: 'width:100%; background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:9px',
    })),
    h('div', { class: 'dim' }, t('ref.paste_hint')),
    out)

  openDialog(t('ref.reconcile'), body, [
    btn(t('btn.close'), { onclick: closeDialog }),
    btn(t('ref.reconcile'), {
      primary: true,
      onclick: () => {
        const theirs = document.getElementById('rc-text').value
          .split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
          .map((line) => {
            const [id, fee, commission] = line.split(/[,\t;]/).map((x) => x.trim())
            return {
              external_id: id,
              case_fee: parse(fee) ?? null,
              commission: parse(commission) ?? null,
            }
          })
        const r = reconcile(ours, theirs)
        const list = (label, rows, render) => rows.length
          ? h('div', {},
            h('div', { class: 'dim', style: 'margin:12px 0 4px' }, `${label} — ${rows.length}`),
            h('table', {}, h('tbody', {}, rows.map(render))))
          : null
        mount(out,
          list(t('ref.agreed'), r.agreed, (x) => h('tr', {},
            h('td', {}, x.external_id || x.label),
            h('td', { class: 'num' }, money(x.commission ?? 0)))),
          list(t('ref.differs'), r.differs, (x) => h('tr', {},
            h('td', {}, x.external_id || x.label),
            h('td', { class: 'num' }, money(x.commission ?? 0)),
            h('td', { class: 'num pill bad' }, money(x.theirs.commission ?? 0)))),
          list(t('ref.ours_only'), r.oursOnly, (x) => h('tr', {},
            h('td', {}, x.external_id || x.label),
            h('td', { class: 'num' }, money(x.commission ?? 0)))),
          list(t('ref.theirs_only'), r.theirsOnly, (x) => h('tr', {},
            h('td', {}, x.external_id || '—'),
            h('td', { class: 'num' }, money(x.commission ?? 0)))))
      },
    }),
  ], { wide: true })
}

// ---- paying -----------------------------------------------------------------

/**
 * How to pay one invoice: the QR first, because it is the only one with
 * nothing to type. The odd satang is explained where it appears rather than
 * hidden.
 */
export async function openHowToPay(docId) {
  const { doc, ways, amount } = await waysToPay(S.db, docId)
  const link = doc.pay_token
    ? `${location.origin}${location.pathname}?pay=${doc.pay_token}`
    : null

  const box = h('div', {})
  const paint = (way) => mount(box,
    way.kind === 'promptpay'
      ? h('div', { style: 'display:flex; gap:18px; flex-wrap:wrap; align-items:center' },
        h('div', { class: 'qr', style: 'width:190px; flex:0 0 190px', html: way.qr }),
        h('div', { style: 'flex:1 1 220px' },
          h('div', { class: 'dim' }, t('pay.scan')),
          h('div', { style: 'font-size:26px; font-weight:640' }, money(amount, doc.currency)),
          doc.pay_tail
            ? h('div', { class: 'dim' },
              `${t('pay.marker')} ${money(doc.pay_tail, doc.currency)} · ${t('pay.marker_note')}`)
            : null))
      : way.kind === 'link'
        ? h('div', {}, h('a', { href: way.url, target: '_blank', rel: 'noreferrer' }, way.url))
        : h('div', {}, fieldsList(way.lines)))

  const body = h('div', {},
    h('div', { style: 'display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px' },
      ways.map((w, i) => btn(w.label, {
        small: true, primary: i === 0, onclick: (e) => {
          [...e.target.parentElement.children].forEach((b) => b.classList.remove('primary'))
          e.target.classList.add('primary')
          paint(w)
        },
      }))),
    box,
    link ? h('div', { class: 'field', style: 'margin-top:16px' },
      h('label', {}, t('pay.link')),
      h('div', { style: 'display:flex; gap:8px' },
        input({ value: link, readonly: true, onclick: (e) => e.target.select() }),
        btn(t('inbox.copy'), {
          small: true,
          onclick: async (e) => {
            try {
              await navigator.clipboard.writeText(link)
              e.target.textContent = t('inbox.copied')
            } catch { /* the field is selectable either way */ }
          },
        }),
        btn(t('pay.open_link'), { small: true, onclick: () => window.open(link, '_blank') }))) : null)

  openDialog(`${t('pay.how')} · ${doc.number}`, body, [
    btn(t('pay.paid_in_full'), {
      onclick: async () => {
        await settleInFull(S.db, docId, { on_date: S.today, account: '1010' })
        closeDialog()
        result(t('pay.settled', { number: doc.number }))
        refresh()
      },
    }),
    btn(t('btn.close'), { primary: true, onclick: closeDialog }),
  ], { wide: true })

  if (ways.length) paint(ways[0])
  else mount(box, h('div', { class: 'dim' }, t('pay.no_way')))
}

const fieldsList = (pairs) => h('table', {}, h('tbody', {}, pairs.map(([k, v]) =>
  h('tr', {}, h('td', { class: 'dim' }, k), h('td', { class: 'strong' }, v)))))

/** Paying a supplier: their QR, if they gave one. */
export async function openPayThem(doc) {
  const party = await S.db.get('SELECT * FROM party WHERE id = ?', doc.party_id)
  const outstanding = doc.gross - doc.paid - doc.wht_credited - (doc.wht - doc.wht_credited)
  const ways = waysToPayThem(party, { amount: outstanding, reference: doc.number })

  const body = h('div', {},
    ways.length
      ? ways.map((w) => w.kind === 'promptpay'
        ? h('div', { style: 'display:flex; gap:16px; align-items:center; margin-bottom:14px' },
          h('div', { class: 'qr', style: 'width:170px; flex:0 0 170px', html: w.qr }),
          h('div', {},
            h('div', { class: 'dim' }, t('pay.their_promptpay')),
            h('div', { style: 'font-size:22px; font-weight:640' }, money(outstanding, doc.currency))))
        : h('div', { style: 'margin-bottom:12px' }, fieldsList(w.lines)))
      : h('div', { class: 'dim' }, t('pay.no_way')))

  openDialog(`${t('pay.them')} · ${nameOf(party)}`, body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('pay.paid_in_full'), {
      primary: true,
      onclick: async () => {
        const wht = doc.wht - doc.wht_credited
        await recordPayment(S.db, {
          entity_id: S.entity.id, direction: 'out', on_date: S.today,
          party_id: doc.party_id, account: '1010', method: 'transfer',
          amount: outstanding, wht_amount: wht,
          wht_cert_no: wht ? `WHT-${doc.number}` : null,
          allocations: [{ doc_id: doc.id, amount: outstanding, wht_amount: wht }],
        })
        closeDialog()
        result(t('pay.settled', { number: doc.number }))
        refresh()
      },
    }),
  ], { wide: true })
}

/** The payer's own page: what is owed, how to pay it, and a way to say it is
 *  done. Nothing here settles anything. */
export async function openPayerPage(doc) {
  const { ways, amount } = await waysToPay(S.db, doc.id)
  const entity = await S.db.get('SELECT * FROM entity WHERE id = ?', doc.entity_id)
  const box = h('div', {})
  const paint = (way) => mount(box,
    way.kind === 'promptpay'
      ? h('div', { class: 'qr', style: 'width:min(260px, 80vw); margin: 0 auto', html: way.qr })
      : way.kind === 'link'
        ? h('div', {}, h('a', { href: way.url, target: '_blank', rel: 'noreferrer' }, way.url))
        : fieldsList(way.lines))

  let photoName = null
  const main = document.getElementById('main')
  mount(main,
    head(nameOf(entity)),
    panel(`${doc.number} · ${money(amount, doc.currency)}`, h('div', { class: 'body' },
      h('div', { style: 'display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px' },
        ways.map((w, i) => btn(w.label, {
          small: true, primary: i === 0,
          onclick: (e) => {
            [...e.target.parentElement.children].forEach((b) => b.classList.remove('primary'))
            e.target.classList.add('primary')
            paint(w)
          },
        }))),
      box,
      h('div', { style: 'margin-top:18px' },
        field(t('pay.attach_slip'), input({
          type: 'file', accept: 'image/*', capture: 'environment',
          onchange: (e) => { photoName = e.target.files?.[0]?.name ?? null },
        })),
        field(t('pay.slip_text'), input({ id: 'pp-slip' })),
        h('button', {
          class: 'btn primary', style: 'width:100%; min-height:46px',
          onclick: async () => {
            await claimPaid(S.db, {
              entity_id: doc.entity_id,
              doc_id: doc.id,
              amount,
              method: 'promptpay',
              slip_raw: document.getElementById('pp-slip').value.trim() || null,
              photo_name: photoName,
            })
            result(t('pay.thanks'))
          },
        }, t('pay.i_paid')))))) 
  if (ways.length) paint(ways[0])
}

/** A way to be paid, added or edited. */
export async function openMethodForm(existing) {
  const accounts = await cashAccounts()
  const kinds = [
    ['promptpay', 'PromptPay'],
    ['bank', t('pay.bank_name')],
    ['cash', t('pay.method.cash') || 'Cash'],
    ['link', t('pay.link_template')],
  ]
  const show = (kind) => {
    for (const [id, want] of [
      ['pm-payee', 'promptpay'], ['pm-bank', 'bank'], ['pm-acname', 'bank'],
      ['pm-acno', 'bank'], ['pm-link', 'link'],
    ]) {
      document.getElementById(id).parentElement.hidden = kind !== want
    }
  }

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('col.type'), select(kinds, {
        id: 'pm-kind', value: existing?.kind || 'promptpay',
        onchange: (e) => show(e.target.value),
      })),
      field(t('col.name'), input({ id: 'pm-label', value: existing?.label_en || '' })),
      field(t('pay.lands_in'), select(
        accounts.map((a) => [a.code, nameOf(a)]),
        { id: 'pm-account', value: existing?.account_code || '1010' }))),
    field(t('pay.payee'), input({ id: 'pm-payee', value: existing?.payee_id || '' })),
    h('div', { class: 'row' },
      field(t('pay.bank_name'), input({ id: 'pm-bank', value: existing?.bank_name || '' })),
      field(t('pay.account_name'), input({ id: 'pm-acname', value: existing?.account_name || '' })),
      field(t('pay.account_no'), input({ id: 'pm-acno', value: existing?.account_no || '' }))),
    field(t('pay.link_template'), input({ id: 'pm-link', value: existing?.link_template || '' })))

  openDialog(existing ? existing.label_en : t('pay.method_add'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const kind = val('pm-kind')
        try {
          if (existing) await S.db.run('DELETE FROM pay_method WHERE id = ?', existing.id)
          await addMethod(S.db, {
            entity_id: S.entity.id,
            kind,
            label_en: val('pm-label') || kind,
            payee_id: kind === 'promptpay' ? val('pm-payee') : null,
            bank_name: val('pm-bank') || null,
            account_name: val('pm-acname') || null,
            account_no: val('pm-acno') || null,
            link_template: kind === 'link' ? val('pm-link') : null,
            account_code: val('pm-account'),
            is_default: existing?.is_default === 1,
          })
          closeDialog()
          result(t('result.saved'))
          refresh()
        } catch (err) {
          result(err.message)
        }
      },
    }),
  ], { wide: true })
  show(existing?.kind || 'promptpay')
}

// ---- the chat app -----------------------------------------------------------


/** An invoice, as a message: the amount, the ways to pay, and the link. */
export async function openSendByLine(doc) {
  const chats = await chatsFor(S.db, S.entity.id)
  const forParty = chats.filter((c) => c.party_id === doc.party_id)
  const text = await howToPayText(S.db, doc.id, {
    locale: S.locale, origin: location.origin + location.pathname.replace(/\/$/, ''),
  })

  const body = h('div', {},
    field(t('line.who'), select(
      (forParty.length ? forParty : chats).map((c) => [c.chat_id, c.display_name || c.chat_id]),
      { id: 'ln-chat' })),
    field(t('line.body'), h('textarea', {
      id: 'ln-body', rows: 6,
      style: 'width:100%; background:var(--panel-2); border:1px solid var(--line); border-radius:8px; padding:9px',
    }, text)),
    chats.length ? null : h('div', { class: 'dim' }, t('line.no_chats')))

  openDialog(t('line.send'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('line.send'), {
      primary: true,
      disabled: !chats.length,
      onclick: async () => {
        await queue(S.db, {
          entity_id: S.entity.id,
          chat_id: val('ln-chat'),
          body: document.getElementById('ln-body').value,
          about_kind: 'doc',
          about_id: doc.id,
          idem_key: `line:doc:${doc.id}:${Date.now()}`,
        })
        closeDialog()
        result(t('line.queued'))
        refresh()
      },
    }),
  ], { wide: true })
}

/** Type what a customer would type, and see what comes back. */
export async function openLineSimulator() {
  const chats = await chatsFor(S.db, S.entity.id)
  const out = h('div', {})

  const body = h('div', {},
    field(t('line.who'), select(
      chats.map((c) => [c.chat_id, c.display_name || c.chat_id]), { id: 'sim-chat' })),
    field(t('line.body'), input({ id: 'sim-text', placeholder: 'ยอดค้างเท่าไหร่' })),
    h('div', { class: 'dim', style: 'margin-bottom:10px' },
      `${t('line.keywords')}: ${KEYWORDS.flatMap((k) => k.match.slice(0, 2)).join(' · ')}`),
    out)

  openDialog(t('line.simulate'), body, [
    btn(t('btn.close'), { onclick: closeDialog }),
    btn(t('line.simulate'), {
      primary: true,
      disabled: !chats.length,
      onclick: async () => {
        const reply = await handleEvent(S.db, {
          type: 'message',
          source: { type: 'user', userId: val('sim-chat') },
          message: { type: 'text', id: `sim-${Date.now()}`, text: val('sim-text') },
        }, { locale: S.locale, origin: location.origin + location.pathname.replace(/\/$/, '') })
        mount(out, h('div', { class: 'totals' },
          h('div', {}, h('span', {}, t('line.reply')),
            h('span', {}, reply?.reply ? '' : t('line.filed'))),
          reply?.reply
            ? h('pre', { class: 'mono', style: 'white-space:pre-wrap' }, reply.reply)
            : null))
        refresh()
      },
    }),
  ], { wide: true })
}

/** Who this chat belongs to — until it is said, questions go unanswered. */
export async function openChatLink(chat) {
  const people = await parties(null)
  const body = h('div', {},
    field(t('line.link_party'), select(
      [['', '—'], ...people.map((x) => [x.id, nameOf(x)])],
      { id: 'cl-party', value: chat.party_id || '' })),
    h('div', { class: 'check' },
      input({ id: 'cl-money', type: 'checkbox', checked: chat.may_see_money === 1 }),
      h('label', { for: 'cl-money' }, t('clients.owed'))))

  openDialog(chat.display_name || chat.chat_id, body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        await linkChat(S.db, chat.id, {
          party_id: val('cl-party') || null,
          may_see_money: checked('cl-money'),
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ])
}

export async function queueDigest() {
  const chats = await chatsFor(S.db, S.entity.id)
  const mine = chats.find((c) => c.person_id) || chats[0]
  if (!mine) { result(t('line.no_chats')); return }
  const text = await lineDigest(S.db, S.entity.id, { locale: S.locale, asOf: S.today })
  await queue(S.db, {
    entity_id: S.entity.id, chat_id: mine.chat_id, body: text,
    about_kind: 'digest', idem_key: `digest:${S.entity.id}:${S.today}`,
  })
  result(t('line.queued'))
  refresh()
}

// ---- instalments ------------------------------------------------------------

/**
 * What paying over time comes to. The shapes sit side by side because the only
 * way to compare them is the same schedule and the same totals; which one is
 * written into a contract is between the parties.
 */
export function financeDrawer() {
  const out = h('div', {})

  const paint = () => {
    const amount = parse(document.getElementById('fin-amount').value) ?? 0
    const months = Math.max(1, Number(document.getElementById('fin-months').value) || 12)
    const rate = Math.round(Number(document.getElementById('fin-rate').value || 0) * 100)
    const markup = Math.round(Number(document.getElementById('fin-markup').value || 0) * 100)
    if (!amount) { mount(out); return }

    const shapes = [
      ['interest', amortise({ principal: amount, annualRateBp: rate, months })],
      ['flat', flatRate({ principal: amount, annualRateBp: rate, months })],
      ['cost_plus', costPlus({ cost: amount, markupBp: markup, months })],
      ['declining_share', decliningShare({
        assetCost: amount, financierShareBp: 8000, months, annualRentBp: markup,
      })],
      ['lease', lease({
        assetCost: amount, months, rental: Math.round((amount * (1 + markup / 10000)) / months),
      })],
      ['no_charge', noChargeLoan({ principal: amount, months })],
    ]

    const late = latePayment({ overdue: amount, days: 30, annualRateBp: rate })
    const lateFixed = latePayment({ overdue: amount, days: 30, fixedCharge: 50000, toCharity: true })

    mount(out,
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, t('fin.shape')),
          h('th', { class: 'num' }, t('fin.monthly')),
          h('th', { class: 'num' }, t('fin.total')),
          h('th', { class: 'num' }, t('fin.cost')),
          h('th', { class: 'num' }, t('fin.effective')))),
        h('tbody', {}, shapes.map(([key, s]) => h('tr', {},
          h('td', {},
            h('span', { class: 'strong' }, t(`fin.${key}`)),
            h('div', { class: 'dim' }, s.note)),
          h('td', { class: 'num' }, money(s.rows[0]?.payment ?? 0)),
          h('td', { class: 'num' }, money(s.total)),
          h('td', { class: 'num' }, money(s.cost)),
          h('td', { class: 'num dim' },
            s.effectiveAnnualBp || s.comparableAnnualBp
              ? `${((s.effectiveAnnualBp || s.comparableAnnualBp) / 100).toFixed(1)}%`
              : '—'))))),
      h('div', { class: 'totals' },
        h('div', {},
          h('span', {}, `${t('fin.late')} · ${t('fin.late_interest')}`),
          h('span', {}, `${money(late.interest)} / 30d`)),
        h('div', {},
          h('span', {}, `${t('fin.late')} · ${t('fin.late_fixed')}`),
          h('span', {}, money(lateFixed.total))),
        h('div', { class: 'note' }, h('span', {}, t('fin.note')), h('span', {}, ''))))
  }

  const controls = h('div', { class: 'row' },
    field(t('fin.amount'), input({ id: 'fin-amount', inputmode: 'decimal', value: '100,000', oninput: paint })),
    field(t('fin.months'), input({ id: 'fin-months', type: 'number', min: '1', value: '12', oninput: paint })),
    field(t('fin.rate'), input({ id: 'fin-rate', inputmode: 'decimal', value: '12', oninput: paint })),
    field(t('fin.markup'), input({ id: 'fin-markup', inputmode: 'decimal', value: '7', oninput: paint })))

  const drawer = h('details', { class: 'drawer' },
    h('summary', {}, t('fin.title')),
    h('div', { class: 'body' },
      h('p', { class: 'dim', style: 'margin-top:0' }, t('fin.hint')),
      controls,
      out))
  drawer.addEventListener('toggle', () => { if (drawer.open) paint() })
  return drawer
}

// ---- coin -------------------------------------------------------------------


/** A wallet: the coin, the chain, the address people send to. */
export async function openWalletForm(existing) {
  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('col.name'), input({ id: 'w-label', value: existing?.label || '' })),
      field(t('cx.asset'), select(
        Object.keys(ASSETS).map((a) => [a, `${a} · ${ASSETS[a].label}`]),
        { id: 'w-asset', value: existing?.asset || 'USDT' })),
      field(t('cx.network'), input({ id: 'w-network', value: existing?.network || 'tron' }))),
    field(t('cx.address'), input({ id: 'w-address', value: existing?.address || '' })),
    h('div', { class: 'dim' }, t('cx.note')))

  openDialog(existing ? existing.label : t('cx.wallet_add'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const label = val('w-label')
        if (!label) return
        try {
          await ensureCryptoAccounts(S.db, S.entity.id)
          if (existing) {
            await S.db.run(
              'UPDATE wallet SET network = ?, address = ? WHERE id = ?',
              val('w-network') || null, val('w-address') || null, existing.id)
          } else {
            await addWalletRow(S.db, {
              entity_id: S.entity.id,
              label,
              asset: val('w-asset'),
              network: val('w-network') || null,
              address: val('w-address') || null,
            })
          }
          closeDialog()
          result(t('result.saved'))
          refresh()
        } catch (err) {
          result(err.message)
        }
      },
    }),
  ])
}

/** What a coin was worth, on a day, and where the number came from. */
export async function openRateEntry(asset = 'USDT') {
  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('cx.asset'), select(
        Object.keys(ASSETS).map((a) => [a, a]), { id: 'ar-asset', value: asset })),
      field(t('form.date'), input({ id: 'ar-date', type: 'date', value: S.today })),
      field(`${t('cx.rate')} (฿)`, input({ id: 'ar-rate', inputmode: 'decimal' }))),
    field(t('cx.source'), input({ id: 'ar-source', placeholder: 'the exchange, that morning' })))

  openDialog(t('cx.rate_set'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const rate = Number(val('ar-rate').replace(/,/g, ''))
        if (!Number.isFinite(rate) || rate <= 0) return
        await setAssetRate(S.db, {
          asset: val('ar-asset'),
          rate_ppm: Math.round(rate * 1_000_000),
          on_date: val('ar-date'),
          source: val('ar-source') || null,
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ])
}

/** Coin arrived against an invoice. */
export async function openReceiveCrypto(doc = null) {
  const walletRows = await walletsFor(S.db, S.entity.id, { direction: 'in' })
  if (!walletRows.length) { await openWalletForm(null); return }
  const open = doc ? [doc] : await S.db.all(
    `SELECT * FROM doc WHERE entity_id = ? AND direction = 'out'
       AND status IN ('issued','part_paid') AND kind <> 'quote' ORDER BY issue_date DESC`,
    S.entity.id)

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('cx.wallets'), select(
        walletRows.map((w) => [w.id, `${w.asset} · ${w.label}`]), { id: 'rc-wallet' })),
      field(t('form.date'), input({ id: 'rc-date', type: 'date', value: S.today }))),
    h('div', { class: 'row' },
      field(t('cx.units'), input({ id: 'rc-units', inputmode: 'decimal' })),
      field(t('cx.tx'), input({ id: 'rc-tx', placeholder: '0x…' }))),
    field(t('col.number'), select(
      [['', '—'], ...open.map((d) => [d.id, `${d.number} · ${money(d.gross - d.paid - d.wht_credited, d.currency)}`])],
      { id: 'rc-doc', value: doc?.id || '' })))

  openDialog(t('cx.received'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const wallet = walletRows.find((w) => w.id === val('rc-wallet'))
        const units = parseAsset(val('rc-units'), wallet.asset)
        if (units == null) { result(t('msg.bad_amount')); return }
        try {
          const out = await receiveCrypto(S.db, {
            entity_id: S.entity.id,
            wallet_id: wallet.id,
            doc_id: val('rc-doc') || null,
            asset_amount: units,
            on_date: val('rc-date'),
            tx_ref: val('rc-tx') || null,
          })
          closeDialog()
          result(t('cx.settled', {
            units: formatAsset(units, wallet.asset),
            value: money(out.value),
            rate: `${(out.rate / 1_000_000).toLocaleString('en-US')} / ${wallet.asset}`,
          }))
          refresh()
        } catch (err) {
          result(err.code === 'no_rate' ? t('cx.no_rate') : err.message)
        }
      },
    }),
  ], { wide: true })
}

/** Paying a supplier, or anything else, out of a wallet. */
export async function openSpendCrypto(doc = null) {
  const walletRows = await walletsFor(S.db, S.entity.id)
  if (!walletRows.length) { await openWalletForm(null); return }
  const expenses = await S.db.all(
    `SELECT * FROM account WHERE entity_id = ? AND type = 'expense' AND is_active = 1
      ORDER BY code`, S.entity.id)

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('cx.wallets'), select(
        walletRows.map((w) => [w.id, `${w.asset} · ${w.label}`]), { id: 'sc-wallet' })),
      field(t('cx.units'), input({ id: 'sc-units', inputmode: 'decimal' })),
      field(t('form.date'), input({ id: 'sc-date', type: 'date', value: S.today }))),
    doc ? null : field(t('col.account'), select(
      expenses.map((a) => [a.code, `${a.code} · ${nameOf(a)}`]), { id: 'sc-account', value: '6900' })),
    field(t('cx.tx'), input({ id: 'sc-tx', placeholder: '0x…' })))

  openDialog(t('cx.pay_in'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const wallet = walletRows.find((w) => w.id === val('sc-wallet'))
        const units = parseAsset(val('sc-units'), wallet.asset)
        if (units == null) { result(t('msg.bad_amount')); return }
        try {
          const out = await spendCrypto(S.db, {
            entity_id: S.entity.id,
            wallet_id: wallet.id,
            asset_amount: units,
            on_date: val('sc-date'),
            doc_id: doc?.id ?? null,
            party_id: doc?.party_id ?? null,
            expense_code: doc ? null : val('sc-account'),
            tx_ref: val('sc-tx') || null,
          })
          closeDialog()
          result(t('cx.spent', {
            units: formatAsset(units, wallet.asset),
            value: money(out.marketValue),
            carrying: money(out.carrying),
            realised: money(out.realised),
          }))
          refresh()
        } catch (err) {
          result(err.code === 'no_rate' ? t('cx.no_rate') : err.message)
        }
      },
    }),
  ], { wide: true })
}

/** What is held, at cost and at the last rate — the difference shown, not posted. */
export async function holdingsPanel() {
  const h_ = await holdings(S.db, S.entity.id, { asOf: S.today })
  if (!h_.rows.length) {
    return h('div', { class: 'body' },
      h('p', { class: 'dim', style: 'margin-top:0' }, t('cx.note')),
      h('button', { class: 'btn', onclick: () => openWalletForm(null) }, t('cx.wallet_add')))
  }
  return h('div', {},
    dataTable(h_.rows, [
      { label: t('cx.wallets'), render: (r) => `${r.asset} · ${r.wallet.label}` },
      { label: t('cx.held'), num: true, render: (r) => formatAsset(r.units, r.asset) },
      { label: t('cx.cost'), num: true, render: (r) => money(r.cost) },
      { label: t('cx.worth'), num: true, render: (r) => r.value == null ? '—' : money(r.value) },
      { label: t('cx.difference'), num: true,
        render: (r) => r.difference == null ? '—'
          : h('span', { class: r.difference >= 0 ? 'pill good' : 'pill bad' }, money(r.difference)) },
      { label: t('cx.rate_on'), phone: false,
        render: (r) => r.rate_on
          ? h('span', {}, whenShort(r.rate_on),
            r.stale ? h('div', { class: 'dim' }, t('cx.rate_stale')) : null)
          : '—' },
    ]),
    h('div', { class: 'body', style: 'display:flex; gap:8px; flex-wrap:wrap' },
      h('button', { class: 'btn', onclick: () => openRateEntry() }, t('cx.rate_set')),
      h('button', { class: 'btn', onclick: () => openReceiveCrypto() }, t('cx.received')),
      h('button', { class: 'btn', onclick: () => openSpendCrypto() }, t('cx.pay_in')),
      h('button', { class: 'btn quiet', onclick: () => openWalletForm(null) }, t('cx.wallet_add'))),
    h('div', { class: 'body dim' }, t('cx.note')))
}

/** A service on the rate card: what they charge, what you quote. */
export async function openServiceRateForm(agreement, existing) {
  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('ref.service'), input({ id: 'sr-name', value: existing?.name_en || '' })),
      field(t('form.name_th'), input({ id: 'sr-th', value: existing?.name_th || '' }))),
    h('div', { class: 'row' },
      field(t('ref.net'), input({
        id: 'sr-net', inputmode: 'decimal',
        value: existing ? format(existing.net_price, existing.currency, { plain: true }) : '',
      })),
      field(t('ref.retail'), input({
        id: 'sr-retail', inputmode: 'decimal',
        value: existing?.retail_price
          ? format(existing.retail_price, existing.currency, { plain: true }) : '',
      })),
      field(t('rules.starts'), input({ id: 'sr-from', type: 'date', value: S.today }))),
    field(t('rules.source'), input({ id: 'sr-source', value: existing?.source || '' })))

  openDialog(t('ref.card'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const name = val('sr-name')
        const net = amount('sr-net')
        if (!name || !net) return
        await setServiceRate(S.db, {
          agreement_id: agreement.id,
          code: existing?.code || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
          name_en: name,
          name_th: val('sr-th') || null,
          net_price: net,
          retail_price: amount('sr-retail') || null,
          from_date: val('sr-from'),
          source: val('sr-source') || null,
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ], { wide: true })
}

/** The client's own invoice on a resold case. */
export async function openBillClientForm(referral) {
  const doc = await billClient(S.db, referral.id, {
    vat: Boolean(S.entity.vat_registered),
  })
  const party = await S.db.get('SELECT * FROM party WHERE id = ?', doc.party_id)
  result(t('result.invoice_issued', {
    number: doc.number, party: nameOf(party), amount: money(doc.gross), due: when(doc.due_date),
  }))
  refresh()
  openDocView(doc.id)
}

// ---- banks, currencies, and finding things ---------------------------------


/** Money from one account to another, including across a currency. */
export async function openTransferForm() {
  const b = await bankBalances(S.db, S.entity.id, { asOf: S.today })
  const options = b.rows.map((r) => [r.account.code,
    `${nameOf(r.account)} · ${format(r.own, r.currency)}`])
  if (options.length < 2) { await openBankAccountForm(null); return }

  const note = h('div', { class: 'dim' })
  const paint = () => {
    const from = b.rows.find((r) => r.account.code === val('tf-from'))
    const to = b.rows.find((r) => r.account.code === val('tf-to'))
    const landed = document.getElementById('tf-landed')
    // Same currency: what lands is what left, less the charge. Across a
    // currency it is the bank's number, so it is asked for rather than guessed.
    const across = from && to && from.currency !== to.currency
    landed.parentElement.hidden = !across
    note.textContent = across ? `${from.currency} → ${to.currency}` : ''
  }

  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('banks.from'), select(options, { id: 'tf-from', onchange: paint })),
      field(t('banks.to'), select(options, { id: 'tf-to', value: options[1]?.[0], onchange: paint }))),
    h('div', { class: 'row' },
      field(t('col.amount'), input({ id: 'tf-amount', inputmode: 'decimal' })),
      field(t('banks.fee'), input({ id: 'tf-fee', inputmode: 'decimal', value: '0' })),
      field(t('form.date'), input({ id: 'tf-date', type: 'date', value: S.today }))),
    field(t('banks.landed'), input({ id: 'tf-landed', inputmode: 'decimal' })),
    note)

  openDialog(t('banks.transfer'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('banks.transfer'), {
      primary: true,
      onclick: async () => {
        const from = b.rows.find((r) => r.account.code === val('tf-from'))
        const to = b.rows.find((r) => r.account.code === val('tf-to'))
        const amount = parse(val('tf-amount'), from.currency)
        if (amount == null) { result(t('msg.bad_amount')); return }
        const landedRaw = val('tf-landed')
        try {
          await transfer(S.db, {
            entity_id: S.entity.id,
            from_code: from.account.code,
            to_code: to.account.code,
            amount,
            fee: parse(val('tf-fee'), from.currency) || 0,
            to_amount: landedRaw ? parse(landedRaw, to.currency) : null,
            on_date: val('tf-date'),
          })
          closeDialog()
          result(t('banks.moved', {
            amount: format(amount, from.currency),
            from: nameOf(from.account),
            to: nameOf(to.account),
            landed: landedRaw ? format(parse(landedRaw, to.currency), to.currency) : format(amount, to.currency),
          }))
          refresh()
        } catch (err) {
          result(err.code === 'no_fx_rate' ? t('cx.no_rate') : err.message)
        }
      },
    }),
  ], { wide: true })
  paint()
}

/** One real account somewhere, as a row in the chart. */
export async function openBankAccountForm(existing) {
  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('col.name'), input({ id: 'ba-name', value: existing?.name_en || '' })),
      field(t('col.currency'), select(
        Object.keys(CURRENCIES).map((c) => [c, `${c} · ${CURRENCIES[c].name_en}`]),
        { id: 'ba-ccy', value: existing?.currency || S.entity.currency || 'THB' }))),
    h('div', { class: 'row' },
      field(t('banks.bank'), input({ id: 'ba-bank', value: existing?.bank_name || '' })),
      field(t('banks.account_no'), input({ id: 'ba-no', value: existing?.account_no || '' }))),
    // What somebody abroad needs to fill in their own bank's transfer form.
    // Filled in once here, it appears on every payment page for this account.
    h('div', { class: 'row' },
      field(t('form.swift'), input({ id: 'ba-swift', value: existing?.swift || '' })),
      field(t('form.iban'), input({ id: 'ba-iban', value: existing?.iban || '' }))),
    field(t('form.bank_address'), input({ id: 'ba-addr', value: existing?.bank_address || '' })))

  openDialog(existing ? nameOf(existing) : t('banks.add'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const name = val('ba-name')
        if (!name) return
        if (existing) {
          await S.db.run(
            `UPDATE account SET name_en = ?, currency = ?, bank_name = ?, account_no = ?,
               swift = ?, iban = ?, bank_address = ?, is_bank = 1 WHERE id = ?`,
            name, val('ba-ccy'), val('ba-bank') || null, val('ba-no') || null,
            val('ba-swift') || null, val('ba-iban') || null, val('ba-addr') || null, existing.id)
        } else {
          await addBankAccount(S.db, {
            entity_id: S.entity.id,
            name_en: name,
            currency: val('ba-ccy'),
            bank_name: val('ba-bank') || null,
            account_no: val('ba-no') || null,
            swift: val('ba-swift') || null,
            iban: val('ba-iban') || null,
            bank_address: val('ba-addr') || null,
          })
        }
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ])
}

/** What one currency was worth in another, on a day. */
export async function openFxRateForm() {
  const codes = Object.keys(CURRENCIES)
  const body = h('div', {},
    h('div', { class: 'row' },
      field(t('cx.asset'), select(codes.map((c) => [c, c]), { id: 'fx-from', value: 'USD' })),
      field(t('group.in'), select(codes.map((c) => [c, c]), {
        id: 'fx-to', value: S.entity.currency || 'THB',
      })),
      field(t('cx.rate'), input({ id: 'fx-rate', inputmode: 'decimal' }))),
    h('div', { class: 'row' },
      field(t('form.date'), input({ id: 'fx-date', type: 'date', value: S.today })),
      field(t('cx.source'), input({ id: 'fx-source', placeholder: 'the bank, that morning' }))))

  openDialog(t('banks.rate_add'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('btn.save'), {
      primary: true,
      onclick: async () => {
        const rate = Number(val('fx-rate').replace(/,/g, ''))
        if (!Number.isFinite(rate) || rate <= 0) { result(t('msg.bad_amount')); return }
        await setFxRate(S.db, {
          asset: val('fx-from'),
          quote: val('fx-to'),
          rate_ppm: toPpm(rate),
          on_date: val('fx-date'),
          source: val('fx-source') || null,
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
  ])
}

/**
 * One box that finds anything with a name or a number: an invoice, a customer,
 * a case, a filing, a piece on the shelf. Typing is faster than remembering
 * which screen a thing lives on, and on a phone it saves a scroll.
 */
export async function openSearch() {
  const out = h('div', {})
  const box = input({
    id: 'q', placeholder: t('search.placeholder'), autocomplete: 'off',
    oninput: () => run(),
  })

  const run = async () => {
    const q = box.value.trim()
    if (q.length < 3) { mount(out, h('div', { class: 'dim' }, t('search.hint'))); return }
    const like = `%${q}%`
    const e = S.entity.id
    const docs = await S.db.all(
      `SELECT d.*, y.name_en AS party_name_en, y.name_th AS party_name_th, y.name_km AS party_name_km
         FROM doc d JOIN party y ON y.id = d.party_id
        WHERE d.entity_id = ? AND (d.number LIKE ? OR d.subject_en LIKE ? OR y.name_en LIKE ?
          OR y.name_th LIKE ? OR COALESCE(y.name_km,'') LIKE ?)
        ORDER BY d.issue_date DESC LIMIT 8`, e, like, like, like, like, like)
    const parties = await S.db.all(
      `SELECT * FROM party WHERE entity_id = ?
         AND (name_en LIKE ? OR COALESCE(name_th,'') LIKE ? OR COALESCE(name_km,'') LIKE ?
           OR COALESCE(tax_id,'') LIKE ?) ORDER BY name_en LIMIT 6`, e, like, like, like, like)
    const refs = await S.db.all(
      `SELECT * FROM referral WHERE entity_id = ?
         AND (COALESCE(label,'') LIKE ? OR COALESCE(external_id,'') LIKE ?)
       ORDER BY sent_on DESC LIMIT 6`, e, like, like)
    const filings = await S.db.all(
      `SELECT f.*, o.code, o.name_en FROM filing f JOIN obligation o ON o.id = f.obligation_id
        WHERE f.entity_id = ? AND (o.code LIKE ? OR f.period LIKE ?)
        ORDER BY f.due_date DESC LIMIT 6`, e, like, like)
    const items = await S.db.all(
      `SELECT * FROM item WHERE entity_id = ? AND (sku LIKE ? OR name_en LIKE ?
         OR COALESCE(name_th,'') LIKE ?) LIMIT 6`, e, like, like, like)

    const section = (label, rows, render, onPick) => rows.length
      ? h('div', {},
        h('div', { class: 'dim', style: 'margin:12px 0 4px' }, label),
        h('table', {}, h('tbody', {}, rows.map((r) => h('tr', {
          class: 'click', onclick: () => { closeDialog(); onPick(r) },
        }, render(r))))))
      : null

    mount(out,
      section(t('nav.invoices'), docs, (d) => [
        h('td', {}, d.status === 'draft' ? t('status.draft') : d.number),
        h('td', {}, nameOf(d, 'party_name')),
        h('td', { class: 'num' }, money(d.gross, d.currency)),
      ], (d) => openDocView(d.id)),
      section(t('nav.contacts'), parties, (p_) => [
        h('td', {}, nameOf(p_)),
        h('td', { class: 'dim' }, p_.tax_id || ''),
      ], (p_) => openInvoiceForm(null, p_.id)),
      section(t('nav.referrals'), refs, (r) => [
        h('td', {}, r.label || r.external_id),
        h('td', { class: 'dim' }, r.status),
        h('td', { class: 'num' }, r.commission ? money(r.commission, r.currency) : ''),
      ], () => go('referrals')),
      section(t('nav.tax'), filings, (f) => [
        h('td', {}, `${f.code} ${f.period}`),
        h('td', { class: 'dim' }, f.due_date),
      ], () => go('tax')),
      section(t('nav.shelf'), items, (i) => [
        h('td', {}, i.sku),
        h('td', {}, nameOf(i)),
      ], () => go('shelf')),
      docs.length || parties.length || refs.length || filings.length || items.length
        ? null : h('div', { class: 'empty' }, t('search.empty')))
  }

  openDialog(t('search.open'), h('div', {}, field('', box), out),
    [btn(t('btn.close'), { primary: true, onclick: closeDialog })], { wide: true })
  box.focus()
}

/**
 * Cash across the counter. The change works itself out — whole notes in the
 * currency of the bill, the rest in the currency of change, landing on a note
 * that exists — and the few riel the rounding costs are named rather than
 * absorbed.
 */
export async function openCashForm(doc) {
  const entity = await S.db.get('SELECT * FROM entity WHERE id = ?', S.entity.id)
  const pack = await import('./lib/jurisdictions/index.mjs')
    .then((m) => m.jurisdictionFor(entity.country))
  const books = doc.currency || entity.currency
  const changeCcy = pack.CHANGE_CURRENCY || books
  const due = doc.gross - doc.paid - doc.wht_credited
  const out = h('div', { class: 'totals' })

  const readTendered = () => [
    { amount: parse(val('cash-primary'), books) ?? 0, currency: books },
    changeCcy === books ? null
      : { amount: parse(val('cash-second'), changeCcy) ?? 0, currency: changeCcy },
  ].filter(Boolean)

  const paint = async () => {
    try {
      const preview = await previewCash(S.db, {
        entity_id: S.entity.id, doc_id: doc.id, on_date: val('cash-date'),
        tendered: readTendered(),
      })
      mount(out,
        h('div', {}, h('span', {}, t('cash.due')), h('span', {}, format(due, books))),
        h('div', {}, h('span', {}, t('cash.tendered')),
          h('span', {}, format(preview.handed, books))),
        preview.enough
          ? h('div', { class: 'big' },
            h('span', {}, t('cash.change')),
            h('span', {}, preview.whole || preview.small
              ? [format(preview.whole, books), preview.small
                ? ` + ${format(preview.small, changeCcy)}` : ''].join('')
              : t('cash.exact')))
          : h('div', { class: 'big' },
            h('span', {}, t('cash.short', { amount: format(preview.short, books) })),
            h('span', {}, '')),
        preview.rounding
          ? h('div', { class: 'note' },
            h('span', {}, t('cash.rounding', { amount: format(preview.rounding, changeCcy) })),
            h('span', {}, ''))
          : null)
    } catch (err) {
      mount(out, h('div', { class: 'note' }, h('span', {}, err.message), h('span', {}, '')))
    }
  }

  const body = h('div', {},
    h('div', { class: 'row' },
      field(`${t('cash.tendered')} · ${books}`, input({
        id: 'cash-primary', inputmode: 'decimal', oninput: paint,
        value: format(due, books, { plain: true }),
      })),
      changeCcy === books ? null : field(`${t('cash.tendered')} · ${changeCcy}`, input({
        id: 'cash-second', inputmode: 'decimal', oninput: paint, value: '',
      })),
      field(t('form.date'), input({ id: 'cash-date', type: 'date', value: S.today }))),
    out,
    changeCcy === books ? null
      : h('div', { class: 'dim' }, t('cash.note', { ccy: changeCcy })))

  openDialog(`${t('cash.title')} · ${doc.number}`, body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('cash.take'), {
      primary: true,
      onclick: async () => {
        try {
          const done = await takeCash(S.db, {
            entity_id: S.entity.id,
            doc_id: doc.id,
            on_date: val('cash-date'),
            tendered: readTendered(),
          })
          closeDialog()
          result(t('cash.done', {
            due: format(done.due, books),
            change: done.whole || done.small
              ? `${format(done.whole, books)}${done.small ? ` + ${format(done.small, changeCcy)}` : ''}`
              : t('cash.exact'),
          }))
          refresh()
        } catch (err) {
          result(err.code === 'short'
            ? t('cash.short', { amount: format(err.detail.short, books) })
            : err.message)
        }
      },
    }),
  ], { wide: true })
  paint()
}

/** The same arithmetic as taking the cash, without posting anything. */
async function previewCash(db, { entity_id, doc_id, on_date, tendered }) {
  const entity = await db.get('SELECT * FROM entity WHERE id = ?', entity_id)
  const pack = await import('./lib/jurisdictions/index.mjs')
    .then((m) => m.jurisdictionFor(entity.country))
  const books = entity.currency || pack.CURRENCY
  const changeCcy = pack.CHANGE_CURRENCY || books
  const doc = await S.db.get('SELECT * FROM doc WHERE id = ?', doc_id)
  const due = doc.gross - doc.paid - doc.wht_credited
  let rate = null
  if (changeCcy !== books) {
    const found = await fxRateOn(db, books, changeCcy, on_date, { through: books })
    if (!found) throw new Error(t('cx.no_rate'))
    rate = found.rate_ppm
  }
  const handed = tenderedValue(tendered, { currency: books, rate_ppm: rate })
  return {
    ...changeFor({
      due, tendered: handed, currency: books, change_in: changeCcy, rate_ppm: rate,
      round_to: pack.CHANGE_ROUNDING || 1, round: 'up',
    }),
    handed,
    due,
  }
}

// ---- bringing the old books in ---------------------------------------------

/**
 * One box that takes whatever they already have.
 *
 * A person changing bookkeeping systems has a customer list, a page of unpaid
 * invoices and a bank statement, in Excel or in an export from the last system.
 * Asking them which importer to use is asking them to understand the program
 * first. So: drop the file in, and it says what it thinks it is holding and
 * exactly what it will do, before it does anything.
 */
export async function openBringForm() {
  const preview = h('div', {})
  const summary = h('div', { class: 'said' })
  // The kind is guessed from the file until somebody disagrees; after that
  // their choice stands, because they can see the file and this cannot.
  let state = { text: '', kind: null, plan: null, name: null, chosen: false }

  // A statement comes from a bank, so the bank accounts are offered first and
  // one of them is what a statement lands in unless somebody says otherwise.
  const accounts = await S.db.all(
    `SELECT code, name_en, name_th, name_km, bank_name, is_bank FROM account
      WHERE entity_id = ? AND subtype = 'cash' ORDER BY is_bank DESC, code`, S.entity.id)

  const KINDS = [
    ['contacts', t('bring.kind_contacts')],
    ['invoices', t('bring.kind_invoices')],
    ['bills', t('bring.kind_bills')],
    ['statement', t('bring.kind_statement')],
  ]

  // What a table is, read off its own headings: money in and out of an account
  // is a statement, an amount against a name is a list of invoices, and a list
  // of names with no amounts is a list of people.
  const kindOf = (columns) => {
    if (columns.balance || (columns.debit && columns.credit)) return 'statement'
    if ((columns.amount || columns.outstanding) && (columns.name || columns.number)) return 'invoices'
    if (columns.name || columns.tax_id || columns.email) return 'contacts'
    return columns.amount ? 'statement' : 'contacts'
  }

  async function planFor(kind) {
    const opts = { entity_id: S.entity.id, text: state.text }
    if (kind === 'contacts') return previewContacts(S.db, opts)
    if (kind === 'statement') {
      return previewStatement(S.db, { ...opts, account_code: val('br-account') || '1010' })
    }
    return previewOpenInvoices(S.db, { ...opts, direction: kind === 'bills' ? 'in' : 'out' })
  }

  async function reread() {
    if (!state.text.trim()) { mount(preview); mount(summary); return }
    const read = look(state.text)
    if (!read.rows.length) {
      mount(preview, h('div', { class: 'empty' }, t('bring.not_a_table')))
      return
    }
    state.kind = state.chosen ? val('br-kind') : kindOf(read.columns)
    const kindSelect = document.getElementById('br-kind')
    if (kindSelect) kindSelect.value = state.kind
    const acct = document.getElementById('br-account')
    if (acct) acct.parentElement.hidden = state.kind !== 'statement'
    state.plan = await planFor(state.kind)

    const rows = state.plan.plan
    const counts = rows.reduce((a, r) => {
      const key = r.action === 'skip' ? 'skip' : r.action
      a[key] = (a[key] || 0) + 1
      return a
    }, {})
    mount(summary,
      h('div', {}, t('bring.read', { rows: rows.length })),
      h('div', {}, Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(' · ')),
      state.kind === 'invoices' || state.kind === 'bills'
        ? h('div', {}, t('bring.carried')) : null)

    const show = rows.slice(0, 8)
    mount(preview, dataTable(show.map((r) => ({
      what: r.action === 'skip' ? t('bring.skip')
        : (r.action === 'update' ? t('bring.update') : t('bring.new')),
      one: describeRow(state.kind, r),
      why: r.why || '',
    })), [
      { label: t('bring.will'), render: (x) => x.what },
      { label: '', render: (x) => x.one },
      { label: '', render: (x) => x.why ? h('span', { class: 'dim' }, x.why) : '' },
    ]),
    rows.length > show.length
      ? h('div', { class: 'body dim' }, t('bring.rows_left', { n: rows.length - show.length }))
      : null)
  }

  const describeRow = (kind, r) => {
    if (kind === 'statement') {
      return `${whenShort(r.line.on_date) || '—'} · ${r.line.description || ''} · ${r.line.amount == null ? '' : money(r.line.amount)}`
    }
    if (kind === 'contacts') return r.party?.name_en || Object.values(r.row)[0] || ''
    return r.doc
      ? `${r.doc.number || ''} ${r.doc.party_name} · ${money(r.doc.amount)}`
      : Object.values(r.row).slice(0, 2).join(' · ')
  }

  const box = h('textarea', {
    id: 'br-text', rows: '5', placeholder: t('bring.paste'),
    style: 'width:100%; font-family: ui-monospace, monospace; font-size:12.5px',
    oninput: (e) => { state.text = e.target.value; reread() },
  })

  const file = h('input', {
    type: 'file', accept: '.csv,.tsv,.txt,text/plain,text/csv',
    onchange: async (e) => {
      const f = e.target.files?.[0]
      if (!f) return
      state.name = f.name
      state.text = await f.text()
      box.value = state.text.split('\n').slice(0, 40).join('\n')
      reread()
    },
  })

  const body = h('div', {},
    field(t('bring.file'), file),
    box,
    h('div', { class: 'row' },
      field(t('bring.kind'), select(KINDS, {
        id: 'br-kind',
        onchange: () => { state.chosen = true; state.kind = val('br-kind'); reread() },
      })),
      field(t('bring.account'), select(
        accounts.map((a) => [a.code, [nameOf(a), a.bank_name].filter(Boolean).join(' · ')]),
        { id: 'br-account', value: accounts[0]?.code, onchange: reread }))),
    summary,
    preview)

  openDialog(t('bring.title'), body, [
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('bring.apply'), {
      primary: true,
      onclick: async () => {
        if (!state.plan) return
        const opts = {
          entity_id: S.entity.id, text: state.text, source_name: state.name || 'a paste',
        }
        if (state.kind === 'contacts') {
          const out = await importContacts(S.db, opts)
          closeDialog()
          result(t('bring.done_contacts', out))
        } else if (state.kind === 'statement') {
          const out = await importStatement(S.db, { ...opts, account_code: val('br-account') || '1010' })
          closeDialog()
          result(t('bring.done_statement', out))
          go('banks')
        } else {
          const out = await importOpenInvoices(S.db, {
            ...opts, direction: state.kind === 'bills' ? 'in' : 'out',
          })
          closeDialog()
          result(t('bring.done_invoices', out), t('bring.carried'))
        }
        refresh()
      },
    }),
  ], { wide: true })

  // A file dropped on the dialog is the same as a file chosen, because that is
  // what people do with a file.
  const dialog = document.querySelector('dialog')
  dialog.addEventListener('dragover', (e) => e.preventDefault())
  dialog.addEventListener('drop', async (e) => {
    e.preventDefault()
    const f = e.dataTransfer?.files?.[0]
    if (!f) return
    state.name = f.name
    state.text = await f.text()
    box.value = state.text.split('\n').slice(0, 40).join('\n')
    reread()
  })
}

/** One statement line, and which invoice it probably is. */
export async function openStatementLine(line) {
  const ranked = await suggestFor(S.db, line)
  const body = h('div', {},
    h('div', { class: 'totals' },
      h('div', {}, h('span', {}, whenShort(line.on_date)), h('span', {}, money(line.amount))),
      line.description ? h('div', { class: 'note' }, h('span', {}, line.description), h('span', {})) : null),
    ranked.length
      ? dataTable(ranked.slice(0, 6), [
        { label: t('bank.suggest'),
          render: (r) => r.kind === 'filing'
            ? `${r.filing.code} · ${r.filing.period}`
            : `${r.doc.number} · ${r.doc.party_name_en}` },
        { label: t('col.amount'), num: true,
          render: (r) => money(r.kind === 'filing'
            ? (r.filing.amount ?? 0)
            : r.doc.gross - r.doc.paid - r.doc.wht_credited) },
        { label: '', render: (r) => h('span', { class: 'dim' }, r.why) },
        { label: '', render: (r) => btn(t('bank.apply'), {
          small: true,
          onclick: async () => {
            if (r.kind === 'filing') {
              await applyLineToFiling(S.db, line.id, r.filing.id)
              closeDialog()
              result(t('tax.paid_said', {
                form: r.filing.code, period: r.filing.period,
                amount: money(Math.abs(line.amount)),
              }))
            } else {
              await applyLine(S.db, line.id, r.doc.id)
              closeDialog()
              result(t('result.settled', { party: r.doc.party_name_en }))
            }
            refresh()
          },
        }) },
      ])
      : h('div', { class: 'empty' }, t('bank.no_guess')))

  openDialog(line.description || whenShort(line.on_date), body, [
    btn(t('bank.ignore'), {
      onclick: async () => {
        await ignoreLine(S.db, line.id)
        closeDialog()
        refresh()
      },
    }),
    btn(t('btn.close'), { primary: true, onclick: closeDialog }),
  ], { wide: true })
}
