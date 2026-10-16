// fx.mjs — one rate table for anything measured against something else.
//
// A currency and a coin are the same problem: how many of THIS is one of THAT,
// on a day, according to whom. So both live in `asset_rate`, and a rate is
// always read as "units of `quote` for one whole unit of `asset`" in parts per
// million — ฿36.25 to the dollar is 36_250_000, and no float is stored.
//
// Three ways to answer, in order, and the answer says which was used:
//   direct       USD→THB was recorded
//   inverse      only THB→USD was recorded, so it is turned over
//   through      neither, but both sides have a rate against the books' own
//                currency, so the two are chained
//
// A rate that could not be found is null rather than 1. Treating a missing
// rate as parity is how a set of books quietly stops adding up.

import { uid } from './ids.mjs'
import { CURRENCIES } from './money.mjs'

export const PPM = 1_000_000

export async function setRate(db, { asset, quote, rate_ppm, on_date, source = null }) {
  const seen = await db.get(
    'SELECT * FROM asset_rate WHERE asset = ? AND quote = ? AND on_date = ?',
    asset, quote, on_date)
  if (seen) {
    await db.run('UPDATE asset_rate SET rate_ppm = ?, source = ? WHERE id = ?',
      rate_ppm, source ?? seen.source, seen.id)
    return db.get('SELECT * FROM asset_rate WHERE id = ?', seen.id)
  }
  const id = uid()
  await db.run(
    'INSERT INTO asset_rate(id, asset, quote, rate_ppm, on_date, source) VALUES (?,?,?,?,?,?)',
    id, asset, quote, rate_ppm, on_date, source)
  return db.get('SELECT * FROM asset_rate WHERE id = ?', id)
}

const direct = (db, asset, quote, onDate) => db.get(
  `SELECT * FROM asset_rate WHERE asset = ? AND quote = ? AND on_date <= ?
    ORDER BY on_date DESC LIMIT 1`, asset, quote, onDate)

/**
 * The rate to use for `from` → `to` on a date, and how it was arrived at.
 * `through` is the currency to chain by when neither direction was recorded —
 * the books' own currency, usually.
 */
export async function rateOn(db, from, to, onDate, { through = null } = {}) {
  if (from === to) return { rate_ppm: PPM, via: 'same', on_date: onDate, source: null }
  const straight = await direct(db, from, to, onDate)
  if (straight) {
    return {
      rate_ppm: straight.rate_ppm, via: 'direct',
      on_date: straight.on_date, source: straight.source,
    }
  }
  const other = await direct(db, to, from, onDate)
  if (other) {
    return {
      rate_ppm: Math.round((PPM * PPM) / other.rate_ppm), via: 'inverse',
      on_date: other.on_date, source: other.source,
    }
  }
  if (through && through !== from && through !== to) {
    const a = await rateOn(db, from, through, onDate)
    const b = await rateOn(db, through, to, onDate)
    if (a && b) {
      return {
        rate_ppm: Math.round((a.rate_ppm * b.rate_ppm) / PPM),
        via: 'through',
        on_date: [a.on_date, b.on_date].sort()[0],
        source: `${from}→${through}→${to}`,
      }
    }
  }
  return null
}

/** Minor units of `to` for minor units of `from`, both currencies given so the
 *  decimals line up (yen has none, dinar has three). */
export function convert(amount, ratePpm, { fromMinor = 2, toMinor = 2 } = {}) {
  const scaled = (amount * ratePpm) / PPM
  return Math.round(scaled * 10 ** (toMinor - fromMinor))
}

const minorOf = (ccy) => CURRENCIES[ccy]?.minor ?? 2

/**
 * The same conversion with the decimals looked up rather than assumed.
 *
 * This is the one that should be used on money: riel has no minor unit and the
 * dollar has two, so converting ONE HUNDRED dollars at four thousand one
 * hundred is four hundred and ten thousand riel — not forty-one million, which
 * is what happens when both sides are assumed to have cents.
 */
export const convertMoney = (amount, ratePpm, from, to) =>
  convert(amount, ratePpm, { fromMinor: minorOf(from), toMinor: minorOf(to) })

/** The rate turned over, for going back the other way. */
export const invert = (ratePpm) => Math.round((PPM * PPM) / ratePpm)

/** A rate typed as a number — 36.25 — as parts per million. */
export const toPpm = (rate) => Math.round(Number(rate) * PPM)
export const fromPpm = (ppm) => ppm / PPM

/** Every rate in force on a date, for showing what the books are using. */
export const ratesInForce = (db, onDate) => db.all(
  `SELECT asset, quote, rate_ppm, MAX(on_date) AS on_date, source
     FROM asset_rate WHERE on_date <= ? GROUP BY asset, quote
   ORDER BY asset, quote`, onDate)
