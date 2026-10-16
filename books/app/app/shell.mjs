// shell.mjs — the things every screen and every form needs: the open books,
// the language, money and date formatting, the dialog, and the one-line
// receipt an action leaves behind.
//
// Screens live in main.mjs, forms in forms.mjs; both import this, and neither
// imports the other, so there is no cycle to reason about.

import { h, mount } from './dom.mjs'
import { makeUI } from './ui-i18n.mjs'
import { makeT, pick } from './i18n/index.mjs'
import { format } from './lib/money.mjs'
import { formatDate, toBE } from './lib/be.mjs'
import { gregorianToHijri, MONTHS as HIJRI_MONTHS } from './lib/hijri.mjs'
import { localDate } from './lib/clock.mjs'
import { BRAND_DEFAULT } from './seed-demo.mjs'
import { vatBpOn, whtBpOn } from './lib/tax.mjs'

export const BRAND_KEY = 'erp.demo.brand.v1'

export const S = {
  db: null, entity: null, view: 'today', rates: null, brandKey: null,
  locale: 'en', brand: { ...BRAND_DEFAULT }, today: localDate(),
}

export let t = makeUI('en')     // this page's words
export let p = makeT('en')      // the product's words, shared with the documents

export function setLocale(locale) {
  S.locale = locale
  t = makeUI(locale)
  p = makeT(locale)
  document.documentElement.lang = locale
}

export const saveBrand = () =>
  localStorage.setItem(S.brandKey || BRAND_KEY, JSON.stringify(S.brand))

/** An amount in the currency these books are kept in, unless told otherwise.
 *  Riel in Phnom Penh, baht in Chiang Mai — never a default from the code. */
export const money = (n, ccy = null) => format(n ?? 0, ccy || S.entity?.currency || 'THB')
export const when = (d) => (d ? formatDate(d, S.locale) : '—')
/** The short form for anything in a table, where a wrapped date costs a row. */
export const whenShort = (d) => (d ? formatDate(d, S.locale, { abbr: true }) : '—')
export const nameOf = (row, field = 'name') =>
  pick(row, field, S.locale) || row?.[`${field}_en`] || ''

/** Any paired column on a row, in the reader's language. */
export const localOf = (row, field) => pick(row, field, S.locale)

/**
 * The rates these books actually charge, for the words on the screen.
 *
 * "Add VAT 7%" was written into the English once. It is ten in Cambodia and it
 * moves in both countries, so the label asks the rate table and the number is
 * whatever is in force where the books are kept.
 */
export async function loadRates() {
  const jur = String(S.entity?.country || 'TH').toUpperCase()
  const [vat, service, rent] = await Promise.all([
    vatBpOn(S.db, S.today, jur),
    whtBpOn(S.db, 'service', S.today, jur),
    whtBpOn(S.db, 'rent', S.today, jur),
  ])
  S.rates = { vatBp: vat, whtBp: service, whtRentBp: rent, jur }
  return S.rates
}

export const vatPct = () => (S.rates?.vatBp ?? 700) / 100
export const whtPct = () => (S.rates?.whtBp ?? 300) / 100
export const whtBp = () => S.rates?.whtBp ?? 300

/**
 * The languages this build offers, in the order the toggle cycles them.
 *
 * A deployment shows two: English and the language of the place. Which second
 * language is a setting, not a branch — Chiang Mai gets Thai, Phnom Penh gets
 * Khmer, and the packs are all in the build either way.
 */
export const localeNames = { en: 'English', th: 'ไทย', km: 'ខ្មែរ' }
export const localePair = () => {
  const pair = Array.isArray(S.brand.locales) && S.brand.locales.length
    ? S.brand.locales : ['en', 'th']
  return pair.filter((l) => localeNames[l])
}
export const nextLocale = () => {
  const pair = localePair()
  const i = pair.indexOf(S.locale)
  return pair[(i + 1) % pair.length] ?? pair[0]
}
/** The one that is not English — what a document's second face is written in. */
/**
 * The same field in the other language of the pair — the line that sits under
 * the main one on a document. Empty when there is nothing to add, so a
 * one-language row does not grow a blank line.
 */
export const secondText = (row, field) => {
  const other = localePair().find((l) => l !== S.locale)
  if (!other) return ''
  const mine = pick(row, field, S.locale)
  const theirs = pick(row, field, other)
  return theirs && theirs !== mine ? theirs : ''
}

export const secondLocale = () => localePair().find((l) => l !== 'en') || 'th'
export const addDays = (d, n) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10)
export const isOverdue = (doc) => (doc.due_date || doc.issue_date) < S.today

// ---- the frame renders itself again when something changes ------------------

let renderer = null
export const setRenderer = (fn) => { renderer = fn }
export const go = (view) => { S.view = view; return renderer(view) }
export const refresh = () => renderer(S.view)

// ---- furniture --------------------------------------------------------------

/**
 * The date in the header is quietly more than one date. Clicking it steps
 * through the reckonings this office actually meets: the Gregorian year on a
 * bank transfer, the Buddhist year on a Thai tax form, and the Hijri one a
 * Muslim client or supplier keeps. Nothing depends on it; it is there for
 * whoever notices.
 */
export function head(title, ...actions) {
  const stamp = h('span', {
    class: 'when', title: 'ᯓ',
    style: 'cursor: default; user-select: none',
    onclick: () => {
      S.eras = ((S.eras ?? 0) + 1) % 3
      stamp.textContent = eraStamp(S.today)
    },
  }, eraStamp(S.today))
  return h('div', { class: 'head' },
    h('h1', {}, title),
    stamp,
    h('div', { class: 'actions' }, actions))
}

function eraStamp(date) {
  const mode = S.eras ?? 0
  if (mode === 0) return when(date)
  const [y] = date.split('-').map(Number)
  if (mode === 1) {
    return S.locale === 'th'
      ? `${when(date)} (${y})`
      : `${when(date)} (${toBE(y)})`
  }
  const h_ = gregorianToHijri(date)
  return `${when(date)} · ${h_.day} ${HIJRI_MONTHS[h_.month - 1]} ${h_.year}`
}

export const panel = (title, body, right = null) =>
  h('section', { class: 'panel' },
    title ? h('h2', {}, title, right ? h('span', { class: 'right' }, right) : null) : null,
    body)

export const card = (k, v, note = null, onclick = null) =>
  h('div', { class: `card${onclick ? ' click' : ''}`, onclick },
    h('div', { class: 'k' }, k),
    h('div', { class: 'v' }, v),
    note ? h('div', { class: 'n' }, note) : null)

export function statusPill(status, overdue = false) {
  if (overdue) return h('span', { class: 'pill bad' }, t('status.overdue'))
  const tone = {
    paid: 'good', filed: 'good', sold: 'good', active: 'good',
    late: 'bad', void: 'bad', part_paid: 'warn', due: 'warn',
  }[status]
  return h('span', { class: `pill${tone ? ' ' + tone : ''}` }, t(`status.${status}`) || status)
}

/** What the action did to the money, in one or two lines. It is a receipt, not
 *  a lesson: it names the amounts that moved and then goes away. */
export function result(...lines) {
  document.querySelector('.result')?.remove()
  const box = h('div', { class: 'result' },
    lines.filter(Boolean).map((l) => h('div', { class: 'line' }, l)))
  document.body.append(box)
  const timer = setTimeout(() => box.remove(), 10000)
  box.onclick = () => { clearTimeout(timer); box.remove() }
}

// ---- the dialog -------------------------------------------------------------

const dlg = document.getElementById('dlg')

export function openDialog(title, body, foot = [], { wide = false } = {}) {
  mount(dlg,
    h('div', { class: 'dlg-head' }, title,
      h('button', {
        class: 'btn small quiet', style: 'margin-left:auto', onclick: () => dlg.close(),
      }, '✕')),
    h('div', { class: 'dlg-body' }, body),
    foot.length ? h('div', { class: 'dlg-foot' }, foot) : null)
  dlg.style.width = wide ? 'min(880px, 96vw)' : ''
  if (!dlg.open) dlg.showModal()
}

export const closeDialog = () => dlg.close()

export const field = (label, control) =>
  h('div', { class: 'field' }, h('label', {}, label), control)

export const select = (options, { value = null, onchange = null, id = null } = {}) =>
  h('select', { onchange, id },
    options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value) }, label)))

export const input = (attrs) => h('input', attrs)

export const btn = (label, { primary = false, small = false, onclick = null, disabled = false } = {}) =>
  h('button', {
    class: `btn${primary ? ' primary' : ''}${small ? ' small' : ''}`, onclick, disabled,
  }, label)
