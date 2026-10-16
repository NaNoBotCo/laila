// payroll.mjs — a month of pay, and the three things taken out of it.
//
// One employment row covers both shapes of worker: a salaried month and a
// ฿600 half day are the same row with a different `pay_unit`, so the pay run
// counts units rather than knowing who is who.
//
// What the employer does with the deductions matters more than the deductions:
// social security is collected from the person AND matched by the company,
// and withheld income tax is the company's estimate of the person's year. Both
// leave the wage account on the day of the payslip and sit as a liability
// until the filing is made, which is why the filing calendar in
// compliance.mjs reads off these two accounts.
//
// Every rate a slip used is written onto the slip. A payslip is a statement to
// a person about their own money and it has to keep saying the same thing
// after the rates move.

import { uid } from '../lib/ids.mjs'
import { ratesInForce, bandsOn } from '../lib/tax.mjs'
import { jurisdictionFor, codeFor } from '../lib/jurisdictions/index.mjs'
import { rateOn as fxRateOn, convertMoney, invert, PPM } from '../lib/fx.mjs'
import { post, accountByCode, accountBySubtype, PostingError } from './books.mjs'
import { recordPayment } from './documents.mjs'

export async function addEmployment(db, {
  entity_id, person_id, title_en = null, title_th = null, title_km = null, pay_unit = 'month',
  pay_rate, currency = null, hours_per_day = 8, start_date, sso_registered = 0,
  sso_from = null, tax_withheld = 0, allowances = null, cost_centre = 'company',
  contract_ref = null, note = null,
}) {
  const seen = await db.get(
    'SELECT * FROM employment WHERE entity_id = ? AND person_id = ? AND start_date = ?',
    entity_id, person_id, start_date)
  if (seen) return seen
  const books = await db.get('SELECT currency FROM entity WHERE id = ?', entity_id)
  const id = uid()
  await db.run(
    `INSERT INTO employment(id, entity_id, person_id, title_en, title_th, title_km,
       pay_unit, pay_rate, currency, hours_per_day, start_date, sso_registered,
       sso_from, tax_withheld, allowances, cost_centre, contract_ref, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entity_id, person_id, title_en, title_th, title_km, pay_unit, pay_rate,
    currency || books?.currency || 'THB',
    hours_per_day, start_date, sso_registered ? 1 : 0, sso_from, tax_withheld ? 1 : 0,
    allowances ? JSON.stringify(allowances) : null, cost_centre, contract_ref, note)
  return db.get('SELECT * FROM employment WHERE id = ?', id)
}

const bp = (row, fallback) => (row?.value_bp ?? fallback)
const amt = (row, fallback) => (row?.value_satang ?? fallback)

/**
 * What one person is paid this month, and what comes off it.
 *
 * `units_milli` is thousandths of the pay unit: 1000 for a full salaried
 * month, 11000 for eleven half days. A monthly wage is not pro-rated by unit
 * count unless fewer than a full unit is passed, so a normal month needs no
 * arithmetic at all.
 */
/**
 * What one person is paid this month, and what comes off it.
 *
 * `units_milli` is thousandths of the pay unit: 1000 for a full salaried month,
 * 11000 for eleven half days. What comes OFF the gross is the country's
 * business, not this module's — the jurisdiction pack is handed the rates in
 * force and returns the deductions, so Thailand's annualised withholding and
 * Cambodia's monthly ladder live where they belong.
 */
export async function computePayslip(db, employment, {
  ym, units_milli = 1000, other_deduct = 0, tax_paid_so_far = 0, periods_remaining = null,
}) {
  const onDate = `${ym}-01`
  const gross = Math.round((employment.pay_rate * units_milli) / 1000)

  const entity = await db.get('SELECT * FROM entity WHERE id = ?', employment.entity_id)
  const country = codeFor(entity?.country)
  const pack = jurisdictionFor(country)
  const rate = await ratesInForce(db, onDate, country)
  const bands = await bandsOn(db, onDate, country)
  const allowances = employment.allowances ? JSON.parse(employment.allowances) : {}

  // THE LAW COUNTS IN ITS OWN CURRENCY. Phnom Penh pays most salaries in
  // dollars, and the tax ladder, the reliefs and the fund's floor and ceiling
  // are all written in riel — so the pay is converted, the deductions are
  // worked out where the thresholds live, and the answers come back into the
  // currency the person is actually paid in. The rate used is kept on the slip.
  const paidIn = employment.currency || entity?.currency || pack.CURRENCY
  const statutory = pack.STATUTORY_CURRENCY || pack.CURRENCY
  let statRate = PPM
  if (paidIn !== statutory) {
    const found = await fxRateOn(db, paidIn, statutory, onDate, { through: statutory })
    if (!found) {
      throw new PostingError('no_fx_rate',
        `No rate for ${paidIn} to ${statutory} on ${onDate}; the deductions are written in ${statutory}.`)
    }
    statRate = found.rate_ppm
  }
  const intoStatutory = (v) => (statRate === PPM ? v : convertMoney(v, statRate, paidIn, statutory))
  const backToPay = (v) => (statRate === PPM ? v : convertMoney(v, invert(statRate), statutory, paidIn))

  const off = pack.payrollDeductions({
    gross: intoStatutory(gross), ym, employment, allowances, rate, bands,
    tax_paid_so_far: intoStatutory(tax_paid_so_far), periods_remaining,
  })

  const social_employee = backToPay(off.social_employee)
  const social_employer = backToPay(off.social_employer)
  const tax = backToPay(off.tax)
  const net = gross - social_employee - tax - other_deduct
  return {
    gross,
    sso_employee: social_employee,
    sso_employer: social_employer,
    wht: tax,
    other_deduct,
    net,
    sso_rate_bp: off.social_rate_bp,
    sso_cap: off.social_cap,
    wht_basis: statRate === PPM
      ? off.working
      : {
        ...off.working,
        paid_in: paidIn,
        computed_in: statutory,
        rate_ppm: statRate,
        gross_statutory: intoStatutory(gross),
      },
    units_milli,
    employer_cost: gross + social_employer,
    currency: paidIn,
    country,
  }
}

/**
 * Build a month's run as a DRAFT. Nothing is posted and nothing is paid; the
 * numbers can be looked at, and a wrong one is fixed by deleting the draft run
 * and building it again.
 */
export async function createPayRun(db, { entity_id, ym, pay_date, entries }) {
  const seen = await db.get('SELECT * FROM pay_run WHERE entity_id = ? AND ym = ?', entity_id, ym)
  if (seen && seen.status !== 'draft') {
    throw new PostingError('run_exists', `${ym} is already ${seen.status}.`)
  }
  const runId = seen?.id ?? uid()
  if (!seen) {
    await db.run('INSERT INTO pay_run(id, entity_id, ym, pay_date) VALUES (?,?,?,?)',
      runId, entity_id, ym, pay_date)
  } else {
    await db.run('DELETE FROM payslip WHERE pay_run_id = ?', runId)
    await db.run('UPDATE pay_run SET pay_date = ? WHERE id = ?', pay_date, runId)
  }

  const slips = []
  for (const e of entries) {
    const employment = await db.get('SELECT * FROM employment WHERE id = ?', e.employment_id)
    if (!employment) throw new PostingError('not_found', `No employment ${e.employment_id}.`)
    const c = await computePayslip(db, employment, { ym, ...e })
    const id = uid()
    await db.run(
      `INSERT INTO payslip(id, pay_run_id, employment_id, person_id, units_milli,
         gross, sso_employee, sso_employer, wht, other_deduct, net,
         sso_rate_bp, sso_cap, wht_basis)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, runId, employment.id, employment.person_id, c.units_milli, c.gross,
      c.sso_employee, c.sso_employer, c.wht, c.other_deduct, c.net,
      c.sso_rate_bp, c.sso_cap, c.wht_basis ? JSON.stringify(c.wht_basis) : null)

    // The wording of a payslip line in each language the books are read in.
    const lines = [
      ['earning', 'basic', 'Basic pay', 'เงินเดือน', 'ប្រាក់បៀវត្សមូលដ្ឋាន', c.gross],
      ['deduction', 'sso', 'Social security', 'ประกันสังคม', 'វិភាគទាន បសស', -c.sso_employee],
      ['deduction', 'wht', 'Withholding tax', 'ภาษีหัก ณ ที่จ่าย', 'ពន្ធលើប្រាក់បៀវត្ស', -c.wht],
      ['deduction', 'other', 'Other deductions', 'รายการหักอื่น', 'ការកាត់ផ្សេងៗ', -c.other_deduct],
      ['employer_cost', 'sso_er', 'Social security — employer', 'ประกันสังคม — นายจ้าง',
        'វិភាគទាន បសស — និយោជក', c.sso_employer],
    ].filter((l) => l[5] !== 0)
    let seq = 0
    for (const [kind, code, en, th, kmText, amount] of lines) {
      await db.run(
        `INSERT INTO payslip_line(id, payslip_id, seq, kind, code, desc_en, desc_th, desc_km, amount)
         VALUES (?,?,?,?,?,?,?,?,?)`, uid(), id, seq++, kind, code, en, th, kmText, amount)
    }
    slips.push(await db.get('SELECT * FROM payslip WHERE id = ?', id))
  }
  return { run: await db.get('SELECT * FROM pay_run WHERE id = ?', runId), slips }
}

/**
 * Approve the run and post it. Wages become an expense on the day the work was
 * paid for; what has not left the bank yet sits in wages payable, and the two
 * tax liabilities sit until their filings.
 */
export async function approvePayRun(db, runId, { posted_by = null } = {}) {
  const run = await db.get('SELECT * FROM pay_run WHERE id = ?', runId)
  if (!run) throw new PostingError('not_found', 'No such pay run.')
  if (run.status !== 'draft') return run
  const slips = await db.all(
    `SELECT s.*, e.cost_centre, e.person_id AS pid FROM payslip s
       JOIN employment e ON e.id = s.employment_id WHERE s.pay_run_id = ?`, runId)
  if (!slips.length) throw new PostingError('empty', 'This run has no payslips.')

  const wages = await accountByCode(db, run.entity_id, '6000')
  const erSso = await accountByCode(db, run.entity_id, '6010')
  const ssoPay = await accountBySubtype(db, run.entity_id, 'sso')
  const whtPay = await accountByCode(db, run.entity_id, '2210')
  const netPay = await accountByCode(db, run.entity_id, '2400')

  const lines = []
  for (const s of slips) {
    const cc = s.cost_centre
    lines.push({ account: wages.id, amount: s.gross, person_id: s.pid, cost_centre: cc })
    if (s.sso_employer) {
      lines.push({ account: erSso.id, amount: s.sso_employer, person_id: s.pid, cost_centre: cc })
    }
    if (s.sso_employee + s.sso_employer) {
      lines.push({ account: ssoPay.id, amount: -(s.sso_employee + s.sso_employer), person_id: s.pid, cost_centre: cc })
    }
    if (s.wht) lines.push({ account: whtPay.id, amount: -s.wht, person_id: s.pid, cost_centre: cc })
    lines.push({ account: netPay.id, amount: -s.net, person_id: s.pid, cost_centre: cc })
  }

  const journal = await post(db, {
    entity_id: run.entity_id,
    on_date: run.pay_date,
    memo_en: `Payroll ${run.ym}`,
    memo_th: `เงินเดือน ${run.ym}`,
    source_kind: 'pay_run',
    source_id: runId,
    idem_key: `payrun:${runId}`,
    posted_by,
    lines,
  })
  await db.run(
    `UPDATE pay_run SET status = 'approved', journal_id = ?, approved_by = ?,
       approved_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    journal.id, posted_by, runId)
  return db.get('SELECT * FROM pay_run WHERE id = ?', runId)
}

/** Pay a slip: the money leaves, and wages payable comes down by the net. */
export async function payPayslip(db, payslipId, { on_date, account = '1010', method = 'transfer', slip_ref = null, posted_by = null }) {
  const slip = await db.get(
    `SELECT s.*, r.entity_id, r.ym FROM payslip s JOIN pay_run r ON r.id = s.pay_run_id
      WHERE s.id = ?`, payslipId)
  if (!slip) throw new PostingError('not_found', 'No such payslip.')
  const netPay = await accountByCode(db, slip.entity_id, '2400')
  const bank = await accountByCode(db, slip.entity_id, account)
  const journal = await post(db, {
    entity_id: slip.entity_id,
    on_date,
    memo_en: `Wage paid ${slip.ym}`,
    source_kind: 'payslip',
    source_id: payslipId,
    idem_key: `payslip:paid:${payslipId}`,
    posted_by,
    lines: [
      { account: netPay.id, amount: slip.net, person_id: slip.person_id },
      { account: bank.id, amount: -slip.net, person_id: slip.person_id, memo: slip_ref },
    ],
  })
  await db.run(
    "UPDATE payslip SET paid_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?", payslipId)
  return journal
}

/** Everything one person was paid in a year — the PND1Kor working. */
export async function yearToDate(db, entityId, personId, year) {
  const rows = await db.all(
    `SELECT r.ym, s.gross, s.sso_employee, s.wht, s.net FROM payslip s
       JOIN pay_run r ON r.id = s.pay_run_id
      WHERE r.entity_id = ? AND s.person_id = ? AND r.ym LIKE ?
        AND r.status IN ('approved','paid')
      ORDER BY r.ym`, entityId, personId, `${year}-%`)
  const sum = (k) => rows.reduce((a, r) => a + r[k], 0)
  return {
    rows,
    gross: sum('gross'), sso: sum('sso_employee'), wht: sum('wht'), net: sum('net'),
  }
}
