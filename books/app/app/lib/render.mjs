// render.mjs — plain text a person can read, in either language.
//
// Text first, because text is what survives: it prints, it pastes into LINE,
// it goes in an email, it reads aloud, and it does not need a browser open. A
// page can be built from the same data later without moving any of this.
//
// THAI AND KHMER WIDTH. Thai vowels and tone marks above and below the line
// take no width of their own — สมุด is four code points and three columns.
// Khmer is worse: a subscript consonant is written under the one before it,
// introduced by an invisible COENG character, so ក្ម is three code points in
// one column, and the vowel signs and diacritics stack on top of that. Padding
// either script by its length over-pads, and every column after it walks left.
// `width()` skips the marks that occupy no column.

const NONSPACING = new RegExp([
  '[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]',        // Thai vowels above/below, tone marks
  '[\u17B4\u17B5]',                              // Khmer inherent vowels, invisible
  '[\u17B7-\u17BD]',                             // Khmer vowel signs above/below
  '[\u17C6-\u17D3]',                             // Khmer signs: nikahit, coeng, robat, …
  '[\u17DD]',                                     // Khmer atthacan
  '[\u200B\u200C\u200D]',                       // zero width space/joiners
].join('|'), 'gu')

export const width = (s) => String(s ?? '')
  // A Khmer subscript is COENG plus the consonant it stacks: both sit under the
  // letter before them and take no column of their own.
  .replace(/\u17D2./gu, '')
  .replace(NONSPACING, '')
  .length

export function pad(s, n, align = 'left') {
  const str = String(s ?? '')
  const gap = Math.max(0, n - width(str))
  if (align === 'right') return ' '.repeat(gap) + str
  if (align === 'center') {
    const l = Math.floor(gap / 2)
    return ' '.repeat(l) + str + ' '.repeat(gap - l)
  }
  return str + ' '.repeat(gap)
}

/**
 * A table with columns sized to their contents.
 * @param cols [{ key, label, align }]
 */
export function table(rows, cols, { gap = 2 } = {}) {
  const widths = cols.map((c) => Math.max(
    width(c.label ?? ''),
    ...rows.map((r) => width(r[c.key] ?? ''))))
  const sep = ' '.repeat(gap)
  const head = cols.map((c, i) => pad(c.label ?? '', widths[i], c.align)).join(sep)
  const rule = widths.map((w) => '─'.repeat(w)).join(sep)
  const body = rows.map((r) =>
    cols.map((c, i) => pad(r[c.key] ?? '', widths[i], c.align)).join(sep))
  return [head, rule, ...body].join('\n')
}

export const rule = (n = 64, ch = '─') => ch.repeat(n)

/** A heading with room around it — the screen is read by someone who does not
 *  want to hunt for where a section starts. */
export function heading(text, { char = '━', n = 64 } = {}) {
  return `\n${text}\n${char.repeat(Math.max(width(text), Math.min(n, 64)))}\n`
}

/** Label and value in two columns, the label padded to the longest. */
export function fields(pairs) {
  const w = Math.max(...pairs.map(([k]) => width(k)))
  return pairs.map(([k, v]) => `${pad(k, w)}  ${v}`).join('\n')
}
