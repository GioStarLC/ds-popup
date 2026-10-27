# 设计：从 dsh-popup 到 DeepSeek 网页

`dsh-popup` 是 DSH 的客户端插件，运行在宿主提供的模块系统、slot 布局和 `InputActions` 之上。Chrome 扩展没有这些。这个移植版保留了交互模型和锚点算法，重写了与宿主打交道的那一层。

## 复用了什么

| 能力 | 位置 |
| --- | --- |
| 锚点模型：`quote` + `prefix` / `suffix` / `index` | `src/core.js` |
| 定位：按上下文打分，歧义拒绝而不是猜 | `src/core.js` |
| 存储：按会话、容量上限、按时间裁剪 | `src/core.js` |
| 交付格式：`> 原文` + `我的回答：…` | `src/core.js` |
| 卡片交互：同意 / 不同意 / 标记 / 补一句，透明到变亮 | `src/card.js` |
| 选区规则：起点决定归属，终点夹取后比较 | `src/content.js` |

## 重写了什么

| DSH 契约 | 网页上的替代 |
| --- | --- |
| `window.__ModuleLoader__` 注册 | content script 直接执行 |
| `shell.overlay` / `conversation.input.*` | Shadow DOM 浮层 + 输入框工具行注入 |
| `data-chat-anchor-key` | `[data-virtual-list-item-key]`（虚拟列表项） |
| `data-chat-flow-kind="assistant-step"` | `.ds-message` + `.ds-assistant-message-main-content` |
| `InputActions.captureInsertion/insertText/setDraft` | 受控 `<textarea>`：原生 `value` setter + `input` 事件 |
| `.dsh-composer-anchor` 的 `aria-expanded` | 无对应；卡片自己 `stopPropagation` 键盘事件 |
| Session id 来自 slot props | URL `/a/chat/s/<uuid>` |
| `--dsw-alias-*` 主题变量 | 自绘调色板，按页面背景亮度选明暗 |

## 宿主契约只有一个文件

`src/adapter.js` 是唯一出现 DeepSeek 选择器的文件：

```
.ds-message                                      一条消息
.ds-assistant-message-main-content               助手消息的标记
[data-virtual-list-item-key]                     虚拟列表项身份
textarea[placeholder*="DeepSeek"]                输入框（带可见性兜底）
```

`tools/check.mjs` 会扫描其余文件，出现这些字符串就失败。DeepSeek 改版时，改这一个文件，其余代码不动。

## 几个关键决定

**回复身份用虚拟列表 key，而不是文本哈希。** 文本哈希在流式回答期间一直在变；列表 key 在滚出视口、卸载、重新挂载后仍是同一个。回复内容被重新生成时，引文很可能已经不在里面，定位自然失败，不会把标记画到新回答上。

**批注的归属是「批注时正在回答的回复」。** 在更早的回复里选中文字仍然可以批注，但它进入的是当前草稿；上一轮遗留的批注只上色、不交付。这条规则在交付时再检查一次。

**写入输入框必须经过 React。** `<textarea>` 是受控组件，直接赋值会在下一次渲染被覆盖。用原型链上的原生 setter 改 DOM，再派发 `input`，React 的 `onChange` 才会读到新值。这是这个移植版唯一一处「碰编辑器 DOM」的地方，原版由宿主 API 代劳。

**撤回比原版更保守。** DSH 版能问编辑器「草稿有没有引用 chip」「是不是在提交中」；网页没有这种契约。所以这里只允许一种情况：草稿仍逐字节等于插入后那一刻的快照。读者改过一个字，就只取消标记、不动文字，并在卡片上说明。

**高亮直接用 CSS Custom Highlight API。** content script 的 isolated world 与页面共享 Document，`CSS.highlights` 的注册表挂在 Document 上，实测可用（`::highlight()` 规则注入页面即可）。不支持的浏览器上标记仍可用，只是不上色。

**复制由卡片接管，而不是让浏览器做。** 卡片打开时把焦点放进批注框，而 Chromium 在聚焦文本控件时会折叠页面选区——实测 `focus()` 之后 `window.getSelection()` 的引文变成空、`collapsed: true`。于是浏览器原生的 `Cmd/Ctrl+C` 复制的是空输入框，而不是刚选中的段落。卡片本来就持有选区原文，所以 `Cmd/Ctrl+C` 和「复制」按钮都直接写剪贴板；如果读者在草稿里选了自己的字，就把这次按键交还给浏览器。没有选择「打开卡片时不聚焦」：选中后直接写是这个扩展的主流程，用失去它来换原生复制不划算。

**没有构建步骤。** 卡片是原生 DOM，不是 React；四个 content script 按顺序加载，共享 `globalThis` 上的三个命名空间。代价是没有类型检查，收益是改一行刷新页面就能看到——对一个要跟随宿主改版的小扩展，这个交换是值的。

## 已知边界

- 页面刷新会清空草稿，但已交付的标记仍记着「已填入」。此时点它取消标记只会移除标记，不会假装撤回过什么。没有做「重新填入」，因为无法区分「草稿丢了」和「消息已经发出」。
- 流式回答期间做的批注，如果在回答结束后引文已经不在正文里（模型改写了那句话），标记会保留但不再上色。
- 只覆盖对话正文与输入框；分享页、侧边栏、设置面板不参与。
- 标记按浏览器会话存在 `localStorage`，换浏览器或清站点数据会丢。
