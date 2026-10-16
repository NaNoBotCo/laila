// change.mjs — the counter, where two currencies meet.
//
// In Phnom Penh a bill is in dollars, the customer hands over dollars, and the
// change comes back as dollars for the whole units and riel for the rest —
// because there are no cents in circulation. The riel is rounded to the nearest
// hundred, because there are no small coins either.
//
// Every till in the country does this arithmetic and almost no software does,
// so the amounts get worked out on a phone and typed back in wrong. It is four
// lines of maths and it belongs in the books.

import { CURRENCIES } from './money.mjs'

const minorOf = (ccy) => CURRENCIES[ccy]?.minor ?? 2
const factorOf = (ccy) => 10 ** minorOf(ccy)

/**
 * What to hand back.
 *
 * @param due        what the bill comes to, in `currency` minor units
 * @param tendered   what was handed over, in `currency` minor units
 * @param currency   the currency the bill is in
 * @param change_in  the currency small change comes back in
 * @param rate_ppm   units of `change_in` for one whole `currency`
 * @param round_to   minor units of `change_in` to round to (no small coins)
 *
 * Returns the split, and the rounding as its own number so it can be seen —
 * a till that quietly keeps the rounding is a till nobody trusts twice.
 */
export function changeFor({
  due, tendered, currency = 'USD', change_in = 'KHR', rate_ppm, round_to = 10_000,
  round = 'nearest',
}) {
  const owed = tendered - due
  if (owed <= 0) {
    return { short: -owed, whole: 0, small: 0, rounding: 0, owed, enough: owed === 0 }
  }
  if (currency === change_in || !rate_ppm) {
    return { whole: owed, small: 0, rounding: 0, owed, enough: true, currency, change_in: currency }
  }

  // Whole units of the bill's currency first — a five-dollar note is better
  // change than twenty thousand riel.
  const factor = factorOf(currency)
  const whole = Math.floor(owed / factor) * factor
  const remainder = owed - whole

  // The rest crosses into the change currency and lands on a coin that exists.
  const exact = Math.round((remainder / factor) * (rate_ppm / 1_000_000) * factorOf(change_in))
  const steps = round === 'up' ? Math.ceil(exact / round_to)
    : round === 'down' ? Math.floor(exact / round_to)
      : Math.round(exact / round_to)
  const small = steps * round_to

  return {
    owed,
    whole,
    small,
    // What the rounding came to, in the change currency and from the shop's
    // side: positive means the customer got the extra. Sub-cent differences
    // vanish if this is expressed in dollars, which is exactly the number
    // people argue about, so it stays in riel.
    rounding: small - exact,
    exact,
    currency,
    change_in,
    enough: true,
  }
}

/**
 * The other direction: a customer pays part in dollars and part in riel, which
 * is just as common. What is that worth against the bill?
 */
export function tenderedValue(parts, { currency = 'USD', rate_ppm }) {
  let total = 0
  for (const { amount, currency: ccy } of parts) {
    if (!amount) continue
    if (ccy === currency) { total += amount; continue }
    if (!rate_ppm) continue
    total += Math.round((amount / factorOf(ccy)) * (1_000_000 / rate_ppm) * factorOf(currency))
  }
  return total
}
