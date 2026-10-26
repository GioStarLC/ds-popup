/**
 * card — the popup, in a closed shadow root of its own.
 *
 * It is plain DOM rather than React: the extension gets no module loader and no
 * host components, and the card is one form, not a tree. Keeping it dependency
 * free is also what keeps the Chrome build free of a bundler.
 *
 * The card never disappears on its own. It closes on Esc, ×, a click outside, or
 * a copy — the same exits as the DSH plugin — and while the reader is typing in
 * it, scrolling the transcript does not take it away.
 */
(function (global) {
  'use strict'

  var HOST_ID = 'ds-popup-host'

  var STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .card {
      position: fixed;
      width: 340px;
      padding: 10px;
      border-radius: 12px;
      border: 1px solid var(--line);
      background: var(--bg);
      color: var(--fg);
      box-shadow: 0 10px 30px rgba(0,0,0,.16), 0 2px 8px rgba(0,0,0,.08);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
            "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      opacity: .72;
      transform: translateZ(0);
      transition: opacity 220ms ease;
      pointer-events: auto;
    }
    .card[data-lit="true"] { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { .card { transition: none; } }
    .quote {
      font-size: 12px;
      line-height: 1.4;
      color: var(--muted);
      border-left: 3px solid var(--line-strong);
      padding: 2px 0 2px 8px;
      margin: 0 26px 8px 2px;
      max-height: 3.9em;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .note {
      display: block;
      width: 100%;
      min-height: 34px;
      max-height: 132px;
      resize: none;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--field);
      color: var(--fg);
      font: inherit;
      font-size: 14px;
      line-height: 20px;
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    .note::placeholder { color: var(--muted); opacity: 1; }
    .note:focus {
      border-color: var(--brand);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand) 22%, transparent);
    }
    .row { display: flex; gap: 6px; margin-top: 8px; align-items: center; }
    button {
      font: inherit;
      cursor: pointer;
      border-radius: 8px;
      border: 1px solid var(--line);
      background: var(--field);
      color: var(--fg);
      transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease;
    }
    button:active { transform: scale(.97); }
    button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
    .quick {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      height: 32px;
      font-size: 13px;
      white-space: nowrap;
    }
    .quick .emoji { font-size: 16px; line-height: 1; }
    .quick:hover { background: var(--hover); }
    .quick--agree {
      border-color: var(--agree-line);
      background: var(--agree-bg);
      color: #fff;
      font-weight: 600;
    }
    .quick--agree:hover { filter: brightness(.94); }
    .mark { height: 32px; padding: 0 10px; font-size: 13px; color: var(--muted); }
    .mark:hover { background: var(--hover); }
    .hint {
      margin-top: 7px;
      font-size: 11px;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .hint kbd {
      font: inherit;
      padding: 0 3px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: var(--field);
    }
    .close {
      position: absolute;
      top: 6px;
      right: 6px;
      width: 22px;
      height: 22px;
      padding: 0;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      font-size: 16px;
      line-height: 20px;
    }
    .close:hover { background: var(--hover); color: var(--fg); }
    .marked-line {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 2px 26px 2px 2px;
      color: var(--muted);
      font-size: 13px;
    }
    .unmark {
      width: 100%;
      height: 32px;
      margin-top: 8px;
      font-size: 13px;
      color: var(--brand);
      border-color: var(--brand-line);
    }
    .unmark:hover { background: var(--brand-soft); }
    .notice {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 2px 26px 2px 2px;
      font-size: 13px;
      color: var(--muted);
    }
    .notice button {
      margin-left: auto;
      height: 26px;
      padding: 0 10px;
      font-size: 12px;
      color: var(--brand);
      border-color: var(--brand-line);
      background: transparent;
    }
    .notice button:hover { background: var(--brand-soft); }
    [hidden] { display: none !important; }
  `

  function themeVars(dark) {
    if (dark) {
      return {
        '--bg': '#1f2126',
        '--field': '#2a2d34',
        '--fg': '#e9e9ea',
        '--muted': '#9b9ea6',
        '--line': 'rgba(255,255,255,.16)',
        '--line-strong': 'rgba(255,255,255,.30)',
        '--hover': 'rgba(255,255,255,.08)',
        '--brand': '#7c93ff',
        '--brand-line': 'rgba(124,147,255,.55)',
        '--brand-soft': 'rgba(124,147,255,.14)',
        '--agree-bg': '#2e7d32',
        '--agree-line': '#2e7d32',
      }
    }
    return {
      '--bg': '#ffffff',
      '--field': '#ffffff',
      '--fg': '#1a1a1a',
      '--muted': '#6b6b6b',
      '--line': 'rgba(0,0,0,.14)',
      '--line-strong': 'rgba(0,0,0,.28)',
      '--hover': 'rgba(0,0,0,.06)',
      '--brand': '#4d6bfe',
      '--brand-line': 'rgba(77,107,254,.5)',
      '--brand-soft': 'rgba(77,107,254,.10)',
      '--agree-bg': '#2e7d32',
      '--agree-line': '#2e7d32',
    }
  }

  var host = null
  var shadow = null
  var card = null
  var refs = {}
  var handlers = {}
  var liftTimer = 0
  var dimTimer = 0
  var scene = null

  function build() {
    host = document.createElement('div')
    host.id = HOST_ID
    // `all: initial` keeps the page's own CSS from leaking into the shadow root
    // through inheritance; the card supplies every property it needs.
    host.style.cssText =
      'all: initial; position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;'
    shadow = host.attachShadow({ mode: 'open' })

    var style = document.createElement('style')
    style.textContent = STYLE
    shadow.appendChild(style)

    card = document.createElement('div')
    card.className = 'card'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-label', '为这段文字决定：标记，或写下你的回答')
    card.innerHTML = [
      '<button class="close" type="button" data-act="close" title="关闭，什么也不记（Esc）" aria-label="关闭">×</button>',
      '<div class="quote" hidden></div>',
      '<textarea class="note" rows="1" aria-label="给这段文字写一句" placeholder="写下你的补充…"></textarea>',
      '<div class="row">',
      '  <button type="button" class="quick quick--agree" data-act="agree">',
      '    <span class="emoji" aria-hidden="true">👍</span><span>同意</span>',
      '  </button>',
      '  <button type="button" class="quick" data-act="disagree">',
      '    <span class="emoji" aria-hidden="true">👎</span><span>不同意</span>',
      '  </button>',
      '  <button type="button" class="mark" data-act="mark" title="只挑中这一段：留在页面上高亮，不写进输入框">标记</button>',
      '</div>',
      '<div class="hint"><span><kbd>Enter</kbd> 保存 · <kbd>Esc</kbd> 关闭</span><span class="left"></span></div>',
      '<div class="marked-line" hidden>这段文字已被标记</div>',
      '<button type="button" class="unmark" data-act="unmark" hidden>取消标记</button>',
      '<div class="notice" hidden><span class="notice-text"></span><button type="button" data-act="undo" hidden>撤销</button></div>',
    ].join('')

    shadow.appendChild(card)

    refs = {
      quote: card.querySelector('.quote'),
      note: card.querySelector('.note'),
      row: card.querySelector('.row'),
      hint: card.querySelector('.hint'),
      left: card.querySelector('.left'),
      markedLine: card.querySelector('.marked-line'),
      unmark: card.querySelector('.unmark'),
      notice: card.querySelector('.notice'),
      noticeText: card.querySelector('.notice-text'),
      undo: card.querySelector('[data-act="undo"]'),
      close: card.querySelector('.close'),
    }

    card.addEventListener('pointerenter', lift)
    card.addEventListener('pointerleave', dim)
    card.addEventListener('focusin', lift)
    card.addEventListener('focusout', dimSoon)
    // The page's own listeners (selection, Enter-to-send) must not see events
    // that belong to this form.
    card.addEventListener('mousedown', function (event) {
      event.stopPropagation()
    })
    card.addEventListener('click', onAct)
    card.addEventListener('keydown', onKeyDown)
    refs.note.addEventListener('input', function () {
      autosize()
      if (handlers.onWritingChange) handlers.onWritingChange(true)
    })
    refs.note.addEventListener('focus', function () {
      if (handlers.onWritingChange) handlers.onWritingChange(true)
    })
    refs.note.addEventListener('blur', function () {
      if (handlers.onWritingChange) handlers.onWritingChange(false)
    })
  }

  function lift() {
    if (scene === null) return
    window.clearTimeout(dimTimer)
    window.clearTimeout(liftTimer)
    liftTimer = window.setTimeout(function () {
      card.setAttribute('data-lit', 'true')
    }, 160)
  }

  function dimSoon() {
    window.clearTimeout(dimTimer)
    dimTimer = window.setTimeout(dim, 240)
  }

  function dim() {
    window.clearTimeout(liftTimer)
    if (scene === null) return
    // Keep it lit while the reader is typing in it: the card is a form, and a
    // form that fades under the cursor is harder to read than one that stays.
    if (refs.note !== null && (refs.note === shadow.activeElement || refs.note.value !== '')) return
    card.setAttribute('data-lit', 'false')
  }

  function onAct(event) {
    var button = event.target.closest ? event.target.closest('[data-act]') : null
    if (button === null) return
    var act = button.getAttribute('data-act')
    if (act === 'agree' || act === 'disagree') {
      if (handlers.onQuick) handlers.onQuick(act === 'agree' ? '同意' : '不同意')
      return
    }
    if (act === 'close' && handlers.onClose) handlers.onClose()
    if (act === 'mark' && handlers.onMark) handlers.onMark()
    if (act === 'unmark' && handlers.onUnmark) handlers.onUnmark()
    if (act === 'undo' && handlers.onUndo) handlers.onUndo()
  }

  function onKeyDown(event) {
    // Keep the transcript's own shortcuts out of this form.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      if (handlers.onClose) handlers.onClose()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing) {
      event.preventDefault()
      if (handlers.onCommit) handlers.onCommit(refs.note.value)
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      if (handlers.onCommit) handlers.onCommit(refs.note.value)
    }
  }

  function autosize() {
    var note = refs.note
    note.style.height = 'auto'
    note.style.height = Math.min(132, Math.max(34, note.scrollHeight)) + 'px'
  }

  function place(rect) {
    var margin = 8
    var width = 340
    var height = card.offsetHeight || 120
    var viewportWidth = window.innerWidth
    var viewportHeight = window.innerHeight

    var left = rect.left + rect.width / 2 - width / 2
    left = Math.max(margin, Math.min(left, viewportWidth - width - margin))

    var top = rect.top - height - 10
    if (top < margin) top = Math.min(rect.bottom + 10, viewportHeight - height - margin)
    top = Math.max(margin, top)

    card.style.left = Math.round(left) + 'px'
    card.style.top = Math.round(top) + 'px'
  }

  function show(next) {
    if (host === null) build()
    scene = next
    if (host.parentNode === null) document.documentElement.appendChild(host)

    var dark = next.dark === true
    var vars = themeVars(dark)
    for (var name in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, name)) {
        host.style.setProperty(name, vars[name])
      }
    }

    var writing = next.mode === 'write'
    refs.quote.hidden = !next.quote
    refs.quote.textContent = next.quote || ''
    refs.note.hidden = !writing
    refs.row.hidden = !writing
    refs.hint.hidden = !writing
    refs.markedLine.hidden = writing
    refs.unmark.hidden = writing
    refs.notice.hidden = true

    if (writing) {
      refs.note.value = typeof next.note === 'string' ? next.note : ''
      autosize()
    } else if (next.notice) {
      refs.notice.hidden = false
      refs.markedLine.hidden = true
      refs.unmark.hidden = true
      refs.noticeText.textContent = next.notice.message
      refs.undo.hidden = !next.notice.undo
    }
    if (next.left) refs.left.textContent = next.left

    // Open quiet. Reaching for the card (pointer or focus) is what brings it up;
    // a card that opens already lit makes the page feel like it moved.
    card.setAttribute('data-lit', 'false')
    place(next.rect)

    if (writing) {
      // Focus once per card, not on every render: the caret belongs where the
      // reader's next sentence goes, and re-focusing would pull it back.
      if (!next.keepFocus) {
        window.setTimeout(function () {
          if (scene === next) {
            refs.note.focus({ preventScroll: true })
            var end = refs.note.value.length
            try { refs.note.setSelectionRange(end, end) } catch (error) { /* noop */ }
          }
        }, 0)
      }
    }
  }

  function hide() {
    scene = null
    window.clearTimeout(liftTimer)
    window.clearTimeout(dimTimer)
    if (host !== null) host.remove()
  }

  function setNotice(notice) {
    if (scene === null) return
    scene = Object.assign({}, scene, { notice: notice, mode: 'marked' })
    show(scene)
  }

  function reposition(rect) {
    if (scene === null) return
    scene = Object.assign({}, scene, { rect: rect })
    place(rect)
  }

  function isInside(event) {
    if (host === null) return false
    var path = event.composedPath ? event.composedPath() : []
    return path.indexOf(host) !== -1
  }

  function isOpen() {
    return scene !== null
  }

  function getScene() {
    return scene
  }

  global.DS_POPUP_CARD = {
    init: function (nextHandlers) {
      handlers = nextHandlers || {}
      if (host === null) build()
    },
    show: show,
    hide: hide,
    setNotice: setNotice,
    reposition: reposition,
    isInside: isInside,
    isOpen: isOpen,
    scene: getScene,
    focusNote: function () {
      if (refs.note) refs.note.focus({ preventScroll: true })
    },
    noteValue: function () {
      return refs.note ? refs.note.value : ''
    },
  }
})(globalThis)
