// i18n — every string a person sees exists in each language the build offers.
//
// Two rules worth reading twice.
//
// LOOKUP ORDER. English needs a singular form ("1 piece"); Thai and Khmer have
// no grammatical plural, so a `_one` key simply never exists in those packs.
// The reader's own general form must therefore beat the English singular —
// otherwise a count of one silently switches the line to English.
//
// FALLING BACK. A pack that has not been filled in yet falls through to
// English rather than showing a key. A half-translated screen is usable; a
// screen of `doc.due_date` is not.
import { en } from './en.mjs'
import { th } from './th.mjs'
import { km } from './km.mjs'

const PACKS = { en, th, km }
export const LOCALES = Object.keys(PACKS)

/** The script a locale is written in, for anything that has to measure text. */
export const SCRIPT = { en: 'latin', th: 'thai', km: 'khmer' }

export function makeT(locale) {
  const loc = PACKS[locale] ? locale : 'en'
  const pack = PACKS[loc]
  return (key, params) => {
    const one = params?.n === 1 ? `${key}_one` : null
    const s = (one && pack[one]) ?? pack[key] ?? (one && en[one]) ?? en[key] ?? key
    return params ? String(s).replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m)) : s
  }
}

/**
 * Pick the right one of a row's paired columns — `name_en`, `name_th`,
 * `name_km` — for the reader's language.
 *
 * A row carries whichever languages it was written in. The reader's own
 * language wins; English is the fallback everything has; and if neither is
 * there, any other language beats an empty cell, because a Thai name shown to
 * a Khmer reader still identifies the account.
 */
export function pick(row, field, locale) {
  if (!row) return ''
  const own = row[`${field}_${locale}`]
  if (own) return own
  const english = row[`${field}_en`]
  if (english) return english
  for (const other of LOCALES) {
    const value = row[`${field}_${other}`]
    if (value) return value
  }
  return ''
}
