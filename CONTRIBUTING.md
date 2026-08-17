# Contributing to Titanium

**English** | [中文](#参与贡献)

Thanks for taking an interest. Titanium is a small, deliberately constrained codebase — the constraints below are not style preferences, they are what keeps the extension installable in a locked-down corporate environment and reusable as an embedded SDK later. Please read them before writing code; a PR that breaks one of them cannot be merged even if the feature is good.

## Before you start

- **Bugs** — open an issue with the bug report template. Include your browser version, the extension version, and whether page actions were on.
- **Features** — open an issue first and let's agree on the shape. Please check the "Out of scope" list below before proposing.
- **Security problems** — do **not** open an issue. See [SECURITY.md](SECURITY.md).
- **Small fixes** (typos, a broken link, an obviously wrong condition) — just send the PR.

## Workflow

`main` is protected: no direct pushes, PR required.

1. Fork the repository and branch off `main`. Name branches `feature/…`, `fix/…` or `docs/…`.
2. Make your change and test it manually (see below).
3. Open a PR against `main` and fill in the template. One logical change per PR — a bug fix and a refactor in the same PR will be sent back for splitting.
4. Commit messages follow the existing history: a short imperative summary, Chinese or English both fine (`修复：…`, `fix: …`). No trailing punctuation, no scope prefixes required.

## Hard constraints

### Zero dependencies, zero build step

Plain HTML/CSS/JS, ES modules, loaded straight from `extension/`. **No npm, no bundler, no transpiler, no external CDN, no third-party library** — including for Markdown rendering, which is hand-written in `core/markdown.js`. The target environment is network-isolated; everything must run offline from local files.

A PR that adds `package.json`, a build script or a vendored library will be declined. If you need something a library provides, write the minimum version of it.

### Manifest V3, Chromium only

Chrome / Edge ≥ 114, ES2020+, no legacy fallback and no polyfills. Firefox and Safari are explicitly out of scope — neither has the MV3 side panel API. Don't add compatibility shims for them.

Adding a new entry to `permissions` needs a strong justification in the PR description; the current set (`sidePanel`, `scripting`, `storage`) is intentionally minimal. `chrome.debugger` will never be added — it shows a permanent "debugging this browser" banner and does not exist in the future SDK form.

### The core / shell split

This is the constraint most PRs get wrong.

**`extension/core/` is platform-independent.** No `chrome.*` anywhere in it, no touching the sidebar's DOM, no assumptions about the runtime. Every module exports pure functions or classes taking and returning plain data. The self-test: *if you deleted the entire extension shell, `core/` should still import and run in an ordinary web page.* That rules out relying on Chromium-only computed properties too — things like `isContentEditable` need an attribute fallback so the code still behaves in a layout-less environment such as jsdom.

**`extension/sidepanel.js` is the shell.** It does exactly three things: render UI and hold state, wire up `chrome.*` APIs, and glue the core modules together. No business logic belongs here. `core/tools.js` defines the tool protocol and dispatch; the actual execution comes in through a provider interface the shell injects.

Config access goes through an injected `storage` interface (`get` / `set`), never `chrome.storage` directly from core.

The reason for all this: the same capabilities will later be packaged as an embedded SDK that in-house systems load with one `<script>` tag. `core/` gets reused verbatim; only the shell is rewritten. (The SDK shell itself is **not** in scope — please don't submit a floating-panel / Shadow DOM version.)

### Injected functions must stay self-contained

`core/snapshot.js`, `search.js`, `highlight.js` and `actions.js` export functions that get serialised whole and injected into the page via `chrome.scripting.executeScript({ func, args })`. Inside those function bodies: **zero module-level references** — no imports, no shared helpers, no constants from the module scope. Return values must be JSON-serialisable; element handles only ever live in the page-side `window.__titanium` (isolated world).

This means some logic — the validation chain, table-to-Markdown conversion — exists twice, in `snapshot.js` and again in `actions.js`. **That duplication is deliberate. Do not refactor it into a shared module.** A PR whose whole point is "de-duplicate the injected helpers" will be declined.

### Bilingual, always, including the model-facing text

No user-facing or model-facing string may be hardcoded anywhere — not in core, not in the shell. Everything lives in the `ZH` / `EN` catalogs in `core/i18n.js` and is read with `t('key')`. **Adding a key means adding it to both catalogs in the same commit.**

"Model-facing" is not a slip: the system prompt (including the sentence telling the model which language to answer in), the `<页面内容>` / `<page_content>` tag names, tool definitions and parameter descriptions, tool results and failure reasons, and page-change summaries all switch with the UI. Otherwise an English UI starts emitting Chinese tool feedback.

Two mechanics to know:

- Static HTML text is marked with `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-aria` and filled in by the shell's `applyStaticI18n`. `data-i18n` writes `textContent`, so a tagged element may contain text only — wrap icons or adjacent labels in their own `<span>`.
- Injected functions can't import i18n. The few strings they need are passed through `args` via `injectedStrings()`, with a Chinese default kept inline as a fallback.

Switching language re-renders static text, the status bar, the **+** menu and the send button immediately. Messages already in the conversation stay in the language they were produced in — don't "fix" that.

### Code style

- **Comments are written in Chinese.** The codebase is consistent about this; please match it.
- Non-trivial logic (SSE parsing, Markdown rendering, table conversion, redaction, quote verification) lives in its own named function or file, with a comment explaining the why.
- CSS colours and spacing go through variables in `sidepanel.css`.
- No dead code, no commented-out blocks, no `console.log` left behind.

## Out of scope

Please don't propose these — they've been decided against:

- **Reading the page automatically** when the sidebar opens or the tab changes. The page is read only when the user sends a message. This is the product's central privacy promise.
- **Any telemetry, analytics or crash reporting.**
- **Mock data, demo modes or simulated business pages.** The extension talks to a real endpoint or it does nothing.
- **Login / SSO / 4A auth, domain allowlists, OCR, RAG.** Covered by other in-bank layers.
- **Firefox support**, and support for data-dense table-heavy systems — those go the structured-data-interface route, not DOM reading.
- **`chrome.debugger`** as an action channel (see above).
- **Technical hard-blocks on irreversible actions.** The guardrail is deliberately a prompt-level one; if you want to propose a real enforcement mechanism, open an issue and let's discuss the design first rather than sending a PR.

## Testing your change

There is no test framework and no CI — verification is manual, so please actually do it and say what you did in the PR.

1. Load `extension/` unpacked in Chrome (`chrome://extensions` → Developer mode → Load unpacked) and reload it after each change.
2. Open DevTools on the side panel itself (right-click inside the panel → Inspect) and check the console is clean. Service worker logs are behind the "service worker" link on the extensions page.
3. Exercise the paths you touched. At minimum, for anything in the perception or action layer: send a first message and confirm the status bar shows title / character count / element count; send a second and confirm the request body does **not** repeat `<页面内容>`; then run whatever tool or action your change affects.
4. If you touched i18n or anything user-facing, check it in **both** languages — switch in the settings drawer and look at the request body in the console too, not just the UI.
5. If you touched `core/`, sanity-check that it still holds the platform-independence rule: no `chrome.` in the diff under `core/`.

```sh
git grep -n "chrome\." extension/core/ | grep -vE ':[0-9]+:\s*(//|\*)'
```

This should print nothing. (The unfiltered grep does match a handful of comments that *mention* `chrome.debugger` or `chrome.tabs` while explaining why core doesn't call them — the filter drops comment lines so only real code shows up.) Worth running before every PR.

## Licence

By contributing you agree your contributions are licensed under the [MIT Licence](LICENSE), same as the project.

---

# 参与贡献

[English](#contributing-to-titanium) | **中文**

感谢关注。Titanium 是一个刻意保持克制的小型代码库 —— 下面这些约束不是代码风格偏好，而是让扩展能在网络隔离的企业环境里装得上、并且将来能原封复用成内嵌 SDK 的前提。动手前请先读一遍；破坏其中任何一条的 PR，哪怕功能本身很好也无法合入。

## 开始之前

- **Bug** —— 用 bug 报告模板开 Issue，请附浏览器版本、扩展版本，以及当时是否开启了页面操作。
- **新功能** —— 先开 Issue 对齐方案。提之前请先看下面的「不在范围内」清单。
- **安全问题** —— **不要**开 Issue，见 [SECURITY.md](SECURITY.md)。
- **小修补**（错别字、失效链接、明显写反的判断）—— 直接发 PR 即可。

## 协作流程

`main` 分支受保护：不能直接推送，必须走 PR。

1. Fork 仓库，从 `main` 切分支，命名用 `feature/…`、`fix/…` 或 `docs/…`。
2. 改完自行手动验证（见下文）。
3. 向 `main` 提 PR 并填写模板。一个 PR 只做一件事 —— 修 bug 顺手重构会被要求拆开。
4. Commit message 沿用现有历史风格：一句祈使式短摘要，中英文均可（`修复：…`、`fix: …`），末尾不加标点，不强制 scope 前缀。

## 硬性约束

### 零依赖、零构建

纯原生 HTML/CSS/JS + ES Module，从 `extension/` 直接加载。**不用 npm、不用打包器、不用转译、不用外部 CDN、不引第三方库** —— 包括 Markdown 渲染，那是 `core/markdown.js` 里手写的。目标环境网络隔离，所有资源必须本地离线可用。

添加 `package.json`、构建脚本或 vendor 进来的库的 PR 会被拒绝。需要某个库的能力时，请自己写最小实现。

### 只做 Manifest V3 + Chromium

Chrome / Edge ≥ 114，ES2020+，不做老浏览器降级、不加 polyfill。火狐与 Safari 明确不在范围内 —— 两者都没有 MV3 侧边栏 API，请不要为它们加兼容层。

新增 `permissions` 条目需要在 PR 描述里给出充分理由，现有的三项（`sidePanel`、`scripting`、`storage`）是刻意压到最小的。`chrome.debugger` 永远不会加 —— 它会在浏览器顶部常驻「正在调试此浏览器」横幅，而且未来的 SDK 形态根本没有这条路。

### core / 外壳分层

这是 PR 里最容易踩错的一条。

**`extension/core/` 是平台无关层。** 里面不出现任何 `chrome.*`，不碰侧边栏的 DOM，不假设运行环境。每个模块用纯函数或类导出，输入输出都是普通数据。自检标准是：*假想删掉整个扩展外壳，`core/` 应该仍能在普通网页里被 import 并跑起来。* 由此推论，也不能依赖只有 Chromium 才有的计算属性 —— 像 `isContentEditable` 这类必须留属性回退，否则在 jsdom 这种没有排版引擎的环境里判定会失效。

**`extension/sidepanel.js` 是外壳。** 它只做三件事：渲染 UI 与维护状态、接线 `chrome.*` API、把 core 模块串起来。业务逻辑一律不写在这里。`core/tools.js` 只定义工具协议与分发，真正的执行靠外壳注入的 provider 接口进来。

配置读写走外壳注入的 `storage` 接口（`get` / `set`），core 里绝不直接碰 `chrome.storage`。

这么分层的原因：同样的能力将来要包装成内嵌 SDK，供行内业务系统一行 `<script>` 接入。届时 `core/` 原封复用，只重写外壳。（SDK 外壳本身**不在**本次范围内，请不要提交悬浮面板 / Shadow DOM 版本。）

### 注入函数必须保持自包含

`core/snapshot.js`、`search.js`、`highlight.js`、`actions.js` 导出的函数会被整体序列化，经 `chrome.scripting.executeScript({ func, args })` 注入页面。这些函数体内：**零模块级引用** —— 不能 import、不能调外部辅助函数、不能用模块作用域的常量。返回值必须 JSON 可序列化；元素句柄只存在于页面侧 isolated world 的 `window.__titanium` 里。

这意味着有些逻辑 —— 校验链、表格转 Markdown —— 在 `snapshot.js` 和 `actions.js` 里各存了一份。**这份重复是刻意为之，不要抽成公共模块。** 以「消除注入函数里的重复代码」为目的的 PR 会被拒绝。

### 双语必须做全，包括发给模型的文案

任何面向用户或面向模型的字符串都不得硬编码 —— core 里不行，外壳里也不行。全部集中在 `core/i18n.js` 的 `ZH` / `EN` 两套目录里，用 `t('key')` 取词。**加一个 key 就要在同一个 commit 里把两套都补上。**

「面向模型」不是口误：system prompt（含「用什么语言作答」那一句）、`<页面内容>` / `<page_content>` 标签名、工具定义与参数说明、工具结果与失败原因、页面变化摘要，全都要跟着界面一起切。否则英文界面下会冒出中文的工具反馈。

两个要点：

- 静态 HTML 文案用 `data-i18n` / `data-i18n-title` / `data-i18n-placeholder` / `data-i18n-aria` 标注，由外壳的 `applyStaticI18n` 写入。`data-i18n` 走 `textContent`，所以被标注的元素内只能有文字 —— 图标、输入框旁的说明文字要单独包 `<span>`。
- 注入函数不能 import i18n，它们需要的少量文案由外壳调 `injectedStrings()` 经 `args` 传入，函数内保留一份中文默认值兜底。

切换语言会立即重渲静态文案、状态条、「+」菜单与发送按钮；**已经生成在消息流里的历史内容保持原语言** —— 那是当时的产物，不要去「修正」它。

### 代码风格

- **注释一律用中文**，代码库在这点上是一致的，请保持。
- 关键逻辑（SSE 解析、Markdown 渲染、表格转换、脱敏、引用校验）拆成独立命名函数或独立文件，并写清楚「为什么这么做」。
- CSS 的配色与间距走 `sidepanel.css` 里的变量。
- 不留死代码、不留注释掉的代码块、不留调试用的 `console.log`。

## 不在范围内

以下都是已经决定不做的，请不要提：

- **自动读取页面** —— 打开侧边栏或切换标签页时自动解读。页面只在用户发送消息时读取，这是产品最核心的隐私承诺。
- **任何埋点、数据分析或崩溃上报。**
- **mock 数据、演示模式、模拟业务系统页面。** 扩展要么连真实接口，要么什么都不做。
- **登录 / SSO / 4A 鉴权、域名白名单、OCR、RAG。** 由行内其他层承担。
- **火狐支持**，以及数据密集型大表格系统的适配 —— 后者走结构化数据接口路线，不走 DOM 读取。
- 把 **`chrome.debugger`** 作为动作执行通道（理由见上）。
- **对不可逆操作做技术硬拦截。** 现在的护栏刻意停在 prompt 层面；如果你想提一套真正的强制机制，请先开 Issue 讨论设计，不要直接发 PR。

## 如何验证你的改动

项目没有测试框架也没有 CI，验证全靠手动 —— 所以请真的做一遍，并在 PR 里写清楚你验了什么。

1. 在 Chrome 里加载已解压的 `extension/`（`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序），每次改完重新加载。
2. 对侧边栏本身开 DevTools（在面板内右键 → 检查），确认控制台干净。service worker 的日志在扩展管理页的「service worker」链接后面。
3. 把你动过的路径跑一遍。涉及感知层或动作层的改动，至少要：发第一条消息，确认状态条出现标题 / 字数 / 元素数；再发第二条，确认请求体里**没有**重复的 `<页面内容>`；然后触发你改动影响到的那个工具或动作。
4. 动了 i18n 或任何面向用户的东西，**两种语言都要看** —— 在设置抽屉里切换，并且不只看界面，也要看控制台里打印的请求体。
5. 动了 `core/`，顺手确认平台无关这条仍然成立：diff 里 `core/` 下不应出现 `chrome.`。

```sh
git grep -n "chrome\." extension/core/ | grep -vE ':[0-9]+:\s*(//|\*)'
```

这条应当无输出。（不加过滤的话会命中几行注释 —— 那些注释是在解释「为什么 core 不调 `chrome.debugger` / `chrome.tabs`」，过滤掉注释行后剩下的才是真代码。）值得在每次提 PR 前跑一次。

## 授权

提交贡献即表示你同意你的贡献以与本项目相同的 [MIT 协议](LICENSE) 授权。
