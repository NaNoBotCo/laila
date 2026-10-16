// hijri.mjs — the Islamic calendar, arithmetically.
//
// Used for two dates a business plans around: Eid al-Fitr and Eid al-Adha,
// when suppliers, staff and offices may be closed and an errand will not get
// done. The conversion here is the standard TABULAR calendar, which is a
// calculation rather than an observation: the actual day is set by the moon
// sighting and can differ by a day either way.
//
// So every date this file produces is marked `expected`, and the calendar row
// it feeds can be corrected by hand. A date that might move by a day is still
// worth having a month ahead; presenting it as certain is what would be wrong.

const ISLAMIC_EPOCH = 1948439.5     // 1 Muharram 1 AH, in Julian days

const floor = Math.floor

const gregorianToJd = (y, m, d) => {
  const a = floor((14 - m) / 12)
  const yy = y + 4800 - a
  const mm = m + 12 * a - 3
  return d + floor((153 * mm + 2) / 5) + 365 * yy + floor(yy / 4) -
    floor(yy / 100) + floor(yy / 400) - 32045 - 0.5
}

function jdToGregorian(jd) {
  const z = floor(jd + 0.5)
  const a = z < 2299161 ? z : (() => {
    const alpha = floor((z - 1867216.25) / 36524.25)
    return z + 1 + alpha - floor(alpha / 4)
  })()
  const b = a + 1524
  const c = floor((b - 122.1) / 365.25)
  const d = floor(365.25 * c)
  const e = floor((b - d) / 30.6001)
  const day = b - d - floor(30.6001 * e)
  const month = e < 14 ? e - 1 : e - 13
  const year = month > 2 ? c - 4716 : c - 4715
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Hijri date → Gregorian, tabular. */
export function hijriToGregorian(hy, hm, hd) {
  const jd = hd + Math.ceil(29.5 * (hm - 1)) + (hy - 1) * 354 +
    floor((3 + 11 * hy) / 30) + ISLAMIC_EPOCH - 1
  return jdToGregorian(jd)
}

/** Gregorian → Hijri, tabular. */
export function gregorianToHijri(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const jd = floor(gregorianToJd(y, m, d)) + 0.5
  const year = floor((30 * (jd - ISLAMIC_EPOCH) + 10646) / 10631)
  const firstOfYear = hijriToJd(year, 1, 1)
  const month = Math.min(12, Math.ceil((jd - 29 - firstOfYear) / 29.5) + 1)
  const day = jd - hijriToJd(year, month, 1) + 1
  return { year, month, day }
}

const hijriToJd = (hy, hm, hd) =>
  hd + Math.ceil(29.5 * (hm - 1)) + (hy - 1) * 354 + floor((3 + 11 * hy) / 30) +
  ISLAMIC_EPOCH - 1

export const MONTHS = ['Muharram', 'Safar', 'Rabi al-Awwal', 'Rabi al-Thani',
  'Jumada al-Ula', 'Jumada al-Akhirah', 'Rajab', 'Shaban', 'Ramadan', 'Shawwal',
  'Dhul-Qadah', 'Dhul-Hijjah']

/**
 * The dates worth a line in a calendar, for a Gregorian year. Ramadan's start
 * matters for working hours as much as the two Eids do.
 */
export function observancesIn(gregorianYear) {
  const out = []
  const candidates = [
    gregorianToHijri(`${gregorianYear}-01-15`).year,
    gregorianToHijri(`${gregorianYear}-12-15`).year,
  ]
  for (const hy of [...new Set(candidates)]) {
    for (const [hm, hd, en, th] of [
      [9, 1, 'Ramadan begins', 'เริ่มเดือนรอมฎอน'],
      [10, 1, 'Eid al-Fitr', 'วันอีฎิ้ลฟิตริ'],
      [12, 10, 'Eid al-Adha', 'วันอีฎิ้ลอัฎฮา'],
    ]) {
      const on = hijriToGregorian(hy, hm, hd)
      if (on.slice(0, 4) !== String(gregorianYear)) continue
      out.push({
        on, name_en: en, name_th: th, kind: 'observance', expected: true,
        hijri: `${hd} ${MONTHS[hm - 1]} ${hy}`,
      })
    }
  }
  return out.sort((a, b) => a.on.localeCompare(b.on))
}
