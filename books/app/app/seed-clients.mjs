// seed-clients.mjs — the books she keeps for other people.
//
// A bookkeeping practice is several sets of books, not one with a column for
// the client: each company has its own chart of accounts, its own document
// numbers, its own tax registration and its own filing calendar, and the
// engine already works that way. What the practice adds on top is one list of
// who needs what this week, and one place where the clients' receipts land.
//
// Each client below is shaped differently on purpose: one is VAT registered and
// one is not, one bills with tax withheld at source, one is a cash business.

import {
  createEntity, addProject, addPerson, addMembership,
} from './modules/entities.mjs'
import { post } from './modules/books.mjs'
import { draft, issue, recordPayment } from './modules/documents.mjs'
import { generateFilings, markLate, markFiled } from './modules/compliance.mjs'
import { openChannel, receive } from './modules/intake.mjs'
import { uid } from './lib/ids.mjs'
import { localDate } from './lib/clock.mjs'

const DAY = 86400000
const dayOffset = (n, from = localDate()) =>
  new Date(Date.parse(`${from}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

async function party(db, entityId, p) {
  const id = uid()
  await db.run(
    `INSERT INTO party(id, entity_id, code, name_en, name_th, kind, tax_id, is_company, terms_days)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    id, entityId, p.code, p.name_en, p.name_th ?? null, p.kind ?? 'both',
    p.tax_id ?? null, p.is_company ?? 1, p.terms_days ?? 0)
  return db.get('SELECT * FROM party WHERE id = ?', id)
}

const acc = async (db, entityId, code) =>
  (await db.get('SELECT id FROM account WHERE entity_id = ? AND code = ?', entityId, code)).id

/** One client's books: a few months of trade, the ways in, and some post. */
async function client(db, spec) {
  const entity = await createEntity(db, {
    code: spec.code,
    name_en: spec.name_en,
    name_th: spec.name_th,
    kind: spec.kind,
    tax_id: spec.tax_id,
    vat_registered: spec.vat ? 1 : 0,
    vat_from: spec.vat ? `${localDate().slice(0, 4)}-01-01` : null,
    address_en: spec.address_en,
    note: spec.note,
  })
  const line = await addProject(db, entity.id, {
    code: `${spec.code}-main`, name_en: spec.line_en, name_th: spec.line_th, lane: spec.lane,
  })

  const customers = []
  for (const c of spec.customers) customers.push(await party(db, entity.id, c))
  const suppliers = []
  for (const s of spec.suppliers) suppliers.push(await party(db, entity.id, s))

  // Money to start the year with.
  await post(db, {
    entity_id: entity.id,
    on_date: dayOffset(-75),
    memo_en: 'Opening balance',
    memo_th: 'ยอดยกมา',
    lines: [
      { account: '1010', amount: spec.opening },
      { account: '3000', amount: -spec.opening },
    ],
  })

  // What they sell.
  const revenue = await acc(db, entity.id, spec.revenue_account || '4100')
  for (const sale of spec.sales) {
    if (sale.cash) {
      const vat = spec.vat ? Math.round((sale.amount * 700) / 10700) : 0
      await post(db, {
        entity_id: entity.id,
        on_date: sale.date,
        memo_en: sale.desc_en,
        memo_th: sale.desc_th,
        source_kind: 'takings',
        lines: [
          { account: '1000', amount: sale.amount, project_id: line.id },
          { account: spec.revenue_account || '4000', amount: -(sale.amount - vat), project_id: line.id, tax_code: vat ? 'VAT7' : null },
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
      subject_th: sale.desc_th,
      lines: [{
        desc_en: sale.desc_en, desc_th: sale.desc_th, unit_price: sale.amount,
        qty_milli: (sale.qty ?? 1) * 1000, unit: sale.unit ?? 'item',
        tax_code: spec.vat ? 'VAT7' : 'NONE', account_id: revenue, project_id: line.id,
      }],
    })).id)
    if (sale.paid) {
      await recordPayment(db, {
        entity_id: entity.id,
        direction: 'in',
        on_date: dayOffset(sale.paid_after ?? 10, sale.date),
        party_id: inv.party_id,
        account: '1010',
        amount: inv.expect_paid,
        wht_amount: inv.wht,
        wht_cert_no: inv.wht ? `WHT-${inv.number}` : null,
        allocations: [{ doc_id: inv.id, amount: inv.expect_paid, wht_amount: inv.wht }],
      })
    }
  }

  // What they buy.
  for (const cost of spec.costs) {
    const bill = await issue(db, (await draft(db, {
      entity_id: entity.id,
      kind: 'bill',
      party_id: suppliers[cost.supplier ?? 0].id,
      project_id: line.id,
      issue_date: cost.date,
      due_date: dayOffset(30, cost.date),
      wht_bp: cost.wht ?? 0,
      lines: [{
        desc_en: cost.desc_en, desc_th: cost.desc_th, unit_price: cost.amount,
        tax_code: spec.vat ? 'VAT7' : 'NONE',
        account_id: await acc(db, entity.id, cost.account), project_id: line.id,
      }],
    })).id)
    if (cost.paid) {
      await recordPayment(db, {
        entity_id: entity.id,
        direction: 'out',
        on_date: dayOffset(5, cost.date),
        party_id: bill.party_id,
        account: '1010',
        amount: bill.expect_paid,
        wht_amount: bill.wht,
        wht_cert_no: bill.wht ? `WHT-OUT-${bill.number}` : null,
        allocations: [{ doc_id: bill.id, amount: bill.expect_paid, wht_amount: bill.wht }],
      })
    }
  }

  // The ways in, and what has come through them.
  const link = await openChannel(db, { entity_id: entity.id, kind: 'link', label: spec.name_en })
  await openChannel(db, {
    entity_id: entity.id, kind: 'email', label: 'Forward receipts',
    address: `${spec.code}@receipts.example`,
  })
  await openChannel(db, {
    entity_id: entity.id, kind: 'line', label: 'LINE', address: `@${spec.code}books`,
  })
  for (const post_ of spec.inbox || []) {
    await receive(db, {
      entity_id: entity.id,
      channel_id: link.id,
      source: post_.source || 'link',
      from_ref: post_.from,
      on_date: post_.date,
      kind: post_.kind || 'bill',
      description: post_.desc,
      amount: post_.amount,
      party_hint: post_.party_hint,
      slip_ref: post_.slip,
      photo_name: post_.photo,
      idem_key: `seed:${spec.code}:${post_.desc}:${post_.date}`,
    })
  }

  // Their filing calendar, with the older months already done.
  const year = localDate().slice(0, 4)
  await generateFilings(db, entity.id, { from: `${year}-01-01`, to: `${Number(year) + 1}-06-30` })
  await markLate(db, entity.id, localDate())
  const done = await db.all(
    `SELECT id, due_date FROM filing WHERE entity_id = ? AND due_date < ? AND status <> 'filed'`,
    entity.id, dayOffset(spec.behind ? -40 : -8))
  for (const f of done) {
    await markFiled(db, f.id, {
      filed_on: dayOffset(-2, f.due_date), ref: `RD-${f.due_date.replace(/-/g, '')}`,
    })
  }
  return entity
}

/** The four sets of books she keeps for other people. */
export async function seedClients(db) {
  const made = []

  made.push(await client(db, {
    code: 'maefah', name_en: 'Mae Fah Coffee House', name_th: 'ร้านกาแฟแม่ฟ้า',
    kind: 'company', vat: true, tax_id: '9990000000011',
    address_en: '14 Singhaklai Road, Chiang Rai',
    line_en: 'Café', line_th: 'ร้านกาแฟ', lane: 'product',
    revenue_account: '4000', opening: 12_000_000,
    note: 'Cash takings banked weekly; supplier bills come in by photo.',
    customers: [{ code: 'walkin', name_en: 'Walk-in customers', name_th: 'ลูกค้าหน้าร้าน', is_company: 0 }],
    suppliers: [
      { code: 'roaster', name_en: 'Doi Example roastery', name_th: 'โรงคั่วดอยตัวอย่าง', tax_id: '9990000000012' },
      { code: 'dairy', name_en: 'Chiang Rai dairy', name_th: 'นมเชียงราย' },
    ],
    sales: [
      { cash: true, amount: 4_820_000, date: dayOffset(-28), desc_en: 'Takings, week', desc_th: 'ยอดขายรายสัปดาห์' },
      { cash: true, amount: 5_140_000, date: dayOffset(-21), desc_en: 'Takings, week', desc_th: 'ยอดขายรายสัปดาห์' },
      { cash: true, amount: 4_660_000, date: dayOffset(-14), desc_en: 'Takings, week', desc_th: 'ยอดขายรายสัปดาห์' },
      { cash: true, amount: 5_380_000, date: dayOffset(-7), desc_en: 'Takings, week', desc_th: 'ยอดขายรายสัปดาห์' },
    ],
    costs: [
      { supplier: 0, amount: 2_400_000, date: dayOffset(-26), account: '5000', paid: true,
        desc_en: 'Coffee beans, 60 kg', desc_th: 'เมล็ดกาแฟ 60 กก.' },
      { supplier: 1, amount: 860_000, date: dayOffset(-12), account: '5000', paid: true,
        desc_en: 'Milk and cream', desc_th: 'นมและครีม' },
      { supplier: 0, amount: 2_400_000, date: dayOffset(-3), account: '5000', paid: false,
        desc_en: 'Coffee beans, 60 kg', desc_th: 'เมล็ดกาแฟ 60 กก.' },
    ],
    inbox: [
      { from: 'Nid (manager)', date: dayOffset(-2), desc: 'Electricity bill, September', amount: 640_000,
        party_hint: 'PEA', photo: 'pea-sept.jpg', source: 'line' },
      { from: 'Nid (manager)', date: dayOffset(-1), desc: 'New grinder, cash', amount: 1_890_000,
        party_hint: 'Coffee equipment shop', photo: 'grinder-receipt.jpg' },
      { from: 'Nid (manager)', date: dayOffset(-1), desc: 'Laundry, aprons and cloths', amount: 120_000,
        party_hint: 'Laundry next door', source: 'line' },
    ],
  }))

  made.push(await client(db, {
    code: 'doiping', name_en: 'Doi Ping Guesthouse', name_th: 'ดอยปิง เกสต์เฮาส์',
    kind: 'sole', vat: false, tax_id: null,
    address_en: '9 Soi 3, Mueang Chiang Rai',
    line_en: 'Rooms', line_th: 'ห้องพัก', lane: 'space',
    revenue_account: '4000', opening: 6_500_000, behind: true,
    note: 'Under the VAT threshold; the question is when it crosses.',
    customers: [
      { code: 'guests', name_en: 'Guests', name_th: 'ผู้เข้าพัก', is_company: 0 },
      { code: 'platform', name_en: 'Booking platform', name_th: 'แพลตฟอร์มจอง', terms_days: 15 },
    ],
    suppliers: [{ code: 'laundry', name_en: 'Rim Kok laundry', name_th: 'ร้านซักรีดริมกก' }],
    sales: [
      { cash: true, amount: 2_260_000, date: dayOffset(-24), desc_en: 'Room takings', desc_th: 'รายได้ห้องพัก' },
      { cash: true, amount: 1_980_000, date: dayOffset(-17), desc_en: 'Room takings', desc_th: 'รายได้ห้องพัก' },
      { customer: 1, amount: 3_400_000, date: dayOffset(-10), paid: true, paid_after: 6,
        desc_en: 'Platform payout, 34 nights', desc_th: 'ยอดโอนจากแพลตฟอร์ม 34 คืน' },
      { customer: 1, amount: 2_900_000, date: dayOffset(-2), paid: false,
        desc_en: 'Platform payout, 29 nights', desc_th: 'ยอดโอนจากแพลตฟอร์ม 29 คืน' },
    ],
    costs: [
      { supplier: 0, amount: 480_000, date: dayOffset(-20), account: '6900', paid: true,
        desc_en: 'Linen washing', desc_th: 'ซักผ้าปูที่นอน' },
    ],
    inbox: [
      { from: 'Khun Ploy', date: dayOffset(-3), desc: 'Water bill', amount: 210_000,
        party_hint: 'Waterworks', photo: 'water.jpg', source: 'line' },
      { from: 'Khun Ploy', date: dayOffset(-1), desc: 'Transfer slip, guest deposit', amount: 500_000,
        kind: 'payment', slip: 'PP-882314', photo: 'slip.jpg', source: 'slip' },
    ],
  }))

  made.push(await client(db, {
    code: 'rimkok', name_en: 'Ban Rim Kok Property Co., Ltd.', name_th: 'บริษัท บ้านริมกก พร็อพเพอร์ตี้ จำกัด',
    kind: 'company', vat: true, tax_id: '9990000000013',
    address_en: '212 Rim Kok Road, Chiang Rai',
    line_en: 'Lettings', line_th: 'ค่าเช่า', lane: 'service',
    revenue_account: '4100', opening: 45_000_000,
    note: 'Rent is withheld at 5% by company tenants, so the tax credit matters.',
    customers: [
      { code: 'tenant1', name_en: 'Northern Logistics Co., Ltd.', name_th: 'บริษัท นอร์เทิร์น โลจิสติกส์ จำกัด', tax_id: '9990000000014', terms_days: 7 },
      { code: 'tenant2', name_en: 'Ms Achara (shophouse)', name_th: 'คุณอัจฉรา', is_company: 0 },
    ],
    suppliers: [{ code: 'builder', name_en: 'Rim Kok builders', name_th: 'ช่างริมกก' }],
    sales: [
      { customer: 0, amount: 4_500_000, date: dayOffset(-33), wht: 500, paid: true,
        desc_en: 'Warehouse rent, September', desc_th: 'ค่าเช่าโกดัง เดือนกันยายน' },
      { customer: 1, amount: 1_800_000, date: dayOffset(-33), paid: true,
        desc_en: 'Shophouse rent, September', desc_th: 'ค่าเช่าอาคารพาณิชย์ เดือนกันยายน' },
      { customer: 0, amount: 4_500_000, date: dayOffset(-3), wht: 500, paid: false,
        desc_en: 'Warehouse rent, October', desc_th: 'ค่าเช่าโกดัง เดือนตุลาคม' },
    ],
    costs: [
      { supplier: 0, amount: 3_200_000, date: dayOffset(-15), account: '6700', paid: true, wht: 300,
        desc_en: 'Roof repair', desc_th: 'ซ่อมหลังคา' },
    ],
    inbox: [
      { from: 'Khun Anan', date: dayOffset(-4), desc: 'Land tax receipt', amount: 1_250_000,
        party_hint: 'Municipality', photo: 'land-tax.jpg' },
    ],
  }))

  made.push(await client(db, {
    code: 'somsak', name_en: 'Somsak Design (sole trader)', name_th: 'สมศักดิ์ ดีไซน์',
    kind: 'sole', vat: false, tax_id: null,
    address_en: '77 Phaholyothin Road, Chiang Rai',
    line_en: 'Architecture', line_th: 'งานออกแบบ', lane: 'service',
    revenue_account: '4100', opening: 3_200_000,
    note: 'Every company client withholds 3%; the certificates are the year\'s tax.',
    customers: [
      { code: 'devco', name_en: 'Lanna Development Co., Ltd.', name_th: 'บริษัท ล้านนา ดีเวลลอปเมนท์ จำกัด', tax_id: '9990000000015', terms_days: 30 },
    ],
    suppliers: [{ code: 'printer', name_en: 'Plan printing shop', name_th: 'ร้านพิมพ์แบบ' }],
    sales: [
      { customer: 0, amount: 8_000_000, date: dayOffset(-40), wht: 300, paid: true, paid_after: 20,
        desc_en: 'Design stage 1', desc_th: 'งานออกแบบ ระยะที่ 1' },
      { customer: 0, amount: 6_000_000, date: dayOffset(-8), wht: 300, paid: false, terms: 30,
        desc_en: 'Design stage 2', desc_th: 'งานออกแบบ ระยะที่ 2' },
    ],
    costs: [
      { supplier: 0, amount: 420_000, date: dayOffset(-9), account: '6700', paid: true,
        desc_en: 'Plan printing', desc_th: 'ค่าพิมพ์แบบ' },
    ],
    inbox: [
      { from: 'Somsak', date: dayOffset(-2), desc: 'Site visit, fuel and tolls', amount: 96_000,
        party_hint: 'PTT', photo: 'fuel.jpg', source: 'line' },
    ],
  }))

  return made
}
