// clock.mjs — local days, in the household's timezone.
//
// Everything stored in this system is an instant in UTC, and everything a
// person schedules is a LOCAL DAY. Those are not the same thing and the gap is
// seven hours wide: at 09:00 in Chiang Mai it is still yesterday in UTC, so a
// morning shift written with `new Date().toISOString().slice(0,10)` lands on
// the day before and the whole schedule is quietly off by one.
//
// So: instants convert to a local YYYY-MM-DD exactly once, here, and after
// that a date is a plain string that no timezone can touch again.

const DAY = 86_400_000

/** The local calendar date of an instant, as YYYY-MM-DD.
 *  'en-CA' is the trick — its short date format IS ISO order. */
export function localDate(instant = new Date(), tz = 'Asia/Bangkok') {
  const d = instant instanceof Date ? instant : new Date(instant)
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/** The local wall-clock time of an instant, as HH:MM (24h). */
export function localTime(instant = new Date(), tz = 'Asia/Bangkok') {
  const d = instant instanceof Date ? instant : new Date(instant)
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d)
}

/** Date arithmetic on the STRING, never on a Date — no timezone involved, so
 *  no daylight-saving or offset can move a day. */
export function addDays(dateStr, n) {
  const t = Date.parse(`${dateStr}T00:00:00Z`)
  return new Date(t + n * DAY).toISOString().slice(0, 10)
}

export const dayIndex = (dateStr) =>
  new Date(`${dateStr}T00:00:00Z`).getUTCDay()      // 0 = Sunday

/** n consecutive dates starting at `from`. */
export const runOfDays = (from, n) =>
  Array.from({ length: n }, (_, i) => addDays(from, i))

/** Whole days between two date strings — negative if `b` is earlier. */
export const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY)

const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_TH = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']
const MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MON_TH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
                'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']

/** "Tue 2 Sep" / "อ. 2 ก.ย." — no year, because a schedule never spans one and
 *  the Thai reading would be the Buddhist Era, which is one more thing to get
 *  wrong for no gain. */
export function dayLabel(dateStr, locale = 'en') {
  const [, m, d] = dateStr.split('-')
  const i = dayIndex(dateStr)
  return locale === 'th'
    ? `${DOW_TH[i]} ${Number(d)} ${MON_TH[Number(m) - 1]}`
    : `${DOW_EN[i]} ${Number(d)} ${MON_EN[Number(m) - 1]}`
}

/** "Today" / "Tomorrow" / the day name — relative first, because a relative
 *  word cannot be misread and a date can. */
export function dayName(dateStr, today, locale = 'en') {
  const n = daysBetween(today, dateStr)
  if (locale === 'th') {
    if (n === 0) return 'วันนี้'
    if (n === 1) return 'พรุ่งนี้'
    if (n === -1) return 'เมื่อวาน'
    return dayLabel(dateStr, 'th')
  }
  if (n === 0) return 'Today'
  if (n === 1) return 'Tomorrow'
  if (n === -1) return 'Yesterday'
  return dayLabel(dateStr, 'en')
}

/** HH:MM comparison as a string — both sides are zero-padded 24h, so string
 *  order IS time order and no parsing is needed. */
export const atOrPast = (hhmm, nowHHMM) => nowHHMM >= hhmm
