/**
 * core — everything in ds-popup that does not know it is running on DeepSeek.
 *
 * This is a port of the parts of dsh-popup's `lib/client.js` that survive a
 * change of host: the anchor model (quote + context + index), the locator that
 * re-derives a Range from a stored anchor, the per-session store, and the
 * Markdown wire format. The host-specific half (which element is a reply, how
 * to write the composer) lives in adapter.js.
 *
 * A mark is never a Range and never a DOM node. The transcript is virtualized:
 * items unmount, streaming replies re-render, and a Range saved now points at a
 * node that will be gone. So a mark stores:
 *
 *   key     the virtual list item the passage sits in
 *   quote   the selected text, whitespace dropped
 *   prefix  ~24 kept characters before the quote
 *   suffix  ~24 kept characters after it
 *   index   the kept-character offset inside the item, as a drift hint
 *
 * Re-deriving walks the item's visible text with the same projection, finds the
 * quote, and scores each occurrence on context and drift. Ambiguity is refused
 * rather than guessed: a mark on the wrong sentence is worse than no mark.
 */
(function (global) {
  'use strict'

  /** Where marks live. A page origin, not a host API: one profile, one store. */
  var MARKS_KEY = 'ds-popup/marks/v1'

  /** Whether an empty composer is filled automatically when it gets focus. */
  var AUTO_KEY = 'ds-popup/auto/v1'

  /**
   * What a note is prefixed with in the delivered draft.
   *
   * This is wire format, not UI copy: it goes into the prompt, and it is the
   * same string in every locale. It exists so the note is not parsed as a lazy
   * continuation of the blockquote above it.
   */
  var ANSWER_LABEL = '我的回答：'

  var MAX_MARKS_PER_SESSION = 200
  var MAX_SESSIONS = 40
  var MAX_OCCURRENCES = 40
  var MAX_QUOTE_CHARS = 8000
  var MAX_TEXT_CHARS = 4000
  var CONTEXT_CHARS = 24

  // ---------------------------------------------------------------------
  // text projection
  // ---------------------------------------------------------------------

  /** Drop whitespace: `selection.toString()` inserts separators no walk sees. */
  function pack(value) {
    var out = ''
    for (var i = 0; i < value.length; i++) {
      var ch = value.charAt(i)
      if (ch.trim() !== '') out += ch
    }
    return out
  }

  function isHidden(element) {
    if (element.nodeType !== 1) return false
    if (element.getAttribute('aria-hidden') === 'true') return true
    var tag = element.tagName
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true
    // `getComputedStyle` is the only reliable answer for a collapsed reasoning
    // block: it is in the DOM with `display: none`, not detached.
    var style = window.getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return true
    return false
  }

  /**
   * Every visible character under `root`, in document order, plus a flat
   * (node, offset) pair per kept character.
   * @param {Element} root
   * @returns {{packed: string, map: Array}}
   */
  function packedMapOf(root) {
    var packed = ''
    var map = []

    function collect(node) {
      var children = node.childNodes
      for (var i = 0; i < children.length; i++) {
        var child = children[i]
        if (child.nodeType === 3) {
          var data = child.data
          for (var j = 0; j < data.length; j++) {
            var ch = data.charAt(j)
            if (ch.trim() === '') continue
            packed += ch
            map.push(child, j)
          }
        } else if (child.nodeType === 1) {
          if (isHidden(child)) continue
          collect(child)
        }
      }
    }

    collect(root)
    return { packed: packed, map: map }
  }

  /** A Range covering `[start, end)` of a packed map, or null. */
  function rangeFromIndices(full, start, end) {
    if (start < 0 || end <= start) return null
    var last = end - 1
    if (last * 2 + 1 >= full.map.length) return null
    var range = document.createRange()
    try {
      range.setStart(full.map[start * 2], full.map[start * 2 + 1])
      range.setEnd(full.map[last * 2], full.map[last * 2 + 1] + 1)
    } catch (error) {
      return null
    }
    return range
  }

  function occurrencesOf(haystack, needle, limit) {
    var out = []
    if (needle === '') return out
    var at = haystack.indexOf(needle)
    while (at !== -1 && out.length < limit) {
      out.push(at)
      at = haystack.indexOf(needle, at + 1)
    }
    return out
  }

  function rectDistance(a, b) {
    var dx = (a.left + a.right) / 2 - (b.left + b.right) / 2
    var dy = (a.top + a.bottom) / 2 - (b.top + b.bottom) / 2
    return Math.sqrt(dx * dx + dy * dy)
  }

  function boxOf(range) {
    var rect = range.getBoundingClientRect()
    if (rect.width !== 0 || rect.height !== 0) return rect
    var rects = range.getClientRects()
    return rects.length > 0 ? rects[0] : rect
  }

  /**
   * The anchor for a live selection inside one reply.
   *
   * The occurrence is chosen geometrically against the selection's own rect,
   * because the DOM is still exactly what the reader selected from.
   *
   * @param {Element} reply - the reply element the selection starts in.
   * @param {string} key - its stable identity.
   * @param {Range} range - the live selection.
   * @param {string} text - the live selection text.
   * @returns {object|null} the anchor.
   */
  function anchorOf(reply, key, range, text) {
    var quote = pack(text)
    if (quote === '' || quote.length > MAX_QUOTE_CHARS) return null

    var full = packedMapOf(reply)
    var candidates = occurrencesOf(full.packed, quote, MAX_OCCURRENCES)
    if (candidates.length === 0) return null

    var target = boxOf(range)
    var best = null
    for (var i = 0; i < candidates.length; i++) {
      var candidate = rangeFromIndices(full, candidates[i], candidates[i] + quote.length)
      if (candidate === null) continue
      var distance = rectDistance(boxOf(candidate), target)
      if (best === null || distance < best.distance) {
        best = { index: candidates[i], distance: distance }
      }
    }
    if (best === null) return null

    return {
      key: key,
      quote: quote,
      prefix: full.packed.slice(Math.max(0, best.index - CONTEXT_CHARS), best.index),
      suffix: full.packed.slice(
        best.index + quote.length,
        best.index + quote.length + CONTEXT_CHARS
      ),
      index: best.index,
      text: text.slice(0, MAX_TEXT_CHARS),
    }
  }

  /**
   * Where a stored mark sits inside one reply's current text.
   * @returns {{start: number, end: number}|null}
   */
  function locate(reply, mark) {
    if (mark === null || typeof mark !== 'object') return null
    if (typeof mark.quote !== 'string' || mark.quote === '') return null
    var prefix = typeof mark.prefix === 'string' ? mark.prefix : ''
    var suffix = typeof mark.suffix === 'string' ? mark.suffix : ''

    var full = packedMapOf(reply)
    var candidates = occurrencesOf(full.packed, mark.quote, MAX_OCCURRENCES)
    if (candidates.length === 0) return null

    var best = null
    for (var i = 0; i < candidates.length; i++) {
      var index = candidates[i]
      var score = 0
      if (prefix !== '') {
        var before = full.packed.slice(Math.max(0, index - prefix.length), index)
        if (before === prefix) score += 4
      }
      if (suffix !== '') {
        var after = full.packed.slice(
          index + mark.quote.length,
          index + mark.quote.length + suffix.length
        )
        if (after === suffix) score += 4
      }
      if (typeof mark.index === 'number') {
        score += Math.max(0, 2 - Math.abs(index - mark.index) / 200)
      }
      if (best === null || score > best.score) best = { index: index, score: score }
    }
    if (best === null) return null
    if (best.score < 4 && candidates.length > 1) return null
    return { start: best.index, end: best.index + mark.quote.length }
  }

  /** The Range for a stored mark inside one reply, or null. */
  function rangeOfMark(reply, mark) {
    var span = locate(reply, mark)
    if (span === null) return null
    var full = packedMapOf(reply)
    return rangeFromIndices(full, span.start, span.end)
  }

  // ---------------------------------------------------------------------
  // storage
  // ---------------------------------------------------------------------

  function readStore() {
    try {
      var raw = window.localStorage.getItem(MARKS_KEY)
      if (raw === null || raw === '') return {}
      var parsed = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed
    } catch (error) {
      return {}
    }
  }

  function writeStore(store) {
    try {
      window.localStorage.setItem(MARKS_KEY, JSON.stringify(store))
    } catch (error) {
      /* A full store costs persistence, not the feature. */
    }
  }

  var cache = { sessionId: null, marks: null }

  function forgetMarks() {
    cache.sessionId = null
    cache.marks = null
  }

  /** Marks recorded for one session, oldest first. */
  function marksOf(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    if (cache.sessionId === sessionId && cache.marks !== null) return cache.marks
    var entry = readStore()[sessionId]
    var marks = []
    if (entry !== null && typeof entry === 'object' && Array.isArray(entry.marks)) {
      marks = entry.marks.filter(function (mark) {
        return (
          mark !== null &&
          typeof mark === 'object' &&
          typeof mark.id === 'string' &&
          typeof mark.key === 'string' &&
          typeof mark.quote === 'string' &&
          mark.quote !== ''
        )
      })
    }
    cache.sessionId = sessionId
    cache.marks = marks
    return marks
  }

  /** Marks not yet handed to the composer. */
  function pendingOf(marks) {
    var out = []
    for (var i = 0; i < marks.length; i++) {
      var at = marks[i].exportedAt
      if (typeof at !== 'number' || at === 0) out.push(marks[i])
    }
    return out
  }

  function noteOf(mark) {
    if (mark === null || typeof mark !== 'object') return ''
    return typeof mark.note === 'string' ? mark.note : ''
  }

  /** Whether a pick asks to enter the composer. A note always implies it. */
  function quotedOf(mark) {
    if (mark === null || typeof mark !== 'object') return false
    if (mark.quoted === true) return true
    return noteOf(mark).trim() !== ''
  }

  function quotableOf(marks) {
    var out = []
    for (var i = 0; i < marks.length; i++) {
      if (quotedOf(marks[i])) out.push(marks[i])
    }
    return out
  }

  /**
   * The picks that belong to the reply currently being answered.
   *
   * A pick was made while answering one reply. When that reply is no longer the
   * newest one, its picks stay on the page but do not enter a new draft.
   */
  function scopedOf(marks, replyKey) {
    if (replyKey === null || replyKey === undefined) return marks
    var out = []
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i]
      if (mark === null || typeof mark !== 'object') continue
      if (mark.replyKey === replyKey) out.push(mark)
    }
    return out
  }

  function newId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID()
      }
    } catch (error) {
      /* Fall through. */
    }
    newId.counter = (newId.counter || 0) + 1
    return 'mark-' + Date.now().toString(36) + '-' + newId.counter
  }

  function samePlace(mark, anchor) {
    return mark.key === anchor.key && mark.index === anchor.index && mark.quote === anchor.quote
  }

  /**
   * Record one anchor and return it as stored.
   *
   * Picking an already-picked passage is a correction, not a no-op: the newer
   * gesture wins, and a changed pick goes back into the queue.
   */
  function addMark(sessionId, anchor, note, quoted) {
    if (typeof sessionId !== 'string' || sessionId === '') return null
    var store = readStore()
    var entry = store[sessionId]
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.marks)) {
      entry = { at: 0, marks: [] }
    }
    var text = typeof note === 'string' ? note : ''
    var wantsQuote = quoted === true ? true : quoted === false ? false : text.trim() !== ''
    var replyKey =
      typeof anchor.replyKey === 'string' && anchor.replyKey !== '' ? anchor.replyKey : null

    var existing = marksOf(sessionId)
    var already = null
    for (var i = 0; i < existing.length; i++) {
      if (samePlace(existing[i], anchor)) already = existing[i]
    }

    var stored
    if (already === null) {
      stored = {
        id: newId(),
        key: anchor.key,
        replyKey: replyKey,
        quote: anchor.quote,
        prefix: anchor.prefix,
        suffix: anchor.suffix,
        index: anchor.index,
        text: anchor.text,
        note: text,
        quoted: wantsQuote,
        at: Date.now(),
        exportedAt: 0,
      }
      var next = existing.concat([stored])
      if (next.length > MAX_MARKS_PER_SESSION) {
        next = next.slice(next.length - MAX_MARKS_PER_SESSION)
      }
      entry.marks = next
    } else {
      var changed = noteOf(already) !== text || quotedOf(already) !== wantsQuote
      stored = Object.assign({}, already, {
        note: text,
        quoted: wantsQuote,
        exportedAt: changed ? 0 : already.exportedAt,
      })
      if (changed) {
        delete stored.exportedChunk
        delete stored.exportedLead
        delete stored.exportedDraft
      }
      if (replyKey !== null) stored.replyKey = replyKey
      entry.marks = entry.marks.map(function (mark) {
        return mark.id === stored.id ? stored : mark
      })
    }
    entry.at = Date.now()
    store[sessionId] = entry
    writeStore(prune(store))
    forgetMarks()
    return stored
  }

  function setMarkNote(sessionId, id, note) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    var store = readStore()
    var entry = store[sessionId]
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.marks)) {
      return marksOf(sessionId)
    }
    entry.marks = entry.marks.map(function (mark) {
      if (mark.id !== id) return mark
      var next = typeof note === 'string' ? note : ''
      var changed = noteOf(mark) !== next || !quotedOf(mark)
      var stored = Object.assign({}, mark, {
        note: next,
        quoted: true,
        exportedAt: changed ? 0 : mark.exportedAt,
      })
      if (changed) {
        delete stored.exportedChunk
        delete stored.exportedLead
        delete stored.exportedDraft
      }
      return stored
    })
    entry.at = Date.now()
    store[sessionId] = entry
    writeStore(prune(store))
    forgetMarks()
    return marksOf(sessionId)
  }

  function removeMark(sessionId, id) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    var store = readStore()
    var entry = store[sessionId]
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.marks)) return []
    var next = entry.marks.filter(function (mark) {
      return mark.id !== id
    })
    entry.marks = next
    entry.at = Date.now()
    store[sessionId] = entry
    writeStore(prune(store))
    forgetMarks()
    return next
  }

  /**
   * Record that a set of marks was handed to the composer.
   *
   * `exportedChunk` is the exact text one mark owns in the draft (trailing blank
   * line included), `exportedLead` the newline the insert added before the
   * batch's first block, and `exportedDraft` the whole draft right after the
   * insert. Withdrawal requires the draft to still equal that snapshot: anything
   * else is the reader's text, and is left alone.
   */
  function markExported(sessionId, items, lead, draftAfter) {
    if (typeof sessionId !== 'string' || sessionId === '' || items.length === 0) {
      return marksOf(sessionId)
    }
    var store = readStore()
    var entry = store[sessionId]
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.marks)) {
      return marksOf(sessionId)
    }
    var records = {}
    for (var i = 0; i < items.length; i++) {
      var item = items[i]
      if (item !== null && typeof item === 'object' && typeof item.id === 'string') {
        records[item.id] = item
      }
    }
    var separator = lead === '\n' ? '\n' : ''
    var stamp = Date.now()
    entry.marks = entry.marks.map(function (mark) {
      if (!Object.prototype.hasOwnProperty.call(records, mark.id)) return mark
      var record = records[mark.id]
      return Object.assign({}, mark, {
        exportedAt: stamp,
        exportedChunk: typeof record.chunk === 'string' ? record.chunk : '',
        exportedLead: separator,
        exportedDraft: typeof draftAfter === 'string' ? draftAfter : '',
      })
    })
    entry.at = stamp
    store[sessionId] = entry
    writeStore(prune(store))
    forgetMarks()
    return marksOf(sessionId)
  }

  /**
   * Move a mark's draft snapshot after another block was removed from the same
   * batch. Without this, a second withdrawal would compare against a draft that
   * no longer exists and refuse forever.
   */
  function setExportedDraft(sessionId, id, draft) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    var store = readStore()
    var entry = store[sessionId]
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.marks)) return
    entry.marks = entry.marks.map(function (mark) {
      if (mark.id !== id) return mark
      if (typeof mark.exportedAt !== 'number' || mark.exportedAt === 0) return mark
      return Object.assign({}, mark, { exportedDraft: draft })
    })
    store[sessionId] = entry
    writeStore(store)
    forgetMarks()
  }

  /** Put a removed mark back, export bookkeeping included. */
  function restoreMark(sessionId, mark) {
    if (typeof sessionId !== 'string' || sessionId === '') return []
    if (mark === null || typeof mark !== 'object' || typeof mark.id !== 'string') {
      return marksOf(sessionId)
    }
    var store = readStore()
    var entry = store[sessionId]
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.marks)) {
      entry = { at: 0, marks: [] }
    }
    var exists = false
    for (var i = 0; i < entry.marks.length; i++) {
      if (entry.marks[i] !== null && entry.marks[i].id === mark.id) exists = true
    }
    if (!exists) {
      entry.marks = entry.marks.concat([mark]).sort(function (a, b) {
        var left = a !== null && typeof a.at === 'number' ? a.at : 0
        var right = b !== null && typeof b.at === 'number' ? b.at : 0
        return left - right
      })
    }
    entry.at = Date.now()
    store[sessionId] = entry
    writeStore(prune(store))
    forgetMarks()
    return marksOf(sessionId)
  }

  /** Keep the store from growing one abandoned session at a time. */
  function prune(store) {
    var keys = Object.keys(store)
    if (keys.length <= MAX_SESSIONS) return store
    keys.sort(function (a, b) {
      var left = store[a] && typeof store[a].at === 'number' ? store[a].at : 0
      var right = store[b] && typeof store[b].at === 'number' ? store[b].at : 0
      return left - right
    })
    var keep = {}
    var kept = keys.slice(keys.length - MAX_SESSIONS)
    for (var i = 0; i < kept.length; i++) keep[kept[i]] = store[kept[i]]
    return keep
  }

  // ---------------------------------------------------------------------
  // the Markdown wire format
  // ---------------------------------------------------------------------

  function tidyQuote(value) {
    return value.replace(/\s+$/, '')
  }

  /** The selection as a blockquote; blank lines stay quoted. */
  function quoteBlock(quote) {
    var lines = quote.split('\n')
    var out = []
    for (var i = 0; i < lines.length; i++) {
      out.push(lines[i] === '' ? '>' : '> ' + lines[i])
    }
    return out.join('\n')
  }

  /** The one block a pick contributes, exactly as the composer receives it. */
  function blockOf(mark) {
    if (!quotedOf(mark)) return ''
    var text = typeof mark.text === 'string' ? mark.text : ''
    var body = text === '' ? (typeof mark.quote === 'string' ? mark.quote : '') : text
    if (body === '') return ''
    var note = noteOf(mark).trim()
    var block = quoteBlock(tidyQuote(body))
    if (note !== '') block += '\n' + ANSWER_LABEL + note
    return block
  }

  function exportBlocks(marks) {
    var blocks = []
    for (var i = 0; i < marks.length; i++) {
      var block = blockOf(marks[i])
      if (block === '') continue
      blocks.push({ id: marks[i].id, block: block })
    }
    return blocks
  }

  /**
   * Every quotable pick as one answer, oldest first, ending in a blank line so
   * the sentence about the whole set has somewhere to start.
   */
  function buildAggregate(marks) {
    var blocks = exportBlocks(marks)
    if (blocks.length === 0) return ''
    var text = []
    for (var i = 0; i < blocks.length; i++) text.push(blocks[i].block)
    return text.join('\n\n') + '\n\n'
  }

  /** The newline a non-empty draft needs before an appended batch. */
  function separatorFor(draft, body) {
    if (body === '') return draft
    if (draft === '') return body
    if (/\n$/.test(draft)) return draft + body
    return draft + '\n' + body
  }

  function composerPlan(draft, marks) {
    var body = buildAggregate(marks)
    if (body === '') return null
    var lead = draft === '' || /\n$/.test(draft) ? '' : '\n'
    return { next: separatorFor(draft, body), lead: lead, body: body }
  }

  function chunkOf(mark) {
    if (mark === null || typeof mark !== 'object') return ''
    if (typeof mark.exportedChunk === 'string' && mark.exportedChunk !== '') {
      return mark.exportedChunk
    }
    var block = blockOf(mark)
    return block === '' ? '' : block + '\n\n'
  }

  /**
   * Take one pick's block out of a draft.
   *
   * Only `exact-snapshot` is allowed: the draft must still be byte-for-byte the
   * text the insert wrote. The shipped DSH plugin can ask the editor about
   * reference chips and submission phase; a web page has no such contract, so
   * this port is deliberately stricter — it refuses whenever the reader has
   * typed, rather than risk rewriting their words.
   *
   * @returns {{status: 'none'|'missing'|'changed'|'locked'|'removed', before?: string, after?: string}}
   */
  function planWithdraw(draft, mark) {
    var chunk = chunkOf(mark)
    if (chunk === '') return { status: 'none' }
    if (typeof mark.exportedDraft !== 'string' || mark.exportedDraft === '') {
      return { status: 'locked' }
    }
    if (draft === '') return { status: 'none' }
    var at = draft.lastIndexOf(chunk)
    if (at === -1) return { status: 'missing' }
    if (draft !== mark.exportedDraft) return { status: 'changed' }
    var next = draft.slice(0, at) + draft.slice(at + chunk.length)
    if (at + chunk.length === draft.length && mark.exportedLead === '\n') {
      if (next.charAt(at - 1) === '\n') next = next.slice(0, at - 1) + next.slice(at)
    }
    return { status: 'removed', before: draft, after: next }
  }

  global.DS_POPUP_CORE = {
    MARKS_KEY: MARKS_KEY,
    AUTO_KEY: AUTO_KEY,
    ANSWER_LABEL: ANSWER_LABEL,
    pack: pack,
    packedMapOf: packedMapOf,
    rangeFromIndices: rangeFromIndices,
    anchorOf: anchorOf,
    locate: locate,
    rangeOfMark: rangeOfMark,
    boxOf: boxOf,
    marksOf: marksOf,
    pendingOf: pendingOf,
    quotableOf: quotableOf,
    scopedOf: scopedOf,
    noteOf: noteOf,
    quotedOf: quotedOf,
    addMark: addMark,
    setMarkNote: setMarkNote,
    removeMark: removeMark,
    markExported: markExported,
    setExportedDraft: setExportedDraft,
    restoreMark: restoreMark,
    blockOf: blockOf,
    buildAggregate: buildAggregate,
    composerPlan: composerPlan,
    chunkOf: chunkOf,
    planWithdraw: planWithdraw,
  }
})(globalThis)
