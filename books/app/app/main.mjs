// main.mjs — the demo's screens.
//
// Every screen is a list of the things a business already thinks about —
// invoices, bills, people, the shelf, what the tax office wants — and every
// action shows what it did to the money in one line. The books underneath are
// the same modules the console runs; nothing here is a mock-up of a feature.

import { openBooks, wipe, inBatch, BUILD_COUNTRY } from './browser-db.mjs'
import { seedDemo, BRAND_DEFAULT } from './seed-demo.mjs'
import { seedKhmer, BRAND_KH } from './seed-kh.mjs'
import { h, mount, dataTable } from './dom.mjs'
import { pick } from './i18n/index.mjs'
import {
  S, t, p, setLocale, saveBrand, money, when, nameOf, addDays, isOverdue,
  head, panel, card, statusPill, result, setRenderer, go, refresh, BRAND_KEY,
  field, select, input, whenShort, localOf, localeNames, localePair, nextLocale,
  secondLocale, loadRates, btn, openDialog, closeDialog,
} from './shell.mjs'
import {
  openInvoiceForm, openBillForm, openPaymentForm, openContactForm, openPieceForm,
  openSellForm, openRepeatingForm, openPayrollForm, openFilingForm, openDocView,
  openPayslipView, openWaysIn, openInboxItem, openRateForm, openBandsForm,
  openObligationForm, downloadRecords, openReferralForm, openTermsForm,
  openBillMonthForm, openReconcileForm, openCompleteForm, openHowToPay,
  openPayerPage, openMethodForm, openSendByLine, openLineSimulator, openChatLink,
  queueDigest, financeDrawer, holdingsPanel, openWalletForm, openReceiveCrypto,
  openSpendCrypto, openRateEntry, openServiceRateForm, openBillClientForm,
  openTransferForm, openBankAccountForm, openFxRateForm, openSearch,
  openBringForm, openStatementLine, openPayFilingForm,
} from './forms.mjs'
import { trialBalance, profitAndLoss, byProject } from './modules/books.mjs'
import { openDocs } from './modules/documents.mjs'
import { setStatus, valuation, margin } from './modules/stock.mjs'
import { runBilling, cancel, recurringMonthly } from './modules/subscriptions.mjs'
import {
  generateFilings, dueBetween, markLate, owedToOffices, unpaidFilings,
} from './modules/compliance.mjs'
import { inbox, inboxCounts, dismiss, channelsFor, channelByAddress, receive } from './modules/intake.mjs'
import { ratesOn, changeLog, setEntityDetails } from './modules/policy.mjs'
import {
  agreements, pipeline, pipelineTotals, agreementOn, rateCard, billNetMonth,
} from './modules/referrals.mjs'
import {
  methodsFor, setDefaultMethod, claimsFor, settleInFull, docByPayToken, amountToAsk,
} from './modules/paying.mjs'
import { month as calendarMonth, dayDetail, seedYear, addHoliday } from './modules/calendar.mjs'
import { chatsFor, pending as outboxPending, markSent } from './modules/line.mjs'
import { balances, bankAccounts } from './modules/banks.mjs'
import {
  statementLines, suggestFor, settleWhatIsClear, batches as importBatches, undoContacts,
} from './modules/importing.mjs'
import { formatAsset } from './modules/crypto.mjs'
import { ratesInForce, fromPpm } from './lib/fx.mjs'
import { formatMonth } from './lib/be.mjs'
import {
  dashboard, cashPosition, whoOwesWhat, vatReport, whtReport, partnerStatement,
} from './modules/reports.mjs'
import { format } from './lib/money.mjs'

// ---- boot ------------------------------------------------------------------

async function boot() {
  // Which country this page is opened for. `?kh` is the Cambodian build: riel,
  // ten percent, the GDT calendar, and English beside Khmer. Everything else is
  // the same code.
  const build = BUILD_COUNTRY === 'KH'
    ? { brand: BRAND_KH, seed: seedKhmer, key: `${BRAND_KEY}.KH` }
    : { brand: BRAND_DEFAULT, seed: seedDemo, key: BRAND_KEY }
  S.brandKey = build.key
  try {
    S.brand = { ...build.brand, ...JSON.parse(localStorage.getItem(build.key) || '{}') }
  } catch { /* a corrupt brand is not worth stopping for */ }
  S.locale = localePair().includes(S.brand.locale) ? S.brand.locale : 'en'
  setLocale(S.locale)

  let { db, database } = await openBooks()
  S.db = db
  S.database = database          // the raw file, for taking a copy away
  const finished = await db.get("SELECT value FROM setting WHERE key = 'seeded'")
  S.entity = finished ? await db.get("SELECT * FROM entity WHERE code = 'demo'") : null
  if (!S.entity) {
    // The first run builds five sets of books; after that it opens from what
    // the browser saved.
    const note = document.getElementById('loading')
    if (note) {
      note.textContent = {
        th: 'กำลังสร้างข้อมูลตัวอย่าง…',
        km: 'កំពុងបង្កើតបញ្ជីគំរូ…',
      }[S.locale] || 'Building the sample books…'
    }
    // A page closed half way through leaves a database that looks complete and
    // is not, so the sample is built from scratch and only then marked done.
    // The rows that did arrive are still there and the same company cannot be
    // created twice, so a half-built sample is thrown away rather than added
    // to — otherwise the page never opens again and the button that would fix
    // it is on the screen that never renders.
    const half = await db.get('SELECT COUNT(*) AS n FROM entity')
    if (half?.n) {
      ;({ db, database } = await openBooks({ fresh: true }))
      S.db = db
      S.database = database
    }
    await db.exec("DELETE FROM setting WHERE key = 'seeded'")
    S.entity = await inBatch(database, () => build.seed(db, S.brand))
    await db.run(
      "INSERT INTO setting(key, value) VALUES ('seeded', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      BUILD_COUNTRY)
  }
  const remembered = localStorage.getItem('erp.demo.entity')
  if (remembered) {
    const row = await db.get("SELECT * FROM entity WHERE id = ? AND status = 'active'", remembered)
    if (row) S.entity = row
  }
  paintBrand()

  // A client who opens the link sees ONE screen: what they paid for, who they
  // paid, how much, a photo. No books, no login, nothing to learn.
  const params = new URLSearchParams(location.search)
  const token = params.get('in')
  if (token) {
    const channel = await channelByAddress(db, token)
    if (channel) return clientPage(channel)
  }
  // A payer who opens a payment link sees the amount, the QR, and a way to say
  // they have paid. Nothing else.
  const payToken = params.get('pay')
  if (payToken) {
    const doc = await docByPayToken(db, payToken)
    if (doc) {
      S.entity = await db.get('SELECT * FROM entity WHERE id = ?', doc.entity_id)
      document.querySelector('.side')?.remove()
      document.getElementById('app').style.gridTemplateColumns = '1fr'
      return openPayerPage(doc)
    }
  }

  await paintSwitcher()
  wireChrome()
  await go('today')
}

function paintBrand() {
  document.documentElement.style.setProperty('--accent', S.brand.accent)
  document.getElementById('brand-mark').textContent = S.brand.mark
  const own = !S.entity || S.entity.code === 'demo'
  document.getElementById('brand-name').textContent = own
    ? (pick(S.brand, 'name', S.locale) || S.brand.name_en)
    : nameOf(S.entity)
  document.getElementById('brand-sub').textContent = own ? S.brand.city : t('books.client')
  document.getElementById('sample-label').textContent = t('chip.sample')
  document.getElementById('reset').textContent = t('chip.reset')
  document.getElementById('lang').textContent = localeNames[nextLocale()]
  document.title = S.brand.name_en
}

/** The client's side of the link — deliberately the whole of what they get. */
async function clientPage(channel) {
  const entity = await S.db.get('SELECT * FROM entity WHERE id = ?', channel.entity_id)
  S.entity = entity
  document.querySelector('.side')?.remove()
  document.getElementById('app').style.gridTemplateColumns = '1fr'
  const main = document.getElementById('main')
  let photoName = null
  let sent = 0

  const form = () => h('div', {},
    field(t('inbox.what'), input({ id: 'c-what', placeholder: t('inbox.what') })),
    h('div', { class: 'row' },
      field(t('inbox.who'), input({ id: 'c-who' })),
      field(t('inbox.how_much'), input({ id: 'c-amount', inputmode: 'decimal' }))),
    field(t('inbox.photo_add'), input({
      id: 'c-photo', type: 'file', accept: 'image/*', capture: 'environment',
      onchange: (e) => { photoName = e.target.files?.[0]?.name ?? null },
    })),
    h('button', {
      class: 'btn primary', style: 'width:100%; min-height:46px',
      onclick: async () => {
        const what = document.getElementById('c-what').value.trim()
        if (!what) return
        const amountRaw = document.getElementById('c-amount').value
        await receive(S.db, {
          entity_id: entity.id,
          channel_id: channel.id,
          source: channel.kind,
          from_ref: t('books.client'),
          on_date: S.today,
          kind: 'bill',
          description: what,
          amount: parseAmount(amountRaw),
          party_hint: document.getElementById('c-who').value.trim(),
          photo_name: photoName,
        })
        sent++
        photoName = null
        paint()
        result(t('inbox.sent'))
      },
    }, t('inbox.send')))

  const paint = () => mount(main,
    head(nameOf(entity)),
    panel(t('inbox.client_send'), h('div', { class: 'body' }, form())),
    sent ? panel(null, h('div', { class: 'empty' },
      t('inbox.sent'), ' ', `× ${sent}`)) : null)

  paint()
}

const parseAmount = (raw) => {
  const s = String(raw || '').replace(/[฿,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'))
}

const VIEWS = [
  ['today', 'nav.today'],
  ['inbox', 'nav.inbox'],
  ['clients', 'nav.clients'],
  ['invoices', 'nav.invoices'],
  ['bills', 'nav.bills'],
  ['contacts', 'nav.contacts'],
  ['shelf', 'nav.shelf'],
  ['repeating', 'nav.repeating'],
  ['referrals', 'nav.referrals'],
  ['calendar', 'nav.calendar'],
  ['banks', 'nav.banks'],
  ['payroll', 'nav.payroll'],
  ['tax', 'nav.tax'],
  ['reports', 'nav.reports'],
  ['rules', 'nav.rules'],
  ['setup', 'nav.setup'],
]

async function paintNav() {
  const counts = await badgeCounts()
  mount(document.getElementById('nav'), VIEWS.map(([key, label]) =>
    h('button', {
      'aria-current': S.view === key ? 'true' : null,
      onclick: () => go(key),
    }, t(label), counts[key]
      ? h('span', { class: `tag${counts[key].quiet ? ' quiet' : ''}` }, counts[key].n)
      : null)))
}

async function badgeCounts() {
  const db = S.db
  const unpaid = await db.get(
    `SELECT COUNT(*) AS n FROM doc WHERE entity_id = ? AND direction = 'out'
       AND status IN ('issued','part_paid')`, S.entity.id)
  const billsDue = await db.get(
    `SELECT COUNT(*) AS n FROM doc WHERE entity_id = ? AND direction = 'in'
       AND status IN ('issued','part_paid')`, S.entity.id)
  const filings = await db.get(
    `SELECT COUNT(*) AS n FROM filing WHERE entity_id = ? AND status IN ('due','late')
       AND due_date <= ?`, S.entity.id, addDays(S.today, 30))
  const waiting = await db.get(
    "SELECT COUNT(*) AS n FROM inbox_item WHERE entity_id = ? AND status = 'new'", S.entity.id)
  const allWaiting = await db.get(
    "SELECT COUNT(*) AS n FROM inbox_item WHERE status = 'new'")
  return {
    inbox: waiting.n ? { n: waiting.n } : null,
    clients: allWaiting.n - waiting.n ? { n: allWaiting.n - waiting.n, quiet: true } : null,
    invoices: unpaid.n ? { n: unpaid.n, quiet: true } : null,
    bills: billsDue.n ? { n: billsDue.n, quiet: true } : null,
    tax: filings.n ? { n: filings.n } : null,
  }
}

/** Which set of books is open. Her own are first; the clients follow. */
async function paintSwitcher() {
  const rows = await S.db.all("SELECT * FROM entity WHERE status = 'active' ORDER BY code = 'demo' DESC, name_en")
  const pick = document.getElementById('entity-pick')
  mount(pick,
    // One switcher answers "whose books" and "all of them at once", because it
    // is the same question asked at two sizes.
    h('option', { value: 'all', selected: S.view === 'group' }, t('group.all')),
    rows.map((e) => h('option', {
      value: e.id, selected: S.view !== 'group' && e.id === S.entity.id,
    }, `${nameOf(e)}${e.code === 'demo' ? ` — ${t('books.mine')}` : ''}`)))
  pick.onchange = async () => {
    if (pick.value === 'all') { await go('group'); return }
    S.entity = await S.db.get('SELECT * FROM entity WHERE id = ?', pick.value)
    localStorage.setItem('erp.demo.entity', S.entity.id)
    await loadRates()
    paintBrand()
    await go(S.view === 'clients' || S.view === 'group' ? 'today' : S.view)
  }
}

function wireChrome() {
  const country = document.getElementById('country-pick')
  if (country) {
    country.value = BUILD_COUNTRY
    country.onchange = () => {
      location.href = location.pathname + (country.value === 'KH' ? '?kh=1' : '')
    }
  }
  document.getElementById('lang').onclick = async () => {
    setLocale(nextLocale())
    S.brand.locale = S.locale
    saveBrand()
    paintBrand()
    await paintSwitcher()
    await go(S.view)
  }
  const search = document.getElementById('search-open')
  if (search) search.onclick = () => openSearch()
  // A keyboard is a nice-to-have on a phone and the fastest thing there is on a
  // desk: `/` opens search from anywhere that is not a field.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey) return
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    e.preventDefault()
    openSearch()
  })
  document.getElementById('reset').onclick = async () => {
    if (!confirm(t('chip.reset_confirm'))) return
    wipe()
    location.reload()
  }
}

async function render(view) {
  await paintNav()
  const main = document.getElementById('main')
  const build = {
    today: viewToday, inbox: viewInbox, clients: viewClients, invoices: viewInvoices,
    bills: viewBills, contacts: viewContacts, shelf: viewShelf, repeating: viewRepeating,
    referrals: viewReferrals, calendar: viewCalendar, banks: viewBanks,
    group: viewGroup, payroll: viewPayroll, tax: viewTax,
    reports: viewReports, rules: viewRules,
    setup: viewSetup,
  }[view]
  mount(main, await build())
  window.scrollTo(0, 0)
}

/** A project's name in the reader's language — and a name for the lines that
 *  belong to no project, which is where overheads land. */
const projectName = (row) =>
  row.project_code === '(none)'
    ? t('col.unassigned')
    : (localOf(row, 'project_name') || row.project_name_en)

// ---- where the money is ----------------------------------------------------

async function viewBanks() {
  const db = S.db
  const b = await balances(db, S.entity.id, { asOf: S.today })
  const rates = await ratesInForce(db, S.today)
  const currencies = Object.entries(b.byCurrency)
  const coins = Object.entries(b.byCoin || {})

  return [
    head(t('banks.title'),
      h('button', { class: 'btn primary', onclick: () => openTransferForm() }, t('banks.transfer')),
      h('button', { class: 'btn', onclick: () => openBankAccountForm(null) }, t('banks.add')),
      h('button', { class: 'btn', onclick: () => openBringForm() }, t('bring.open'))),
    h('div', { class: 'cards' },
      // Each currency on its own card: two currencies are two facts, not one
      // number with an average in it.
      ...currencies.map(([ccy, own]) => card(ccy, format(own, ccy), null)),
      ...coins.map(([asset, units]) => card(asset, formatAsset(units, asset, { withSymbol: false }),
        t('cx.cost'))),
      card(t('banks.total'), money(b.money, b.into),
        b.unpriced ? t('banks.rate_missing') : t('banks.worth', { ccy: b.into }))),
    panel(null, dataTable(b.rows, [
      { label: t('col.account'), render: (r) => h('span', {},
        h('span', { class: 'strong' }, nameOf(r.account)),
        r.account.bank_name || r.account.account_no
          ? h('div', { class: 'dim' },
            [r.account.bank_name, r.account.account_no].filter(Boolean).join(' · '))
          : null) },
      { label: t('col.currency'), render: (r) => r.currency },
      { label: t('banks.own'), num: true,
        render: (r) => (r.coin ? formatAsset(r.own, r.currency) : format(r.own, r.currency)) },
      { label: t('banks.worth', { ccy: b.into }), num: true, phone: false,
        render: (r) => r.value == null
          ? h('span', { class: 'pill warn' }, t('banks.rate_missing'))
          : h('span', {}, money(r.value, b.into),
            r.coin ? h('div', { class: 'dim' }, t('cx.cost')) : null) },
      { label: t('cx.rate_on'), phone: false,
        render: (r) => r.rate_on ? whenShort(r.rate_on) : (r.rate ? '—' : '') },
    ], { onRow: (r) => openBankAccountForm(r.account) })),
    panel(t('banks.rates'), h('div', {},
      rates.length
        ? dataTable(rates, [
          { label: t('cx.asset'), render: (r) => `${r.asset} → ${r.quote}` },
          { label: t('cx.rate'), num: true,
            render: (r) => fromPpm(r.rate_ppm).toLocaleString('en-US', { maximumFractionDigits: 6 }) },
          { label: t('cx.rate_on'), render: (r) => whenShort(r.on_date) },
          { label: t('rules.source'), phone: false, render: (r) => r.source || '—' },
        ])
        : h('div', { class: 'empty' }, t('banks.rate_missing')),
      h('div', { class: 'body' },
        h('button', { class: 'btn', onclick: () => openFxRateForm() }, t('banks.rate_add')),
        h('p', { class: 'dim' }, t('banks.no_rate_note'))))),
    await statementPanel(),
  ]
}

/**
 * What the bank says happened, beside what the books say is owed.
 *
 * A line is not a payment until somebody — or an amount carrying its own satang
 * tail — says which invoice it is. The certain ones can be done in one press;
 * the rest stay here, which is the only honest place for them.
 */
async function statementPanel() {
  const lines = await statementLines(S.db, S.entity.id, { status: 'new' })
  if (!lines.length) return null
  const guesses = new Map()
  for (const line of lines.slice(0, 40)) guesses.set(line.id, await suggestFor(S.db, line))
  return panel(t('bank.lines'), h('div', {},
    dataTable(lines, [
      { label: t('col.date'), render: (r) => whenShort(r.on_date) },
      { label: t('form.description'), render: (r) => r.description || '—' },
      { label: t('col.amount'), num: true, render: (r) => money(r.amount, r.currency) },
      { label: t('bank.suggest'), render: (r) => {
        const top = (guesses.get(r.id) || [])[0]
        if (!top) return h('span', { class: 'dim' }, t('bank.no_guess'))
        // A line can belong to an invoice or to a return that has been filed:
        // the transfer to the Revenue Department is a payment like any other.
        const name = top.kind === 'filing'
          ? `${top.filing.code} · ${top.filing.period}`
          : `${top.doc.number} · ${top.doc.party_name_en}`
        return h('span', {}, name, h('div', { class: 'dim' }, top.why))
      } },
    ], { onRow: (r) => openStatementLine(r) }),
    h('div', { class: 'body' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const run = await settleWhatIsClear(S.db, S.entity.id)
          result(t('bank.matched', { n: run.settled.length, left: run.waiting.length }))
          refresh()
        },
      }, t('bank.match_clear')))))
}

// ---- every set of books at once --------------------------------------------

async function viewGroup() {
  const db = S.db
  const entities = await db.all("SELECT * FROM entity WHERE status = 'active' ORDER BY code = 'demo' DESC, name_en")
  const into = S.groupCurrency || S.brand.currency || 'THB'
  const rows = []
  for (const e of entities) {
    const b = await balances(db, e.id, { asOf: S.today, to: into })
    const owed = await whoOwesWhat(db, e.id, { asOf: S.today })
    const pl = await profitAndLoss(db, e.id, {
      from: `${S.today.slice(0, 7)}-01`, to: S.today,
    })
    const due = await db.get(
      `SELECT COUNT(*) AS n FROM filing WHERE entity_id = ? AND status IN ('due','late')
         AND due_date <= ?`, e.id, addDays(S.today, 30))
    rows.push({
      entity: e,
      name: nameOf(e),
      currency: e.currency,
      cash: b.byCurrency[e.currency] ?? 0,
      cashIn: b.total,
      owed: owed.receivableTotal,
      owing: owed.payableTotal,
      result: pl.result,
      due: due.n,
      unpriced: b.unpriced,
    })
  }
  const totals = rows.reduce((a, r) => ({ cashIn: a.cashIn + r.cashIn }), { cashIn: 0 })

  return [
    head(t('group.title'),
      h('span', { class: 'chip' }, `${t('group.in')} ${into}`)),
    h('div', { class: 'cards' },
      card(t('group.cash'), money(totals.cashIn, into), t('group.in') + ' ' + into),
      card(t('group.entity'), String(rows.length)),
      card(t('group.due'), String(rows.reduce((a, r) => a + r.due, 0)))),
    panel(null, dataTable(rows, [
      { label: t('group.entity'), render: (r) => h('span', {},
        h('span', { class: 'strong' }, r.name),
        h('div', { class: 'dim' }, `${r.entity.country || 'TH'} · ${r.currency}`)) },
      { label: t('group.cash'), num: true, render: (r) => format(r.cash, r.currency) },
      { label: t('banks.worth', { ccy: into }), num: true, phone: false,
        render: (r) => r.unpriced ? h('span', { class: 'pill warn' }, t('banks.rate_missing')) : money(r.cashIn, into) },
      { label: t('group.owed'), num: true, phone: false, render: (r) => format(r.owed, r.currency) },
      { label: t('group.owing'), num: true, phone: false, render: (r) => format(r.owing, r.currency) },
      { label: t('group.month'), num: true, render: (r) => format(r.result, r.currency) },
      { label: t('group.due'), num: true,
        render: (r) => r.due ? h('span', { class: 'pill warn' }, r.due) : '—' },
    ], {
      onRow: async (r) => {
        S.entity = r.entity
        localStorage.setItem('erp.demo.entity', r.entity.id)
        paintBrand()
        await paintSwitcher()
        await go('today')
      },
    })),
    h('p', { class: 'dim', style: 'margin: 12px 2px' }, t('group.note')),
  ]
}

// ---- the inbox -------------------------------------------------------------

async function viewInbox() {
  const items = await inbox(S.db, S.entity.id, { status: 'new' })
  const channels = await channelsFor(S.db, S.entity.id)
  return [
    head(t('inbox.title'),
      h('button', { class: 'btn', onclick: () => openWaysIn(channels) }, t('inbox.ways_in'))),
    panel(null, items.length
      ? h('table', {}, h('tbody', {}, items.map((i) => h('tr', {},
        h('td', {},
          h('div', { class: 'strong' }, i.description || '—'),
          h('div', { class: 'dim' },
            `${t('inbox.from')} ${i.from_ref || '—'} · ${whenShort(i.on_date || i.received_at.slice(0, 10))}`,
            i.photo_name ? ` · ${t('inbox.photo')}` : '',
            i.slip_ref ? ` · ${i.slip_ref}` : '')),
        h('td', { class: 'num' }, i.amount ? money(i.amount, i.currency) : '—'),
        h('td', {},
          h('div', { class: 'dim' }, t('inbox.guess')),
          h('div', {}, i.party_name_en || i.party_hint || t('inbox.no_guess'),
            i.account_hint ? h('span', { class: 'dim' }, ` · ${i.account_hint}`) : null)),
        h('td', { class: 'num' },
          h('button', {
            class: 'btn small primary',
            onclick: (e) => { e.stopPropagation(); openInboxItem(i) },
          }, t('inbox.make_bill')),
          ' ',
          h('button', {
            class: 'btn small',
            onclick: async (e) => {
              e.stopPropagation()
              await dismiss(S.db, i.id, { why: 'not ours' })
              result(t('result.saved'))
              refresh()
            },
          }, t('inbox.not_ours')))))))
      : h('div', { class: 'empty' }, t('inbox.empty'))),
  ]
}

// ---- the practice ----------------------------------------------------------

async function viewClients() {
  const db = S.db
  const rows = await db.all("SELECT * FROM entity WHERE status = 'active' ORDER BY code = 'demo' DESC, name_en")
  const waiting = Object.fromEntries((await inboxCounts(db)).map((r) => [r.entity_id, r.n]))
  const out = []
  for (const e of rows) {
    await markLate(db, e.id, S.today)
    const next = (await dueBetween(db, e.id, { from: '2000-01-01', to: addDays(S.today, 60) }))[0]
    const late = await db.get(
      "SELECT COUNT(*) AS n FROM filing WHERE entity_id = ? AND status = 'late'", e.id)
    const owed = await db.get(
      `SELECT COALESCE(SUM(gross - paid - wht_credited),0) AS n FROM doc
        WHERE entity_id = ? AND direction = 'out' AND status IN ('issued','part_paid')
          AND kind <> 'quote'`, e.id)
    const owing = await db.get(
      `SELECT COALESCE(SUM(gross - paid - wht_credited),0) AS n FROM doc
        WHERE entity_id = ? AND direction = 'in' AND status IN ('issued','part_paid')`, e.id)
    const last = await db.get(
      'SELECT MAX(on_date) AS d FROM journal WHERE entity_id = ?', e.id)
    out.push({
      e,
      name: nameOf(e),
      own: e.code === 'demo',
      vat: e.vat_registered ? t('clients.vat') : t('clients.no_vat'),
      waiting: waiting[e.id] || 0,
      next: next ? `${next.code} ${next.period}` : '—',
      next_due: next ? whenShort(next.due_date) : '',
      late: late.n,
      owed: owed.n,
      owing: owing.n,
      last: last?.d ? whenShort(last.d) : '—',
    })
  }
  return [
    head(t('nav.clients')),
    panel(null, dataTable(out, [
      { label: t('col.name'), render: (r) => h('span', {},
        h('span', { class: 'strong' }, r.name),
        r.own ? h('span', { class: 'dim' }, ` · ${t('books.mine')}`) : null) },
      { label: t('clients.vat'), phone: false, render: (r) => r.vat },
      { label: t('clients.waiting'), num: true,
        render: (r) => r.waiting ? h('span', { class: 'pill warn' }, r.waiting) : '—' },
      { label: t('clients.next_filing'), render: (r) => h('span', {},
        r.next, r.next_due ? h('div', { class: 'dim' }, r.next_due) : null,
        r.late ? h('div', { class: 'pill bad' }, `${r.late} ${t('clients.late')}`) : null) },
      { label: t('clients.owed'), num: true, phone: false, render: (r) => money(r.owed) },
      { label: t('clients.owing'), num: true, phone: false, render: (r) => money(r.owing) },
      { label: t('clients.last_entry'), phone: false, render: (r) => r.last },
    ], {
      onRow: async (r) => {
        S.entity = r.e
        localStorage.setItem('erp.demo.entity', r.e.id)
        await loadRates()
        paintBrand()
        await paintSwitcher()
        await go('today')
      },
    })),
  ]
}

// ---- rates and rules -------------------------------------------------------

const RATE_LABELS = {
  'vat:standard': 'VAT',
  'vat:registration_threshold': 'VAT registration threshold',
  'wht:service': 'Withholding — services',
  'wht:professional': 'Withholding — professional fees',
  'wht:rent': 'Withholding — rent',
  'wht:advertising': 'Withholding — advertising',
  'wht:transport': 'Withholding — transport',
  'sso:employee_bp': 'Social security — employee',
  'sso:employer_bp': 'Social security — employer',
  'sso:wage_floor': 'Social security — wage floor',
  'sso:wage_cap': 'Social security — wage ceiling',
  'pit:expense_bp': 'Employment expense deduction',
  'pit:expense_cap': 'Expense deduction cap',
  'pit:personal_allowance': 'Personal allowance',
  'pit:spouse_allowance': 'Spouse allowance',
  'pit:child_allowance': 'Child allowance',
  'pit:sso_deduction_cap': 'Social security deduction cap',
}

const rateValue = (r) =>
  r.value_bp != null ? `${(r.value_bp / 100).toFixed(r.value_bp % 100 ? 2 : 0)}%` : money(r.value_satang)

async function viewRules() {
  const db = S.db
  const rates = (await ratesOn(db, S.today)).filter((r) => r.scope !== 'pit_band')
  const bands = await ratesOn(db, S.today, { scope: 'pit_band' })
  const obligations = await db.all(
    `SELECT * FROM obligation WHERE entity_id = ? AND (active_to IS NULL OR active_to >= ?)
      ORDER BY code`, S.entity.id, S.today)
  const log = await changeLog(db, { limit: 12 })

  return [
    head(t('nav.rules')),
    panel(t('rules.rates'), dataTable(rates, [
      { label: t('rules.what'),
        render: (r) => h('span', {},
          RATE_LABELS[`${r.scope}:${r.code}`] || `${r.scope} · ${r.code}`,
          // A figure nobody has checked says so where it is read, not in a
          // footnote: these packs ship a shape, and the number is local advice.
          r.unconfirmed
            ? h('span', { class: 'tag quiet', title: t('rules.unconfirmed_why', { place: r.jur }) },
              ` ${t('rules.unconfirmed')}`)
            : null) },
      { label: t('rules.value'), num: true, render: rateValue },
      { label: t('rules.from'), render: (r) => whenShort(r.from_date) },
      { label: t('rules.source'), phone: false, render: (r) => r.source || '—' },
      { label: '', render: (r) => h('button', {
        class: 'btn small', onclick: (e) => { e.stopPropagation(); openRateForm(r, RATE_LABELS[`${r.scope}:${r.code}`]) },
      }, t('rules.change')) },
    ])),
    panel(t('rules.bands'), h('div', {},
      dataTable(bands.map((b, i) => ({
        n: String(i + 1),
        upTo: b.value_satang == null ? '—' : money(b.value_satang),
        rate: `${(b.value_bp / 100).toFixed(0)}%`,
      })), [
        { label: '', key: 'n' },
        { label: t('rules.value'), num: true, key: 'upTo' },
        { label: '%', num: true, key: 'rate' },
      ]),
      h('div', { class: 'body' },
        h('button', { class: 'btn', onclick: () => openBandsForm(bands) }, t('rules.change')))),
      whenShort(bands[0]?.from_date)),
    panel(t('rules.filings'), dataTable(obligations, [
      { label: t('col.form'), key: 'code' },
      { label: t('col.name'), phone: false,
        render: (r) => nameOf(r) },
      { label: t('rules.due_rule'), render: (r) => r.due_rule },
      { label: t('rules.efile'), num: true, render: (r) => `${r.efile_bonus_days} ${t('rules.days')}` },
      { label: t('rules.applies'), phone: false, render: (r) => r.applies_when || '—' },
      { label: '', render: (r) => h('button', {
        class: 'btn small', onclick: (e) => { e.stopPropagation(); openObligationForm(r) },
      }, t('rules.change')) },
    ])),
    panel(t('rules.log'), dataTable(log, [
      { label: t('rules.when'), render: (r) => whenShort(r.at.slice(0, 10)) },
      { label: t('rules.what'), render: (r) => `${r.action} · ${r.object_id}` },
      { label: t('rules.was'), phone: false, render: (r) => describeSide(r.detail?.was) },
      { label: t('rules.now'), render: (r) => describeSide(r.detail?.now) },
      { label: t('rules.from'), phone: false,
        render: (r) => r.detail?.from_date ? whenShort(r.detail.from_date) : '—' },
    ], { empty: t('report.nothing') })),
  ]
}

function describeSide(side) {
  if (side == null) return '—'
  if (typeof side !== 'object') return String(side)
  if (Array.isArray(side)) return `${side.length} bands`
  if (side.value_bp != null) return `${(side.value_bp / 100).toFixed(2)}%`
  if (side.value_satang != null) return money(side.value_satang)
  return Object.entries(side).filter(([, v]) => v != null)
    .map(([k, v]) => `${k}: ${typeof v === 'number' && k.includes('rate') ? money(v) : v}`).join(', ') || '—'
}

// ---- work sent on, and the share of it ------------------------------------

const REF_STATUS = ['sent', 'accepted', 'completed', 'billed', 'paid', 'declined']

async function viewReferrals() {
  const db = S.db
  const rows = await pipeline(db, S.entity.id)
  const totals = await pipelineTotals(db, S.entity.id)
  const terms = await agreements(db, S.entity.id)
  const live = terms.filter((a) => !a.to_date || a.to_date >= S.today)

  const termsLine = (a) => {
    if (a.basis === 'margin') return t('ref.basis.margin')
    if (a.basis === 'fixed_per_case') {
      return `${money(a.fixed_amount ?? 0, a.currency)} ${t('ref.per_case')}`
    }
    if (a.basis === 'tiered') return t('ref.basis.tiered')
    return `${((a.rate_bp ?? 0) / 100).toFixed(a.rate_bp % 100 ? 2 : 0)}% ${t('ref.of_fee')}`
  }

  return [
    head(t('nav.referrals'),
      h('button', { class: 'btn primary', onclick: () => openReferralForm(live) }, t('ref.new')),
      live.some((a) => a.basis !== 'margin')
        ? h('button', {
          class: 'btn', onclick: () => openBillMonthForm(live.filter((a) => a.basis !== 'margin')),
        }, t('ref.bill_month'))
        : null,
      live.some((a) => a.basis === 'margin')
        ? h('button', {
          class: 'btn',
          onclick: async () => {
            const margin = live.find((a) => a.basis === 'margin')
            const period = S.today.slice(0, 7)
            const { doc, cases } = await billNetMonth(S.db, {
              entity_id: S.entity.id, agreement_id: margin.id, period,
              vat: Boolean(S.entity.vat_registered),
            })
            if (!doc) { result(t('ref.none_due')); return }
            result(t('result.bill_added', {
              number: doc.number, party: nameOf(margin, 'party_name'),
              amount: money(doc.gross), due: when(doc.due_date),
            }))
            refresh()
          },
        }, t('ref.bill_net'))
        : null,
      live.length
        ? h('button', { class: 'btn', onclick: () => openReconcileForm() }, t('ref.reconcile'))
        : null),
    h('div', { class: 'cards' },
      card(t('ref.earned'), money(totals.earned),
        `${totals.by.completed?.n ?? 0} ${t('ref.completed').toLowerCase()}`),
      card(t('ref.outstanding'), money(totals.billed),
        `${totals.by.billed?.n ?? 0}`),
      card(t('ref.this_year'), money(totals.paid), `${totals.by.paid?.n ?? 0}`),
      card(t('ref.sent'), String((totals.by.sent?.n ?? 0) + (totals.by.accepted?.n ?? 0)))),
    live.some((a) => a.basis === 'margin')
      ? panel(t('ref.card'), await rateCardPanel(live.filter((a) => a.basis === 'margin')))
      : null,
    panel(t('ref.terms'),
      live.length
        ? dataTable(live, [
          { label: t('ref.code'), key: 'code' },
          { label: t('ref.who_pays'), render: (a) => nameOf(a, 'party_name') },
          { label: t('ref.rate'), render: termsLine },
          { label: t('rules.from'), render: (a) => whenShort(a.from_date) },
          { label: p('doc.wht', { pct: 3 }), phone: false,
            render: (a) => `${(a.wht_bp / 100).toFixed(0)}%` },
          { label: t('rules.source'), phone: false, render: (a) => a.source || '—' },
          { label: '', render: (a) => h('button', {
            class: 'btn small', onclick: (e) => { e.stopPropagation(); openTermsForm(a) },
          }, t('rules.change')) },
        ])
        : h('div', { class: 'body' },
          h('p', { class: 'dim', style: 'margin-top:0' }, t('ref.no_terms')),
          h('button', { class: 'btn primary', onclick: () => openTermsForm(null) }, t('ref.set_terms')))),
    panel(null, dataTable(rows, [
      { label: t('ref.date'), render: (r) => whenShort(r.sent_on) },
      { label: t('ref.label'), render: (r) => h('span', {},
        h('span', { class: 'strong' }, r.label || r.service || '—'),
        r.external_id ? h('div', { class: 'dim' }, r.external_id) : null) },
      { label: t('ref.case_fee'), num: true, phone: false,
        render: (r) => r.case_fee ? money(r.case_fee, r.currency) : '—' },
      { label: t('ref.commission'), num: true,
        render: (r) => r.commission ? money(r.commission, r.currency) : '—' },
      { label: t('col.status'), render: (r) => h('span', {
        class: `pill${['paid'].includes(r.status) ? ' good' : r.status === 'completed' ? ' warn' : r.status === 'declined' ? ' bad' : ''}`,
      }, t(`ref.${r.status}`)) },
      { label: t('ref.client'), phone: false,
        render: (r) => r.client_doc_id
          ? h('button', {
            class: 'btn small', onclick: (e) => { e.stopPropagation(); openDocView(r.client_doc_id) },
          }, t('btn.open'))
          : (r.status === 'completed' && r.client_party_id
            ? h('button', {
              class: 'btn small', onclick: (e) => { e.stopPropagation(); openBillClientForm(r) },
            }, t('ref.bill_client'))
            : '—') },
      { label: '', render: (r) => ['sent', 'accepted'].includes(r.status)
        ? h('button', {
          class: 'btn small', onclick: (e) => { e.stopPropagation(); openCompleteForm(r) },
        }, t('ref.mark_done'))
        : r.doc_id
          ? h('button', {
            class: 'btn small', onclick: (e) => { e.stopPropagation(); openDocView(r.doc_id) },
          }, t('btn.open'))
          : '' },
    ], { empty: t('ref.empty') })),
  ]
}

/** What each service costs and what it is quoted at — the whole arrangement in
 *  three columns. */
async function rateCardPanel(marginAgreements) {
  const rows = []
  for (const a of marginAgreements) {
    for (const r of await rateCard(S.db, a.id, S.today)) {
      rows.push({ ...r, agreement: a })
    }
  }
  return h('div', {},
    rows.length
      ? dataTable(rows, [
        { label: t('ref.service'), render: (r) => nameOf(r) },
        { label: t('ref.net'), num: true, render: (r) => money(r.net_price, r.currency) },
        { label: t('ref.retail'), num: true,
          render: (r) => r.retail_price ? money(r.retail_price, r.currency) : '—' },
        { label: t('ref.margin'), num: true,
          render: (r) => r.retail_price
            ? h('span', { class: 'strong' }, money(r.retail_price - r.net_price, r.currency))
            : '—' },
        { label: t('rules.from'), phone: false, render: (r) => whenShort(r.from_date) },
        { label: t('rules.source'), phone: false, render: (r) => r.source || '—' },
        { label: '', render: (r) => h('button', {
          class: 'btn small',
          onclick: (e) => { e.stopPropagation(); openServiceRateForm(r.agreement, r) },
        }, t('rules.change')) },
      ])
      : h('div', { class: 'empty' }, t('report.nothing')),
    h('div', { class: 'body' },
      h('button', {
        class: 'btn',
        onclick: () => openServiceRateForm(marginAgreements[0], null),
      }, t('ref.add_service'))))
}

// ---- the month -------------------------------------------------------------

const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_TH = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']
const DOW_KM = ['អា', 'ច', 'អ', 'ព', 'ព្រ', 'សុ', 'ស']
const DOW_LOCAL = { th: DOW_TH, km: DOW_KM }

const ITEM_TONE = {
  filing: 'warn', filing_online: '', receivable: 'good', payable: 'bad',
  billing: '', payroll: '', referral_done: 'good', referral_sent: '',
}

let calendarYm = null

async function viewCalendar() {
  const db = S.db
  const ym = calendarYm || S.today.slice(0, 7)
  calendarYm = ym
  const year = Number(ym.slice(0, 4))
  // Days off are rows; a year that has none yet gets the fixed ones written.
  const known = await db.get(
    'SELECT COUNT(*) AS n FROM holiday WHERE substr(on_date,1,4) = ?', String(year))
  if (!known.n) await seedYear(db, year, { country: S.entity?.country })

  const grid = await calendarMonth(db, S.entity.id, ym)
  const shift = (n) => {
    const [y, m] = ym.split('-').map(Number)
    const total = y * 12 + (m - 1) + n
    calendarYm = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
    return refresh()
  }

  const first = new Date(`${grid.from}T00:00:00Z`).getUTCDay()
  const cells = [
    ...Array.from({ length: first }, () => null),
    ...grid.days,
  ]

  const dayCell = (d) => {
    if (!d) return h('div', { class: 'cal-day empty' })
    const isToday = d.date === S.today
    const holiday = d.holidays[0]
    return h('div', {
      class: `cal-day${isToday ? ' today' : ''}${holiday ? ' holiday' : ''}`,
      onclick: () => openDay(d.date),
    },
      h('div', { class: 'cal-head' },
        h('span', { class: 'n' }, String(Number(d.date.slice(8)))),
        holiday
          ? h('span', { class: 'cal-holiday' }, nameOf(holiday)) : null),
      h('div', { class: 'cal-items' },
        d.items.slice(0, 4).map((i) => h('div', { class: `cal-item ${ITEM_TONE[i.kind] || ''}` },
          nameOf(i, 'label'),
          i.amount ? h('span', { class: 'amt' }, money(i.amount)) : null)),
        d.items.length > 4
          ? h('div', { class: 'cal-item dim' }, `+${d.items.length - 4}`) : null),
      // The day's own shape, kept to one quiet line.
      h('div', { class: 'cal-sun' }, `${d.sun.sunrise}–${d.sun.sunset}`))
  }

  return [
    head(`${formatMonth(ym, S.locale, { both: true })}`,
      h('button', { class: 'btn', onclick: () => shift(-1) }, '←'),
      h('button', { class: 'btn', onclick: () => { calendarYm = S.today.slice(0, 7); refresh() } },
        t('cal.today')),
      h('button', { class: 'btn', onclick: () => shift(1) }, '→')),
    h('div', { class: 'cal-grid-head' },
      (S.locale === 'en' ? DOW_EN : DOW_LOCAL[S.locale] || DOW_TH).map((d) => h('div', {}, d))),
    h('div', { class: 'cal-grid' }, cells.map(dayCell)),
  ]
}

async function openDay(date) {
  const d = await dayDetail(S.db, S.entity.id, date)
  const line = (k, v) => h('div', {}, h('span', { class: 'dim' }, k), ' ', h('span', {}, v))
  openDialog(when(date), h('div', {},
    d.holidays.length
      ? h('div', { style: 'margin-bottom:10px' },
        d.holidays.map((hol) => h('div', {},
          h('span', { class: 'pill warn' }, nameOf(hol)),
          hol.expected ? h('span', { class: 'dim' }, ` · ${t('cal.expected')}`) : null)))
      : null,
    d.items.length
      ? h('table', {}, h('tbody', {}, d.items.map((i) => h('tr', {},
        h('td', { class: 'dim' }, t(`cal.${i.kind}`) || i.kind),
        h('td', {}, nameOf(i, 'label')),
        h('td', { class: 'num' }, i.amount ? money(i.amount) : '')))))
      : h('div', { class: 'empty' }, t('cal.nothing')),
    h('div', { class: 'day-quiet' },
      line(t('cal.sunrise'), d.sun.sunrise),
      line(t('cal.sunset'), d.sun.sunset),
      line(t('cal.daylight'), `${(d.sun.daylightMinutes / 60).toFixed(1)} ${t('cal.hours')}`),
      d.prayer
        ? h('div', { class: 'prayer' },
          ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].map((k) =>
            h('span', {}, `${k} ${d.prayer[k]}`)))
        : null,
      h('div', { class: 'dim' }, `${t('cal.place')} ${S.entity.place || 'Chiang Rai'}`))),
  [
    btn(t('cal.add_holiday'), {
      onclick: async () => {
        const name = prompt(t('cal.add_holiday'))
        if (!name) return
        await addHoliday(S.db, {
          entity_id: S.entity.id, on_date: date, name_en: name, kind: 'custom',
          source: 'added by hand',
        })
        closeDialog()
        result(t('result.saved'))
        refresh()
      },
    }),
    btn(t('btn.close'), { primary: true, onclick: closeDialog }),
  ], { wide: true })
}

// ---- today -----------------------------------------------------------------

async function viewToday() {
  const db = S.db
  await markLate(db, S.entity.id, S.today)
  const d = await dashboard(db, S.entity.id, { asOf: S.today })
  const receivable = d.owed.receivable
  const overdue = receivable.filter(isOverdue)   // quotations are not in here
  const filings = (await dueBetween(db, S.entity.id, { from: '2000-01-01', to: addDays(S.today, 45) }))
  const drafts = await db.all(
    "SELECT * FROM doc WHERE entity_id = ? AND status = 'draft' ORDER BY issue_date", S.entity.id)
  const quotes = await db.all(
    "SELECT * FROM doc WHERE entity_id = ? AND kind = 'quote' AND status = 'issued'", S.entity.id)
  const projects = d.projects.filter((r) => r.income || r.expense)
  const top = Math.max(1, ...projects.map((r) => r.income))

  const claims = await claimsFor(db, S.entity.id, { status: 'new' })
  // Money the bank has seen that no invoice has claimed yet: the work is here,
  // so it is named here rather than waiting to be gone looking for.
  const unplaced = await statementLines(db, S.entity.id, { status: 'new', limit: 5 })
  const waiting = [
    ...unplaced.map((line) => ({
      what: `${whenShort(line.on_date)} · ${line.description || t('bank.lines')} · ${money(line.amount, line.currency)}`,
      go: () => openStatementLine(line),
    })),
    ...claims.map((c) => ({
      what: t('pay.claim_one', {
        party: nameOf(c, 'party_name'), amount: money(c.amount ?? 0), number: c.number || '—',
      }),
      go: () => openClaim(c),
    })),
    ...drafts.map((doc) => ({
      what: `${t('today.draft_invoice')} · ${nameOf(doc, 'subject') || money(doc.gross)}`,
      go: () => openInvoiceForm(doc),
    })),
    ...overdue.map((doc) => ({
      what: `${doc.number} · ${nameOf(doc, 'party_name')} · ${money(doc.outstanding)} ${t('status.overdue')}`,
      go: () => openPaymentForm(doc, 'in'),
    })),
    ...filings.slice(0, 3).map((f) => ({
      what: `${f.code} ${f.period} · ${when(f.due_date)}${f.amount ? ' · ' + money(f.amount) : ''}`,
      go: () => openFilingForm(f),
    })),
    ...quotes.map((doc) => ({
      what: `${t('today.quote_out')} · ${nameOf(doc, 'subject')} · ${money(doc.gross)}`,
      go: () => openDocView(doc.id),
    })),
  ]

  return [
    head(t('nav.today'),
      h('button', { class: 'btn primary', onclick: () => openInvoiceForm() }, t('btn.new_invoice')),
      h('button', { class: 'btn', onclick: () => openBillForm() }, t('btn.new_bill'))),
    h('div', { class: 'cards' },
      card(t('today.bank'), money(d.cash.total), null, () => go('reports')),
      card(t('today.owed_in'), money(d.owed.receivableTotal),
        `${receivable.length} ${t('today.unpaid')}${overdue.length ? ` · ${overdue.length} ${t('status.overdue').toLowerCase()}` : ''}`,
        () => go('invoices')),
      card(t('today.owed_out'), money(d.owed.payableTotal), null, () => go('bills')),
      card(t('today.month'), money(d.pl.result),
        `${money(d.pl.incomeTotal)} ${t('col.in').toLowerCase()} · ${money(d.pl.expenseTotal)} ${t('col.out').toLowerCase()}`,
        () => go('reports')),
      filings.length
        ? card(t('today.due_next'), `${filings[0].code} ${filings[0].period}`,
          when(filings[0].due_date), () => go('tax'))
        : null),
    panel(t('today.needs_you'),
      waiting.length
        ? h('table', {}, h('tbody', {}, waiting.slice(0, 8).map((w) =>
          h('tr', { class: 'click', onclick: w.go }, h('td', {}, w.what)))))
        : h('div', { class: 'empty' }, t('today.nothing_waiting'))),
    panel(t('today.by_line'),
      h('table', {}, h('tbody', {}, projects.map((r) =>
        h('tr', {},
          h('td', {}, projectName(r),
            h('div', { class: 'bar' }, h('span', { style: `width:${Math.round((r.income / top) * 100)}%` }))),
          h('td', { class: 'num' }, money(r.income)),
          h('td', { class: 'num dim' }, money(r.expense)),
          h('td', { class: 'num strong' }, money(r.result))))))),
  ]
}

/** Somebody says they have paid. The invoice closes when the money is seen. */
function openClaim(claim) {
  openDialog(t('pay.claims'), h('div', {},
    h('div', { class: 'field' },
      h('label', {}, t('col.customer')),
      h('div', { class: 'strong' }, nameOf(claim, 'party_name'))),
    h('div', { class: 'row' },
      h('div', { class: 'field' },
        h('label', {}, t('col.number')), h('div', {}, claim.number || '—')),
      h('div', { class: 'field' },
        h('label', {}, t('col.amount')), h('div', {}, money(claim.amount ?? 0))),
      h('div', { class: 'field' },
        h('label', {}, t('pay.slip_ref') || 'ref'), h('div', {}, claim.slip_ref || '—'))),
    claim.photo_name ? h('div', { class: 'dim' }, claim.photo_name) : null),
  [
    btn(t('pay.reject'), {
      onclick: async () => {
        await S.db.run("UPDATE pay_claim SET status = 'rejected' WHERE id = ?", claim.id)
        closeDialog()
        refresh()
      },
    }),
    btn(t('btn.cancel'), { onclick: closeDialog }),
    btn(t('pay.settle'), {
      primary: true,
      onclick: async () => {
        await settleInFull(S.db, claim.doc_id, {
          on_date: S.today, account: '1010', slip_ref: claim.slip_ref, claim_id: claim.id,
        })
        closeDialog()
        result(t('pay.settled', { number: claim.number }))
        refresh()
      },
    }),
  ], { wide: true })
}

// ---- invoices --------------------------------------------------------------

async function viewInvoices() {
  const rows = await S.db.all(
    `SELECT d.*, y.name_en AS party_name_en, y.name_th AS party_name_th,
            y.name_km AS party_name_km,
            pr.name_en AS project_name_en, pr.name_th AS project_name_th,
            pr.name_km AS project_name_km
       FROM doc d JOIN party y ON y.id = d.party_id
       LEFT JOIN project pr ON pr.id = d.project_id
      WHERE d.entity_id = ? AND d.direction = 'out'
      ORDER BY d.issue_date DESC, d.number DESC`, S.entity.id)
  return [
    head(t('nav.invoices'),
      h('button', { class: 'btn primary', onclick: () => openInvoiceForm() }, t('btn.new_invoice'))),
    panel(null, dataTable(rows, [
      { label: t('col.number'), render: (r) => r.status === 'draft' ? t('status.draft') : r.number },
      { label: t('col.date'), render: (r) => whenShort(r.issue_date) },
      { label: t('col.customer'), render: (r) => nameOf(r, 'party_name') },
      { label: t('col.for'), phone: false,
        render: (r) => nameOf(r, 'subject') || nameOf(r, 'project_name') },
      { label: t('col.total'), num: true, render: (r) => money(r.gross, r.currency) },
      { label: t('col.outstanding'), num: true, phone: false,
        render: (r) => ['paid', 'void'].includes(r.status) || r.kind === 'quote' ? '—'
          : money(r.gross - r.paid - r.wht_credited, r.currency) },
      { label: t('col.status'),
        // A quotation has a date on it and nobody owes it, so it never reads
        // as overdue.
        render: (r) => statusPill(r.status, r.kind !== 'quote' && !['paid', 'void', 'draft'].includes(r.status) && isOverdue(r)) },
    ], {
      empty: t('empty.invoices'),
      onRow: (r) => (r.status === 'draft' ? openInvoiceForm(r) : openDocView(r.id)),
    })),
  ]
}

// ---- bills -----------------------------------------------------------------

async function viewBills() {
  const rows = await S.db.all(
    `SELECT d.*, y.name_en AS party_name_en, y.name_th AS party_name_th,
            y.name_km AS party_name_km
       FROM doc d JOIN party y ON y.id = d.party_id
      WHERE d.entity_id = ? AND d.direction = 'in'
      ORDER BY d.issue_date DESC`, S.entity.id)
  return [
    head(t('nav.bills'),
      h('button', { class: 'btn primary', onclick: () => openBillForm() }, t('btn.new_bill'))),
    panel(null, dataTable(rows, [
      { label: t('col.date'), render: (r) => whenShort(r.issue_date) },
      { label: t('col.supplier'), render: (r) => nameOf(r, 'party_name') },
      { label: t('col.for'), phone: false,
        render: (r) => nameOf(r, 'subject') || r.ref_external || '—' },
      { label: t('col.total'), num: true, render: (r) => money(r.gross, r.currency) },
      { label: t('col.outstanding'), num: true,
        render: (r) => r.status === 'paid' ? '—' : money(r.gross - r.paid - r.wht_credited) },
      { label: t('col.status'), render: (r) => statusPill(r.status) },
      { label: '', render: (r) => r.status === 'paid' || r.status === 'draft' ? '' :
        h('button', {
          class: 'btn small', onclick: (e) => { e.stopPropagation(); openPaymentForm(r, 'out') },
        }, t('btn.pay_it')) },
    ], { empty: t('empty.bills'), onRow: (r) => openDocView(r.id) })),
  ]
}

// ---- contacts --------------------------------------------------------------

async function viewContacts() {
  const rows = await S.db.all(
    `SELECT y.*, 
            (SELECT COALESCE(SUM(d.gross - d.paid - d.wht_credited),0) FROM doc d
              WHERE d.party_id = y.id AND d.direction = 'out'
                AND d.status IN ('issued','part_paid')) AS owes,
            (SELECT COALESCE(SUM(d.gross - d.paid - d.wht_credited),0) FROM doc d
              WHERE d.party_id = y.id AND d.direction = 'in'
                AND d.status IN ('issued','part_paid')) AS owed
       FROM party y WHERE y.entity_id = ? ORDER BY y.name_en`, S.entity.id)
  return [
    head(t('nav.contacts'),
      h('button', { class: 'btn primary', onclick: () => openContactForm() }, t('btn.new_contact'))),
    panel(null, dataTable(rows, [
      { label: t('col.name'), render: (r) => nameOf(r) },
      { label: t('col.type'), phone: false,
        render: (r) => r.is_company ? t('form.company') : t('form.person') },
      { label: t('col.taxid'), phone: false, render: (r) => r.tax_id || '—' },
      { label: t('form.country'), phone: false,
        render: (r) => [r.country, r.currency].filter(Boolean).join(' · ') },
      { label: t('col.owes'), num: true, render: (r) => r.owes ? money(r.owes) : '—' },
      { label: t('col.out'), num: true, render: (r) => r.owed ? money(r.owed) : '—' },
      { label: '', render: (r) => h('button', {
        class: 'btn small', onclick: (e) => { e.stopPropagation(); openInvoiceForm(null, r.id) },
      }, t('btn.new_invoice')) },
    ], { onRow: (r) => openContactForm(r) })),
  ]
}

// ---- the shelf -------------------------------------------------------------

async function viewShelf() {
  const db = S.db
  const rows = await db.all(
    'SELECT * FROM item WHERE entity_id = ? ORDER BY status, sku', S.entity.id)
  const held = await valuation(db, S.entity.id)
  const sold = await margin(db, S.entity.id, { from: `${S.today.slice(0, 4)}-01-01`, to: S.today })
  return [
    head(t('nav.shelf'),
      h('button', { class: 'btn primary', onclick: () => openPieceForm() }, t('btn.new_piece'))),
    h('div', { class: 'cards' },
      card(t('status.in_stock'), String(held.pieces), money(held.total)),
      card(t('status.sold'), String(sold.rows.length), money(sold.revenue)),
      card(t('col.margin'), money(sold.margin),
        sold.medianDaysHeld != null ? `${sold.medianDaysHeld} days` : null)),
    panel(null, dataTable(rows, [
      { label: t('form.sku'), key: 'sku' },
      { label: t('col.item'), render: (r) => nameOf(r) },
      { label: t('col.cost'), num: true, render: (r) => money(r.acq_cost + r.prep_cost) },
      { label: t('col.asking'), num: true, phone: false,
        render: (r) => r.ask_price ? money(r.ask_price) : '—' },
      { label: t('col.sold'), num: true, render: (r) => r.sold_price ? money(r.sold_price) : '—' },
      { label: t('col.margin'), num: true,
        render: (r) => r.sold_price ? money(r.sold_price - r.acq_cost - r.prep_cost) : '—' },
      { label: t('col.status'), render: (r) => statusPill(r.status) },
      { label: '', render: (r) => r.status === 'sold' ? '' : h('span', {},
        r.status === 'in_stock'
          ? h('button', { class: 'btn small', onclick: async (e) => {
            e.stopPropagation()
            await setStatus(db, r.id, 'listed', { on_date: S.today })
            result(t('status.listed'))
            refresh()
          } }, t('btn.list_it'))
          : null,
        ' ',
        h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); openSellForm(r) } },
          t('btn.sell_it'))) },
    ], { empty: t('empty.shelf') })),
  ]
}

// ---- repeating -------------------------------------------------------------

async function viewRepeating() {
  const db = S.db
  const rows = await db.all(
    `SELECT s.*, pl.name_en AS plan_en, pl.name_th AS plan_th,
            pl.name_km AS plan_km, pl.price, pl.interval,
            y.name_en AS party_name_en, y.name_th AS party_name_th,
            y.name_km AS party_name_km
       FROM subscription s JOIN plan pl ON pl.id = s.plan_id JOIN party y ON y.id = s.party_id
      WHERE s.entity_id = ? ORDER BY s.status, s.next_bill_on`, S.entity.id)
  const mrr = await recurringMonthly(db, S.entity.id)
  const dueNow = rows.filter((r) => r.status === 'active' && r.next_bill_on && r.next_bill_on <= S.today)
  return [
    head(t('nav.repeating'),
      h('button', {
        class: 'btn primary', disabled: !dueNow.length, onclick: billDue,
      }, t('btn.bill_due')),
      h('button', { class: 'btn', onclick: () => openRepeatingForm() }, t('btn.new_repeating'))),
    h('div', { class: 'cards' },
      ...Object.entries(mrr).map(([ccy, v]) => card(t('sub.interval.month') || 'per month', format(v, ccy)))),
    panel(null, dataTable(rows, [
      { label: t('col.customer'), render: (r) => nameOf(r, 'party_name') },
      { label: t('col.plan'), render: (r) => localOf(r, 'plan') || r.plan_en },
      { label: t('col.seats'), num: true, key: 'seats' },
      { label: t('col.each'), num: true, render: (r) => money(r.price_override ?? r.price) },
      { label: t('col.next'), render: (r) => r.next_bill_on ? whenShort(r.next_bill_on) : '—' },
      { label: t('col.status'), render: (r) => statusPill(r.status === 'active' ? 'active' : 'ended') },
      { label: '', render: (r) => r.status !== 'active' ? '' : h('button', {
        class: 'btn small', onclick: async (e) => {
          e.stopPropagation()
          await cancel(S.db, r.id, { at_period_end: true })
          result(t('result.stopped'))
          refresh()
        },
      }, t('btn.stop')) },
    ], { empty: t('empty.repeating') })),
  ]
}

async function billDue() {
  let made = []
  for (let i = 0; i < 24; i++) {
    const batch = await runBilling(S.db, S.entity.id, { asOf: S.today })
    if (!batch.length) break
    made = made.concat(batch)
  }
  const total = made.reduce((a, d) => a + d.gross, 0)
  result(t('result.billed', { n: made.length, amount: money(total) }))
  refresh()
}

// ---- payroll ---------------------------------------------------------------

async function viewPayroll() {
  const db = S.db
  const staff = await db.all(
    `SELECT e.*, pe.name_en, pe.name_th FROM employment e JOIN person pe ON pe.id = e.person_id
      WHERE e.entity_id = ? AND (e.end_date IS NULL OR e.end_date >= ?)
      ORDER BY e.pay_rate DESC`, S.entity.id, S.today)
  const runs = await db.all(
    'SELECT * FROM pay_run WHERE entity_id = ? ORDER BY ym DESC LIMIT 6', S.entity.id)
  const slips = await db.all(
    `SELECT s.*, r.ym, pe.name_en, pe.name_th FROM payslip s
       JOIN pay_run r ON r.id = s.pay_run_id JOIN person pe ON pe.id = s.person_id
      WHERE r.entity_id = ? ORDER BY r.ym DESC, pe.name_en LIMIT 12`, S.entity.id)
  return [
    head(t('nav.payroll'),
      h('button', { class: 'btn primary', onclick: () => openPayrollForm(staff) }, t('btn.run_payroll'))),
    panel(t('col.person'), dataTable(staff, [
      { label: t('col.person'), render: (r) => nameOf(r) },
      { label: t('col.role'), render: (r) => nameOf(r, 'title') },
      { label: t('col.pay'), num: true, render: (r) => `${money(r.pay_rate)} / ${r.pay_unit}` },
      { label: p('payroll.sso_employee'), render: (r) => r.sso_registered ? '✓' : '—' },
      { label: p('payroll.wht'), render: (r) => r.tax_withheld ? '✓' : '—' },
    ])),
    panel(t('form.month'), dataTable(slips, [
      { label: t('col.period'), key: 'ym' },
      { label: t('col.person'), render: (r) => nameOf(r) },
      { label: p('payroll.gross'), num: true, render: (r) => money(r.gross) },
      { label: p('payroll.sso_employee'), num: true, phone: false, render: (r) => money(r.sso_employee) },
      { label: p('payroll.wht'), num: true, phone: false, render: (r) => money(r.wht) },
      { label: t('col.net'), num: true, render: (r) => h('span', { class: 'strong' }, money(r.net)) },
      { label: t('col.status'), render: (r) => statusPill(r.paid_at ? 'paid' : 'due') },
    ], { onRow: (r) => openPayslipView(r.id) }),
      runs.length ? `${runs.length}` : null),
  ]
}

// ---- tax -------------------------------------------------------------------

async function viewTax() {
  const db = S.db
  const year = S.today.slice(0, 4)
  await generateFilings(db, S.entity.id, { from: `${year}-01-01`, to: `${Number(year) + 1}-06-30` })
  await markLate(db, S.entity.id, S.today)
  // Everything still owed, then the next few months: a year of rows nobody has
  // to scroll past to find what is late.
  const due = (await dueBetween(db, S.entity.id, { from: '2000-01-01', to: `${Number(year) + 1}-06-30` }))
    .filter((f) => f.due_date <= addDays(S.today, 120))
  const filed = await db.all(
    `SELECT f.*, o.code, o.name_en, o.name_th FROM filing f JOIN obligation o ON o.id = f.obligation_id
      WHERE f.entity_id = ? AND f.status IN ('filed','paid')
      ORDER BY f.due_date DESC LIMIT 8`, S.entity.id)
  const vat = await vatReport(db, S.entity.id, { ym: S.today.slice(0, 7) })
  const wht = await whtReport(db, S.entity.id, { ym: S.today.slice(0, 7) })
  // What is actually owed to each office right now, and which returns are
  // filed and not yet paid. Both go to nothing when the transfer is made,
  // which is the point of them being here.
  const offices = await owedToOffices(db, S.entity.id, { asOf: S.today })
  const toPay = await unpaidFilings(db, S.entity.id)

  return [
    head(t('nav.tax')),
    h('div', { class: 'cards' },
      card(t('report.vat'), money(vat.payable),
        `${money(vat.outputTax)} − ${money(vat.inputTax)}`),
      card(t('report.wht'), money(wht.withheldTotal),
        `${t('report.wht_in')}: ${money(wht.sufferedTotal)}`),
      wht.missingCertificates
        ? card(p('report.certs_missing'), String(wht.missingCertificates)) : null),
    panel(t('status.due'), dataTable(due, [
      { label: t('col.form'), key: 'code' },
      { label: t('col.name'), phone: false,
        render: (r) => nameOf(r) },
      { label: t('col.period'), key: 'period' },
      { label: t('col.due'), render: (r) => whenShort(r.due_date) },
      { label: t('col.efile'), phone: false,
        render: (r) => r.efile_date ? whenShort(r.efile_date) : '—' },
      { label: t('col.amount'), num: true, render: (r) => r.amount == null ? '—' : money(r.amount) },
      { label: t('col.status'), render: (r) => statusPill(r.status) },
      { label: '', render: (r) => h('button', {
        class: 'btn small', onclick: (e) => { e.stopPropagation(); openFilingForm(r) },
      }, t('btn.mark_filed')) },
    ], { empty: t('empty.tax') })),
    toPay.length ? panel(t('tax.to_pay'), h('div', {},
      dataTable(toPay, [
        { label: t('col.form'), key: 'code' },
        { label: t('col.period'), key: 'period' },
        { label: t('col.due'), render: (r) => whenShort(r.due_date) },
        { label: t('col.amount'), num: true, render: (r) => money(r.amount ?? 0) },
        { label: t('col.status'), render: (r) => statusPill(r.status) },
        { label: '', render: (r) => h('button', {
          class: 'btn small primary',
          onclick: (e) => { e.stopPropagation(); openPayFilingForm(r) },
        }, t('tax.pay_it')) },
      ]))) : null,
    offices.length ? panel(t('tax.owed_offices'), h('div', {},
      dataTable(offices, [
        { label: t('col.account'), render: (r) => nameOf(r) },
        { label: t('col.amount'), num: true,
          render: (r) => h('span', {}, money(Math.abs(r.owed)),
            r.owed < 0 ? h('div', { class: 'dim' }, t('tax.owed_to_you')) : null) },
      ]),
      h('p', { class: 'body dim' }, t('tax.owed_note')))) : null,
    filed.length ? panel(t('status.filed'), dataTable(filed, [
      { label: t('col.form'), key: 'code' },
      { label: t('col.period'), key: 'period' },
      { label: t('form.filed_on'), render: (r) => whenShort(r.filed_on) },
      { label: t('form.ref'), render: (r) => r.ref || '—' },
      { label: t('tax.paid_on'), render: (r) => r.paid_on ? whenShort(r.paid_on) : '—' },
    ])) : null,
  ]
}

// ---- reports ---------------------------------------------------------------

async function viewReports() {
  const db = S.db
  const from = `${S.today.slice(0, 4)}-01-01`
  const pl = await profitAndLoss(db, S.entity.id, { from, to: S.today })
  const lines = await byProject(db, S.entity.id, { from, to: S.today })
  const cash = await cashPosition(db, S.entity.id, { asOf: S.today })
  const owed = await whoOwesWhat(db, S.entity.id, { asOf: S.today })
  const tb = await trialBalance(db, S.entity.id, { from, to: S.today })
  const owner = await partnerStatement(db, S.entity.id, { from, to: S.today })

  const plRow = (r) => ({ name: nameOf(r), amount: money(Math.abs(r.balance)) })

  return [
    head(t('nav.reports')),
    h('div', { class: 'cards' },
      card(t('col.in'), money(pl.incomeTotal)),
      card(t('col.out'), money(pl.expenseTotal)),
      card(t('col.result'), money(pl.result)),
      card(t('today.bank'), money(cash.total))),
    panel(t('report.lines'), dataTable(lines, [
      { label: t('col.line'), render: (r) => projectName(r) },
      { label: t('col.in'), num: true, render: (r) => money(r.income) },
      { label: t('col.out'), num: true, render: (r) => money(r.expense) },
      { label: t('col.result'), num: true, render: (r) => h('span', { class: 'strong' }, money(r.result)) },
    ])),
    panel(t('report.pl'), dataTable(
      [...pl.income.map(plRow), ...pl.expense.map(plRow)],
      [{ label: t('col.account'), key: 'name' }, { label: t('col.amount'), num: true, key: 'amount' }])),
    panel(t('report.owes'), dataTable(owed.receivable, [
      { label: t('col.number'), key: 'number' },
      { label: t('col.customer'), render: (r) => nameOf(r, 'party_name') },
      { label: t('col.due'), render: (r) => whenShort(r.due_date || r.issue_date) },
      { label: t('col.outstanding'), num: true, render: (r) => money(r.outstanding) },
    ], { empty: t('today.nothing_waiting'), onRow: (r) => openDocView(r.id) }),
      `${money(owed.receivableTotal)}`),
    panel(t('report.partner'), dataTable(owner.partners, [
      { label: t('col.name'), render: (r) => nameOf(r) },
      { label: p('report.share'), num: true, render: (r) => `${(r.share_bp / 100).toFixed(0)}%` },
      { label: t('col.result'), num: true, render: (r) => money(r.share_of_result) },
      { label: p('report.opening'), num: true, render: (r) => money(r.capital) },
    ])),
    panel(t('cx.holdings'), await holdingsPanel()),
    financeDrawer(),
    panel(t('report.trial'), dataTable(tb.rows, [
      { label: '', key: 'code' },
      { label: t('col.account'), render: (r) => nameOf(r) },
      { label: p('report.debit'), num: true, render: (r) => r.balance > 0 ? money(r.balance) : '' },
      { label: p('report.credit'), num: true, render: (r) => r.balance < 0 ? money(-r.balance) : '' },
    ]), `${money(tb.totals.debits)} / ${money(tb.totals.credits)}`),
  ]
}

// ---- setup -----------------------------------------------------------------

async function viewSetup() {
  const e = S.entity
  const b = S.brand
  const own = e.code === 'demo'

  // The books that are open have their own registered details, and a change to
  // them is recorded like any other change to a rule.
  const books = h('div', {},
    h('div', { class: 'row' },
      field(t('setup.entity_name'), input({ id: 'e-name-en', value: e.name_en })),
      field(t('form.name_th', { language: localeNames[secondLocale()] }), input({
        id: 'e-name-th', value: e[`name_${secondLocale()}`] || '',
      }))),
    h('div', { class: 'row' },
      field(t('form.taxid'), input({ id: 'e-taxid', value: e.tax_id || '' })),
      field(t('setup.address'), input({ id: 'e-address', value: e.address_en || '' }))),
    h('div', { class: 'check' },
      input({ id: 'e-vat', type: 'checkbox', checked: !!e.vat_registered }),
      h('label', { for: 'e-vat' }, t('setup.vat'))),
    h('button', {
      class: 'btn primary',
      onclick: async () => {
        await setEntityDetails(S.db, e.id, {
          name_en: document.getElementById('e-name-en').value.trim() || e.name_en,
          [`name_${secondLocale()}`]: document.getElementById('e-name-th').value.trim() || null,
          tax_id: document.getElementById('e-taxid').value.trim() || null,
          address_en: document.getElementById('e-address').value.trim() || null,
          vat_registered: document.getElementById('e-vat').checked ? 1 : 0,
        }, { note: 'changed in Setup' })
        S.entity = await S.db.get('SELECT * FROM entity WHERE id = ?', e.id)
        if (own) {
          S.brand = {
            ...S.brand,
            name_en: S.entity.name_en,
            [`name_${secondLocale()}`]: S.entity[`name_${secondLocale()}`],
          }
          saveBrand()
        }
        paintBrand()
        await paintSwitcher()
        result(t('result.saved'))
        refresh()
      },
    }, t('btn.save')))

  // The white label: how the app itself looks, whoever's books are open.
  const brandForm = h('div', {},
    h('div', { class: 'row' },
      field(t('setup.mark'), input({ id: 'b-mark', value: b.mark, maxlength: 3 })),
      field(t('setup.accent'), input({ id: 'b-accent', type: 'color', value: b.accent })),
      field(t('setup.language'), select([['en', 'English'], ['th', 'ไทย']], { value: b.locale }))),
    h('button', {
      class: 'btn',
      onclick: async () => {
        S.brand = {
          ...S.brand,
          mark: document.getElementById('b-mark').value.trim().slice(0, 3) || S.brand.mark,
          accent: document.getElementById('b-accent').value,
          locale: brandForm.querySelector('select').value,
        }
        saveBrand()
        setLocale(S.brand.locale)
        paintBrand()
        result(t('result.saved'))
        refresh()
      },
    }, t('btn.save')))

  return [
    head(t('nav.setup')),
    panel(`${t('setup.these_books')} — ${nameOf(e)}`, h('div', { class: 'body' }, books)),
    await bringPanel(),
    panel(t('setup.brand'), h('div', { class: 'body' }, brandForm)),
    panel(t('pay.methods'), await payMethodsPanel()),
    panel(t('line.title'), await linePanel()),
    panel(t('records.title'), h('div', { class: 'body' },
      h('p', { class: 'dim', style: 'margin-top:0' }, t('records.note')),
      h('button', { class: 'btn', onclick: downloadRecords }, t('records.export')))),
    panel(t('setup.data'), h('div', { class: 'body' },
      h('button', {
        class: 'btn', onclick: async () => {
          if (!confirm(t('chip.reset_confirm'))) return
          wipe()
          location.reload()
        },
      }, t('setup.reset')))),
  ]
}


/**
 * Moving in: the file they already have, and what each one turned into.
 *
 * A batch that has touched nothing can be taken back out, which is what makes
 * trying it cost nothing — the reason most people never move their books is
 * that the first import is a one-way door.
 */
async function bringPanel() {
  const rows = await importBatches(S.db, S.entity.id)
  const said = (b) => {
    const c = JSON.parse(b.counts || '{}')
    return Object.entries(c).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ') || '—'
  }
  return panel(t('bring.title'), h('div', {},
    rows.length
      ? dataTable(rows, [
        { label: t('col.date'), render: (b) => whenShort(b.at.slice(0, 10)) },
        { label: t('bring.kind'), render: (b) => t(`bring.kind_${b.kind}`) },
        { label: t('rules.source'), phone: false, render: (b) => b.source_name || '—' },
        { label: t('bring.will'), render: said },
        { label: '', render: (b) => b.kind === 'contacts'
          ? h('button', { class: 'btn small', onclick: async (e) => {
            e.stopPropagation()
            const out = await undoContacts(S.db, b.id)
            result(t('bring.undone', out))
            refresh()
          } }, t('bring.undo'))
          : '' },
      ])
      : h('div', { class: 'empty' }, t('bring.nothing_yet')),
    h('div', { class: 'body' },
      h('button', { class: 'btn primary', onclick: () => openBringForm() }, t('bring.open')))))
}

/** The ways money can arrive, in the order the payer is offered them. */
async function payMethodsPanel() {
  const methods = await methodsFor(S.db, S.entity.id, { direction: 'in' })
  return h('div', {},
    methods.length
      ? dataTable(methods, [
        { label: t('col.name'), render: (m) => h('span', {},
          h('span', { class: 'strong' }, pick(m, 'label', S.locale) || m.label_en),
          m.is_default ? h('span', { class: 'pill good' }, ` ${t('pay.default')}`) : null) },
        { label: t('col.type'), phone: false, render: (m) => m.kind },
        { label: t('doc.description'),
          render: (m) => m.payee_id || m.account_no || m.qr_payload || m.link_template || '—' },
        { label: t('pay.lands_in'), phone: false, render: (m) => m.account_code },
        { label: '', render: (m) => h('span', {},
          m.is_default ? null : h('button', {
            class: 'btn small',
            onclick: async (e) => {
              e.stopPropagation()
              await setDefaultMethod(S.db, m.id)
              result(t('result.saved'))
              refresh()
            },
          }, t('pay.make_default')),
          ' ',
          h('button', {
            class: 'btn small',
            onclick: (e) => { e.stopPropagation(); openMethodForm(m) },
          }, t('rules.change'))) },
      ])
      : h('div', { class: 'empty' }, t('pay.no_way')),
    h('div', { class: 'body' },
      h('button', { class: 'btn', onclick: () => openMethodForm(null) }, t('pay.method_add'))))
}

/** The chat app, as far as the books are concerned: who is connected, and what
 *  is waiting to be said to them. */
async function linePanel() {
  const chats = await chatsFor(S.db, S.entity.id)
  const queued = (await outboxPending(S.db)).filter((m) => m.entity_id === S.entity.id)
  return h('div', {},
    chats.length
      ? dataTable(chats, [
        { label: t('line.who'), render: (c) => c.display_name || c.chat_id },
        { label: t('col.type'), phone: false, render: (c) => c.kind },
        { label: t('col.customer'), render: (c) => (c.party_id ? '✓' : '—') },
        { label: '', render: (c) => h('button', {
          class: 'btn small', onclick: (e) => { e.stopPropagation(); openChatLink(c) },
        }, t('rules.change')) },
      ])
      : h('div', { class: 'body' }, h('p', { class: 'dim' }, t('line.no_chats'))),
    queued.length
      ? h('div', {},
        h('div', { class: 'body dim' }, `${t('line.outbox')} — ${queued.length}`),
        dataTable(queued.slice(0, 5), [
          { label: t('line.who'), render: (m) => m.chat_id },
          { label: t('line.body'), render: (m) => m.body.split('\n')[0].slice(0, 60) },
          { label: '', render: (m) => h('button', {
            class: 'btn small',
            onclick: async (e) => {
              e.stopPropagation()
              await markSent(S.db, m.id, { error: 'no credentials on this demo' })
              refresh()
            },
          }, t('btn.close')) },
        ]))
      : null,
    h('div', { class: 'body', style: 'display:flex; gap:8px; flex-wrap:wrap' },
      h('button', { class: 'btn', onclick: () => openLineSimulator() }, t('line.simulate')),
      h('button', { class: 'btn', onclick: () => queueDigest() }, t('line.digest'))))
}

setRenderer(render)
await boot()
