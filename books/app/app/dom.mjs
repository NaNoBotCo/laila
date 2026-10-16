// dom.mjs — element building, small enough to read in one go.
//
// No framework: every screen is a function that returns elements and the view
// is replaced whole. At this size that is faster to follow than a diff, and it
// means a screen cannot hold stale state.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k === 'class') el.className = v
    else if (k === 'html') el.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (k === 'value') el.value = v
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = Boolean(v)
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

export const frag = (...children) => {
  const f = document.createDocumentFragment()
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue
    f.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return f
}

export function mount(node, ...children) {
  node.replaceChildren(frag(...children))
  return node
}

/** A table from rows and column definitions. `cols` take {key|render, label,
 *  num} and a row may carry an onclick. */
export function dataTable(rows, cols, { onRow = null, empty = null } = {}) {
  if (!rows.length && empty) return h('div', { class: 'empty' }, empty)
  // `phone: false` keeps a column off a narrow screen, where a row is a card
  // and seven lines of it is a wall.
  const cls = (c, base) => [base, c.phone === false ? 'phone-hide' : null]
    .filter(Boolean).join(' ') || null
  return h('table', {},
    h('thead', {}, h('tr', {}, cols.map((c) =>
      h('th', { class: cls(c, c.num ? 'num' : '') }, c.label)))),
    h('tbody', {}, rows.map((r) =>
      h('tr', {
        class: onRow ? 'click' : null,
        onclick: onRow ? () => onRow(r) : null,
      }, cols.map((c) => h('td', {
        class: cls(c, c.num ? 'num' : c.class || ''),
        // Narrow screens turn each row into a card and read this attribute as
        // the label, so a table needs no second markup for the phone.
        'data-label': c.label || null,
      }, c.render ? c.render(r) : r[c.key]))))))
}
