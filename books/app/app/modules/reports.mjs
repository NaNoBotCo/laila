// reports.mjs — the questions the books exist to answer.
//
// Each function returns DATA. Turning it into something to read is render.mjs's
// job, so the same figures can go to a screen, a text file, a page or a CSV
// without being computed twice or differently.

import { splitByWeights } from '../lib/money.mjs'
import { trialBalance, profitAndLoss, byProject } from './books.mjs'
import { holdingsOn } from './entities.mjs'
import { openDocs, ageBuckets } from './documents.mjs'

/** Money that is actually there, per cash account. */
export async function cashPosition(db, entityId, { asOf = null } = {}) {
  const rows = await db.all(
    `SELECT a.code, a.name_en, a.name_th, COALESCE(SUM(l.amount),0) AS balance
       FROM account a
       LEFT JOIN journal_line l ON l.account_id = a.id
       LEFT JOIN journal j ON j.id = l.journal_id
      WHERE a.entity_id = ? AND a.subtype = 'cash'
        AND (? IS NULL OR j.on_date IS NULL OR j.on_date <= ?)
      GROUP BY a.id ORDER BY a.code`, entityId, asOf, asOf)
  return { rows, total: rows.reduce((a, r) => a + r.balance, 0) }
}

/** Who owes the business, and what the business owes. */
export async function whoOwesWhat(db, entityId, { asOf }) {
  const receivable = await openDocs(db, entityId, { direction: 'out', asOf })
  const payable = await openDocs(db, entityId, { direction: 'in', asOf })
  return {
    receivable, payable,
    receivableTotal: receivable.reduce((a, d) => a + d.outstanding, 0),
    payableTotal: payable.reduce((a, d) => a + d.outstanding, 0),
    receivableAged: ageBuckets(receivable, asOf),
    payableAged: ageBuckets(payable, asOf),
  }
}

/**
 * What each partner's share of a period comes to, and where they stand.
 *
 * The result is split by shareholding in force at the end of the period, with
 * the odd satang going to the largest holder so the parts add back to the
 * whole. A share of a result is NOT a distribution: nothing is posted here,
 * and taking money out is a drawing, which shows in its own column.
 */
export async function partnerStatement(db, entityId, { from, to }) {
  const pl = await profitAndLoss(db, entityId, { from, to })
  const holdings = await holdingsOn(db, entityId, to)
  const shares = splitByWeights(pl.result, holdings.map((h) => h.share_bp))
  const tb = await trialBalance(db, entityId, { to })

  const partners = []
  for (const [i, h] of holdings.entries()) {
    const capital = tb.rows
      .filter((r) => r.subtype === 'equity_partner' && r.code.startsWith('30'))
      .find((r) => r.name_en.endsWith(h.name_en))
    const drawings = tb.rows
      .filter((r) => r.subtype === 'equity_partner' && r.code.startsWith('31'))
      .find((r) => r.name_en.endsWith(h.name_en))
    partners.push({
      person_id: h.person_id,
      code: h.person_code,
      name_en: h.name_en,
      name_th: h.name_th,
      share_bp: h.share_bp,
      share_of_result: shares[i],
      capital: capital ? -capital.balance : 0,
      drawings: drawings ? drawings.balance : 0,
    })
  }
  return { from, to, result: pl.result, income: pl.incomeTotal, expense: pl.expenseTotal, partners }
}

/**
 * VAT for a month: output tax charged, input tax paid, and the difference —
 * which is the figure on the return, and which is a refund claim when input
 * runs ahead of output.
 */
export async function vatReport(db, entityId, { ym }) {
  const sales = await db.all(
    `SELECT d.number, d.issue_date, d.net, d.vat, p.name_en AS party_name_en,
            p.name_th AS party_name_th,
            p.name_km AS party_name_km, p.tax_id
       FROM doc d JOIN party p ON p.id = d.party_id
      WHERE d.entity_id = ? AND d.direction = 'out' AND d.status <> 'draft'
        AND substr(d.issue_date,1,7) = ? AND d.vat <> 0
      ORDER BY d.issue_date, d.number`, entityId, ym)
  const purchases = await db.all(
    `SELECT d.number, d.ref_external, d.issue_date, d.net, d.vat,
            p.name_en AS party_name_en, p.name_th AS party_name_th,
            p.name_km AS party_name_km, p.tax_id
       FROM doc d JOIN party p ON p.id = d.party_id
      WHERE d.entity_id = ? AND d.direction = 'in' AND d.status <> 'draft'
        AND substr(d.issue_date,1,7) = ? AND d.vat <> 0
      ORDER BY d.issue_date, d.number`, entityId, ym)
  const outputTax = sales.reduce((a, r) => a + r.vat, 0)
  const inputTax = purchases.reduce((a, r) => a + r.vat, 0)
  return { ym, sales, purchases, outputTax, inputTax, payable: outputTax - inputTax }
}

/**
 * Withholding, both directions: tax the business withheld from suppliers and
 * owes the Revenue Department, and tax customers withheld from it, which is
 * money already paid against its own tax and needs the certificate to prove.
 */
export async function whtReport(db, entityId, { ym }) {
  const withheld = await db.all(
    `SELECT p.on_date, p.wht_amount, p.wht_cert_no, y.name_en, y.name_th, y.tax_id,
            y.is_company
       FROM payment p JOIN party y ON y.id = p.party_id
      WHERE p.entity_id = ? AND p.direction = 'out' AND p.wht_amount > 0
        AND substr(p.on_date,1,7) = ? ORDER BY p.on_date`, entityId, ym)
  const suffered = await db.all(
    `SELECT p.on_date, p.wht_amount, p.wht_cert_no, y.name_en, y.name_th, y.tax_id
       FROM payment p JOIN party y ON y.id = p.party_id
      WHERE p.entity_id = ? AND p.direction = 'in' AND p.wht_amount > 0
        AND substr(p.on_date,1,7) = ? ORDER BY p.on_date`, entityId, ym)
  return {
    ym,
    pnd3: withheld.filter((r) => !r.is_company),
    pnd53: withheld.filter((r) => r.is_company),
    suffered,
    withheldTotal: withheld.reduce((a, r) => a + r.wht_amount, 0),
    sufferedTotal: suffered.reduce((a, r) => a + r.wht_amount, 0),
    missingCertificates: suffered.filter((r) => !r.wht_cert_no).length,
  }
}

/** One line per project: what it earned, what it cost, what it left. */
export async function projectScoreboard(db, entityId, { from, to }) {
  const rows = await byProject(db, entityId, { from, to })
  return rows
}

/** Everything the screen needs in one call, for a date. */
export async function dashboard(db, entityId, { asOf }) {
  const ym = asOf.slice(0, 7)
  const monthStart = `${ym}-01`
  const [cash, owed, pl, projects] = await Promise.all([
    cashPosition(db, entityId, { asOf }),
    whoOwesWhat(db, entityId, { asOf }),
    profitAndLoss(db, entityId, { from: monthStart, to: asOf }),
    byProject(db, entityId, { from: monthStart, to: asOf }),
  ])
  return { asOf, cash, owed, pl, projects }
}
