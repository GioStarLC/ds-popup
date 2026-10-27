/**
 * content — wiring for the DeepSeek web host.
 *
 * Everything here is glue: selection → anchor → card → store → highlight, and
 * the composer as the single exit. The rules that are not glue are the ones
 * worth stating:
 *
 *   - Only assistant replies are annotatable. A selection in a user message,
 *     the sidebar, or a search field has nowhere to be anchored.
 *   - A mark belongs to the reply being answered when it was made. Picking a
 *     passage in an older reply still joins the draft; a pick left over from a
 *     superseded reply is painted but never handed over.
 *   - The draft is only ever written on an explicit exit (the card's commit,
 *     the insert button, auto-insert into an empty composer). Reading never
 *     writes.
 *   - Scrolling closes a card that is not being written in, because the
 *     passage it is about may not be where it was; while typing it stays,
 *     because it is a form and the sentence is not something to lose.
 */
(function (global) {
  'use strict'

  var C = global.DS_POPUP_CORE
  var A = global.DS_POPUP_ADAPTER
  var Card = global.DS_POPUP_CARD

  if (!C || !A || !Card) return

  var OPEN_DELAY_MS = 80
  var HIGHLIGHT_MARK = 'ds-popup-mark'
  var HIGHLIGHT_PREVIEW = 'ds-popup-preview'
  var STYLE_ID = 'ds-popup-style'
  var TOOLS_ID = 'ds-popup-tools'
  var VERSION = '0.1.0'

  var writing = false
  var openSerial = 0
  var quietFocus = false
  var previewRange = null
  var lastSession = null
  var lastHref = null
  var supportsHighlight = false

  // ---------------------------------------------------------------------
  // highlight
  // ---------------------------------------------------------------------

  var HIGHLIGHT_CSS = [
    '::highlight(' + HIGHLIGHT_MARK + '){',
    '  background-color: rgba(255,212,64,.80);',
    '  color: #1b1b1b;',
    '}',
    '::highlight(' + HIGHLIGHT_PREVIEW + '){',
    '  background-color: rgba(77,107,254,.22);',
    '}',
  ].join('\n')

  var UI_CSS = [
    '#' + TOOLS_ID + '{display:inline-flex;align-items:center;gap:6px;margin-inline-start:8px;}',
    '#' + TOOLS_ID + ' button{',
    '  font:500 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;',
    '  height:26px;padding:0 10px;border-radius:13px;cursor:pointer;',
    '  border:1px solid rgba(0,0,0,.14);background:transparent;color:#4d6bfe;',
    '  transition:background-color 120ms ease,border-color 120ms ease;',
    '}',
    '#' + TOOLS_ID + ' button:hover{background:rgba(77,107,254,.08);}',
    '#' + TOOLS_ID + ' button[data-active="true"]{',
    '  background:rgba(77,107,254,.10);border-color:rgba(77,107,254,.45);',
    '}',
    '#' + TOOLS_ID + ' button[hidden]{display:none;}',
    'html[data-ds-popup-dark="true"] #' + TOOLS_ID + ' button{',
    '  border-color:rgba(255,255,255,.18);color:#7c93ff;',
    '}',
  ].join('\n')

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.dataset.version = VERSION
    style.textContent = HIGHLIGHT_CSS + '\n' + UI_CSS
    ;(document.head || document.documentElement).appendChild(style)
  }

  function highlights() {
    try {
      if (typeof window.Highlight !== 'function') return null
      if (window.CSS === undefined || window.CSS.highlights === undefined) return null
      return window.CSS.highlights
    } catch (error) {
      return null
    }
  }

  function paint() {
    var registry = highlights()
    if (registry === null) {
      supportsHighlight = false
      return
    }
    supportsHighlight = true
    var session = A.sessionId()
    var marks = C.marksOf(session)
    var byKey = A.repliesByKey()
    var ranges = []
    for (var i = 0; i < marks.length; i++) {
      var reply = byKey[marks[i].key]
      if (reply === undefined) continue
      var range = C.rangeOfMark(reply, marks[i])
      if (range !== null) ranges.push(range)
    }
    try {
      if (ranges.length === 0) registry.delete(HIGHLIGHT_MARK)
      else registry.set(HIGHLIGHT_MARK, new window.Highlight(...ranges))
    } catch (error) {
      /* A registry failure must not take the feature down with it. */
    }
  }

  function setPreview(range) {
    var registry = highlights()
    if (registry === null) return
    previewRange = range
    try {
      if (range === null) registry.delete(HIGHLIGHT_PREVIEW)
      else registry.set(HIGHLIGHT_PREVIEW, new window.Highlight(range))
    } catch (error) {
      /* noop */
    }
  }

  // ---------------------------------------------------------------------
  // reading a selection
  // ---------------------------------------------------------------------

  function elementOf(node) {
    if (node === null || node === undefined) return null
    return node.nodeType === 1 ? node : node.parentElement || null
  }

  function inOurUi(event) {
    if (Card.isInside(event)) return true
    var target = elementOf(event.target)
    if (target === null) return false
    return target.closest('#' + TOOLS_ID) !== null
  }

  function inEditable(event) {
    return A.isEditable(event.target)
  }

  function inModal(event) {
    var target = elementOf(event.target)
    if (target === null) return false
    return target.closest('[role="dialog"], [role="alertdialog"]') !== null
  }

  /**
   * Read the current selection as an anchor.
   *
   * The start decides which reply the passage belongs to. The end is only
   * clamped into that reply and compared: a triple-click on the last paragraph
   * drags the selection into the composer below it, and refusing that would make
   * the last paragraph of every reply unannotatable. Clamping also keeps the
   * card's rect off the composer.
   */
  function readSelection() {
    var selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0) return null
    if (selection.isCollapsed) return null

    var range = selection.getRangeAt(0)
    var reply = A.replyOf(range.startContainer)
    if (reply === null) return null
    var key = A.keyOf(reply)
    if (key === null) return null

    var text = selection.toString()
    if (C.pack(text) === '') return null

    var anchor = C.anchorOf(reply, key, range, text)
    if (anchor !== null) return { anchor: anchor, range: range, reply: reply, text: text }

    var clamped = document.createRange()
    try {
      clamped.setStart(range.startContainer, range.startOffset)
      clamped.setEnd(reply, reply.childNodes.length)
    } catch (error) {
      return null
    }
    var clampedText = clamped.toString()
    if (C.pack(clampedText) !== C.pack(text)) return null
    anchor = C.anchorOf(reply, key, clamped, clampedText)
    if (anchor === null) return null
    return { anchor: anchor, range: clamped, reply: reply, text: clampedText }
  }

  function samePassage(scene, found) {
    var mine = scene && scene.anchor
    var theirs = found && found.anchor
    if (mine === null || mine === undefined || theirs === null || theirs === undefined) {
      return false
    }
    return mine.key === theirs.key && mine.index === theirs.index && mine.quote === theirs.quote
  }

  // ---------------------------------------------------------------------
  // the card
  // ---------------------------------------------------------------------

  function currentReplyKey() {
    return A.latestReplyKey()
  }

  function writeMark(anchor, note, quoted) {
    var session = A.sessionId()
    var scoped = Object.assign({}, anchor, { replyKey: currentReplyKey() })
    var stored = C.addMark(session, scoped, note, quoted)
    marksChanged()
    return stored
  }

  function marksChanged() {
    paint()
    ensureTools()
  }

  function closeCard(options) {
    var scene = Card.scene()
    Card.hide()
    setPreview(null)
    writing = false
    // Leaving the card puts the caret back where the reader will type next.
    // Quietly: arriving in the composer would otherwise auto-insert a set they
    // just walked away from.
    if (options && options.focusComposer) {
      quietFocus = true
      A.focusComposer(false)
      window.setTimeout(function () {
        quietFocus = false
      }, 0)
    }
    void scene
  }

  function openWriteCard(found, point) {
    var scene = Card.scene()
    if (scene !== null && samePassage(scene, found)) return
    openSerial += 1
    var rect = found.range.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) rect = point
    Card.show({
      mode: 'write',
      rect: rect,
      quote: found.anchor.text,
      // What the browser would have put on the clipboard had focusing the note
      // not collapsed the selection. The display quote above is clamped; this is
      // the whole passage.
      copyText: found.text,
      note: '',
      dark: A.isDark(),
      anchor: found.anchor,
      replyKey: currentReplyKey(),
      serial: openSerial,
      left: pendingCount() > 0 ? '待填入 ' + pendingCount() + ' 条' : '',
    })
    setPreview(found.range)
    writing = true
  }

  function openMarkedCard(mark, rect) {
    openSerial += 1
    Card.show({
      mode: 'marked',
      rect: rect,
      quote: mark.text || mark.quote,
      mark: mark,
      dark: A.isDark(),
      serial: openSerial,
      note: '',
    })
    writing = false
  }

  /** A mark under a point, if the reader clicked one instead of selecting. */
  function markAtPoint(x, y) {
    var marks = C.marksOf(A.sessionId())
    var byKey = A.repliesByKey()
    var found = null
    for (var i = 0; i < marks.length; i++) {
      var mark = marks[i]
      var reply = byKey[mark.key]
      if (reply === undefined) continue
      var range = C.rangeOfMark(reply, mark)
      if (range === null) continue
      var rects = range.getClientRects()
      for (var j = 0; j < rects.length; j++) {
        var rect = rects[j]
        if (x >= rect.left - 2 && x <= rect.right + 2 && y >= rect.top - 2 && y <= rect.bottom + 2) {
          found = { mark: mark, rect: rect }
        }
      }
    }
    return found
  }

  // ---------------------------------------------------------------------
  // the composer
  // ---------------------------------------------------------------------

  function pendingList() {
    var marks = C.marksOf(A.sessionId())
    // Only annotated picks that have not been handed over yet. `quotableOf`
    // alone would keep counting a mark after it entered the draft.
    return C.quotableOf(C.pendingOf(C.scopedOf(marks, currentReplyKey())))
  }

  function pendingCount() {
    return pendingList().length
  }

  function autoEnabled() {
    try {
      return window.localStorage.getItem(C.AUTO_KEY) !== '0'
    } catch (error) {
      return true
    }
  }

  function setAutoEnabled(next) {
    try {
      window.localStorage.setItem(C.AUTO_KEY, next ? '1' : '0')
    } catch (error) {
      /* noop */
    }
  }

  /** Hand the pending set over. Only annotated picks enter the draft. */
  function insertPending(manual) {
    var pending = pendingList()
    if (pending.length === 0) return false
    var draft = A.readDraft()
    if (draft === null) return false
    if (!manual && draft !== '') return false
    var plan = C.composerPlan(draft, pending)
    if (plan === null) return false
    if (!A.writeDraft(plan.next)) return false
    var session = A.sessionId()
    var items = []
    for (var i = 0; i < pending.length; i++) {
      items.push({ id: pending[i].id, chunk: C.chunkOf(pending[i]) })
    }
    C.markExported(session, items, plan.lead, plan.next)
    // Earlier batches still in this draft must move their snapshot too, or a
    // withdrawal of one of them would compare against a draft that is gone.
    var marks = C.marksOf(session)
    for (var j = 0; j < marks.length; j++) {
      if (marks[j].exportedDraft === draft && marks[j].exportedAt) {
        C.setExportedDraft(session, marks[j].id, plan.next)
      }
    }
    marksChanged()
    if (manual) {
      A.focusComposer(true)
      window.setTimeout(function () {
        A.focusComposer(true)
      }, 0)
    }
    return true
  }

  function ensureTools() {
    ensureStyle()
    var box = A.composerBox()
    var toolbar = A.composerToolbar()
    if (box === null || toolbar === null) {
      var orphan = document.getElementById(TOOLS_ID)
      if (orphan !== null) orphan.remove()
      return
    }
    var count = pendingCount()
    if (count === 0) {
      var existing = document.getElementById(TOOLS_ID)
      if (existing !== null) existing.remove()
      return
    }
    var tools = document.getElementById(TOOLS_ID)
    if (tools === null || tools.parentNode !== toolbar) {
      if (tools !== null) tools.remove()
      tools = document.createElement('span')
      tools.id = TOOLS_ID
      var insert = document.createElement('button')
      insert.type = 'button'
      insert.setAttribute('data-role', 'insert')
      insert.addEventListener('mousedown', function (event) {
        event.preventDefault()
        event.stopPropagation()
      })
      insert.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        insertPending(true)
      })
      var auto = document.createElement('button')
      auto.type = 'button'
      auto.setAttribute('data-role', 'auto')
      auto.textContent = '自动'
      auto.addEventListener('mousedown', function (event) {
        event.preventDefault()
        event.stopPropagation()
      })
      auto.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        var next = !autoEnabled()
        setAutoEnabled(next)
        ensureTools()
      })
      tools.appendChild(insert)
      tools.appendChild(auto)
      toolbar.appendChild(tools)
    }
    var insertButton = tools.querySelector('[data-role="insert"]')
    var autoButton = tools.querySelector('[data-role="auto"]')
    if (insertButton !== null) {
      insertButton.textContent = '填入 ' + count
      insertButton.title = '把 ' + count + ' 条批注写进输入框'
    }
    if (autoButton !== null) autoButton.setAttribute('data-active', autoEnabled() ? 'true' : 'false')
    if (autoButton !== null) {
      autoButton.title = autoEnabled()
        ? '进入空输入框时自动填入：开（点击关闭）'
        : '进入空输入框时自动填入：关（点击打开）'
    }
    document.documentElement.setAttribute(
      'data-ds-popup-dark',
      A.isDark() ? 'true' : 'false'
    )
  }

  function maybeAutoInsert() {
    if (quietFocus) return
    if (!autoEnabled()) return
    if (A.readDraft() !== '') return
    insertPending(false)
  }

  // ---------------------------------------------------------------------
  // events
  // ---------------------------------------------------------------------

  function onMouseUp(event) {
    if (inOurUi(event)) return
    if (inEditable(event)) {
      // Clicking the composer is a click outside the card: it has no reason to
      // stay open over the thing the reader just moved to.
      if (Card.isOpen()) closeCard({ focusComposer: false })
      return
    }
    if (inModal(event)) {
      if (Card.isOpen()) closeCard({ focusComposer: false })
      return
    }

    var x = event.clientX
    var y = event.clientY
    window.setTimeout(function () {
      openFromSelection(x, y)
    }, OPEN_DELAY_MS)
  }

  function openFromSelection(x, y) {
    var found = readSelection()
    if (found !== null) {
      openWriteCard(found, { left: x, top: y, right: x, bottom: y, width: 0, height: 0 })
      return
    }
    var at = markAtPoint(x, y)
    if (at !== null) {
      var scene = Card.scene()
      if (scene !== null && scene.mark && scene.mark.id === at.mark.id) return
      openMarkedCard(at.mark, at.rect)
      return
    }
    if (Card.isOpen()) closeCard({ focusComposer: false })
  }

  function onKeyDown(event) {
    // The card handles its own keys; only a card that does not own focus needs
    // the document-level escape.
    if (inOurUi(event)) return
    if (Card.isOpen()) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeCard({ focusComposer: true })
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        var scene = Card.scene()
        if (scene !== null && scene.mode === 'marked') closeCard({ focusComposer: false })
        return
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Enter') {
      if (A.isEditable(event.target)) return
      var found = readSelection()
      if (found === null) return
      event.preventDefault()
      openWriteCard(found, null)
    }
  }

  function onCopy(event) {
    if (inOurUi(event)) return
    var scene = Card.scene()
    if (scene !== null && scene.mode === 'marked') closeCard({ focusComposer: false })
  }

  function onViewportChange(event) {
    if (!Card.isOpen()) return
    if (writing) return
    // Our own tools are position: static in the composer, so their scroll is the
    // page's; ignore nothing, the rule is simply "scroll dismisses an unwritten
    // card".
    void event
    closeCard({ focusComposer: false })
  }

  function onFocusIn(event) {
    if (quietFocus) return
    var field = A.composerField()
    if (field === null || event.target !== field) return
    maybeAutoInsert()
  }

  function onDocumentClick(event) {
    if (inOurUi(event)) return
    ensureTools()
  }

  // ---------------------------------------------------------------------
  // card actions
  // ---------------------------------------------------------------------

  Card.init({
    onWritingChange: function (next) {
      writing = next
    },
    onCommit: function (note) {
      var scene = Card.scene()
      if (scene === null || scene.mode !== 'write') return
      var text = typeof note === 'string' ? note : ''
      closeCard({ focusComposer: false })
      if (text.trim() === '') return
      writeMark(scene.anchor, text, true)
    },
    onQuick: function (answer) {
      var scene = Card.scene()
      if (scene === null || scene.mode !== 'write') return
      var typed = String(Card.noteValue() || '').trim()
      var note
      if (typed === '' || typed === answer || typed.indexOf(answer) === 0) {
        note = typed === '' ? answer : typed
      } else {
        note = answer + '\n' + typed
      }
      closeCard({ focusComposer: false })
      writeMark(scene.anchor, note, true)
    },
    onMark: function () {
      var scene = Card.scene()
      if (scene === null || scene.mode !== 'write') return
      closeCard({ focusComposer: false })
      writeMark(scene.anchor, '', false)
    },
    onUnmark: function () {
      var scene = Card.scene()
      if (scene === null || !scene.mark) return
      var session = A.sessionId()
      var mark = scene.mark
      var draft = A.readDraft()
      var plan = draft === null ? { status: 'locked' } : C.planWithdraw(draft, mark)

      C.removeMark(session, mark.id)
      marksChanged()

      if (plan.status === 'removed' && A.writeDraft(plan.after)) {
        // Every mark from the same insert shares the draft snapshot. Rewrite it
        // so a second withdrawal is still measured against what is on screen.
        var marks = C.marksOf(session)
        for (var i = 0; i < marks.length; i++) {
          if (marks[i].exportedDraft === plan.before) {
            C.setExportedDraft(session, marks[i].id, plan.after)
          }
        }
        Card.setNotice({
          message: '已取消标记 · 已从输入框移除',
          undo: { session: session, mark: mark, before: plan.before, after: plan.after },
        })
        return
      }
      if (plan.status === 'missing') {
        Card.setNotice({ message: '已取消标记 · 输入框里已经没有这段引用', undo: null })
        return
      }
      if (plan.status === 'changed') {
        Card.setNotice({ message: '已取消标记 · 输入框里这段已被改动，未自动移除', undo: null })
        return
      }
      if (plan.status === 'locked') {
        Card.setNotice({ message: '已取消标记 · 输入框里这段无法安全改写，未自动移除', undo: null })
        return
      }
      closeCard({ focusComposer: false })
    },
    onUndo: function () {
      var scene = Card.scene()
      if (scene === null || !scene.notice || !scene.notice.undo) return
      var undo = scene.notice.undo
      closeCard({ focusComposer: false })
      if (A.readDraft() !== undo.after) return
      if (!A.writeDraft(undo.before)) return
      C.restoreMark(undo.session, undo.mark)
      marksChanged()
    },
    onClose: function () {
      closeCard({ focusComposer: true })
    },
  })

  // ---------------------------------------------------------------------
  // transcript changes and SPA navigation
  // ---------------------------------------------------------------------

  var paintTimer = 0

  function schedulePaint() {
    window.clearTimeout(paintTimer)
    paintTimer = window.setTimeout(function () {
      paint()
      ensureTools()
    }, 140)
  }

  function onNavigate() {
    var session = A.sessionId()
    if (session !== lastSession) {
      lastSession = session
      closeCard({ focusComposer: false })
    }
    schedulePaint()
  }

  function boot() {
    ensureStyle()
    lastSession = A.sessionId()
    lastHref = window.location.href
    paint()
    ensureTools()

    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('copy', onCopy, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('click', onDocumentClick, true)
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)

    var observer = new MutationObserver(function () {
      schedulePaint()
    })
    observer.observe(document.body, { childList: true, subtree: true })

    window.setInterval(function () {
      if (window.location.href !== lastHref) {
        lastHref = window.location.href
        onNavigate()
      }
      ensureTools()
    }, 900)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
})(globalThis)
