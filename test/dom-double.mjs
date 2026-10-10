/**
 * Minimal DOM double for the dsh-arrow-navigator tests.
 *
 * It implements only what the client bundle touches: attribute selectors,
 * `closest`, tree queries, `dataset`, geometry through explicit layout numbers,
 * and a scrollport whose `scrollTop` moves its children's viewport rects.
 * Geometry mirrors the browser: a row's viewport top is
 * `scrollerRect.top + (row.contentTop - scroller.scrollTop)`.
 */

function parseCompound (part) {
  const matchers = []
  let rest = part
  const tag = /^([a-zA-Z][\w-]*)/.exec(rest)
  if (tag !== null) {
    matchers.push({ kind: 'tag', tag: tag[1].toUpperCase() })
    rest = rest.slice(tag[0].length)
  }
  while (rest.length > 0) {
    const klass = /^\.([\w-]+)/.exec(rest)
    if (klass !== null) {
      matchers.push({ kind: 'class', name: klass[1] })
      rest = rest.slice(klass[0].length)
      continue
    }
    const attr = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest)
    if (attr !== null) {
      matchers.push({ kind: 'attr', name: attr[1], value: attr[2] })
      rest = rest.slice(attr[0].length)
      continue
    }
    throw new Error(`dom-double: unsupported selector part "${part}"`)
  }
  if (matchers.length === 0) throw new Error(`dom-double: unsupported selector part "${part}"`)
  return matchers
}

function parseSelector (selector) {
  return selector.split(',').map((part) => parseCompound(part.trim())).filter((group) => group.length > 0)
}

function matchesOne (element, matcher) {
  if (matcher.kind === 'tag') return element.tagName === matcher.tag
  if (matcher.kind === 'class') return String(element.className ?? '').split(/\s+/).includes(matcher.name)
  const value = element.getAttribute(matcher.name)
  if (value === null) return false
  return matcher.value === undefined || value === matcher.value
}

function matches (element, groups) {
  return groups.some((group) => group.every((matcher) => matchesOne(element, matcher)))
}

export class El {
  constructor (tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase()
    this.attrs = {}
    this.dataset = {}
    this.children = []
    this.parent = null
    this.text = ''
    this.hidden = false
    this.disabled = false
    this.value = undefined
    this.isConnected = true
    this.scrollTop = 0
    this.scrollHeight = 0
    this.clientHeight = 0
    this.contentTop = 0
    this.listeners = {}
    for (const [name, value] of Object.entries(attrs)) this.setAttribute(name, value)
  }

  setAttribute (name, value) {
    this.attrs[name] = String(value)
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())
      this.dataset[key] = String(value)
    }
    if (name === 'hidden') this.hidden = true
    if (name === 'disabled') this.disabled = true
    if (name === 'value') this.value = String(value)
  }

  getAttribute (name) {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null
  }

  removeAttribute (name) {
    delete this.attrs[name]
    if (name === 'hidden') this.hidden = false
  }

  appendChild (child) {
    child.parent = this
    this.children.push(child)
    return child
  }

  remove () {
    if (this.parent === null) return
    this.parent.children = this.parent.children.filter((child) => child !== this)
    this.parent = null
    this.isConnected = false
  }

  get textContent () {
    return this.text + this.children.map((child) => child.textContent).join('')
  }

  // The DOM exposes both names; the double stores one parent link.
  get parentElement () { return this.parent ?? null }
  get parentNode () { return this.parent ?? null }

  set textContent (value) {
    this.text = String(value)
    this.children = []
  }

  descendants () {
    const out = []
    for (const child of this.children) {
      out.push(child, ...child.descendants())
    }
    return out
  }

  querySelectorAll (selector) {
    const matchers = parseSelector(selector)
    return this.descendants().filter((element) => matches(element, matchers))
  }

  querySelector (selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  closest (selector) {
    const matchers = parseSelector(selector)
    let node = this
    while (node !== null && node !== undefined) {
      if (matches(node, matchers)) return node
      node = node.parent
    }
    return null
  }

  contains (other) {
    let node = other
    while (node !== null && node !== undefined) {
      if (node === this) return true
      node = node.parent
    }
    return false
  }

  getBoundingClientRect () {
    const scroller = this.closest('[data-conversation-scroll]')
    const isScroller = this.getAttribute('data-conversation-scroll') !== null
    if (isScroller || scroller === null) {
      return {
        top: this.viewportTop ?? 0,
        left: 0,
        width: this.viewportWidth ?? 800,
        height: isScroller ? this.clientHeight : (this.rectHeight ?? 24)
      }
    }
    return {
      top: (scroller.viewportTop ?? 0) + (this.contentTop - scroller.scrollTop),
      left: 0,
      width: this.viewportWidth ?? 600,
      height: this.rectHeight ?? 40
    }
  }

  click () {
    if (this.disabled) return
    this.listeners.click?.()
  }

  dispatchEvent (event) {
    this.dispatched = this.dispatched ?? []
    this.dispatched.push(event.type)
    this.listeners[event.type]?.(event)
    return true
  }

  scrollTo (options) {
    if (typeof options === 'number') {
      this.scrollTop = options
      return
    }
    this.scrollCalls = this.scrollCalls ?? []
    this.scrollCalls.push(options ?? null)
    if (typeof options?.top === 'number') this.scrollTop = options.top
  }

  scrollIntoView (options) {
    this.scrollCalls = this.scrollCalls ?? []
    this.scrollCalls.push(options ?? null)
  }

  addEventListener (type, listener) {
    this.listeners[type] = listener
  }
}

/**
 * One sidebar group, mimicking `ui-workspace`:
 * - it renders at most `limit` (5 in the product) Session rows at a time;
 * - an `overflow:<key>` button carries the hidden count while rows are hidden and
 *   reveals one batch per press (the final press reveals the rest); once nothing is
 *   hidden the same button stays mounted as the group's collapse control
 *   (`aria-expanded="true"`, label "收起"), exactly like the product;
 * - a collapsed group renders only its `workspace:<key>` header with
 *   `aria-expanded="false"`, and clicking the header toggles the group.
 */
export function createSidebarGroup (doc, { key, sessionIds, limit = 5, expanded = true, shown, selectedId = null, parent = null }) {
  const header = new El('div', { 'data-row-key': `workspace:${key}`, role: 'treeitem', 'aria-expanded': expanded ? 'true' : 'false' })
  const body = new El('div')
  const initial = shown ?? Math.min(limit, sessionIds.length)
  const group = { header, body, shown: expanded ? initial : 0, expanded }
  ;(parent ?? doc.body).appendChild(header)
  ;(parent ?? doc.body).appendChild(body)
  let overflow = null
  const render = () => {
    // React reuses the button node while it stays mounted, so the double keeps it
    // across re-renders instead of recreating it.
    for (const child of [...body.children]) {
      if (child !== overflow) child.remove()
    }
    const visible = group.expanded ? sessionIds.slice(0, group.shown) : []
    for (const id of visible) {
      const row = new El('div', { 'data-row-key': `session:${id}`, role: 'treeitem' })
      if (id === selectedId) row.setAttribute('aria-selected', 'true')
      body.appendChild(row)
    }
    // The button exists while the group has more rows than one default batch.
    if (!group.expanded || sessionIds.length <= limit) {
      overflow?.remove()
      overflow = null
      return
    }
    const visibleHidden = sessionIds.length - visible.length
    const sessionsExpanded = visibleHidden === 0
    if (overflow === null) {
      overflow = new El('button', { 'data-row-key': `overflow:${key}` })
      // React rebuilds this handler on every render, so it reads the current row
      // count rather than a value captured when the button first mounted.
      overflow.addEventListener('click', () => {
        const expandedNow = sessionIds.length - group.shown <= 0
        const remaining = sessionIds.length - group.shown
        group.shown = expandedNow ? limit : (remaining <= limit ? sessionIds.length : group.shown + limit)
        render()
      })
      body.appendChild(overflow)
    } else if (overflow.parent !== body) {
      body.appendChild(overflow)
    }
    overflow.textContent = sessionsExpanded ? '收起' : `展开其余 ${visibleHidden} 个会话`
    overflow.setAttribute('aria-expanded', sessionsExpanded ? 'true' : 'false')
  }
  header.addEventListener('click', () => {
    group.expanded = !group.expanded
    header.setAttribute('aria-expanded', group.expanded ? 'true' : 'false')
    group.shown = group.expanded ? initial : 0
    render()
  })
  render()
  return group
}

export function createDocument () {
  const html = new El('html')
  const head = new El('head')
  const body = new El('body')
  html.appendChild(head)
  html.appendChild(body)
  const doc = {
    documentElement: html,
    head,
    body,
    activeElement: body,
    createElement: (tag) => new El(tag),
    querySelectorAll: (selector) => {
      const matchers = parseSelector(selector)
      return [html, ...html.descendants()].filter((element) => matches(element, matchers))
    },
    querySelector (selector) {
      return this.querySelectorAll(selector)[0] ?? null
    }
  }
  return doc
}

/** Build a scrollport with Turn rows: `turns` is an array of turn numbers. */
export function createConversation (doc, { turns, sessionId = 's1', viewportTop = 100, clientHeight = 600, rowHeight = 50, rail = false, parent = null }) {
  const scroller = new El('div', { 'data-conversation-scroll': '' })
  scroller.viewportTop = viewportTop
  scroller.clientHeight = clientHeight
  scroller.scrollHeight = turns.length * rowHeight + 2000
  const wrapper = new El('div', { 'data-slot': 'main.conversation' })
  const occurrence = new El('div', { 'data-conversation-session': sessionId })
  const column = new El('div')
  if (rail) scroller.appendChild(createTurnRail(scroller, column, turns))
  occurrence.appendChild(column)
  wrapper.appendChild(occurrence)
  scroller.appendChild(wrapper)
  ;(parent ?? doc.body).appendChild(scroller)
  let cursor = 0
  for (const turn of turns) {
    const row = new El('div', { 'data-chat-turn': String(turn) })
    row.contentTop = cursor
    row.rectHeight = rowHeight
    column.appendChild(row)
    cursor += rowHeight
  }
  return { scroller, column, wrapper, occurrence }
}

/**
 * Chat's own Turn navigation rail: one mark per Turn, `data-index` in rail order,
 * `aria-current` on the active mark, and a press that aligns that Turn exactly as
 * the product does.
 */
export function createTurnRail (scroller, column, turns) {
  const box = new El('nav', { 'aria-label': 'conversation turn navigation' })
  const marks = []
  const activate = (index) => {
    for (const [position, mark] of marks.entries()) {
      if (position === index) mark.setAttribute('aria-current', 'true')
      else mark.removeAttribute('aria-current')
    }
    const row = column.children[index]
    if (row !== undefined) scroller.scrollTop = Math.max(0, row.contentTop - 24)
  }
  turns.forEach((turn, index) => {
    const mark = new El('button', { 'data-index': String(index), 'aria-label': `跳转到第 ${turn} 段` })
    if (index === 0) mark.setAttribute('aria-current', 'true')
    mark.addEventListener('click', () => activate(index))
    box.appendChild(mark)
    marks.push(mark)
  })
  box.marks = marks
  box.activate = activate
  return box
}

export function setTurnRows (conversation, turns, rowHeight = 50) {
  conversation.column.children = []
  let cursor = 0
  for (const turn of turns) {
    const row = new El('div', { 'data-chat-turn': String(turn) })
    row.contentTop = cursor
    row.rectHeight = rowHeight
    conversation.column.appendChild(row)
    cursor += rowHeight
  }
  conversation.scroller.scrollHeight = turns.length * rowHeight + 2000
  return conversation.column.children
}
