// seed-demo.mjs — the sample business the demo opens with.
//
// Sample figures, round on purpose so nobody mistakes them for a real month.
// The SHAPE is the real thing: several lines of work under one company, money
// owed both ways, tax withheld by customers, a consignment shelf, two
// retainers, three people on payroll, and the filings all of that creates.
//
// Dates are relative to today, so the demo is never opening on a stale month.

import { createEntity, addPerson, addProject, addMembership, ensurePartnerAccounts, setHolding } from './modules/entities.mjs'
import { post } from './modules/books.mjs'
import { draft, issue, recordPayment } from './modules/documents.mjs'
import { acquire, sell, setStatus } from './modules/stock.mjs'
import { addPlan, subscribe, runBilling } from './modules/subscriptions.mjs'
import { addEmployment, createPayRun, approvePayRun, payPayslip } from './modules/payroll.mjs'
import { generateFilings, markLate, markFiled } from './modules/compliance.mjs'
import { openChannel, receive } from './modules/intake.mjs'
import {
  setAgreement, addReferral, setStatus as setReferralStatus, billMonth,
  setServiceRate, billClient, billNetMonth,
} from './modules/referrals.mjs'
import {
  addWallet, setAssetRate, receiveCrypto, ensureCryptoAccounts, parseAsset,
} from './modules/crypto.mjs'
import { addMethod, claimPaid, amountToAsk, preparePayment } from './modules/paying.mjs'
import { seedYear } from './modules/calendar.mjs'
import { addBankAccount } from './modules/banks.mjs'
import { importStatement } from './modules/importing.mjs'
import { setRate as setFxRate, toPpm } from './lib/fx.mjs'
import { handleEvent, linkChat, chatFor, queue, digest } from './modules/line.mjs'
import { seedClients } from './seed-clients.mjs'
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
const lastOfMonth = (offset = 0, from = localDate()) =>
  dayOffset(-1, firstOfMonth(offset + 1, from))

export const BRAND_DEFAULT = {
  name_en: 'Example Desk Co., Ltd.',
  name_th: 'เอ็กซ์แซมเพิล เดสก์ จำกัด',
  mark: 'ED',
  accent: '#1f6f5c',
  city: 'Chiang Rai',
  locale: 'en',
}

// Most of this book's customers are foreigners, which changes the invoice:
// they read English, and they do not withhold tax — that is a thing a Thai
// company does to a Thai supplier. So the customer carries the answer and a
// new invoice takes it without being asked twice.
async function party(db, entityId, p) {
  const id = uid()
  const country = (p.country ?? 'TH').toUpperCase()
  const withholds = p.withholds ?? (country === 'TH' && (p.is_company ?? 1) ? 1 : 0)
  await db.run(
    `INSERT INTO party(id, entity_id, code, name_en, name_th, kind, tax_id, is_company,
       address_en, address_th, email, terms_days, country, currency, locale,
       withholds, tax_treatment, note_tax)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, entityId, p.code, p.name_en, p.name_th ?? null, p.kind ?? 'both',
    p.tax_id ?? null, p.is_company ?? 1, p.address_en ?? null, p.address_th ?? null,
    p.email ?? null, p.terms_days ?? 0, country, p.currency ?? null,
    p.locale ?? (country === 'TH' ? 'th' : 'en'), withholds,
    p.tax_treatment ?? null, p.note_tax ?? null)
  return db.get('SELECT * FROM party WHERE id = ?', id)
}

/** Build the whole sample company. Returns the entity. */
export async function seedDemo(db, brand = BRAND_DEFAULT) {
  const today = localDate()
  const entity = await createEntity(db, {
    code: 'demo',
    name_en: brand.name_en,
    name_th: brand.name_th,
    kind: 'company',
    tax_id: '9990000000001',
    vat_registered: 1,
    vat_from: `${today.slice(0, 4)}-01-01`,
    address_en: `88 Phahonyothin Road, Mueang ${brand.city} 57000`,
    address_th: `88 ถนนพหลโยธิน เมือง${brand.city === 'Chiang Rai' ? 'เชียงราย' : brand.city} 57000`,
  })

  // Where the books are, so the calendar knows the shape of the day.
  await db.run('UPDATE entity SET place = ?, lat = ?, lng = ? WHERE id = ?',
    brand.city, 19.9105, 99.8406, entity.id)

  // The accounts money actually sits in: a baht account, a dollar account for
  // the foreign work, and the cash drawer. Each one is a row in the chart, so a
  // balance can be read against a statement.
  await db.run(
    `UPDATE account SET name_en = ?, name_th = ?, bank_name = ?, account_no = ?,
       is_bank = 1, currency = 'THB' WHERE entity_id = ? AND code = '1010'`,
    'Kasikornbank — baht', 'กสิกรไทย — บาท', 'Kasikornbank', '123-4-56789-0', entity.id)
  // Somebody sending from abroad fills in their own bank's form, and it asks
  // for SWIFT and the bank's address. Recorded once, printed on every payment
  // page for this account.
  await db.run(
    `UPDATE account SET swift = ?, bank_address = ? WHERE entity_id = ? AND code = '1010'`,
    'KASITHBK', '1 Ratburana Road, Bangkok 10140, Thailand', entity.id)
  const dollarAccount = await addBankAccount(db, {
    entity_id: entity.id,
    name_en: 'Bangkok Bank — dollars',
    name_th: 'กรุงเทพ — ดอลลาร์',
    bank_name: 'Bangkok Bank',
    account_no: '555-0-12345-6',
    currency: 'USD',
    swift: 'BKKBTHBK',
    bank_address: '333 Silom Road, Bangkok 10500, Thailand',
    note: 'What the foreign clients pay into.',
  })
  for (const [on, rate] of [
    [dayOffset(-60), 35.80], [dayOffset(-30), 36.10], [dayOffset(-2), 36.05],
  ]) {
    await setFxRate(db, {
      asset: 'USD', quote: 'THB', rate_ppm: toPpm(rate), on_date: on,
      source: 'the bank, that morning',
    })
  }

  // The ways to be paid, default first: a scan, a transfer form, or cash.
  await addMethod(db, {
    entity_id: entity.id, kind: 'promptpay', label_en: 'PromptPay', label_th: 'พร้อมเพย์',
    payee_id: '0812345678', account_code: '1020', is_default: true, sort: 1,
  })
  await addMethod(db, {
    entity_id: entity.id, kind: 'bank', label_en: 'Bank transfer', label_th: 'โอนเข้าบัญชี',
    bank_name: 'Kasikornbank', account_name: brand.name_en, account_no: '123-4-56789-0',
    account_code: '1010', sort: 2,
  })
  await addMethod(db, {
    entity_id: entity.id, kind: 'cash', label_en: 'Cash', label_th: 'เงินสด',
    account_code: '1000', sort: 3,
  })
  await addMethod(db, {
    entity_id: entity.id, kind: 'link', label_en: 'Card, for visitors abroad',
    label_th: 'บัตรเครดิต สำหรับลูกค้าต่างประเทศ',
    link_template: 'https://pay.example/vs?amount={amount}&ref={ref}',
    account_code: '1010', sort: 4,
  })

  // ---- people ----
  const owner = await addPerson(db, { code: 'owner', name_en: 'Mali', name_th: 'มะลิ' })
  const nok = await addPerson(db, { code: 'nok', name_en: 'Nok', name_th: 'นก', locale: 'th' })
  const ploy = await addPerson(db, { code: 'ploy', name_en: 'Ploy', name_th: 'พลอย', locale: 'th' })
  const sam = await addPerson(db, { code: 'sam', name_en: 'Sam', name_th: 'แซม', locale: 'th' })
  const mint = await addPerson(db, { code: 'mint', name_en: 'Mint', name_th: 'มิ้นท์', locale: 'th' })
  await addMembership(db, { person_id: owner.id, entity_id: entity.id, role: 'owner' })
  await addMembership(db, { person_id: nok.id, entity_id: entity.id, role: 'bookkeeper' })
  await ensurePartnerAccounts(db, entity.id, owner)
  await setHolding(db, {
    entity_id: entity.id, person_id: owner.id, share_bp: 10000,
    from_date: `${today.slice(0, 4)}-01-01`,
  })

  // ---- the lines of work ----
  const lines = [
    ['visa', 'Visa desk', 'งานวีซ่า', 'service'],
    ['tours', 'Tours', 'ทัวร์', 'service'],
    ['licences', 'Licence work', 'งานใบอนุญาต', 'service'],
    ['shop', 'Consignment shop', 'ร้านฝากขาย', 'product'],
    ['property', 'Property', 'อสังหาริมทรัพย์', 'service'],
    ['cowork', 'Coworking space', 'โคเวิร์กกิ้ง', 'space'],
    ['hostel', 'Hostel', 'โฮสเทล', 'space'],
  ]
  const project = {}
  for (const [code, en, th, lane] of lines) {
    project[code] = await addProject(db, entity.id, { code, name_en: en, name_th: th, lane })
  }

  // ---- who they trade with ----
  const alpine = await party(db, entity.id, {
    code: 'alpine', name_en: 'Alpine Trekking Co., Ltd.', name_th: 'บริษัท อัลไพน์ เทรคกิ้ง จำกัด',
    tax_id: '9990000000002', terms_days: 15, address_th: '12 ถนนสิงหไคล เชียงราย',
  })
  const oakes = await party(db, entity.id, {
    code: 'oakes', name_en: 'Mr Brian Oakes', is_company: 0, kind: 'customer',
    email: 'brian@example.com', country: 'GB',
  })
  const coffee = await party(db, entity.id, {
    code: 'coffee', name_en: 'Golden Triangle Coffee Co., Ltd.', name_th: 'บริษัท โกลเด้น ไทรแองเกิ้ล คอฟฟี่ จำกัด',
    tax_id: '9990000000003', terms_days: 30,
  })
  const village = await party(db, entity.id, {
    code: 'village', name_en: 'Sunrise Retirement Village', name_th: 'ซันไรส์ รีไทร์เมนต์ วิลเลจ',
    tax_id: '9990000000004', terms_days: 30,
  })
  const school = await party(db, entity.id, {
    code: 'school', name_en: 'Ban Doi International School', name_th: 'โรงเรียนนานาชาติบ้านดอย',
    tax_id: '9990000000005',
  })
  const remote = await party(db, entity.id, {
    code: 'remote', name_en: 'Remote Works Co., Ltd.', name_th: 'บริษัท รีโมท เวิร์คส์ จำกัด',
    tax_id: '9990000000006', terms_days: 15,
  })
  const freelancer = await party(db, entity.id, {
    code: 'freelancer', name_en: 'Ms Dao Suwan', name_th: 'คุณดาว สุวรรณ',
    is_company: 0, kind: 'customer',
  })
  const platform = await party(db, entity.id, {
    code: 'platform', name_en: 'Booking platform', name_th: 'แพลตฟอร์มจองที่พัก',
    kind: 'both', is_company: 1, terms_days: 15,
  })
  // The rest of the book: people from somewhere else, which is most of it.
  await party(db, entity.id, {
    code: 'weber', name_en: 'Frau Ilse Weber', is_company: 0, kind: 'customer',
    email: 'ilse@example.de', country: 'DE', locale: 'en',
  })
  await party(db, entity.id, {
    code: 'nguyen', name_en: 'Mr David Nguyen', is_company: 0, kind: 'customer',
    email: 'david@example.com.au', country: 'AU', locale: 'en',
  })
  await party(db, entity.id, {
    code: 'lanexport', name_en: 'Mekong Timber Trading (Vientiane)', kind: 'customer',
    country: 'LA', terms_days: 30, tax_treatment: 'zero_rated',
    note_tax: 'Zero-rated: advice given for a business outside Thailand.',
  })
  const printer = await party(db, entity.id, {
    code: 'printshop', name_en: 'Mae Fah Print Shop', name_th: 'ร้านพิมพ์แม่ฟ้า',
    kind: 'supplier', tax_id: '9990000000007',
  })
  const translator = await party(db, entity.id, {
    code: 'translator', name_en: 'Khun Aomsin (translator)', name_th: 'คุณออมสิน (นักแปล)',
    kind: 'supplier', is_company: 0,
  })
  const host = await party(db, entity.id, {
    code: 'hosting', name_en: 'Cloud hosting', kind: 'supplier',
  })
  // Two suppliers the inbox will recognise on its own, and one it will not: a
  // government office nobody has invoiced from before still needs a person.
  await party(db, entity.id, {
    code: 'ptt', name_en: 'PTT station', name_th: 'ปั๊ม ปตท.', kind: 'supplier',
  })
  await party(db, entity.id, {
    code: 'makro', name_en: 'Makro', name_th: 'แม็คโคร', kind: 'supplier',
    tax_id: '9990000000008',
  })

  const acc = async (code) =>
    (await db.get('SELECT id FROM account WHERE entity_id = ? AND code = ?', entity.id, code)).id
  const services = await acc('4100')
  const sales = await acc('4000')
  const seatsAccount = await acc('4200')
  const printing = await acc('6700')
  const hosting = await acc('6200')
  const professional = await acc('6400')

  // ---- money to start with ----
  await post(db, {
    entity_id: entity.id,
    on_date: firstOfMonth(-2),
    memo_en: 'Opening balance',
    memo_th: 'ยอดยกมา',
    lines: [
      { account: '1010', amount: 88_800_000 },
      { account: '1000', amount: 2_000_000 },
      { account: '3001', amount: -90_800_000, person_id: owner.id },
    ],
  })

  // ---- work done, billed ----
  const jobs = [
    { party: alpine, project: 'visa', date: dayOffset(-38), wht: 300, paid: 'full',
      subject_en: 'Work permits and visa extensions, 6 guides',
      subject_th: 'ใบอนุญาตทำงานและต่อวีซ่า ไกด์ 6 คน',
      items: [
        ['Work permit renewal × 6', 'ต่อใบอนุญาตทำงาน × 6', 6, 'item', 450000],
        ['Non-B extension × 6', 'ต่อวีซ่า Non-B × 6', 6, 'item', 380000],
        ['Government fees paid on their behalf', 'ค่าธรรมเนียมราชการที่สำรองจ่าย', 1, 'item', 1_200_000],
      ] },
    { party: oakes, project: 'visa', date: dayOffset(-21), wht: 0, paid: 'full',
      subject_en: 'Retirement extension and 90-day reporting',
      subject_th: 'ต่อวีซ่าเกษียณและรายงานตัว 90 วัน',
      items: [
        ['Retirement extension', 'ต่อวีซ่าเกษียณ', 1, 'item', 1_500_000],
        ['Bank letter and document run', 'หนังสือรับรองธนาคารและงานเอกสาร', 1, 'item', 300_000],
      ] },
    { party: coffee, project: 'licences', date: dayOffset(-12), wht: 300, paid: 'part', due_days: 7,
      subject_en: 'Import licence, first stage',
      subject_th: 'ใบอนุญาตนำเข้า ระยะแรก',
      items: [
        ['Licence application and filings', 'ยื่นคำขอใบอนุญาตและเอกสาร', 1, 'item', 3_500_000],
        ['Certified translations', 'แปลเอกสารรับรอง', 12, 'page', 60_000],
      ] },
    { party: school, project: 'visa', date: dayOffset(-6), wht: 300, paid: 'none', due_days: 3,
      subject_en: 'Non-ED sponsorship pack, four teachers',
      subject_th: 'ชุดเอกสารสปอนเซอร์ Non-ED ครู 4 คน',
      items: [
        ['Sponsorship documents × 4', 'เอกสารสปอนเซอร์ × 4', 4, 'item', 550_000],
        ['Immigration appointment escort', 'พาไปตรวจคนเข้าเมือง', 1, 'day', 250_000],
      ] },
    { party: village, project: 'property', date: dayOffset(-33), wht: 500, paid: 'full',
      subject_en: 'Building management fee, September',
      subject_th: 'ค่าบริหารอาคาร เดือนกันยายน',
      items: [
        ['Management fee', 'ค่าบริหารจัดการ', 1, 'month', 2_500_000],
        ['Rent collection, 18 units', 'เก็บค่าเช่า 18 ยูนิต', 18, 'unit', 50_000],
      ] },
    { party: remote, project: 'property', date: dayOffset(-20), wht: 500, paid: 'full',
      subject_en: 'Letting commission, two shophouses',
      subject_th: 'ค่านายหน้าให้เช่า อาคารพาณิชย์ 2 คูหา',
      items: [
        ['Letting commission, one month rent each', 'ค่านายหน้า เท่ากับค่าเช่า 1 เดือน ต่อคูหา', 2, 'unit', 2_800_000],
      ] },
    { party: platform, project: 'hostel', date: dayOffset(-9), wht: 0, paid: 'full',
      subject_en: 'Platform payout, nights 1–15',
      subject_th: 'ยอดโอนจากแพลตฟอร์ม คืนที่ 1–15',
      items: [
        ['Dorm beds, 128 nights', 'เตียงรวม 128 คืน', 128, 'night', 45_000],
        ['Private rooms, 22 nights', 'ห้องส่วนตัว 22 คืน', 22, 'night', 120_000],
      ] },
    { party: alpine, project: 'tours', date: dayOffset(-3), wht: 0, paid: 'none',
      subject_en: 'Border run, 11 passengers',
      subject_th: 'ทริปวิ่งชายแดน ผู้โดยสาร 11 คน',
      items: [
        ['Escorted border run', 'พาไปวิ่งชายแดน', 11, 'person', 180_000],
        ['Van and driver', 'รถตู้พร้อมคนขับ', 1, 'day', 350_000],
      ] },
  ]

  const issued = []
  for (const job of jobs) {
    const d = await draft(db, {
      entity_id: entity.id,
      kind: 'tax_invoice',
      party_id: job.party.id,
      project_id: project[job.project].id,
      issue_date: job.date,
      due_date: dayOffset(job.due_days ?? 15, job.date),
      wht_bp: job.wht,
      subject_en: job.subject_en,
      subject_th: job.subject_th,
      lines: job.items.map(([en, th, qty, unit, price]) => ({
        desc_en: en, desc_th: th, qty_milli: qty * 1000, unit,
        unit_price: price, tax_code: 'VAT7', account_id: services,
        project_id: project[job.project].id,
      })),
    })
    const inv = await issue(db, d.id)
    issued.push({ inv, job })
    if (job.paid === 'none') continue
    const cash = job.paid === 'full' ? inv.expect_paid : Math.round(inv.expect_paid / 2)
    const wht = job.paid === 'full' ? inv.wht : 0
    await recordPayment(db, {
      entity_id: entity.id,
      direction: 'in',
      on_date: dayOffset(job.paid === 'full' ? 9 : 5, job.date),
      party_id: job.party.id,
      account: '1010',
      method: 'transfer',
      amount: cash,
      wht_amount: wht,
      wht_cert_no: wht ? `WHT-${job.party.code.toUpperCase()}-01` : null,
      slip_ref: `TRF-${Math.floor(Math.random() * 900000 + 100000)}`,
      allocations: [{ doc_id: inv.id, amount: cash, wht_amount: wht }],
    })
  }

  // One quotation waiting for an answer, and one invoice still a draft.
  await issue(db, (await draft(db, {
    entity_id: entity.id, kind: 'quote', party_id: village.id,
    project_id: project.property.id, issue_date: dayOffset(-4),
    subject_en: 'Annual compliance package, 40 residents',
    subject_th: 'แพ็กเกจดูแลเอกสารรายปี ผู้พักอาศัย 40 คน',
    lines: [
      { desc_en: '90-day reporting, per resident per year', desc_th: 'รายงานตัว 90 วัน ต่อคนต่อปี',
        qty_milli: 40000, unit: 'person', unit_price: 240_000, tax_code: 'VAT7', account_id: services },
    ],
  })).id)

  await draft(db, {
    entity_id: entity.id, kind: 'invoice', party_id: coffee.id,
    project_id: project.licences.id, issue_date: today,
    subject_en: 'Import licence, second stage',
    subject_th: 'ใบอนุญาตนำเข้า ระยะที่สอง',
    wht_bp: 300,
    lines: [{ desc_en: 'Second stage filings', desc_th: 'ยื่นเอกสารระยะที่สอง',
      unit_price: 2_800_000, tax_code: 'VAT7', account_id: services }],
  })

  // ---- what the business buys ----
  const bills = [
    { party: printer, project: 'visa', date: dayOffset(-30), account: printing, wht: 0,
      desc_en: 'Document printing and binding', desc_th: 'งานพิมพ์และเข้าเล่ม', amount: 480_000, paid: true },
    { party: host, project: 'visa', date: dayOffset(-25), account: hosting, wht: 0,
      desc_en: 'Booking site hosting', desc_th: 'ค่าโฮสติ้งเว็บจอง', amount: 250_000, paid: true },
    { party: translator, project: 'licences', date: dayOffset(-10), account: professional, wht: 300,
      desc_en: 'Certified translation, 40 pages', desc_th: 'แปลเอกสารรับรอง 40 หน้า',
      amount: 1_600_000, paid: true },
    { party: platform, project: 'hostel', date: dayOffset(-9), account: professional, wht: 0,
      desc_en: 'Platform commission, 15%', desc_th: 'ค่าคอมมิชชั่นแพลตฟอร์ม 15%',
      amount: 1_260_000, paid: true },
    { party: printer, project: 'shop', date: dayOffset(-2), account: printing, wht: 0,
      desc_en: 'Shop labels and tags', desc_th: 'ป้ายและสติกเกอร์ร้าน', amount: 120_000, paid: false },
  ]
  for (const b of bills) {
    const bill = await issue(db, (await draft(db, {
      entity_id: entity.id, kind: 'bill', party_id: b.party.id,
      project_id: project[b.project].id, issue_date: b.date,
      due_date: dayOffset(30, b.date), wht_bp: b.wht,
      lines: [{ desc_en: b.desc_en, desc_th: b.desc_th, unit_price: b.amount,
        tax_code: 'VAT7', account_id: b.account, project_id: project[b.project].id }],
    })).id)
    if (!b.paid) continue
    await recordPayment(db, {
      entity_id: entity.id, direction: 'out', on_date: dayOffset(6, b.date),
      party_id: b.party.id, account: '1010', method: 'transfer',
      amount: bill.expect_paid, wht_amount: bill.wht,
      wht_cert_no: bill.wht ? `WHT-OUT-${b.party.code.toUpperCase()}` : null,
      allocations: [{ doc_id: bill.id, amount: bill.expect_paid, wht_amount: bill.wht }],
    })
  }

  // ---- the consignment shelf ----
  const pieces = [
    ['SLV-001', 'Silver offering bowl', 'ขันเงิน', 450_000, 1_200_000, 'sold'],
    ['TEX-004', 'Indigo hill-tribe jacket', 'เสื้อครามชาวเขา', 180_000, 650_000, 'sold'],
    ['TEA-011', 'Teak serving tray', 'ถาดไม้สัก', 120_000, 380_000, 'listed'],
    ['LAC-002', 'Lacquer betel box', 'เชี่ยนหมากลงรัก', 260_000, 900_000, 'listed'],
    ['SLV-007', 'Silver belt, Karen work', 'เข็มขัดเงินกะเหรี่ยง', 320_000, 950_000, 'in_stock'],
  ]
  for (const [sku, en, th, cost, ask, status] of pieces) {
    const it = await acquire(db, {
      entity_id: entity.id, project_id: project.shop.id, sku,
      name_en: en, name_th: th, category: 'consignment',
      acq_cost: cost, acq_date: dayOffset(-45), ask_price: ask,
      location: 'shop floor', paid_from: '1000',
    })
    if (status === 'listed') await setStatus(db, it.id, 'listed', { on_date: dayOffset(-40) })
    if (status === 'sold') {
      await sell(db, it.id, {
        party_id: oakes.id, price: ask, on_date: dayOffset(-15),
        paid_to: '1000', method: 'cash', kind: 'invoice', revenue_account: '4000',
      })
    }
  }

  // ---- what comes in every month ----
  const reporting = await addPlan(db, {
    entity_id: entity.id, project_id: project.visa.id, code: 'reporting',
    name_en: '90-day reporting, per person', name_th: 'รายงานตัว 90 วัน ต่อคน',
    price: 150_000, interval: 'month', tax_code: 'VAT7', account_id: seatsAccount,
  })
  const retainer = await addPlan(db, {
    entity_id: entity.id, project_id: project.licences.id, code: 'retainer',
    name_en: 'Compliance retainer', name_th: 'ค่าที่ปรึกษารายเดือน',
    price: 800_000, interval: 'month', tax_code: 'VAT7', account_id: seatsAccount,
  })
  await subscribe(db, {
    entity_id: entity.id, party_id: village.id, plan_id: reporting.id, seats: 6,
    start_date: firstOfMonth(-2),
  })
  await subscribe(db, {
    entity_id: entity.id, party_id: coffee.id, plan_id: retainer.id, seats: 1,
    start_date: firstOfMonth(-2),
  })

  // The coworking space is the clearest case of money that arrives on its own
  // every month: a desk is a seat, and the billing run raises the invoices.
  const hotDesk = await addPlan(db, {
    entity_id: entity.id, project_id: project.cowork.id, code: 'hotdesk',
    name_en: 'Hot desk, monthly', name_th: 'โต๊ะทำงานรายเดือน',
    price: 250_000, interval: 'month', tax_code: 'VAT7', account_id: seatsAccount,
  })
  const office = await addPlan(db, {
    entity_id: entity.id, project_id: project.cowork.id, code: 'office',
    name_en: 'Private office', name_th: 'ห้องทำงานส่วนตัว',
    price: 1_200_000, interval: 'month', tax_code: 'VAT7', account_id: seatsAccount,
  })
  await subscribe(db, {
    entity_id: entity.id, party_id: remote.id, plan_id: office.id, seats: 1,
    start_date: firstOfMonth(-2),
  })
  await subscribe(db, {
    entity_id: entity.id, party_id: remote.id, plan_id: hotDesk.id, seats: 4,
    start_date: firstOfMonth(-2),
  })
  await subscribe(db, {
    entity_id: entity.id, party_id: freelancer.id, plan_id: hotDesk.id, seats: 1,
    start_date: firstOfMonth(-1),
  })
  for (let i = 0; i < 6; i++) {
    const made = await runBilling(db, entity.id, { asOf: today })
    if (!made.length) break
  }
  // The earlier months were collected; what is open is this month's, which is
  // what a well-run desk looks like on any given day.
  const openSubs = await db.all(
    `SELECT * FROM doc WHERE entity_id = ? AND direction = 'out'
       AND status IN ('issued','part_paid')
       AND (issue_date < ? OR party_id IN (?, ?))
     ORDER BY issue_date`, entity.id, firstOfMonth(0), remote.id, freelancer.id)
  for (const d of openSubs) {
    const owing = d.gross - d.paid - d.wht_credited
    if (owing <= 0) continue
    await recordPayment(db, {
      entity_id: entity.id, direction: 'in', on_date: dayOffset(7, d.issue_date),
      party_id: d.party_id, account: '1010', method: 'transfer',
      amount: owing, slip_ref: `TRF-${Math.floor(Math.random() * 900000 + 100000)}`,
      allocations: [{ doc_id: d.id, amount: owing, wht_amount: 0 }],
    })
  }

  // Cash businesses do not raise an invoice per guest. Takings are banked in a
  // run and posted as one line, which is how the week actually arrives.
  const takings = [
    [dayOffset(-28), 1_840_000, 'Hostel takings, week', 'ยอดขายโฮสเทล รายสัปดาห์', 'hostel'],
    [dayOffset(-21), 2_120_000, 'Hostel takings, week', 'ยอดขายโฮสเทล รายสัปดาห์', 'hostel'],
    [dayOffset(-14), 1_560_000, 'Hostel takings, week', 'ยอดขายโฮสเทล รายสัปดาห์', 'hostel'],
    [dayOffset(-7), 2_480_000, 'Hostel takings, week', 'ยอดขายโฮสเทล รายสัปดาห์', 'hostel'],
    [dayOffset(-11), 360_000, 'Day passes', 'ค่าใช้พื้นที่รายวัน', 'cowork'],
    [dayOffset(-4), 420_000, 'Day passes', 'ค่าใช้พื้นที่รายวัน', 'cowork'],
  ]
  for (const [on_date, gross, memo_en, memo_th, line] of takings) {
    const vat = entity.vat_registered ? Math.round((gross * 700) / 10700) : 0
    await post(db, {
      entity_id: entity.id,
      on_date,
      memo_en,
      memo_th,
      source_kind: 'takings',
      idem_key: `takings:${line}:${on_date}`,
      lines: [
        { account: '1000', amount: gross, project_id: project[line].id },
        { account: '4000', amount: -(gross - vat), project_id: project[line].id, tax_code: 'VAT7' },
        vat ? { account: '2100', amount: -vat, tax_code: 'VAT7' } : null,
      ].filter(Boolean),
    })
  }

  // Rooms and desks need cleaning and electricity, and both belong to the line
  // they serve rather than to the office.
  const running = [
    [dayOffset(-24), 480_000, '6110', 'hostel', 'Electricity and water', 'ค่าไฟและค่าน้ำ'],
    [dayOffset(-24), 320_000, '6110', 'cowork', 'Electricity and internet', 'ค่าไฟและอินเทอร์เน็ต'],
    [dayOffset(-18), 260_000, '6900', 'hostel', 'Laundry', 'ค่าซักรีด'],
    [dayOffset(-16), 900_000, '6100', 'cowork', 'Rent, coworking floor', 'ค่าเช่าพื้นที่โคเวิร์กกิ้ง'],
    [dayOffset(-16), 1_500_000, '6100', 'hostel', 'Rent, hostel building', 'ค่าเช่าอาคารโฮสเทล'],
  ]
  for (const [on_date, amount, account, line, memo_en, memo_th] of running) {
    await post(db, {
      entity_id: entity.id,
      on_date,
      memo_en,
      memo_th,
      source_kind: 'expense',
      idem_key: `running:${line}:${on_date}:${account}`,
      lines: [
        { account, amount, project_id: project[line].id },
        { account: '1010', amount: -amount, project_id: project[line].id },
      ],
    })
  }

  // ---- the people on payroll ----
  const staff = [
    [nok, 'Office manager', 'ผู้จัดการสำนักงาน', 3_200_000],
    [ploy, 'Document runner', 'พนักงานเดินเอกสาร', 1_800_000],
    [sam, 'Guide and driver', 'ไกด์และคนขับ', 2_000_000],
    [mint, 'Front desk, hostel', 'พนักงานต้อนรับโฮสเทล', 1_600_000],
  ]
  const employments = []
  for (const [person, title_en, title_th, rate] of staff) {
    employments.push(await addEmployment(db, {
      entity_id: entity.id, person_id: person.id, title_en, title_th,
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
  for (const s of slips) {
    await payPayslip(db, s.id, { on_date: lastOfMonth(-1), account: '1010' })
  }

  // ---- the filing calendar ----
  const year = today.slice(0, 4)
  await generateFilings(db, entity.id, { from: `${year}-01-01`, to: `${Number(year) + 1}-06-30` })
  await markLate(db, entity.id, today)
  // Everything older than last month is already filed; what is left is the
  // month just gone and what is coming.
  const done = await db.all(
    `SELECT f.id, f.due_date FROM filing f
      WHERE f.entity_id = ? AND f.due_date < ? AND f.status <> 'filed'`,
    entity.id, dayOffset(-8))
  for (const f of done) {
    await markFiled(db, f.id, {
      filed_on: dayOffset(-2, f.due_date), ref: `RD-${f.due_date.replace(/-/g, '')}`,
      person_id: nok.id,
    })
  }

  // Her own ways in, and a few things that came through them this week.
  const ownLink = await openChannel(db, { entity_id: entity.id, kind: 'link', label: brand.name_en })
  await openChannel(db, {
    entity_id: entity.id, kind: 'email', label: 'Forward receipts',
    address: 'receipts@exampledesk.example',
  })
  await openChannel(db, { entity_id: entity.id, kind: 'line', label: 'LINE', address: '@exdeskbooks' })
  for (const item of [
    { from: 'Nok', desc: 'Immigration fees, four cases', amount: 760_000, hint: 'Immigration',
      photo: 'immigration.jpg', source: 'line', date: dayOffset(-1) },
    { from: 'Mint', desc: 'Hostel cleaning supplies', amount: 148_000, hint: 'Makro',
      photo: 'makro.jpg', date: dayOffset(-2) },
    { from: 'Sam', desc: 'Van fuel, border run', amount: 210_000, hint: 'PTT',
      photo: 'ptt.jpg', source: 'line', date: dayOffset(-3) },
  ]) {
    await receive(db, {
      entity_id: entity.id, channel_id: ownLink.id, source: item.source || 'link',
      from_ref: item.from, on_date: item.date, kind: 'bill', description: item.desc,
      amount: item.amount, party_hint: item.hint, photo_name: item.photo,
      idem_key: `seed:own:${item.desc}`,
    })
  }

  // Work sent to a desk in another province, and the share of it that comes
  // back. Sample terms — the real ones are whatever the two sides agreed.
  const partnerDesk = await party(db, entity.id, {
    code: 'cmdesk', name_en: 'Northern visa desk', name_th: 'สำนักงานวีซ่าภาคเหนือ',
    tax_id: '9990000000009', terms_days: 15,
  })
  const terms = await setAgreement(db, {
    entity_id: entity.id,
    party_id: partnerDesk.id,
    code: 'CRVS',
    name_en: 'Referral commission',
    name_th: 'ค่าแนะนำลูกค้า',
    basis: 'percent_of_fee',
    rate_bp: 1000,
    wht_bp: 300,
    project_id: project.visa.id,
    terms_days: 15,
    from_date: firstOfMonth(-3),
    source: 'sample terms',
  })
  const cases = [
    ['ENQ-2041', 'Work permit, Chiang Mai factory', dayOffset(-64), dayOffset(-52), 2_400_000, 'billed'],
    ['ENQ-2052', 'Retirement extension', dayOffset(-58), dayOffset(-49), 1_500_000, 'billed'],
    ['ENQ-2077', 'Non-ED, language school', dayOffset(-40), dayOffset(-28), 1_800_000, 'completed'],
    ['ENQ-2090', 'Marriage visa, first application', dayOffset(-33), dayOffset(-21), 2_200_000, 'completed'],
    ['ENQ-2104', 'Border run, group of nine', dayOffset(-16), null, null, 'accepted'],
    ['ENQ-2111', 'Company registration and work permit', dayOffset(-9), null, null, 'sent'],
    ['ENQ-2115', 'Tourist extension', dayOffset(-6), null, null, 'declined'],
  ]
  for (const [external_id, label, sent, done, fee, status] of cases) {
    const r = await addReferral(db, {
      entity_id: entity.id, code: 'CRVS', sent_on: sent, label,
      external_id, agreement_id: terms.id, channel: 'site',
    })
    if (status === 'declined') {
      await setReferralStatus(db, r.id, {
        status: 'declined', on_date: dayOffset(3, sent), why: 'client went elsewhere',
      })
      continue
    }
    if (status === 'sent') continue
    await setReferralStatus(db, r.id, { status: 'accepted', on_date: dayOffset(2, sent) })
    if (!done) continue
    await setReferralStatus(db, r.id, { status: 'completed', on_date: done, case_fee: fee })
  }
  // The older month has already been billed and paid.
  const billedMonth = (await db.get(
    `SELECT substr(completed_on,1,7) AS ym FROM referral
      WHERE entity_id = ? AND status = 'completed' ORDER BY completed_on LIMIT 1`, entity.id))?.ym
  if (billedMonth) {
    const { doc } = await billMonth(db, {
      entity_id: entity.id, agreement_id: terms.id, period: billedMonth,
    })
    if (doc) {
      await recordPayment(db, {
        entity_id: entity.id, direction: 'in', on_date: dayOffset(12, doc.issue_date),
        party_id: partnerDesk.id, account: '1010', amount: doc.expect_paid,
        wht_amount: doc.wht, wht_cert_no: `WHT-${doc.number}`,
        allocations: [{ doc_id: doc.id, amount: doc.expect_paid, wht_amount: doc.wht }],
      })
      await db.run("UPDATE referral SET status = 'paid' WHERE doc_id = ?", doc.id)
    }
  }

  // A customer who says they have paid, waiting to be matched against the bank.
  const unpaid = await db.get(
    `SELECT * FROM doc WHERE entity_id = ? AND direction = 'out'
       AND status = 'issued' AND kind <> 'quote' ORDER BY issue_date DESC LIMIT 1`, entity.id)
  if (unpaid) {
    await claimPaid(db, {
      entity_id: entity.id, doc_id: unpaid.id, amount: amountToAsk(unpaid),
      method: 'promptpay', photo_name: 'slip.jpg',
      note: 'Sent from the customer\'s phone', idem_key: `seed:claim:${unpaid.id}`,
    })
  }

  // Ways to pay THEM, so paying out is a scan too.
  await db.run(
    "UPDATE party SET pay_promptpay = ?, pay_bank = ?, pay_account_no = ?, pay_account_name = ? WHERE code = ?",
    '0899999999', 'SCB', '987-6-54321-0', 'Mae Fah Print Shop', 'printshop')
  await db.run("UPDATE party SET pay_promptpay = ? WHERE code = ?", '0866666666', 'translator')

  // The year's fixed holidays, and the observances that are calculated.
  const thisYear = Number(today.slice(0, 4))
  await seedYear(db, thisYear)
  await seedYear(db, thisYear + 1)

  // Two chats, arrived the only way a chat id can arrive: through the webhook.
  // One is a customer, one is the office.
  for (const [chatId, name, partyCode] of [
    ['Uc0ffee', 'Golden Triangle Coffee', 'coffee'],
    ['Uoffice', 'Nok (office)', null],
  ]) {
    await handleEvent(db, {
      type: 'follow', source: { type: 'user', userId: chatId },
    }, { locale: brand.locale })
    const chat = await chatFor(db, chatId)
    await db.run('UPDATE chat SET entity_id = ?, display_name = ? WHERE id = ?',
      entity.id, name, chat.id)
    if (partyCode) {
      const who = await db.get('SELECT id FROM party WHERE entity_id = ? AND code = ?',
        entity.id, partyCode)
      await linkChat(db, chat.id, { party_id: who.id })
    } else {
      await linkChat(db, chat.id, { person_id: nok.id, may_see_money: 1 })
    }
  }
  // The morning list, waiting to go out.
  await queue(db, {
    entity_id: entity.id, chat_id: 'Uoffice',
    body: await digest(db, entity.id, { locale: brand.locale, asOf: today }),
    about_kind: 'digest', idem_key: `seed:digest:${today}`,
  })

  // A second arrangement, and the one that pays better: the other desk does the
  // work at a net price and the client is quoted a retail one. Her figures.
  const partnerDesk2 = await party(db, entity.id, {
    code: 'cmvisa', name_en: 'Northern visa office', name_th: 'สำนักงานวีซ่าภาคเหนือ',
    tax_id: '9990000000010', terms_days: 15,
  })
  const placed = await setAgreement(db, {
    entity_id: entity.id,
    party_id: partnerDesk2.id,
    code: 'PLACED',
    name_en: 'Files placed with the office',
    name_th: 'งานที่ส่งให้สำนักงาน',
    basis: 'margin',
    project_id: project.visa.id,
    terms_days: 15,
    from_date: firstOfMonth(-3),
    source: 'the net price they quote, and what the market quotes',
  })
  await setServiceRate(db, {
    agreement_id: placed.id, code: 'retirement-extension',
    name_en: 'Retirement extension', name_th: 'ต่อวีซ่าเกษียณ',
    net_price: 1_600_000, retail_price: 2_500_000, from_date: firstOfMonth(-3),
    source: 'they charge 16,000; the going quote is 25,000',
  })

  const placedCases = [
    ['Mr Brian Oakes', oakes.id, dayOffset(-26), dayOffset(-14)],
    ['Sunrise Retirement Village', village.id, dayOffset(-12), dayOffset(-4)],
    ['Ban Doi International School', school.id, dayOffset(-5), null],
  ]
  for (const [label, clientId, sent, done] of placedCases) {
    const r = await addReferral(db, {
      entity_id: entity.id, code: 'PLACED', sent_on: sent,
      service_code: 'retirement-extension', client_party_id: clientId,
      external_id: `PL-${sent.replace(/-/g, '').slice(4)}`,
      note: label,
    })
    await setReferralStatus(db, r.id, { status: 'accepted', on_date: dayOffset(1, sent) })
    if (!done) continue
    await setReferralStatus(db, r.id, { status: 'completed', on_date: done })
    await billClient(db, r.id, { vat: Boolean(entity.vat_registered) })
  }
  // Their bill for last month's files.
  await billNetMonth(db, {
    entity_id: entity.id, agreement_id: placed.id,
    period: dayOffset(-14).slice(0, 7), vat: Boolean(entity.vat_registered),
  })

  // A wallet, the rates it has been valued at, and one invoice settled in coin.
  await ensureCryptoAccounts(db, entity.id)
  const wallet = await addWallet(db, {
    entity_id: entity.id, label: 'Working wallet', asset: 'USDT', network: 'tron',
    address: 'TQn9Y2khDD95J42FQtQTdwVVRvsdemo', is_default: true,
    note: 'What foreign clients ask to pay in.',
  })
  await addWallet(db, {
    entity_id: entity.id, label: 'Cold', asset: 'BTC', network: 'bitcoin',
    address: 'bc1qexampledemoaddress0000000000000',
    note: 'Held, not spent.',
  })
  for (const [on, usdt, btc] of [
    [dayOffset(-30), 35_900_000, 2_180_000_000_000],
    [dayOffset(-14), 36_100_000, 2_240_000_000_000],
    [dayOffset(-2), 36_050_000, 2_310_000_000_000],
  ]) {
    await setAssetRate(db, { asset: 'USDT', rate_ppm: usdt, on_date: on, source: 'exchange mid, morning' })
    await setAssetRate(db, { asset: 'BTC', rate_ppm: btc, on_date: on, source: 'exchange mid, morning' })
  }
  const coinInvoice = await db.get(
    `SELECT * FROM doc WHERE entity_id = ? AND direction = 'out' AND status = 'issued'
       AND kind <> 'quote' ORDER BY issue_date LIMIT 1`, entity.id)
  if (coinInvoice) {
    const owed = coinInvoice.gross - coinInvoice.paid - coinInvoice.wht_credited
    await receiveCrypto(db, {
      entity_id: entity.id,
      doc_id: coinInvoice.id,
      wallet_id: wallet.id,
      asset_amount: Math.round((owed / 100) / 36.05 * 1e6),
      on_date: dayOffset(-2),
      tx_ref: '0x7f3c…demo',
      note: 'settled in USDT at the day\'s rate',
    })
  }

  // One job billed in dollars — and settled when the rate had moved, which is
  // where the exchange difference on the books comes from.
  const dollarJob = await issue(db, (await draft(db, {
    entity_id: entity.id,
    kind: 'invoice',
    party_id: remote.id,
    project_id: project.consulting?.id ?? project.visa.id,
    issue_date: dayOffset(-30),
    due_date: dayOffset(-15),
    currency: 'USD',
    subject_en: 'Relocation package, two families',
    subject_th: 'แพ็กเกจย้ายถิ่นฐาน 2 ครอบครัว',
    lines: [{
      desc_en: 'Relocation and visa handling', desc_th: 'บริการย้ายถิ่นฐานและวีซ่า',
      unit_price: 320_000, tax_code: 'NONE',
    }],
  })).id)
  await recordPayment(db, {
    entity_id: entity.id,
    direction: 'in',
    on_date: dayOffset(-2),
    party_id: remote.id,
    account: dollarAccount.code,
    currency: 'USD',
    method: 'transfer',
    amount: dollarJob.expect_paid,
    slip_ref: 'SWIFT-77213',
    allocations: [{ doc_id: dollarJob.id, amount: dollarJob.expect_paid, wht_amount: 0 }],
  })

  // Last week off the bank, imported the way anybody would import it: as the
  // file the bank gives you. One line is a customer paying an invoice down to
  // the satang, which the program can place on its own; the other two are the
  // electricity and a deposit nobody has claimed, which it cannot and says so.
  const toPlace = await db.get(
    `SELECT * FROM doc WHERE entity_id = ? AND direction = 'out'
       AND status IN ('issued','part_paid') AND kind <> 'quote'
     ORDER BY issue_date DESC LIMIT 1`, entity.id)
  if (toPlace) {
    const ready = await preparePayment(db, toPlace.id)
    const who = await db.get('SELECT * FROM party WHERE id = ?', ready.party_id)
    const asked = (amountToAsk(ready) / 100).toFixed(2)
    const day = (d) => {
      const [y, m, dd] = dayOffset(d).split('-')
      return `${dd}/${m}/${Number(y) + 543}`
    }
    await importStatement(db, {
      entity_id: entity.id,
      account_code: '1010',
      source_name: 'kbank-september.csv',
      text: 'บัญชีกระแสรายวัน 123-4-56789-0\n\n'
        + 'วันที่,รายการ,ถอน,ฝาก,คงเหลือ\n'
        + `${day(-3)},"TRANSFER ${String(who?.name_en || '').toUpperCase()}",,"${asked}","1,402,666.48"\n`
        + `${day(-2)},PEA ELECTRICITY,"1,240.00",,"1,401,426.48"\n`
        + `${day(-1)},DEPOSIT ATM CHIANGRAI,,"3,500.00","1,404,926.48"\n`,
    })
  }

  // The books she keeps for other people.
  await seedClients(db)

  return entity
}
