/**
 * adapter — the only file that knows what chat.deepseek.com looks like.
 *
 * The host contract is small on purpose, because it is the part that can break
 * when DeepSeek ships a redesign:
 *
 *   .ds-message                                   one message
 *   .ds-assistant-message-main-content            marks an assistant message
 *   [data-virtual-list-item-key]                  its stable list identity
 *   textarea[placeholder*="DeepSeek"]              the composer
 *
 * The first two are design-system class names (readable, not CSS-module
 * hashes); the third is the virtual list's own key; the fourth is matched on
 * its localized placeholder with a visible-textarea fallback. Everything else
 * in this extension works against the small API below, so a selector change
 * does not reach the rest of the code.
 */
(function (global) {
  'use strict'

  var MESSAGE_SELECTOR = '.ds-message'
  var ASSISTANT_MARKER = '.ds-assistant-message-main-content'
  var THINK_MARKER = '.ds-think-content'
  var ITEM_KEY_ATTRIBUTE = 'data-virtual-list-item-key'
  var COMPOSER_PLACEHOLDER = 'DeepSeek'
  var EDITABLE_SELECTOR =
    'textarea, input, select, [contenteditable="true"], [contenteditable=""]'

  function elementOf(node) {
    if (node === null || node === undefined) return null
    if (node.nodeType === 1) return node
    return node.parentElement || null
  }

  function isVisible(element) {
    if (element === null) return false
    if (!element.isConnected) return false
    var rect = element.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return false
    var style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  }

  function isEditable(node) {
    var element = elementOf(node)
    if (element === null) return false
    return element.closest(EDITABLE_SELECTOR) !== null
  }

  /** The conversation id in `/a/chat/s/<uuid>`, or 'new' on the home screen. */
  function sessionId() {
    var match = /\/a\/chat\/s\/([^/?#]+)/.exec(window.location.pathname)
    if (match !== null) return match[1]
    return 'new'
  }

  function messages() {
    return Array.prototype.slice.call(document.querySelectorAll(MESSAGE_SELECTOR))
  }

  function isAssistant(message) {
    if (message === null) return false
    return (
      message.querySelector(ASSISTANT_MARKER) !== null ||
      message.querySelector(THINK_MARKER) !== null
    )
  }

  /**
   * The reply's identity.
   *
   * DeepSeek puts the virtual list key on the item wrapper, one level above
   * `.ds-message`. That key survives scrolling (the item unmounts and comes back
   * with the same key) and a reload. If a future build drops it, the index among
   * messages is the fallback — weaker, because an item that is not mounted does
   * not have an index, but better than refusing every mark.
   */
  function keyOf(message) {
    if (message === null) return null
    var item = message.closest('[' + ITEM_KEY_ATTRIBUTE + ']')
    if (item !== null) {
      var value = item.getAttribute(ITEM_KEY_ATTRIBUTE)
      if (value !== null && value !== '') return value
    }
    var index = messages().indexOf(message)
    return index === -1 ? null : 'index:' + index
  }

  /** The assistant reply a node sits in, or null. */
  function replyOf(node) {
    var element = elementOf(node)
    if (element === null) return null
    var message = element.closest(MESSAGE_SELECTOR)
    if (message === null || !isAssistant(message)) return null
    return message
  }

  function assistantReplies() {
    return messages().filter(isAssistant)
  }

  /** The reply being answered: the newest assistant message in the list. */
  function latestReply() {
    var replies = assistantReplies()
    return replies.length === 0 ? null : replies[replies.length - 1]
  }

  function latestReplyKey() {
    var reply = latestReply()
    return reply === null ? null : keyOf(reply)
  }

  function repliesByKey() {
    var map = {}
    var replies = assistantReplies()
    for (var i = 0; i < replies.length; i++) {
      var key = keyOf(replies[i])
      if (key !== null) map[key] = replies[i]
    }
    return map
  }

  function composerField() {
    var textareas = Array.prototype.slice.call(document.querySelectorAll('textarea'))
    // The chat composer is the visible textarea whose placeholder names the
    // model. The placeholder is localized, so the model name is the stable half.
    for (var i = 0; i < textareas.length; i++) {
      var field = textareas[i]
      if (field.placeholder && field.placeholder.indexOf(COMPOSER_PLACEHOLDER) !== -1) {
        if (isVisible(field)) return field
      }
    }
    // Fallback: the last visible textarea, which is where a chat composer sits
    // in every layout this page has shipped.
    for (var j = textareas.length - 1; j >= 0; j--) {
      if (isVisible(textareas[j])) return textareas[j]
    }
    return null
  }

  /**
   * The box that holds the composer and its tool row.
   *
   * From the live DOM: textarea → wrapper → box, and the box's other child is
   * the row of toggles. Deriving it by structure rather than by the hashed
   * class is what lets the insert button survive a CSS-module rebuild.
   */
  function composerBox() {
    var field = composerField()
    if (field === null) return null
    var wrapper = field.parentElement
    if (wrapper === null) return null
    return wrapper.parentElement || wrapper
  }

  /** The tool row beside the composer, where the insert button is seated. */
  function composerToolbar() {
    var box = composerBox()
    var field = composerField()
    if (box === null || field === null) return null
    var wrapper = field.parentElement
    var children = box.children
    var fallback = null
    for (var i = children.length - 1; i >= 0; i--) {
      var child = children[i]
      if (child === wrapper || child.contains(field)) continue
      // The tool row is the sibling that owns the toggles. Identifying it by
      // its controls rather than by being "the other child" survives the
      // attachment tray that DeepSeek adds above the field.
      if (child.querySelector('[role="button"], button, .ds-toggle-button') !== null) {
        return child
      }
      if (fallback === null) fallback = child
    }
    return fallback
  }

  function readDraft() {
    var field = composerField()
    return field === null ? null : field.value
  }

  /**
   * Write a draft through React's own listener.
   *
   * The textarea is controlled, so assigning `.value` alone would be overwritten
   * on the next render. React tracks the last value on the node; setting the
   * prototype setter updates the DOM without updating that tracker, and the
   * `input` event then makes React read the new value and re-render. This is the
   * one DOM-level thing this port does that the DSH plugin did not have to: the
   * host there published `setDraft`.
   *
   * @returns {boolean} whether a composer was found and written.
   */
  function writeDraft(text) {
    var field = composerField()
    if (field === null) return false
    try {
      var descriptor = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )
      descriptor.set.call(field, text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    } catch (error) {
      return false
    }
  }

  function focusComposer(atEnd) {
    var field = composerField()
    if (field === null) return
    try {
      field.focus({ preventScroll: true })
      if (atEnd) {
        var end = field.value.length
        field.setSelectionRange(end, end)
      }
    } catch (error) {
      /* Focus is a convenience; losing it costs nothing durable. */
    }
  }

  /** Whether the page is currently in dark mode, by sampling its own surface. */
  function isDark() {
    try {
      var value = window
        .getComputedStyle(document.body)
        .getPropertyValue('background-color')
      var match = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value)
      if (match === null) return false
      var luminance =
        (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255
      return luminance < 0.5
    } catch (error) {
      return false
    }
  }

  global.DS_POPUP_ADAPTER = {
    sessionId: sessionId,
    messages: messages,
    isAssistant: isAssistant,
    isEditable: isEditable,
    keyOf: keyOf,
    replyOf: replyOf,
    assistantReplies: assistantReplies,
    latestReply: latestReply,
    latestReplyKey: latestReplyKey,
    repliesByKey: repliesByKey,
    composerField: composerField,
    composerBox: composerBox,
    composerToolbar: composerToolbar,
    readDraft: readDraft,
    writeDraft: writeDraft,
    focusComposer: focusComposer,
    isDark: isDark,
    isVisible: isVisible,
  }
})(globalThis)
