// seed-kh.mjs — the Cambodian sample: a small practice in Phnom Penh.
//
// The same shape as the Chiang Mai sample and none of the same law. Riel rather
// than baht, ten percent rather than seven, fifteen percent withheld on a
// service rather than three, the social security fund's three schemes rather
// than one, and a filing calendar that runs on the twentieth with five more
// days for filing online.
//
// Sample figures, round on purpose. The shape is not: several lines of work
// under one company, money owed both ways, books kept for other people, and
// receipts arriving from clients who will never learn the software.

import { createEntity, addProject, addPerson, addMembership, ensurePartnerAccounts, setHolding } from './modules/entities.mjs'
import { post } from './modules/books.mjs'
import { draft, issue, recordPayment } from './modules/documents.mjs'
import { addPlan, subscribe, runBilling } from './modules/subscriptions.mjs'
import { addEmployment, createPayRun, approvePayRun, payPayslip } from './modules/payroll.mjs'
import { generateFilings, markLate, markFiled } from './modules/compliance.mjs'
import { openChannel, receive } from './modules/intake.mjs'
import { addMethod } from './modules/paying.mjs'
import { seedYear } from './modules/calendar.mjs'
import { addBankAccount } from './modules/banks.mjs'
import { setRate as setFxRate, toPpm } from './lib/fx.mjs'
import { uid } from './lib/ids.mjs'
import { localDate } from './lib/clock.mjs'

const DAY = 86400000
const dayOffset = (n, from = localDate()) =>
  new Date(Date.parse(`${from}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
const firstOfMonth = (offset = 0, from = localDate()) => {
  const [y, m] = from.split('-').map(Number)
  const t = y * 12 + (m - 1) + offset
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}-01`
}
const lastOfMonth = (offset = 0) => dayOffset(-1, firstOfMonth(offset + 1))

export const BRAND_KH = {
  name_en: 'Angkor Books & Services',
  name_km: 'អង្គរ សៀវភៅ និង សេវាកម្ម',
  mark: 'អ',
  accent: '#1d4e89',
  city: 'Phnom Penh',
  locale: 'en',
  locales: ['en', 'km'],
  country: 'KH',
}

async function party(db, entityId, p) {
  const id = uid()
  await db.run(
    `INSERT INTO party(id, entity_id, code, name_en, name_km, kind, tax_id, is_company,
       address_en, address_km, email, terms_days)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entityId, p.code, p.name_en, p.name_km ?? null, p.kind ?? 'both',
    p.tax_id ?? null, p.is_company ?? 1, p.address_en ?? null, p.address_km ?? null,
    p.email ?? null, p.terms_days ?? 0)
  return db.get('SELECT * FROM party WHERE id = ?', id)
}

const acc = async (db, entityId, code) =>
  (await db.get('SELECT id FROM account WHERE entity_id = ? AND code = ?', entityId, code)).id

/** One client's books, kept by the practice. */
async function client(db, spec) {
  const entity = await createEntity(db, {
    code: spec.code,
    name_en: spec.name_en,
    name_km: spec.name_km,
    kind: spec.kind,
    country: 'KH',
    tax_id: spec.tax_id,
    vat_registered: spec.vat ? 1 : 0,
    vat_from: spec.vat ? `${localDate().slice(0, 4)}-01-01` : null,
    address_en: spec.address_en,
    locale: 'km',
    second_locale: 'km',
    note: spec.note,
  })
  const line = await addProject(db, entity.id, {
    code: `${spec.code}-main`, name_en: spec.line_en, name_km: spec.line_km, lane: spec.lane,
  })
  const customers = []
  for (const c of spec.customers) customers.push(await party(db, entity.id, c))
  const suppliers = []
  for (const s of spec.suppliers) suppliers.push(await party(db, entity.id, s))

  await post(db, {
    entity_id: entity.id,
    on_date: dayOffset(-75),
    memo_en: 'Opening balance',
    memo_km: 'សមតុល្យដើមគ្រា',
    lines: [
      { account: '1010', amount: spec.opening },
      { account: '3000', amount: -spec.opening },
    ],
  })

  const revenue = await acc(db, entity.id, spec.revenue_account || '4100')
  for (const sale of spec.sales) {
    if (sale.cash) {
      const vat = spec.vat ? Math.round((sale.amount * 1000) / 11000) : 0
      await post(db, {
        entity_id: entity.id,
        on_date: sale.date,
        memo_en: sale.desc_en,
        memo_km: sale.desc_km,
        source_kind: 'takings',
        lines: [
          { account: '1000', amount: sale.amount, project_id: line.id },
          { account: spec.revenue_account || '4000', amount: -(sale.amount - vat),
            project_id: line.id, tax_code: vat ? 'VAT7' : null },
          vat ? { account: '2100', amount: -vat, tax_code: 'VAT7' } : null,
        ].filter(Boolean),
      })
      continue
    }
    const inv = await issue(db, (await draft(db, {
      entity_id: entity.id,
      kind: spec.vat ? 'tax_invoice' : 'invoice',
      party_id: customers[sale.customer ?? 0].id,
      project_id: line.id,
      issue_date: sale.date,
      due_date: dayOffset(sale.terms ?? 15, sale.date),
      wht_bp: sale.wht ?? 0,
      subject_en: sale.desc_en,
      subject_km: sale.desc_km,
      lines: [{
        desc_en: sale.desc_en, desc_km: sale.desc_km, unit_price: sale.amount,
        qty_milli: (sale.qty ?? 1) * 1000, unit: sale.unit ?? 'item',
        tax_code: spec.vat ? 'VAT7' : 'NONE', account_id: revenue, project_id: line.id,
      }],
    })).id)
    if (sale.paid) {
      await recordPayment(db, {
        entity_id: entity.id, direction: 'in', on_date: dayOffset(sale.paid_after ?? 10, sale.date),
        party_id: inv.party_id, account: '1010', amount: inv.expect_paid,
        wht_amount: inv.wht, wht_cert_no: inv.wht ? `WHT-${inv.number}` : null,
        allocations: [{ doc_id: inv.id, amount: inv.expect_paid, wht_amount: inv.wht }],
      })
    }
  }

  for (const cost of spec.costs) {
    const bill = await issue(db, (await draft(db, {
      entity_id: entity.id, kind: 'bill', party_id: suppliers[cost.supplier ?? 0].id,
      project_id: line.id, issue_date: cost.date, due_date: dayOffset(30, cost.date),
      wht_bp: cost.wht ?? 0,
      lines: [{
        desc_en: cost.desc_en, desc_km: cost.desc_km, unit_price: cost.amount,
        tax_code: spec.vat ? 'VAT7' : 'NONE',
        account_id: await acc(db, entity.id, cost.account), project_id: line.id,
      }],
    })).id)
    if (cost.paid) {
      await recordPayment(db, {
        entity_id: entity.id, direction: 'out', on_date: dayOffset(5, cost.date),
        party_id: bill.party_id, account: '1010', amount: bill.expect_paid,
        wht_amount: bill.wht, wht_cert_no: bill.wht ? `WHT-OUT-${bill.number}` : null,
        allocations: [{ doc_id: bill.id, amount: bill.expect_paid, wht_amount: bill.wht }],
      })
    }
  }

  const link = await openChannel(db, { entity_id: entity.id, kind: 'link', label: spec.name_en })
  await openChannel(db, {
    entity_id: entity.id, kind: 'email', label: 'Forward receipts',
    address: `${spec.code}@receipts.example`,
  })
  await openChannel(db, {
    entity_id: entity.id, kind: 'chat', label: 'Telegram', address: `@${spec.code}books`,
  })
  for (const item of spec.inbox || []) {
    await receive(db, {
      entity_id: entity.id, channel_id: link.id, source: item.source || 'link',
      from_ref: item.from, on_date: item.date, kind: 'bill', description: item.desc,
      amount: item.amount, party_hint: item.hint, photo_name: item.photo,
      idem_key: `seed:${spec.code}:${item.desc}:${item.date}`,
    })
  }

  const year = localDate().slice(0, 4)
  await generateFilings(db, entity.id, { from: `${year}-01-01`, to: `${Number(year) + 1}-06-30` })
  await markLate(db, entity.id, localDate())
  const done = await db.all(
    `SELECT id, due_date FROM filing WHERE entity_id = ? AND due_date < ? AND status <> 'filed'`,
    entity.id, dayOffset(spec.behind ? -40 : -8))
  for (const f of done) {
    await markFiled(db, f.id, {
      filed_on: dayOffset(-2, f.due_date), ref: `GDT-${f.due_date.replace(/-/g, '')}`,
    })
  }
  return entity
}

/** The practice's own books, and the four sets it keeps for other people. */
export async function seedKhmer(db, brand = BRAND_KH) {
  const today = localDate()
  const entity = await createEntity(db, {
    code: 'demo',
    name_en: brand.name_en,
    name_km: brand.name_km,
    kind: 'company',
    country: 'KH',
    tax_id: 'K001-901234567',
    vat_registered: 1,
    vat_from: `${today.slice(0, 4)}-01-01`,
    address_en: '31 Street 240, Chamkarmon, Phnom Penh',
    address_km: 'ផ្ទះលេខ ៣១ ផ្លូវ ២៤០ ខណ្ឌចំការមន រាជធានីភ្នំពេញ',
    locale: 'en',
    second_locale: 'km',
  })

  const owner = await addPerson(db, { code: 'owner', name_en: 'Sopheap', name_km: 'សុភាព', locale: 'km' })
  const staff1 = await addPerson(db, { code: 'dara', name_en: 'Dara', name_km: 'តារា', locale: 'km' })
  const staff2 = await addPerson(db, { code: 'chan', name_en: 'Chanthou', name_km: 'ចន្ថូ', locale: 'km' })
  const staff3 = await addPerson(db, { code: 'vuth', name_en: 'Vuthy', name_km: 'វុទ្ធី', locale: 'km' })
  await addMembership(db, { person_id: owner.id, entity_id: entity.id, role: 'owner' })
  await addMembership(db, { person_id: staff1.id, entity_id: entity.id, role: 'bookkeeper' })
  await ensurePartnerAccounts(db, entity.id, owner)
  await setHolding(db, {
    entity_id: entity.id, person_id: owner.id, share_bp: 10000,
    from_date: `${today.slice(0, 4)}-01-01`,
  })

  const project = {}
  for (const [code, en, kmName, lane] of [
    ['books', 'Bookkeeping', 'សេវាកម្មគណនេយ្យ', 'service'],
    ['tax', 'Tax filing', 'សេវាដាក់លិខិតប្រកាសពន្ធ', 'service'],
    ['company', 'Company registration', 'សេវាចុះបញ្ជីក្រុមហ៊ុន', 'service'],
    ['payrollsvc', 'Payroll service', 'សេវាគណនាប្រាក់បៀវត្ស', 'service'],
    ['training', 'Training', 'វគ្គបណ្តុះបណ្តាល', 'service'],
  ]) {
    project[code] = await addProject(db, entity.id, {
      code, name_en: en, name_km: kmName, lane,
    })
  }

  // How they take money: a bank account, and the QR their bank issues. The
  // payload is what the bank gave them — this system draws it, it does not
  // invent one.
  // Phnom Penh runs on two currencies at once: riel for the state, dollars for
  // most of the trade. Both are accounts, and the rate between them is a row.
  // The dollar account is the main one, because the trade is in dollars; the
  // riel account is for the state and for change.
  await db.run(
    `UPDATE account SET name_en = ?, name_km = ?, bank_name = ?, account_no = ?,
       is_bank = 1, currency = 'USD' WHERE entity_id = ? AND code = '1010'`,
    'ABA — dollars', 'ABA — ដុល្លារ', 'ABA Bank', '000 123 456', entity.id)
  const rielAccount = await addBankAccount(db, {
    entity_id: entity.id,
    name_en: 'ABA — riel',
    name_km: 'ABA — រៀល',
    bank_name: 'ABA Bank',
    account_no: '000 123 457',
    currency: 'KHR',
    note: 'What the tax office is paid from, and where the change comes from.',
  })
  // The cash drawer holds both: notes in dollars, change in riel.
  await db.run(
    "UPDATE account SET currency = 'USD' WHERE entity_id = ? AND code = '1000'", entity.id)
  await addBankAccount(db, {
    entity_id: entity.id, code: '1005', name_en: 'Cash drawer — riel',
    name_km: 'ថតសាច់ប្រាក់ — រៀល', currency: 'KHR',
    note: 'Change across the counter.',
  })
  for (const [on, rate] of [
    [dayOffset(-60), 4080], [dayOffset(-30), 4100], [dayOffset(-2), 4090],
  ]) {
    await setFxRate(db, {
      asset: 'USD', quote: 'KHR', rate_ppm: toPpm(rate), on_date: on,
      source: 'the bank, that morning',
    })
  }

  await addMethod(db, {
    entity_id: entity.id, kind: 'bank', label_en: 'Bank transfer', label_km: 'ផ្ទេរតាមធនាគារ',
    bank_name: 'ACLEDA Bank', account_name: 'Angkor Books & Services Co., Ltd.',
    account_no: '0001-2345678-9', account_code: '1010', direction: 'in', is_default: 1,
  })
  await addMethod(db, {
    entity_id: entity.id, kind: 'cash', label_en: 'Cash', label_km: 'សាច់ប្រាក់',
    account_code: '1000', direction: 'both',
  })

  const clients = [
    { code: 'sunrise', name_en: 'Sunrise Café Co., Ltd.', name_km: 'ក្រុមហ៊ុន សាន់រាយ កាហ្វេ',
      tax_id: 'K001-902000011', terms_days: 15 },
    { code: 'bassac', name_en: 'Bassac Garments Ltd.', name_km: 'ក្រុមហ៊ុន បាសាក់ សម្លៀកបំពាក់',
      tax_id: 'K001-902000022', terms_days: 30 },
    { code: 'riverside', name_en: 'Riverside Guesthouse', name_km: 'ផ្ទះសំណាក់រីវើសាយ',
      tax_id: 'K001-902000033', terms_days: 15 },
    { code: 'mekong', name_en: 'Mekong Tuk Tuk (Mr Vanna)', name_km: 'តុកតុកមេគង្គ (លោក វណ្ណា)',
      is_company: 0 },
  ]
  const party_ = {}
  for (const c of clients) party_[c.code] = await party(db, entity.id, c)

  const landlord = await party(db, entity.id, {
    code: 'landlord', name_en: 'Mrs Sreymom (landlord)', name_km: 'លោកស្រី ស្រីមុំ (ម្ចាស់ផ្ទះ)',
    kind: 'supplier', is_company: 0,
  })
  const isp = await party(db, entity.id, {
    code: 'isp', name_en: 'Phnom Penh Internet', name_km: 'អ៊ីនធឺណិតភ្នំពេញ', kind: 'supplier',
    tax_id: 'K001-903000011',
  })
  const printer = await party(db, entity.id, {
    code: 'print', name_en: 'Street 310 print shop', name_km: 'ហាងបោះពុម្ពផ្លូវ ៣១០',
    kind: 'supplier',
  })

  await post(db, {
    entity_id: entity.id,
    on_date: firstOfMonth(-2),
    memo_en: 'Opening capital',
    memo_km: 'ដើមទុនដំបូង',
    lines: [
      { account: '1010', amount: 1_170_000 },
      { account: '1000', amount: 30_000 },
      { account: '3001', amount: -1_200_000, person_id: owner.id },
    ],
  })

  const services = await acc(db, entity.id, '4100')
  const jobs = [
    { party: party_.bassac, project: 'books', date: dayOffset(-36), wht: 1500, paid: 'full',
      subject_en: 'Bookkeeping, quarter to August',
      subject_km: 'សេវាកម្មគណនេយ្យ ត្រីមាសដល់ខែសីហា',
      items: [['Monthly bookkeeping × 3', 'សេវាកម្មគណនេយ្យ ៣ ខែ', 3, 'month', 44_000]] },
    { party: party_.sunrise, project: 'tax', date: dayOffset(-24), wht: 1500, paid: 'full',
      subject_en: 'Monthly returns and VAT', subject_km: 'លិខិតប្រកាសប្រចាំខែនិងអាករ',
      items: [['Monthly tax filing × 2', 'ដាក់លិខិតប្រកាសពន្ធ ២ ខែ', 2, 'month', 22_000]] },
    { party: party_.riverside, project: 'company', date: dayOffset(-15), wht: 1500, paid: 'part',
      subject_en: 'Company registration and patent tax',
      subject_km: 'ចុះបញ្ជីក្រុមហ៊ុននិងពន្ធប៉ាតង់',
      items: [
        ['Registration file', 'ឯកសារចុះបញ្ជី', 1, 'item', 78_000],
        ['Official fees paid on their behalf', 'ថ្លៃរដ្ឋបាលដែលបានសងជំនួស', 1, 'item', 34_000],
      ] },
    { party: party_.mekong, project: 'books', date: dayOffset(-7), wht: 0, paid: 'none',
      subject_en: 'Bookkeeping, August', subject_km: 'សេវាកម្មគណនេយ្យ ខែសីហា',
      items: [['Monthly bookkeeping', 'សេវាកម្មគណនេយ្យប្រចាំខែ', 1, 'month', 15_000]] },
    { party: party_.bassac, project: 'training', date: dayOffset(-4), wht: 1500, paid: 'none',
      subject_en: 'Payroll training, two days', subject_km: 'បណ្តុះបណ្តាលប្រាក់បៀវត្ស ២ ថ្ងៃ',
      items: [['Training, per day', 'វគ្គបណ្តុះបណ្តាល ក្នុងមួយថ្ងៃ', 2, 'day', 39_000]] },
  ]
  for (const job of jobs) {
    const d = await draft(db, {
      entity_id: entity.id, kind: 'tax_invoice', party_id: job.party.id,
      project_id: project[job.project].id, issue_date: job.date,
      due_date: dayOffset(15, job.date), wht_bp: job.wht,
      subject_en: job.subject_en, subject_km: job.subject_km,
      lines: job.items.map(([en, kmText, qty, unit, price]) => ({
        desc_en: en, desc_km: kmText, qty_milli: qty * 1000, unit,
        unit_price: price, tax_code: 'VAT7', account_id: services,
        project_id: project[job.project].id,
      })),
    })
    const inv = await issue(db, d.id)
    if (job.paid === 'none') continue
    const cash = job.paid === 'full' ? inv.expect_paid : Math.round(inv.expect_paid / 2)
    const wht = job.paid === 'full' ? inv.wht : 0
    await recordPayment(db, {
      entity_id: entity.id, direction: 'in',
      on_date: dayOffset(job.paid === 'full' ? 9 : 5, job.date),
      party_id: job.party.id, account: '1010', method: 'transfer',
      amount: cash, wht_amount: wht,
      wht_cert_no: wht ? `WHT-${inv.number}` : null,
      slip_ref: `TRF-${Math.floor(Math.random() * 900000 + 100000)}`,
      allocations: [{ doc_id: inv.id, amount: cash, wht_amount: wht }],
    })
  }

  // What the practice itself buys. Rent to a landlord who is a person, so
  // ten percent is withheld and owed to the tax administration.
  const bills = [
    { party: landlord, project: 'books', date: dayOffset(-30), account: '6100', wht: 1000,
      desc_en: 'Office rent, September', desc_km: 'ថ្លៃជួលការិយាល័យ ខែកញ្ញា',
      amount: 49_000, paid: true },
    { party: isp, project: 'books', date: dayOffset(-26), account: '6200', wht: 0,
      desc_en: 'Internet and hosting', desc_km: 'អ៊ីនធឺណិតនិងម៉ាស៊ីនមេ', amount: 8_000, paid: true },
    { party: printer, project: 'company', date: dayOffset(-5), account: '6700', wht: 0,
      desc_en: 'Binding and printing', desc_km: 'ការបោះពុម្ពនិងចងក្រង', amount: 4_500, paid: false },
  ]
  for (const b of bills) {
    const bill = await issue(db, (await draft(db, {
      entity_id: entity.id, kind: 'bill', party_id: b.party.id,
      project_id: project[b.project].id, issue_date: b.date,
      due_date: dayOffset(30, b.date), wht_bp: b.wht,
      lines: [{ desc_en: b.desc_en, desc_km: b.desc_km, unit_price: b.amount,
        tax_code: 'VAT7', account_id: await acc(db, entity.id, b.account),
        project_id: project[b.project].id }],
    })).id)
    if (!b.paid) continue
    await recordPayment(db, {
      entity_id: entity.id, direction: 'out', on_date: dayOffset(6, b.date),
      party_id: b.party.id, account: '1010', amount: bill.expect_paid,
      wht_amount: bill.wht, wht_cert_no: bill.wht ? `WHT-OUT-${bill.number}` : null,
      allocations: [{ doc_id: bill.id, amount: bill.expect_paid, wht_amount: bill.wht }],
    })
  }

  // The monthly retainers, which is what a bookkeeping practice runs on.
  const retainer = await addPlan(db, {
    entity_id: entity.id, project_id: project.books.id, code: 'retainer',
    name_en: 'Monthly bookkeeping', name_km: 'សេវាកម្មគណនេយ្យប្រចាំខែ',
    price: 15_000, interval: 'month', tax_code: 'VAT7',
    account_id: await acc(db, entity.id, '4200'),
  })
  const payrollPlan = await addPlan(db, {
    entity_id: entity.id, project_id: project.payrollsvc.id, code: 'payroll-seat',
    name_en: 'Payroll, per employee', name_km: 'គណនាប្រាក់បៀវត្ស ក្នុងមួយបុគ្គលិក',
    price: 500, interval: 'month', tax_code: 'VAT7',
    account_id: await acc(db, entity.id, '4200'),
  })
  await subscribe(db, {
    entity_id: entity.id, party_id: party_.sunrise.id, plan_id: retainer.id, seats: 1,
    start_date: firstOfMonth(-2),
  })
  await subscribe(db, {
    entity_id: entity.id, party_id: party_.bassac.id, plan_id: payrollPlan.id, seats: 180,
    start_date: firstOfMonth(-2),
  })
  await subscribe(db, {
    entity_id: entity.id, party_id: party_.riverside.id, plan_id: retainer.id, seats: 1,
    start_date: firstOfMonth(-1),
  })
  for (let i = 0; i < 6; i++) {
    const made = await runBilling(db, entity.id, { asOf: today })
    if (!made.length) break
  }
  const openSubs = await db.all(
    `SELECT * FROM doc WHERE entity_id = ? AND direction = 'out'
       AND status IN ('issued','part_paid') AND issue_date < ?
     ORDER BY issue_date`, entity.id, firstOfMonth(0))
  for (const d of openSubs) {
    const owing = d.gross - d.paid - d.wht_credited
    if (owing <= 0) continue
    await recordPayment(db, {
      entity_id: entity.id, direction: 'in', on_date: dayOffset(7, d.issue_date),
      party_id: d.party_id, account: '1010', amount: owing,
      allocations: [{ doc_id: d.id, amount: owing, wht_amount: 0 }],
    })
  }

  // Three on payroll, in riel, inside the social security band.
  const staff = [
    [staff1, 'Senior bookkeeper', 'គណនេយ្យករជាន់ខ្ពស់', 59_000],
    [staff2, 'Bookkeeper', 'គណនេយ្យករ', 34_000],
    [staff3, 'Office and filing', 'រដ្ឋបាលនិងឯកសារ', 22_000],
  ]
  const employments = []
  for (const [person, title_en, title_km, rate] of staff) {
    employments.push(await addEmployment(db, {
      entity_id: entity.id, person_id: person.id, title_en, title_km,
      pay_unit: 'month', pay_rate: rate, start_date: `${today.slice(0, 4)}-01-01`,
      sso_registered: 1, tax_withheld: 1,
    }))
  }
  const lastMonth = firstOfMonth(-1).slice(0, 7)
  const { run, slips } = await createPayRun(db, {
    entity_id: entity.id, ym: lastMonth, pay_date: lastOfMonth(-1),
    entries: employments.map((e) => ({ employment_id: e.id })),
  })
  await approvePayRun(db, run.id)
  for (const s of slips) await payPayslip(db, s.id, { on_date: lastOfMonth(-1), account: '1010' })

  // The ways in, and this week's post.
  const link = await openChannel(db, { entity_id: entity.id, kind: 'link', label: brand.name_en })
  await openChannel(db, {
    entity_id: entity.id, kind: 'email', label: 'Forward receipts',
    address: 'receipts@angkorbooks.example',
  })
  await openChannel(db, {
    entity_id: entity.id, kind: 'chat', label: 'Telegram', address: '@angkorbooks',
  })
  for (const item of [
    { from: 'Dara', desc: 'Electricity, September', amount: 5_000, hint: 'EDC',
      photo: 'edc-sept.jpg', date: dayOffset(-2), source: 'chat' },
    { from: 'Chanthou', desc: 'Taxi to the tax office', amount: 28_000, hint: 'PassApp',
      date: dayOffset(-1) },
    { from: 'Vuthy', desc: 'Paper and toner', amount: 4_000, hint: 'Street 310 print shop',
      photo: 'print.jpg', date: dayOffset(-1) },
  ]) {
    await receive(db, {
      entity_id: entity.id, channel_id: link.id, source: item.source || 'link',
      from_ref: item.from, on_date: item.date, kind: 'bill', description: item.desc,
      amount: item.amount, party_hint: item.hint, photo_name: item.photo,
      idem_key: `seed:kh:${item.desc}`,
    })
  }

  const year = today.slice(0, 4)
  await generateFilings(db, entity.id, { from: `${year}-01-01`, to: `${Number(year) + 1}-06-30` })
  await markLate(db, entity.id, today)
  const done = await db.all(
    `SELECT id, due_date FROM filing WHERE entity_id = ? AND due_date < ? AND status <> 'filed'`,
    entity.id, dayOffset(-8))
  for (const f of done) {
    await markFiled(db, f.id, {
      filed_on: dayOffset(-2, f.due_date), ref: `GDT-${f.due_date.replace(/-/g, '')}`,
    })
  }

  // Cambodia's own days off, so a deadline that lands on one moves.
  const thisYear = Number(today.slice(0, 4))
  await seedYear(db, thisYear, { country: 'KH' })
  await seedYear(db, thisYear + 1, { country: 'KH' })

  // The books kept for other people.
  await client(db, {
    code: 'sunrisecafe', name_en: 'Sunrise Café Co., Ltd.', name_km: 'ក្រុមហ៊ុន សាន់រាយ កាហ្វេ',
    kind: 'company', vat: true, tax_id: 'K001-902000011',
    address_en: '18 Street 278, Phnom Penh',
    line_en: 'Café', line_km: 'ហាងកាហ្វេ', lane: 'product',
    revenue_account: '4000', opening: 220_000,
    note: 'Cash takings banked weekly; supplier bills arrive by photo.',
    customers: [{ code: 'walkin', name_en: 'Walk-in customers', name_km: 'អតិថិជនទូទៅ', is_company: 0 }],
    suppliers: [
      { code: 'roaster', name_en: 'Mondulkiri roastery', name_km: 'រោងចម្អិនកាហ្វេមណ្ឌលគិរី',
        tax_id: 'K001-903000022' },
      { code: 'dairy', name_en: 'Phnom Penh dairy', name_km: 'ផលិតផលទឹកដោះគោភ្នំពេញ' },
    ],
    sales: [
      { cash: true, amount: 105_000, date: dayOffset(-28), desc_en: 'Takings, week', desc_km: 'ចំណូលប្រចាំសប្តាហ៍' },
      { cash: true, amount: 120_000, date: dayOffset(-21), desc_en: 'Takings, week', desc_km: 'ចំណូលប្រចាំសប្តាហ៍' },
      { cash: true, amount: 100_000, date: dayOffset(-14), desc_en: 'Takings, week', desc_km: 'ចំណូលប្រចាំសប្តាហ៍' },
      { cash: true, amount: 125_000, date: dayOffset(-7), desc_en: 'Takings, week', desc_km: 'ចំណូលប្រចាំសប្តាហ៍' },
    ],
    costs: [
      { supplier: 0, amount: 54_000, date: dayOffset(-26), account: '5000', paid: true,
        desc_en: 'Coffee beans, 60 kg', desc_km: 'គ្រាប់កាហ្វេ ៦០ គីឡូ' },
      { supplier: 1, amount: 19_000, date: dayOffset(-12), account: '5000', paid: true,
        desc_en: 'Milk and cream', desc_km: 'ទឹកដោះគោនិងក្រែម' },
      { supplier: 0, amount: 54_000, date: dayOffset(-3), account: '5000', paid: false,
        desc_en: 'Coffee beans, 60 kg', desc_km: 'គ្រាប់កាហ្វេ ៦០ គីឡូ' },
    ],
    inbox: [
      { from: 'Srey (manager)', date: dayOffset(-2), desc: 'Electricity bill', amount: 13_000,
        hint: 'EDC', photo: 'edc.jpg', source: 'chat' },
      { from: 'Srey (manager)', date: dayOffset(-1), desc: 'New grinder, cash', amount: 40_000,
        hint: 'Equipment shop', photo: 'grinder.jpg' },
    ],
  })

  await client(db, {
    code: 'bassacgar', name_en: 'Bassac Garments Ltd.', name_km: 'ក្រុមហ៊ុន បាសាក់ សម្លៀកបំពាក់',
    kind: 'company', vat: true, tax_id: 'K001-902000022',
    address_en: 'Veng Sreng Blvd, Phnom Penh',
    line_en: 'Subcontract sewing', line_km: 'ការកាត់ដេរម៉ៅការ', lane: 'product',
    revenue_account: '4000', opening: 2_925_000,
    note: '180 on the line; the payroll service is the reason they are here.',
    customers: [{ code: 'buyer', name_en: 'Overseas buyer', name_km: 'អ្នកទិញក្រៅប្រទេស',
      tax_id: null, is_company: 1, terms_days: 45 }],
    suppliers: [{ code: 'fabric', name_en: 'Fabric importer', name_km: 'អ្នកនាំចូលក្រណាត់',
      tax_id: 'K001-903000033' }],
    sales: [
      { customer: 0, amount: 2_050_000, date: dayOffset(-40), paid: true, paid_after: 30, terms: 45,
        desc_en: 'Order 2261, 12,000 pieces', desc_km: 'ការបញ្ជាទិញ ២២៦១ ចំនួន ១២,០០០ ដុំ' },
      { customer: 0, amount: 1_855_000, date: dayOffset(-8), paid: false, terms: 45,
        desc_en: 'Order 2288, 11,000 pieces', desc_km: 'ការបញ្ជាទិញ ២២៨៨ ចំនួន ១១,០០០ ដុំ' },
    ],
    costs: [
      { supplier: 0, amount: 925_000, date: dayOffset(-35), account: '5000', paid: true,
        desc_en: 'Fabric and trims', desc_km: 'ក្រណាត់និងគ្រឿងបន្លាស់' },
    ],
    inbox: [
      { from: 'HR office', date: dayOffset(-3), desc: 'NSSF receipt, August', amount: 57_000,
        hint: 'NSSF', photo: 'nssf.jpg' },
    ],
  })

  await client(db, {
    code: 'riversidegh', name_en: 'Riverside Guesthouse', name_km: 'ផ្ទះសំណាក់រីវើសាយ',
    kind: 'sole', vat: false, tax_id: null, behind: true,
    address_en: 'Street 110, Phnom Penh',
    line_en: 'Rooms', line_km: 'បន្ទប់ស្នាក់នៅ', lane: 'space',
    revenue_account: '4000', opening: 135_000,
    note: 'Below the registration threshold; the question is when it crosses.',
    customers: [
      { code: 'guests', name_en: 'Guests', name_km: 'ភ្ញៀវ', is_company: 0 },
      { code: 'platform', name_en: 'Booking platform', name_km: 'វេទិកាកក់បន្ទប់', terms_days: 15 },
    ],
    suppliers: [{ code: 'laundry', name_en: 'Street 110 laundry', name_km: 'ហាងបោកអ៊ុតផ្លូវ ១១០' }],
    sales: [
      { cash: true, amount: 51_000, date: dayOffset(-24), desc_en: 'Room takings', desc_km: 'ចំណូលបន្ទប់' },
      { cash: true, amount: 45_000, date: dayOffset(-17), desc_en: 'Room takings', desc_km: 'ចំណូលបន្ទប់' },
      { customer: 1, amount: 78_000, date: dayOffset(-10), paid: true, paid_after: 6,
        desc_en: 'Platform payout, 32 nights', desc_km: 'ការទូទាត់ពីវេទិកា ៣២ យប់' },
      { customer: 1, amount: 66_000, date: dayOffset(-2), paid: false,
        desc_en: 'Platform payout, 27 nights', desc_km: 'ការទូទាត់ពីវេទិកា ២៧ យប់' },
    ],
    costs: [
      { supplier: 0, amount: 10_000, date: dayOffset(-20), account: '6900', paid: true,
        desc_en: 'Linen washing', desc_km: 'បោកអ៊ុតកម្រាលពូក' },
    ],
    inbox: [
      { from: 'Reception', date: dayOffset(-3), desc: 'Water bill', amount: 4_500,
        hint: 'Water authority', photo: 'water.jpg', source: 'chat' },
    ],
  })

  await client(db, {
    code: 'mekongtuk', name_en: 'Mekong Tuk Tuk (Mr Vanna)', name_km: 'តុកតុកមេគង្គ (លោក វណ្ណា)',
    kind: 'sole', vat: false, tax_id: null,
    address_en: 'Street 63, Phnom Penh',
    line_en: 'Driving', line_km: 'សេវាដឹកជញ្ជូន', lane: 'service',
    revenue_account: '4100', opening: 34_000,
    note: 'One vehicle, mostly cash, a hotel contract that withholds.',
    customers: [
      { code: 'hotel', name_en: 'Riverside hotel', name_km: 'សណ្ឋាគាររីវើសាយ',
        tax_id: 'K001-902000044', terms_days: 30 },
    ],
    suppliers: [{ code: 'garage', name_en: 'Street 63 garage', name_km: 'ហាងជួសជុលផ្លូវ ៦៣' }],
    sales: [
      { cash: true, amount: 30_000, date: dayOffset(-21), desc_en: 'Fares, fortnight', desc_km: 'ចំណូលដឹកភ្ញៀវ ២ សប្តាហ៍' },
      { customer: 0, amount: 68_000, date: dayOffset(-12), wht: 1500, paid: true, paid_after: 8,
        desc_en: 'Hotel airport transfers', desc_km: 'ដឹកភ្ញៀវសណ្ឋាគារទៅអាកាសយានដ្ឋាន' },
      { customer: 0, amount: 59_000, date: dayOffset(-3), wht: 1500, paid: false,
        desc_en: 'Hotel airport transfers', desc_km: 'ដឹកភ្ញៀវសណ្ឋាគារទៅអាកាសយានដ្ឋាន' },
    ],
    costs: [
      { supplier: 0, amount: 9_500, date: dayOffset(-14), account: '6300', paid: true,
        desc_en: 'Service and tyres', desc_km: 'ជួសជុលនិងកង់' },
    ],
    inbox: [
      { from: 'Vanna', date: dayOffset(-1), desc: 'Fuel, week', amount: 5_500, hint: 'Tela',
        photo: 'fuel.jpg', source: 'chat' },
    ],
  })

  return entity
}
