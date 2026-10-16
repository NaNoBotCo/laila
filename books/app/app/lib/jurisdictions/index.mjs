// jurisdictions — one engine, more than one country.
//
// A pack holds what differs between places: the rates a fresh set of books
// starts with, the ladder salary tax is charged on, the filing calendar, the
// chart of accounts in the local language, and what comes off a month's pay.
// Everything else — double entry, documents, stock, the intake, the reports —
// is the same code in both.
//
// Adding a country is a pack. Nothing in the modules knows a country's name.

import * as TH from './th.mjs'
import * as KH from './kh.mjs'
import * as LA from './la.mjs'
import * as MM from './mm.mjs'

// TH and KH carry rates somebody checked. LA and MM are skeletons: a working
// set of books in the local currency, with every rate marked unconfirmed until
// whoever signs the return sets it.
export const PACKS = { TH, KH, LA, MM }
export const COUNTRIES = Object.keys(PACKS)

export const jurisdictionFor = (country) => PACKS[String(country || 'TH').toUpperCase()] || TH

/** The name of the pack a set of books keeps, for storing on a row. */
export const codeFor = (country) =>
  (PACKS[String(country || 'TH').toUpperCase()] ? String(country).toUpperCase() : 'TH')
