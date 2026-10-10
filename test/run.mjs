/**
 * Node-level tests for dsh-arrow-navigator.
 *
 * The browser bundle is a `window.__ModuleLoader__.load(...)` module, so the test
 * evaluates it with the DOM double in place, then drives the captured
 * `observeFixedInput` listener with synthetic keydown frames and asserts the
 * resulting Session opens, scroll offsets, and guard behavior.
 *
 * Run: node test/run.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { El, createDocument, createConversation, setTurnRows, createSidebarGroup } from './dom-double.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')
const rootPath = path.join(here, '..')

let failures = 0
let checks = 0
function check (label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
function equal (label, actual, expected) {
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------
const document = createDocument()
const storage = new Map()
const windowListeners = new Map()
const window = {
  document,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value))
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  requestAnimationFrame: (fn) => { fn(); return 0 },
  addEventListener: (type, listener) => {
    if (!windowListeners.has(type)) windowListeners.set(type, new Set())
    windowListeners.get(type).add(listener)
  },
  removeEventListener: (type, listener) => {
    windowListeners.get(type)?.delete(listener)
  },
  __ModuleLoader__: { rows: [], load (row) { this.rows.push(row) } }
}
/** Deliver a window event to the plugin's own listeners (keyup, blur). */
function fireWindow (type, event = {}) {
  for (const listener of [...(windowListeners.get(type) ?? [])]) listener(event)
}

/** Wait for real timers, so held-key cadence can be exercised. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** The plugin's held-key cadence, mirrored here so tests can time a hold. */
const HOLD_DELAY_MS = 220
const HOLD_STEP_MS = 90
globalThis.window = window
globalThis.document = document
globalThis.Element = El
/** Minimal Event stub: the plugin announces `scrollend`, Chat listens for it. */
globalThis.Event = class Event {
  constructor (type) {
    this.type = type
  }
}

const source = fs.readFileSync(bundlePath, 'utf8')
new Function('window', source)(window)
const row = window.__ModuleLoader__.rows[0]
check('bundle registers exactly one module factory', window.__ModuleLoader__.rows.length === 1)
equal('module id is the package name', row.id, 'dsh-arrow-navigator')
const bundle = row.factory(() => { throw new Error('no runtime imports expected') })
check('bundle exports apply()', typeof bundle.apply === 'function')
check('bundle declares required services', JSON.stringify(bundle.inject) === JSON.stringify(['sessions', 'shortcuts', 'locale', 'slots']), JSON.stringify(bundle.inject))

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------
function createSessions (rows, ids = rows.map((entry) => entry.id)) {
  const byId = {}
  for (const entry of rows) byId[entry.id] = { retainedBy: { mainView: 0 }, blank: false, ...entry }
  return {
    list: {
      ids,
      byId,
      phase: 'ready',
      getSnapshot () { return this }
    }
  }
}

function createHarness ({ sessions, workspaces = null, options = null, failOpen = new Set(), silentOpen = new Set() }) {
  const registered = []
  const observers = []
  const opened = []
  const attempts = []
  const disposers = []
  const injected = []
  const slotRegistrations = []
  if (options !== null) storage.set('dsh.arrow-nav.v1', JSON.stringify(options))
  else storage.delete('dsh.arrow-nav.v1')
  const dictionaries = {}
  const ctx = {
    sessions,
    locale: {
      register: (ns, dicts) => {
        dictionaries[ns] = dicts
        return () => {}
      },
      bind: (ns) => (key, params) => {
        const dicts = dictionaries[ns] ?? { zh: {} }
        const template = dicts.zh?.[key] ?? dicts.en?.[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
    shortcuts: {
      registerFixed: (command) => {
        registered.push(command)
        return () => {}
      },
      observeFixedInput: (listener) => {
        observers.push(listener)
        return () => {}
      }
    },
    // the live per-Session retention observable the plugin verifies opens with
    retainInfo: (id) => ({
      getSnapshot: () => ({ retainedBy: { mainView: sessions.list.byId[id]?.retainedBy?.mainView ?? 0 } })
    }),
    slots: {
      inject: (key, callback) => {
        injected.push(key)
        callback()
        return () => {}
      },
      register: (declaration, component) => {
        slotRegistrations.push({ declaration, component })
        return () => {}
      }
    },
    get: (name) => {
      if (name === 'workspaces') {
        if (workspaces === null) return undefined
        // the service exposes `list` as an observable snapshot source
        return { list: { ...workspaces, getSnapshot () { return this } } }
      }
      if (name === 'uiWorkspace') {
        return {
          // the real app moves the main-view retention to the opened Session
          openSession: (id) => {
            attempts.push(id)
            if (failOpen.has(id)) throw new Error(`session retain refused: ${id}`)
            opened.push(id)
            if (silentOpen.has(id)) return
            for (const entry of Object.values(sessions.list.byId)) entry.retainedBy = { mainView: 0 }
            const target = sessions.list.byId[id]
            if (target !== undefined) target.retainedBy = { mainView: 1 }
          }
        }
      }
      return undefined
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    }
  }
  bundle.apply(ctx)
  return {
    registered,
    observers,
    opened,
    attempts,
    injected,
    slotRegistrations,
    disposeAll: () => { for (const dispose of disposers) dispose() }
  }
}

function press (harness, code, { target = null, region = 'page', modal = null, ...gestureOverrides } = {}) {
  let consumed = false
  const input = {
    type: 'keydown',
    gesture: {
      code,
      control: false,
      alt: false,
      shift: false,
      meta: false,
      repeat: false,
      composing: false,
      defaultPrevented: false,
      ...gestureOverrides
    },
    context: { region, modal, target: target ?? document.body },
    consume: () => { consumed = true }
  }
  for (const observer of harness.observers) observer(input)
  return consumed
}

function hintText () {
  const element = document.body.querySelector('.dsh-arrow-nav-hint')
  return element === null || element.hidden ? null : element.textContent
}

/** One Conversation is mounted at a time in the product; keep blocks isolated. */
function resetConversations () {
  for (const element of document.body.querySelectorAll('[data-conversation-scroll]')) element.remove()
}

/** Reading memory owned by one mounted Conversation in the running plugin. */
function newReading () {
  return { turn: null, top: -1, token: 0, session: undefined }
}

/** One rendered sidebar Session row, as `ui-workspace` renders it. */
function sidebarRow (id, selected = false) {
  const node = new El('div', { 'data-row-key': `session:${id}`, role: 'treeitem' })
  if (selected) node.setAttribute('aria-selected', 'true')
  return node
}

/** Let queued microtasks, animation frames, and timers settle. */
function flush () {
  return new Promise((resolve) => setTimeout(resolve, 25))
}

/** Remove every rendered sidebar row so a block starts from an empty sidebar. */
function resetSidebar () {
  for (const node of document.body.querySelectorAll('[data-row-key]')) node.remove()
}

// ---------------------------------------------------------------------------
console.log('\n[1d] the shipped workflow file is structurally sound')
{
  // A broken workflow fails on GitHub with a run that starts no jobs at all, which
  // is invisible from inside the repo. The bench has no YAML parser, so it asserts
  // the shape that matters: real YAML comments (a stray Markdown "> " turns the whole
  // document into a block scalar), a name, triggers, a runner, and the bench itself.
  const workflowPath = path.join(rootPath, '.github', 'workflows', 'test.yml')
  check('the workflow file exists', fs.existsSync(workflowPath), workflowPath)
  const workflow = fs.readFileSync(workflowPath, 'utf8')
  check('comments are YAML comments, not Markdown quotes', !/^>/m.test(workflow), workflow.split('\n').find((line) => line.startsWith('>')))
  check('declares a workflow name', /^name:\s*\S/m.test(workflow))
  check('declares triggers', /^on:\s*$/m.test(workflow))
  check('declares a job with a runner', /runs-on:\s*\S/.test(workflow))
  check('runs the plugin bench', workflow.includes('node test/run.mjs'))
  check('no tabs (YAML forbids them for indentation)', !/\t/.test(workflow))
}

// ---------------------------------------------------------------------------
console.log('\n[1] shortcut declarations')
{
  const sessions = createSessions([{ id: 'a' }])
  const harness = createHarness({ sessions })
  equal('two fixed rows registered', harness.registered.length, 2)
  const [prev, next] = harness.registered
  equal('previous-conversation id', prev.id, 'arrowNav.sessionPrev')
  equal('previous-conversation key cap', JSON.stringify(prev.keys), JSON.stringify(['←']))
  equal('previous-conversation physical key', prev.bindings[0].code, 'ArrowLeft')
  equal('previous-conversation has no modifiers', prev.bindings[0].modifiers.length, 0)
  equal('next-conversation id', next.id, 'arrowNav.sessionNext')
  equal('next-conversation physical key', next.bindings[0].code, 'ArrowRight')
  equal('application display group', prev.group, 'application')
  check('labels are localized', prev.label() === '上一个对话', prev.label())
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[1b] liveness probe and diagnostics')
{
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions })
  equal('the plugin claims a frame-wide overlay seat', JSON.stringify(harness.injected), JSON.stringify(['shell.overlay']))
  const probe = harness.slotRegistrations[0]
  equal('the probe is registered under a stable id', probe.declaration.id, 'arrow-nav-probe')
  equal('the probe renders nothing', probe.component(), null)
  check('the probe reports the running build', window.__dshArrowNav?.build !== undefined, String(window.__dshArrowNav?.build))

  // Shift+↑ toggles the overlay without navigating and without typing into an editor
  check('Shift+↑ is consumed by the overlay toggle', press(harness, 'ArrowUp', { shift: true }) === true)
  const overlay = () => document.body.querySelector('.dsh-arrow-nav-diag')
  check('the overlay appears', overlay() !== null)
  check('the overlay names the build', overlay().textContent.includes('dsh-arrow-nav v'), overlay().textContent.slice(0, 40))
  check('Shift+↑ again hides it', press(harness, 'ArrowUp', { shift: true }) === true && overlay() === null)
  equal('no conversation was opened by the toggle', harness.opened.length, 0)
  equal('Shift+↑ inside a text field is left alone', press(harness, 'ArrowUp', { shift: true, target: new El('input'), region: 'editable' }), false)
  harness.disposeAll()
  equal('dispose removes the overlay', document.body.querySelector('.dsh-arrow-nav-diag'), null)
}

// ---------------------------------------------------------------------------
console.log('\n[2] conversation switching (←/→)')
{
  const sessions = createSessions([
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B' },
    { id: 'c', title: 'C', retainedBy: { mainView: 1 } },
    { id: 'd', title: 'D' },
    { id: 'e', title: 'E' }
  ])
  const workspaces = {
    phase: 'ready',
    items: [
      { workspaceId: 'w1', title: 'Alpha', sessionIds: ['a', 'b', 'c'] },
      { workspaceId: 'w2', title: 'Beta', sessionIds: ['d', 'e'] }
    ],
    pinnedSessionIds: [],
    archivedSessionIds: []
  }
  const harness = createHarness({ sessions, workspaces })

  check('→ moves to the next conversation', press(harness, 'ArrowRight') === true)
  equal('→ opened "d"', harness.opened.at(-1), 'd')
  equal('→ hint shows position and title', hintText(), '4/5 · D')

  press(harness, 'ArrowLeft')
  equal('← moves back to "c" (current)', harness.opened.at(-1), 'c')
  press(harness, 'ArrowLeft')
  equal('← moves to "b"', harness.opened.at(-1), 'b')
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2b] rendered sidebar rows are the navigation order')
{
  resetSidebar()
  const sessions = createSessions([
    { id: 'a', title: 'A' },
    { id: 'b', title: 'B', retainedBy: { mainView: 1 } },
    { id: 'c', title: 'C' }
  ])
  // The service order is a, b, c; the sidebar happens to render c, b, a (a manual
  // order, or a search result). Arrow navigation must follow what is on screen.
  const sidebar = new El('div', { 'data-slot': 'sidebar' })
  for (const [id, selected] of [['c', false], ['b', true], ['a', false]]) {
    sidebar.appendChild(sidebarRow(id, selected))
  }
  document.body.appendChild(sidebar)
  const harness = createHarness({ sessions })
  press(harness, 'ArrowRight')
  equal('→ follows the rendered row order', harness.opened.at(-1), 'a')
  press(harness, 'ArrowLeft')
  equal('← returns to the selected row', harness.opened.at(-1), 'b')
  press(harness, 'ArrowLeft')
  equal('← continues up the rendered order', harness.opened.at(-1), 'c')
  sidebar.remove()
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2c] auto-expand: the "remaining sessions" batch')
{
  resetSidebar()
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's5' ? 1 : 0 } })))
  createSidebarGroup(document, { key: 'w1', sessionIds: ids, limit: 5, selectedId: 's5' })
  const harness = createHarness({ sessions })

  const overflow = document.body.querySelectorAll('[data-row-key]').find((node) => node.dataset.rowKey === 'overflow:w1')
  check('a limited group renders its expand button', overflow !== undefined && overflow.textContent === '展开其余 5 个会话', overflow?.textContent)
  check('→ at the rendered end is consumed', press(harness, 'ArrowRight') === true)
  await flush()
  equal('→ expands the group and opens the next session', harness.opened.at(-1), 's6')
  equal('the hint counts every revealed session', hintText(), '6/10 · S6')
  const collapseControl = document.body.querySelectorAll('[data-row-key]').find((node) => node.dataset.rowKey === 'overflow:w1')
  check('the expanded group keeps the button as its collapse control', collapseControl !== undefined && collapseControl.textContent === '收起' && collapseControl.getAttribute('aria-expanded') === 'true', collapseControl?.textContent)
  equal('every session row is rendered', document.body.querySelectorAll('[data-row-key]').filter((node) => node.dataset.rowKey.startsWith('session:')).length, 10)
  const openedRow = document.body.querySelectorAll('[data-row-key]').find((node) => node.dataset.rowKey === 'session:s6')
  check('the opened row is scrolled into view', openedRow?.scrollCalls?.length === 1)
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2d] auto-expand: a collapsed group below')
{
  resetSidebar()
  const first = ['s1', 's2', 's3']
  const second = ['s4', 's5']
  const sessions = createSessions([...first, ...second].map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's3' ? 1 : 0 } })))
  const sidebar = new El('div', { 'data-slot': 'sidebar' })
  document.body.appendChild(sidebar)
  createSidebarGroup(document, { key: 'w1', sessionIds: first, selectedId: 's3', parent: sidebar })
  createSidebarGroup(document, { key: 'w2', sessionIds: second, expanded: false, parent: sidebar })
  const harness = createHarness({ sessions })

  equal('a collapsed group renders no session rows', document.body.querySelectorAll('[data-row-key]').filter((node) => node.dataset.rowKey.startsWith('session:')).length, 3)
  press(harness, 'ArrowRight')
  await flush()
  equal('→ expands the next group and opens its first session', harness.opened.at(-1), 's4')
  const header = document.body.querySelectorAll('[data-row-key]').find((node) => node.dataset.rowKey === 'workspace:w2')
  equal('the collapsed header reports the expansion', header.getAttribute('aria-expanded'), 'true')
  sidebar.remove()
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2e] auto-expand: a collapsed group above')
{
  resetSidebar()
  const first = ['s1', 's2']
  const second = ['s3', 's4']
  const sessions = createSessions([...first, ...second].map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's3' ? 1 : 0 } })))
  const sidebar = new El('div', { 'data-slot': 'sidebar' })
  document.body.appendChild(sidebar)
  createSidebarGroup(document, { key: 'w1', sessionIds: first, expanded: false, parent: sidebar })
  createSidebarGroup(document, { key: 'w2', sessionIds: second, selectedId: 's3', parent: sidebar })
  const harness = createHarness({ sessions })

  press(harness, 'ArrowLeft')
  await flush()
  equal('← expands the previous group and opens its last session', harness.opened.at(-1), 's2')
  sidebar.remove()
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2f] auto-expand can be switched off')
{
  resetSidebar()
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's5' ? 1 : 0 } })))
  createSidebarGroup(document, { key: 'w1', sessionIds: ids, limit: 5, selectedId: 's5' })
  const harness = createHarness({ sessions, options: { autoExpand: false } })

  press(harness, 'ArrowRight')
  await flush()
  equal('no session opens without expansion', harness.opened.length, 0)
  equal('the end hint is shown instead', hintText(), `已经是最后一个对话 · ${window.__dshArrowNav.build}`)
  check('the expand button is untouched', document.body.querySelector('[data-row-key="overflow:w1"]') !== null)
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2g] auto-collapse: leaving a revealed group folds it back')
{
  resetSidebar()
  const first = ['s1', 's2', 's3', 's4', 's5', 's6']
  const second = ['s7', 's8', 's9']
  const sessions = createSessions([...first, ...second].map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's5' ? 1 : 0 } })))
  const sidebar = new El('div', { 'data-slot': 'sidebar' })
  document.body.appendChild(sidebar)
  createSidebarGroup(document, { key: 'w1', sessionIds: first, limit: 5, selectedId: 's5', parent: sidebar })
  createSidebarGroup(document, { key: 'w2', sessionIds: second, selectedId: 's9', parent: sidebar })
  const harness = createHarness({ sessions, options: { autoCollapse: true } })
  const control = () => document.body.querySelectorAll('[data-row-key]').find((node) => node.dataset.rowKey === 'overflow:w1')
  const rendered = (ids) => document.body.querySelectorAll('[data-row-key]').filter((node) => node.dataset.rowKey.startsWith('session:') && ids.includes(node.dataset.rowKey.slice(8))).length

  press(harness, 'ArrowRight')
  await flush()
  equal('the step expands w1 and opens s6', harness.opened.at(-1), 's6')
  equal('the reader is still inside the expanded group', rendered(first), 6)

  press(harness, 'ArrowRight')
  await flush()
  equal('the next step leaves the group for s7', harness.opened.at(-1), 's7')
  equal('leaving folds the group back to its default batch', rendered(first), 5)
  equal('the untouched group keeps its rows', rendered(second), 3)
  equal('the control is an expand button again', control().textContent, '展开其余 1 个会话')
  equal('the folded group reports collapsed rows', control().getAttribute('aria-expanded'), 'false')
  check('the session the reader left is no longer rendered', document.body.querySelector('[data-row-key="session:s6"]') === null)
  sidebar.remove()
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2h] auto-collapse: leaving a reopened group folds it back')
{
  resetSidebar()
  const first = ['s1', 's2']
  const second = ['s3', 's4']
  const sessions = createSessions([...first, ...second].map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's3' ? 1 : 0 } })))
  const sidebar = new El('div', { 'data-slot': 'sidebar' })
  document.body.appendChild(sidebar)
  createSidebarGroup(document, { key: 'w1', sessionIds: first, expanded: false, parent: sidebar })
  createSidebarGroup(document, { key: 'w2', sessionIds: second, selectedId: 's3', parent: sidebar })
  const harness = createHarness({ sessions, options: { autoCollapse: true } })
  const header = () => document.body.querySelectorAll('[data-row-key]').find((node) => node.dataset.rowKey === 'workspace:w1')

  press(harness, 'ArrowLeft')
  await flush()
  equal('← reopens the group and opens s2', harness.opened.at(-1), 's2')
  equal('the reopened group reports the expansion', header().getAttribute('aria-expanded'), 'true')

  press(harness, 'ArrowRight')
  await flush()
  equal('→ walks back out to s3', harness.opened.at(-1), 's3')
  equal('leaving folds the group again', header().getAttribute('aria-expanded'), 'false')
  check('its rows are gone from the sidebar', document.body.querySelector('[data-row-key="session:s2"]') === null)
  sidebar.remove()
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2i] auto-collapse is opt-in (default keeps the expansion)')
{
  resetSidebar()
  const first = ['s1', 's2', 's3', 's4', 's5', 's6']
  const second = ['s7', 's8']
  const sessions = createSessions([...first, ...second].map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's5' ? 1 : 0 } })))
  const sidebar = new El('div', { 'data-slot': 'sidebar' })
  document.body.appendChild(sidebar)
  createSidebarGroup(document, { key: 'w1', sessionIds: first, limit: 5, selectedId: 's5', parent: sidebar })
  createSidebarGroup(document, { key: 'w2', sessionIds: second, parent: sidebar })
  const harness = createHarness({ sessions })

  press(harness, 'ArrowRight')
  await flush()
  press(harness, 'ArrowRight')
  await flush()
  equal('the step still walks into and past the revealed group', harness.opened.at(-1), 's7')
  equal('by default the expansion stays open', document.body.querySelectorAll('[data-row-key]').filter((node) => node.dataset.rowKey.startsWith('session:')).length, 6 + 2)
  sidebar.remove()
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2j] a fully revealed group is not treated as expandable')
{
  resetSidebar()
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's6' ? 1 : 0 } })))
  createSidebarGroup(document, { key: 'w1', sessionIds: ids, limit: 5, shown: 6, selectedId: 's6' })
  const harness = createHarness({ sessions })

  press(harness, 'ArrowRight')
  await flush()
  equal('nothing opens at the true end', harness.opened.length, 0)
  equal('the end hint is shown', hintText(), `已经是最后一个对话 · ${window.__dshArrowNav.build}`)
  equal('the collapse control was not pressed', document.body.querySelector('[data-row-key="overflow:w1"]').textContent, '收起')
  equal('all rows stay revealed', document.body.querySelectorAll('[data-row-key]').filter((node) => node.dataset.rowKey.startsWith('session:')).length, 6)
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2k] a hidden current row never stalls navigation')
{
  resetSidebar()
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']
  // The sidebar shows only the first five rows (as after a fold), while the
  // current Session is the sixth: the rendered list cannot say what follows.
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's6' ? 1 : 0 } })))
  const workspaces = {
    phase: 'ready',
    items: [{ workspaceId: 'w1', title: 'ws', sessionIds: ids }],
    pinnedSessionIds: [],
    archivedSessionIds: []
  }
  createSidebarGroup(document, { key: 'w1', sessionIds: ids, limit: 5 })
  const harness = createHarness({ sessions, workspaces })

  check('→ still moves', press(harness, 'ArrowRight') === true)
  await flush()
  equal('the projection supplies the next conversation', harness.opened.at(-1), 's7')
  check('the group was revealed for the target', document.body.querySelectorAll('[data-row-key]').length > 7)
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2l] the rendered list ending is not the conversation list ending')
{
  resetSidebar()
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's5' ? 1 : 0 } })))
  const workspaces = {
    phase: 'ready',
    items: [{ workspaceId: 'w1', title: 'ws', sessionIds: ids }],
    pinnedSessionIds: [],
    archivedSessionIds: []
  }
  // Only five rows are rendered and no affordance is exposed (for example while
  // the sidebar is mid-animation): the step must still reach the sixth Session.
  const sidebar = new El('div', { 'data-slot': 'sidebar' })
  document.body.appendChild(sidebar)
  for (const id of ids.slice(0, 5)) sidebar.appendChild(sidebarRow(id, id === 's5'))
  const harness = createHarness({ sessions, workspaces })

  press(harness, 'ArrowRight')
  await flush()
  equal('→ falls back to the projection instead of reporting the end', harness.opened.at(-1), 's6')
  equal('the hint counts the whole list', hintText(), '6/6 · S6')
  sidebar.remove()
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2m] an unopenable Session is walked past, never a wall')
{
  resetSidebar()
  const ids = ['s1', 's2', 's3', 's4']
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's1' ? 1 : 0 } })))
  const harness = createHarness({ sessions, failOpen: new Set(['s2']) })

  press(harness, 'ArrowRight')
  await flush()
  equal('the step skips the unopenable Session', harness.opened.at(-1), 's3')
  check('the refusal is logged for the diagnostics overlay', window.__dshArrowNav.lines().some((line) => line.includes('open s2 failed')), window.__dshArrowNav.lines().join(' | '))
  equal('the unopenable Session was attempted once', harness.attempts.filter((id) => id === 's2').length, 1)

  press(harness, 'ArrowRight')
  await flush()
  equal('later steps keep moving', harness.opened.at(-1), 's4')
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2n] an open that has no effect is caught inside the same press')
{
  resetSidebar()
  const ids = ['s1', 's2', 's3']
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's1' ? 1 : 0 } })))
  // `s2` accepts the call but the main view never moves — a silent failure.
  const harness = createHarness({ sessions, silentOpen: new Set(['s2']) })

  press(harness, 'ArrowRight')
  await new Promise((resolve) => setTimeout(resolve, 500))
  equal('the dud is skipped and the step still lands on the next Session', harness.opened.at(-1), 's3')
  check('the dud is logged for the diagnostics overlay', window.__dshArrowNav.lines().some((line) => line.includes('did not take effect')), window.__dshArrowNav.lines().join(' | '))
  check('the explanation is taken down once the press succeeds', document.body.querySelector('.dsh-arrow-nav-diag') === null)
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[1c] the diagnostics panel is opt-in, then gets out of the way')
{
  resetSidebar()
  const overlay = () => document.body.querySelector('.dsh-arrow-nav-diag')

  // the default install never shows a panel by itself
  const silent = createHarness({
    sessions: createSessions([{ id: 's1', title: 'only', retainedBy: { mainView: 1 } }])
  })
  press(silent, 'ArrowRight')
  await flush()
  check('a blocked step stays silent by default', overlay() === null)
  press(silent, 'ArrowUp', { shift: true })
  check('Shift+↑ still summons it', overlay() !== null)
  press(silent, 'ArrowUp', { shift: true })
  silent.disposeAll()

  // diagnostics:true lets it explain itself, and it fades on its own
  const blocked = createHarness({
    sessions: createSessions([{ id: 's1', title: 'only', retainedBy: { mainView: 1 } }]),
    options: { diagnostics: true, autoHideMs: 60 }
  })
  press(blocked, 'ArrowRight')
  await flush()
  check('diagnostics:true explains a blocked step', overlay() !== null)
  await new Promise((resolve) => setTimeout(resolve, 140))
  check('the explanation disappears on its own', overlay() === null)
  blocked.disposeAll()

  // a panel the reader opened stays until they close it again
  const pinned = createHarness({
    sessions: createSessions([{ id: 's1', title: 'only', retainedBy: { mainView: 1 } }]),
    options: { diagnostics: true, autoHideMs: 60 }
  })
  press(pinned, 'ArrowUp', { shift: true })
  check('Shift+↑ opens the panel', overlay() !== null)
  await new Promise((resolve) => setTimeout(resolve, 140))
  check('a pinned panel waits for the reader', overlay() !== null)
  press(pinned, 'ArrowUp', { shift: true })
  check('Shift+↑ closes it again', overlay() === null)
  pinned.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2o] with diagnostics on, hitting an end explains itself')
{
  resetSidebar()
  const sessions = createSessions([{ id: 's1', title: 'only', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions, options: { diagnostics: true } })
  equal('no overlay before the blocked step', document.body.querySelector('.dsh-arrow-nav-diag'), null)
  press(harness, 'ArrowRight')
  await flush()
  const overlay = document.body.querySelector('.dsh-arrow-nav-diag')
  check('the blocked step shows the overlay without any shortcut', overlay !== null)
  check('the overlay carries the decision log', overlay.textContent.includes('[ArrowRight]'), overlay.textContent.slice(0, 120))
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2p] a plan with no target never spins on the Session controller')
{
  resetSidebar()
  const sessions = createSessions([{ id: 's1', title: 'a', retainedBy: { mainView: 1 } }])
  // The list is not ready yet: planning yields a trace with no Session to open.
  sessions.list.phase = 'pending'
  const harness = createHarness({ sessions, options: { diagnostics: true } })

  const consumed = press(harness, 'ArrowRight')
  await flush()
  check('the press is consumed', consumed === true)
  equal('the Session controller is never called with an empty target', harness.attempts.length, 0)
  equal('the end is reported instead of looping', hintText(), `已经是最后一个对话 · ${window.__dshArrowNav.build}`)
  const lines = window.__dshArrowNav.lines().filter((line) => line.includes('no target'))
  equal('exactly one decision line is recorded', lines.length, 1)
  check('the overlay explains the state', document.body.querySelector('.dsh-arrow-nav-diag') !== null)
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2q] holding ←/→ keeps switching conversations')
{
  resetSidebar()
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's1' ? 1 : 0 } })))
  const sidebar = new El('div', { 'data-slot': 'sidebar' })
  document.body.appendChild(sidebar)
  createSidebarGroup(document, { key: 'w1', sessionIds: ids, selectedId: 's1', parent: sidebar })
  const harness = createHarness({ sessions })

  press(harness, 'ArrowRight')
  await flush()
  equal('the first press lands on the neighbour', harness.opened.at(-1), 's2')

  // hold: the repeat timer keeps stepping, and the view follows each step
  await sleep(HOLD_DELAY_MS + HOLD_STEP_MS * 3 + 80)
  check('holding keeps switching', harness.opened.length >= 3, JSON.stringify(harness.opened))
  check('each held step lands on a new conversation', new Set(harness.opened).size === harness.opened.length, JSON.stringify(harness.opened))

  // A step already dispatched may still land, but the repeat itself must stop.
  const steps = harness.opened.length
  fireWindow('keyup', { code: 'ArrowRight' })
  await sleep(HOLD_STEP_MS * 3)
  const afterRelease = harness.opened.length
  await sleep(HOLD_STEP_MS * 3)
  equal('the release stops the repeat', harness.opened.length, afterRelease, JSON.stringify(harness.opened))
  check('holding moved through several conversations', afterRelease - steps >= 0 && steps >= 3, JSON.stringify(harness.opened))
  sidebar.remove()
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2q2] holdPreview walks a cursor instead of switching')
{
  resetSidebar()
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's1' ? 1 : 0 } })))
  const sidebar = new El('div', { 'data-slot': 'sidebar' })
  document.body.appendChild(sidebar)
  createSidebarGroup(document, { key: 'w1', sessionIds: ids, selectedId: 's1', parent: sidebar })
  const harness = createHarness({ sessions, options: { holdPreview: true } })

  press(harness, 'ArrowRight')
  await flush()
  equal('the first press lands on the neighbour', harness.opened.at(-1), 's2')

  await sleep(HOLD_DELAY_MS + HOLD_STEP_MS * 2 + 60)
  const cursor = () => document.body.querySelector('[data-arrow-nav-cursor="true"]')
  check('holding highlights a row ahead', cursor() !== null)
  const landed = cursor()?.dataset?.rowKey?.replace('session:', '')
  check('the cursor walked past the neighbour', landed !== undefined && landed !== 's1' && landed !== 's2', String(landed))
  equal('holding switches nothing else', harness.opened.length, 1)
  check('the hint says the release will open it', hintText()?.startsWith('松手打开：') === true, String(hintText()))

  fireWindow('keyup', { code: 'ArrowRight' })
  await flush()
  equal('the release opens what the cursor rested on', harness.opened.at(-1), landed)
  equal('the cursor highlight is cleaned up', cursor(), null)
  sidebar.remove()
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2r] holding can be switched off, and turns step while held')
{
  resetSidebar()
  const ids = ['s1', 's2', 's3']
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's1' ? 1 : 0 } })))
  const quiet = createHarness({ sessions, options: { holdRepeat: false } })
  equal('holdRepeat:false ignores a repeat', press(quiet, 'ArrowRight', { repeat: true }), false)
  equal('…and nothing was opened', quiet.opened.length, 0)
  quiet.disposeAll()

  resetConversations()
  const conversation = createConversation(document, { turns: [1, 2, 3, 4, 5], rail: true })
  const rail = conversation.scroller.querySelector('nav')
  const activeIndex = () => rail.children.findIndex((mark) => mark.getAttribute('aria-current') === 'true')

  // By default ↑/↓ keep the transcript's own scrolling: a repeat is neither
  // stepped nor consumed, so the browser still scrolls the page.
  const scrollerHarness = createHarness({ sessions: createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }]) })
  const restingIndex = activeIndex()
  equal('a ↓ repeat stays with the browser (not consumed)', press(scrollerHarness, 'ArrowDown', { repeat: true }), false)
  await sleep(HOLD_STEP_MS * 2)
  equal('…and the turns were left alone', activeIndex(), restingIndex)
  scrollerHarness.disposeAll()

  // holdTurns opts into stepping turns while held, and then the repeat is ours.
  const turns = createHarness({ sessions: createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }]), options: { holdTurns: true } })
  press(turns, 'ArrowDown')
  await flush()
  equal('the first ↓ steps one turn', activeIndex(), 1)
  equal('an owned repeat is consumed so the page cannot scroll as well', press(turns, 'ArrowDown', { repeat: true }), true)
  await sleep(HOLD_DELAY_MS + HOLD_STEP_MS + 60)
  check('holding ↓ keeps stepping turns', activeIndex() >= 2, String(activeIndex()))
  fireWindow('keyup', { code: 'ArrowDown' })
  const settled = activeIndex()
  await sleep(HOLD_STEP_MS * 3)
  equal('the release stops the stepping', activeIndex(), settled)
  turns.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[2q3] a held key survives the focus its own switching causes')
{
  resetSidebar()
  resetConversations()
  const ids = ['s1', 's2', 's3', 's4', 's5', 's6']
  const sessions = createSessions(ids.map((id) => ({ id, title: id.toUpperCase(), retainedBy: { mainView: id === 's1' ? 1 : 0 } })))
  // Chat's real shape: one column holds the transcript AND the composer beside it.
  const column = new El('div')
  document.body.appendChild(column)
  createConversation(document, { turns: [1, 2, 3], sessionId: 's1', parent: column })
  const editor = new El('div', { role: 'textbox' })
  column.appendChild(editor)
  const harness = createHarness({ sessions })

  // A press made while that editor holds focus still switches.
  check('focus in the composer column still switches', press(harness, 'ArrowRight', { target: editor }) === true)
  await flush()
  equal('the next conversation was opened', harness.opened.at(-1), 's2')

  // Holding → keeps walking even though every switch hands focus back to that editor.
  await sleep(HOLD_DELAY_MS + HOLD_STEP_MS * 2 + 80)
  check('holding → keeps going after the focus moved', harness.opened.length >= 3, JSON.stringify(harness.opened))
  check('each step landed on a new conversation', new Set(harness.opened).size === harness.opened.length, JSON.stringify(harness.opened))

  // Focus can also land somewhere that is neither the sidebar nor the conversation
  // (a toast, a header control). The hold is still ONE gesture, so it keeps walking.
  const stepsBefore = harness.opened.length
  editor.remove()
  document.body.appendChild(editor)
  await sleep(HOLD_DELAY_MS + HOLD_STEP_MS * 2 + 80)
  check('the hold survives focus leaving the column entirely', harness.opened.length > stepsBefore, JSON.stringify(harness.opened))
  check('…and each such step is still a new conversation', new Set(harness.opened).size === harness.opened.length, JSON.stringify(harness.opened))

  fireWindow('keyup', { code: 'ArrowRight' })
  const settled = harness.opened.length
  await sleep(HOLD_STEP_MS * 3)
  equal('the release stops it', harness.opened.length, settled, JSON.stringify(harness.opened))
  column.remove()
  harness.disposeAll()
}
{
  const sessions = createSessions([
    { id: 'old', title: 'archived' },
    { id: 'sub', title: 'subagent child', origin: 'subagent' },
    { id: 'blank', title: '', blank: true },
    { id: 'pin', title: 'pinned' },
    { id: 'real', title: 'real', retainedBy: { mainView: 1 } }
  ])
  const workspaces = {
    phase: 'ready',
    items: [{ workspaceId: 'w1', title: 'ws', sessionIds: ['old', 'sub', 'real', 'pin'] }],
    pinnedSessionIds: ['pin'],
    archivedSessionIds: ['old']
  }
  const harness = createHarness({ sessions, workspaces })
  // current 'real': ← should reach the pinned row (pinned lead the group), and the
  // archived / subagent / non-current blank rows must be skipped.
  press(harness, 'ArrowLeft')
  equal('archived/subagent/blank rows are skipped', harness.opened.at(-1), 'pin')
  press(harness, 'ArrowLeft')
  equal('pinned row is the head of the group', harness.opened.length, 1)
  equal('first-row hint', hintText(), `已经是第一个对话 · ${window.__dshArrowNav.build}`)
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[4a] turn navigation prefers the transcript rail')
{
  resetConversations()
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions })
  const conversation = createConversation(document, { turns: [1, 2, 3, 4], rail: true })
  const scroller = conversation.scroller
  const rail = scroller.querySelector('nav')
  const mark = (index) => rail.children[index]

  check('↓ presses the next rail mark', press(harness, 'ArrowDown') === true)
  equal('Chat own jump ran (the rail aligned the turn)', scroller.scrollTop, 50 - 24)
  equal('the active mark moved', mark(1).getAttribute('aria-current'), 'true')
  equal('the hint names the turn from the mark label', hintText(), '第 2 段')

  press(harness, 'ArrowDown')
  equal('another ↓ follows the rail again', mark(2).getAttribute('aria-current'), 'true')
  equal('the hint follows the rail', hintText(), '第 3 段')

  press(harness, 'ArrowUp')
  equal('↑ returns to the previous mark', mark(1).getAttribute('aria-current'), 'true')
  equal('↑ hint', hintText(), '第 2 段')

  rail.children[0].setAttribute('aria-current', 'true')
  press(harness, 'ArrowUp')
  equal('↑ at the first rail mark leaves the scroll alone', scroller.scrollTop, 50 - 24)
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[4] turn navigation (↑/↓)')
{
  resetConversations()
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions })
  const conversation = createConversation(document, { turns: [1, 2, 3, 4] })
  const scroller = conversation.scroller
  const reading = newReading()

  // reading line = 100 + 96 = 196; rows sit at 100/150/200/250 → turn 2 is read.
  check('↓ jumps to the next turn', press(harness, 'ArrowDown') === true)
  equal('↓ scrolls to turn 3 (contentTop 100 - inset 24)', scroller.scrollTop, 76)
  equal('↓ hint', hintText(), '第 3 段')
  equal('the jump scrolls instantly, never through a smooth pass', scroller.scrollCalls?.at(-1)?.behavior, 'instant')
  check('the jump announces the settled scrollport to Chat', scroller.dispatched?.includes('scrollend') === true)
  harness.disposeAll()
}

{
  resetConversations()
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions })
  const conversation = createConversation(document, { turns: [1, 2, 3], rowHeight: 30 })
  const scroller = conversation.scroller

  // Regression: with 30px rows the reading line (96px) covers the aligned row and
  // the next one, so geometry alone would read the turn just left and Up would
  // never move. The landing memory must carry the sequence upward.
  press(harness, 'ArrowUp')
  const first = scroller.scrollTop
  press(harness, 'ArrowUp')
  const second = scroller.scrollTop
  check('↑ keeps moving on short turns', second < first, `${first} -> ${second}`)
  equal('↑ reached the first turn', second, 0)
  press(harness, 'ArrowUp')
  equal('↑ at the first turn hint', hintText(), `已经是第一段 · ${window.__dshArrowNav.build}`)
  harness.disposeAll()
}

{
  resetConversations()
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions })
  // One Turn owns several rows; Up must align the *first* row of the target turn
  // (contentTop 50 → offset 26), never its last row (contentTop 100 → offset 76).
  const conversation = createConversation(document, { turns: [1, 2, 2, 3, 3] })
  const scroller = conversation.scroller
  scroller.scrollTop = 80

  press(harness, 'ArrowUp')
  equal('↑ aligns the first row of the previous turn', scroller.scrollTop, 26)
  equal('↑ hint names the target turn', hintText(), '第 2 段')
  harness.disposeAll()
}

{
  resetConversations()
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions })
  const conversation = createConversation(document, { turns: [1, 2, 3, 4] })
  const scroller = conversation.scroller
  // a collapsed process group leaves a zero-height row behind: never read, never targeted
  conversation.column.children[1].rectHeight = 0

  press(harness, 'ArrowDown')
  equal('rows that are not laid out are skipped', hintText(), '第 3 段')
  equal('↓ lands on the first laid-out turn after the gap', scroller.scrollTop, 100 - 24)
  harness.disposeAll()
}

{
  resetConversations()
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions })
  const conversation = createConversation(document, { turns: [1, 2, 3, 4], rowHeight: 200 })
  const scroller = conversation.scroller

  scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight
  const reading = newReading()
  const rows = bundle.__internals.turnRows(scroller)
  equal('the tail reads as the last turn', bundle.__internals.readTurn(scroller, rows, reading), 4)
  press(harness, 'ArrowDown')
  equal('↓ at the tail stays at the tail', scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight)
  equal('↓ at the tail hint', hintText(), `已经是最后一段 · ${window.__dshArrowNav.build}`)
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[5] history paging on the first loaded turn')
{
  resetConversations()
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions })
  const conversation = createConversation(document, { turns: [5, 6], rowHeight: 200 })
  const scroller = conversation.scroller
  const button = new El('button')
  button.textContent = '加载更早'
  button.addEventListener('click', () => {
    setTurnRows(conversation, [3, 4, 5, 6], 200)
    button.disabled = true
  })
  scroller.appendChild(button)

  press(harness, 'ArrowUp')
  equal('first ↑ asks for the previous page', button.disabled, true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  equal('after paging, the jump lands on the turn before the old head', scroller.scrollTop, 200 - 24)
  harness.disposeAll()
}

{
  resetConversations()
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions })
  const conversation = createConversation(document, { turns: [5, 6], rowHeight: 200 })
  const busy = new El('button')
  busy.textContent = '加载中'
  busy.disabled = true
  conversation.scroller.appendChild(busy)

  press(harness, 'ArrowUp')
  equal('a busy history button reports loading instead of an end', hintText(), '正在加载更早的对话…')
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[6] guards')
{
  resetConversations()
  const sessions = createSessions([
    { id: 's1', title: 'session', retainedBy: { mainView: 1 } },
    { id: 's2', title: 'second' }
  ])
  const harness = createHarness({ sessions })
  const conversation = createConversation(document, { turns: [1, 2, 3] })
  const scroller = conversation.scroller

  equal('shift+arrow is ignored', press(harness, 'ArrowDown', { shift: true }), false)
  equal('alt+arrow is ignored', press(harness, 'ArrowDown', { alt: true }), false)
  equal('key repeats are ignored', press(harness, 'ArrowDown', { repeat: true }), false)
  equal('composition is ignored', press(harness, 'ArrowDown', { composing: true }), false)
  equal('already-prevented input is ignored', press(harness, 'ArrowDown', { defaultPrevented: true }), false)
  equal('a modal owns the arrows', press(harness, 'ArrowDown', { modal: 'settings' }), false)
  equal('the terminal region owns the arrows', press(harness, 'ArrowDown', { region: 'terminal' }), false)
  equal('an unhandled code passes through', press(harness, 'Enter'), false)
  equal('guarded presses never scroll', scroller.scrollTop, 0)

  // focus outside the accepted scopes (for example the settings panel)
  const settings = new El('div', { 'data-slot': 'settings.section' })
  const settingsButton = new El('button')
  settings.appendChild(settingsButton)
  document.body.appendChild(settings)
  equal('focus outside the conversation/sidebar scopes is ignored', press(harness, 'ArrowDown', { target: settingsButton }), false)

  // the resident composer releases arrows only while it is empty
  const composer = new El('div', { 'data-conversation-region': 'composer' })
  const editor = new El('textarea')
  editor.value = ''
  composer.appendChild(editor)
  conversation.occurrence.appendChild(composer)
  check('an empty composer still navigates', press(harness, 'ArrowDown', { target: editor, region: 'editable' }) === true)
  editor.value = '正在输入'
  equal('a composer with text keeps its caret', press(harness, 'ArrowDown', { target: editor, region: 'editable' }), false)

  // another text field never navigates
  const search = new El('input')
  search.value = ''
  document.body.appendChild(search)
  equal('an empty search field keeps its arrows', press(harness, 'ArrowDown', { target: search, region: 'editable' }), false)

  // Chat's real layout: the composer seat is a SIBLING of the transcript, not a
  // child. After a switch Chat focuses its rich editor, and the arrows must survive.
  const column = new El('div')
  const seat = new El('div', { 'data-conversation-region': 'composer' })
  const richEditor = new El('div', { role: 'textbox', contenteditable: 'true' })
  richEditor.textContent = ''
  seat.appendChild(richEditor)
  column.appendChild(seat)
  document.body.appendChild(column)
  check('an empty composer outside the transcript still navigates', press(harness, 'ArrowDown', { target: richEditor, region: 'editable' }) === true)
  richEditor.textContent = '正在输入'
  equal('a composer with text still keeps its arrows', press(harness, 'ArrowDown', { target: richEditor, region: 'editable' }), false)
  column.remove()

  // an open composer popup (slash commands / mentions) owns the arrows — but only
  // while it actually holds the interaction, never merely by being on screen.
  editor.value = ''
  const floating = new El('div', { role: 'menu' })
  floating.viewportWidth = 200
  floating.clientHeight = 100
  document.body.appendChild(floating)
  check('a floating layer that owns nothing does not block the arrows', press(harness, 'ArrowDown', { target: editor, region: 'editable' }) === true)

  const listbox = new El('div', { role: 'listbox', 'aria-activedescendant': 'option-3' })
  listbox.viewportWidth = 200
  listbox.clientHeight = 100
  document.body.appendChild(listbox)
  equal('a listbox walking an active option owns the arrows', press(harness, 'ArrowDown', { target: editor, region: 'editable' }), false)
  listbox.remove()
  floating.remove()

  // a sidebar Session row keeps conversation switching available
  const sidebar = new El('div', { 'data-slot': 'sidebar' })
  sidebar.appendChild(sidebarRow('s1', true))
  const sidebarRow2 = sidebarRow('s2')
  const rowButton = new El('button')
  sidebarRow2.appendChild(rowButton)
  sidebar.appendChild(sidebarRow2)
  document.body.appendChild(sidebar)
  check('focus on a sidebar row still switches conversations', press(harness, 'ArrowRight', { target: rowButton }) === true)
  equal('sidebar-row press opened the next session', harness.opened.at(-1), 's2')
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[6b] a guard that keeps refusing says why')
{
  resetConversations()
  resetSidebar()
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions, options: { diagnostics: true } })
  createConversation(document, { turns: [1, 2, 3] })
  const overlay = () => document.body.querySelector('.dsh-arrow-nav-diag')

  const field = new El('input')
  field.value = ''
  document.body.appendChild(field)
  press(harness, 'ArrowDown', { target: field, region: 'editable' })
  press(harness, 'ArrowDown', { target: field, region: 'editable' })
  check('two refusals stay silent', overlay() === null)
  press(harness, 'ArrowDown', { target: field, region: 'editable' })
  check('the third refusal shows why the arrow did nothing', overlay() !== null && overlay().textContent.includes('refused'), overlay()?.textContent?.slice(0, 140))
  check('the reason names the element that holds the keys', overlay().textContent.includes('editor holds keys'), overlay().textContent.slice(0, 160))
  field.remove()

  // standing down for a popup is correct, so it must explain itself
  for (const node of document.body.querySelectorAll('.dsh-arrow-nav-hint')) node.remove()
  press(harness, 'ArrowDown', { modal: 'other' })
  press(harness, 'ArrowDown', { modal: 'other' })
  equal('a refused arrow says who owns the keys', hintText(), '方向键先归打开的菜单/弹窗（Esc 可关闭）')
  harness.disposeAll()
}

// ---------------------------------------------------------------------------
console.log('\n[7] options and cleanup')
{
  resetConversations()
  const sessions = createSessions([{ id: 's1', title: 'session', retainedBy: { mainView: 1 } }])
  const harness = createHarness({ sessions, options: { hint: false } })
  createConversation(document, { turns: [1, 2, 3] })
  press(harness, 'ArrowDown')
  equal('hint:false suppresses the overlay', document.body.querySelector('.dsh-arrow-nav-hint') === null, true)
  harness.disposeAll()

  const harness2 = createHarness({ sessions })
  resetConversations()
  createConversation(document, { turns: [1, 2] })
  press(harness2, 'ArrowDown')
  const element = document.body.querySelector('.dsh-arrow-nav-hint')
  check('hint element is owned by the plugin', element !== null && element.className === 'dsh-arrow-nav-hint')
  harness2.disposeAll()
  equal('dispose removes the hint element', document.body.querySelector('.dsh-arrow-nav-hint'), null)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) process.exit(1)
