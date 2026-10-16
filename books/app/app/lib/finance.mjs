// finance.mjs — instalments, four ways.
//
// A business that sells on terms gets asked the same question in different
// words: what does it cost to pay over time? The answer depends on the shape
// of the arrangement, and the shapes differ in more than their label —
// one charges for the use of money, the others charge for a thing, its use, or
// a share in it.
//
// So the arithmetic for all of them lives here side by side, produces the same
// kind of schedule, and reports the same totals — which is the only way a
// comparison means anything. Every function returns what is paid, when, and
// what the whole thing comes to.
//
// Nothing here rules on whether an arrangement is permissible: that is between
// the parties and whoever they ask. The code's job is the numbers.

const bp = (amount, rate) => Math.round((amount * rate) / 10000)
const roundTo = (v) => Math.round(v)

/** Equal instalments over n months at a nominal annual rate: the conventional
 *  shape, where each payment is part interest on the balance and part capital. */
export function amortise({ principal, annualRateBp, months, firstDate = null }) {
  if (months <= 0) throw new Error('A schedule needs months.')
  const monthlyRate = annualRateBp / 10000 / 12
  const payment = monthlyRate === 0
    ? principal / months
    : (principal * monthlyRate) / (1 - (1 + monthlyRate) ** -months)
  let balance = principal
  const rows = []
  for (let n = 1; n <= months; n++) {
    const interest = roundTo(balance * monthlyRate)
    let capital = roundTo(payment) - interest
    if (n === months) capital = balance                 // the last one clears it
    balance -= capital
    rows.push({
      n,
      on: firstDate ? addMonths(firstDate, n - 1) : null,
      payment: interest + capital,
      interest,
      capital,
      balance: Math.max(0, balance),
    })
  }
  const total = rows.reduce((a, r) => a + r.payment, 0)
  return {
    kind: 'interest',
    rows,
    total,
    cost: total - principal,
    principal,
    note: 'interest on the outstanding balance',
  }
}

/** Thailand's hire-purchase habit: a flat rate on the original amount for the
 *  whole term, which reads lower than it is. Shown beside its true equivalent. */
export function flatRate({ principal, annualRateBp, months }) {
  const charge = roundTo((principal * (annualRateBp / 10000) * months) / 12)
  const payment = roundTo((principal + charge) / months)
  const rows = Array.from({ length: months }, (_, i) => ({
    n: i + 1,
    payment: i === months - 1 ? principal + charge - payment * (months - 1) : payment,
    interest: roundTo(charge / months),
    capital: payment - roundTo(charge / months),
    balance: 0,
  }))
  return {
    kind: 'flat',
    rows,
    total: principal + charge,
    cost: charge,
    principal,
    effectiveAnnualBp: effectiveRateBp(principal, payment, months),
    note: 'a flat charge on the original amount',
  }
}

/**
 * The equivalent reducing-balance rate for a given payment — what a flat rate
 * actually costs, found by bisection because there is no closed form.
 */
export function effectiveRateBp(principal, payment, months) {
  if (payment * months <= principal) return 0
  let lo = 0
  let hi = 2
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    const value = mid === 0
      ? payment * months
      : (payment * (1 - (1 + mid / 12) ** -months)) / (mid / 12)
    if (value > principal) lo = mid
    else hi = mid
  }
  return Math.round(((lo + hi) / 2) * 10000)
}

/**
 * Cost-plus sale (murabaha). The seller buys the thing, discloses what it cost,
 * adds an agreed profit, and sells it on terms. The price is fixed at the
 * outset: it does not grow if payment is late, and there is no rate running.
 */
export function costPlus({ cost, markupBp = null, markupAmount = null, months, firstDate = null }) {
  const profit = markupAmount ?? bp(cost, markupBp ?? 0)
  const price = cost + profit
  const each = Math.floor(price / months)
  const rows = Array.from({ length: months }, (_, i) => ({
    n: i + 1,
    on: firstDate ? addMonths(firstDate, i) : null,
    payment: i === months - 1 ? price - each * (months - 1) : each,
    // Profit is recognised evenly across the term rather than front-loaded:
    // nothing is being charged for time, so nothing accrues.
    profit: Math.round(profit / months),
    capital: each - Math.round(profit / months),
    balance: price - each * (i + 1),
  }))
  return {
    kind: 'cost_plus',
    rows,
    total: price,
    cost: profit,
    principal: cost,
    price,
    comparableAnnualBp: effectiveRateBp(cost, each, months),
    note: 'a disclosed cost, an agreed profit, and a price that does not move',
  }
}

/**
 * Lease (ijara). The owner keeps the asset and charges for its use; ownership
 * transfers at the end only if that was agreed separately.
 */
export function lease({ assetCost, months, rental, residual = 0, transfer = false, firstDate = null }) {
  const rows = Array.from({ length: months }, (_, i) => ({
    n: i + 1,
    on: firstDate ? addMonths(firstDate, i) : null,
    payment: rental,
    rental,
    balance: 0,
  }))
  const total = rental * months + (transfer ? residual : 0)
  return {
    kind: 'lease',
    rows,
    total,
    cost: total - assetCost,
    principal: assetCost,
    residual,
    transfer,
    note: transfer ? 'rent for use, then transfer at the residual' : 'rent for use; the asset stays with the owner',
  }
}

/**
 * Declining partnership (diminishing musharaka). Two parties own the asset in
 * shares; the user buys the other's share in steps and pays rent on whatever
 * share they do not yet own, so the rent falls as ownership rises.
 */
export function decliningShare({
  assetCost, financierShareBp, months, annualRentBp, firstDate = null,
}) {
  const financierStake = bp(assetCost, financierShareBp)
  const stepped = Math.floor(financierStake / months)
  let held = financierStake
  const rows = []
  for (let n = 1; n <= months; n++) {
    const buy = n === months ? held : stepped
    const rent = roundTo((held * (annualRentBp / 10000)) / 12)
    held -= buy
    rows.push({
      n,
      on: firstDate ? addMonths(firstDate, n - 1) : null,
      payment: buy + rent,
      capital: buy,
      rent,
      balance: Math.max(0, held),
    })
  }
  const total = rows.reduce((a, r) => a + r.payment, 0)
  return {
    kind: 'declining_share',
    rows,
    total,
    cost: total - financierStake,
    principal: financierStake,
    note: 'rent on the share still held, falling as it is bought out',
  }
}

/**
 * A loan at no charge (qard hasan), with an administrative fee that may cover
 * what the arrangement actually costs to run and no more. The fee is capped
 * here rather than expressed as a rate, which is the whole point.
 */
export function noChargeLoan({ principal, months, adminFee = 0, feeCap = null, firstDate = null }) {
  const fee = feeCap == null ? adminFee : Math.min(adminFee, feeCap)
  const each = Math.floor((principal + fee) / months)
  const rows = Array.from({ length: months }, (_, i) => ({
    n: i + 1,
    on: firstDate ? addMonths(firstDate, i) : null,
    payment: i === months - 1 ? principal + fee - each * (months - 1) : each,
    capital: each,
    balance: principal + fee - each * (i + 1),
  }))
  return {
    kind: 'no_charge',
    rows,
    total: principal + fee,
    cost: fee,
    principal,
    note: 'repayment plus a stated administrative cost',
  }
}

/**
 * Late payment, two ways. Interest on the overdue amount grows with the delay
 * and is income; a fixed late charge does not grow, and where the arrangement
 * says the charge is not to be kept, it is recorded as payable to a charity
 * rather than as revenue.
 */
export function latePayment({ overdue, days, annualRateBp = 0, fixedCharge = 0, toCharity = false }) {
  const interest = roundTo((overdue * (annualRateBp / 10000) * days) / 365)
  return {
    interest,
    fixedCharge,
    keepsGrowing: annualRateBp > 0,
    // Where a charge is not to be kept, it is a liability the moment it is
    // charged, not income that is given away later.
    account: toCharity ? 'payable_to_charity' : 'other_income',
    total: annualRateBp > 0 ? interest : fixedCharge,
  }
}

/** Same total, different shapes — for putting two offers side by side. */
export function compare(schedules) {
  return schedules.map((s) => ({
    kind: s.kind,
    total: s.total,
    cost: s.cost,
    monthly: s.rows[0]?.payment ?? 0,
    months: s.rows.length,
    note: s.note,
  })).sort((a, b) => a.total - b.total)
}

function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}
