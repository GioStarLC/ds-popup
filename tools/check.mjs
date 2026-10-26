/**
 * check — what would otherwise cost a browser reload to discover.
 *
 * Three things, all of which fail silently at runtime:
 *
 *   1. Manifest wiring. A missing file in `content_scripts` is an extension
 *      that loads and does nothing, with no error anywhere in the page.
 *   2. Syntax. Content scripts are not bundled here, so a stray bracket in one
 *      file kills only that file's share of the chain.
 *   3. The host boundary. `core.js`, `card.js` and `content.js` must not know
 *      DeepSeek's selectors; only `adapter.js` may. Mechanical, but it is the
 *      property that makes a redesign a one-file change.
 *
 * It also exercises the pure half of core: the text projection, the Markdown
 * wire format, and the withdrawal planner. Those are the parts where a wrong
 * answer is silent (a quote assembled differently, a draft rewritten when it
 * should have been refused), so they get real assertions rather than a smoke
 * test.
 *
 *   node tools/check.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext, Script } from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function fail(message) {
  failures.push(message)
}

function ok(condition, message) {
  if (!condition) fail(message)
}

function read(relative) {
  return readFileSync(join(ROOT, relative), 'utf8')
}

// ---------------------------------------------------------------------------
// 1. manifest wiring
// ---------------------------------------------------------------------------

const manifest = JSON.parse(read('manifest.json'))
ok(manifest.manifest_version === 3, 'manifest: expected manifest_version 3')

const scripts = (manifest.content_scripts || []).flatMap((entry) => entry.js || [])
ok(scripts.length > 0, 'manifest: no content scripts')
for (const script of scripts) {
  ok(existsSync(join(ROOT, script)), `manifest: missing content script ${script}`)
}
ok(
  (manifest.content_scripts || []).every((entry) => (entry.matches || []).length > 0),
  'manifest: a content script entry has no matches'
)
for (const size of ['16', '48', '128']) {
  const icon = manifest.icons && manifest.icons[size]
  ok(Boolean(icon), `manifest: no ${size}px icon`)
  if (icon) ok(existsSync(join(ROOT, icon)), `manifest: missing icon ${icon}`)
}

// ---------------------------------------------------------------------------
// 2. syntax
// ---------------------------------------------------------------------------

const sources = {}
for (const script of scripts) {
  const source = read(script)
  sources[script] = source
  try {
    new Script(source, { filename: script })
  } catch (error) {
    fail(`syntax: ${script}: ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// 3. the host boundary
// ---------------------------------------------------------------------------

const HOST_MARKERS = [
  '.ds-message',
  '.ds-markdown',
  'ds-assistant-message-main-content',
  'data-virtual-list-item-key',
  'ds-toggle-button',
]

for (const script of scripts) {
  if (script.endsWith('adapter.js')) continue
  for (const marker of HOST_MARKERS) {
    ok(
      sources[script].indexOf(marker) === -1,
      `boundary: ${script} mentions ${marker}; move it into adapter.js`
    )
  }
}

// ---------------------------------------------------------------------------
// 4. core's pure half
// ---------------------------------------------------------------------------

const sandbox = { console }
runInNewContext(read('src/core.js'), sandbox, { filename: 'src/core.js' })
const core = sandbox.DS_POPUP_CORE
ok(core !== undefined, 'core: DS_POPUP_CORE was not registered')
if (core === undefined) {
  report()
  process.exit(1)
}

ok(core.pack(' 一 二\n三 ') === '一二三', 'core.pack: whitespace projection')
ok(core.pack('') === '', 'core.pack: empty')

const one = {
  text: '第一步：用 Redis',
  note: '运维成本高',
  quoted: true,
}
ok(
  core.blockOf(one) === '> 第一步：用 Redis\n我的回答：运维成本高',
  'core.blockOf: quote then labelled note'
)

const multi = {
  text: '第一段\n\n第二段',
  note: '',
  quoted: true,
}
ok(
  core.blockOf(multi) === '> 第一段\n>\n> 第二段',
  'core.blockOf: a blank line inside the quote stays quoted'
)

const bare = { text: '只有原文', note: '', quoted: false }
ok(core.blockOf(bare) === '', 'core.blockOf: a mark is not delivered')

const two = [
  { id: 'a', text: 'A', note: '甲', quoted: true },
  { id: 'b', text: 'B', note: '乙', quoted: true },
]
const aggregate = core.buildAggregate(two)
ok(
  aggregate === '> A\n我的回答：甲\n\n> B\n我的回答：乙\n\n',
  'core.buildAggregate: one block, a blank line, the next'
)

const emptyPlan = core.composerPlan('', two)
ok(emptyPlan !== null, 'core.composerPlan: produced a plan')
ok(emptyPlan.lead === '', 'core.composerPlan: empty draft needs no separator')
ok(emptyPlan.next === aggregate, 'core.composerPlan: empty draft gets the body alone')

const filledPlan = core.composerPlan('已经写了一句', two)
ok(filledPlan.lead === '\n', 'core.composerPlan: non-empty draft gets one newline')
ok(
  filledPlan.next === '已经写了一句\n' + aggregate,
  'core.composerPlan: append keeps the existing text'
)

const trailingPlan = core.composerPlan('已经写了一句\n', two)
ok(trailingPlan.lead === '', 'core.composerPlan: trailing newline is already a separator')

const exported = {
  id: 'a',
  text: 'A',
  note: '甲',
  quoted: true,
  exportedAt: 1,
  exportedChunk: '> A\n我的回答：甲\n\n',
  exportedDraft: '> A\n我的回答：甲\n\n',
}
ok(
  core.planWithdraw(exported.exportedDraft, exported).status === 'removed',
  'core.planWithdraw: exact snapshot is removable'
)
ok(
  core.planWithdraw(exported.exportedDraft, exported).after === '',
  'core.planWithdraw: removal leaves an empty draft'
)
ok(
  core.planWithdraw('> A\n我的回答：甲\n\n手写的一句', exported).status === 'changed',
  'core.planWithdraw: an edited draft is refused'
)
ok(
  core.planWithdraw('别的文字', exported).status === 'missing',
  'core.planWithdraw: a draft without the block is reported as missing'
)
ok(
  core.planWithdraw('', exported).status === 'none',
  'core.planWithdraw: nothing to take back'
)
ok(
  core.planWithdraw(exported.exportedDraft, { ...exported, exportedDraft: undefined }).status ===
    'locked',
  'core.planWithdraw: no snapshot means refuse'
)

const leadMark = {
  ...exported,
  exportedChunk: '> A\n\n',
  exportedDraft: '前面\n> A\n\n',
  exportedLead: '\n',
  text: 'A',
  note: '',
}
const leadPlan = core.planWithdraw('前面\n> A\n\n', leadMark)
ok(leadPlan.status === 'removed', 'core.planWithdraw: batch lead removal')
ok(leadPlan.after === '前面', 'core.planWithdraw: the leading newline leaves with the block')

report()

function report() {
  if (failures.length === 0) {
    console.log('check: ok — manifest, syntax, boundary, core')
    return
  }
  for (const failure of failures) console.error('FAIL:', failure)
  process.exitCode = 1
}
