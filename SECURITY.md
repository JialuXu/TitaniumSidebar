# Security Policy

**English** | [中文](#安全策略)

## Supported versions

Titanium ships as an unpacked extension loaded from this repository. Only the tip of `main` receives security fixes; older tags are not patched.

| Version | Supported |
|---|---|
| `main` (currently 0.3.x) | ✅ |
| Anything older | ❌ — pull the latest `main` and reload the unpacked extension |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub: go to the [**Security** tab](https://github.com/JialuXu/TitaniumSidebar/security/advisories/new) → **Report a vulnerability**. This opens a private advisory draft that only you and the maintainer can see; we can discuss the fix there and publish an advisory once it is out.

What helps:

- The affected file and function (`extension/core/…` or `extension/sidepanel.js`)
- A concrete reproduction: a page that triggers it, the exact prompt, and what the model or the extension then did
- What an attacker gains — page content leaked to a third party, an action performed the user never approved, code executing in the sidebar, and so on
- Your browser and version, and whether **Allow page actions** was on

**Never include real API keys, real personal data or screenshots of live banking / internal systems in a report.** Reproduce with dummy values.

Expect a first response within about a week. This is a personal side project, not a staffed product — there is no formal SLA, but reports are read and taken seriously.

## Scope

### In scope

- XSS or script execution in the sidebar (the Markdown renderer escapes HTML before rendering — a bypass is a real bug)
- Redaction bypass: content matching the masker's patterns reaching the network unmasked
- Anything that causes a page action to fire without the user having enabled **Allow page actions**
- Acting on the wrong target: `ref` / session / tab-id confusion that makes an action hit an element or tab the user was not looking at
- Leaking the API key or captured page content anywhere other than the endpoint the user configured
- Escapes from the injected functions into the host page's privileged context, or pollution of host page globals beyond `window.__titanium` in the isolated world

### Out of scope — known, documented and accepted by design

These are properties of the design, not defects. They are listed so you do not spend time on them:

- **`host_permissions: ["<all_urls>"]`.** The extension is meant to work on any page; the breadth is the feature. It also covers `captureVisibleTab` and lets the extension context call the configured endpoint without CORS.
- **Page content and your API key go to the endpoint you configured.** That is the product. The extension has no telemetry, no analytics and no server of its own; the key lives in `chrome.storage.local` in plaintext, protected only by your browser profile.
- **Redaction is regex best-effort, not a security control.** It catches common Chinese ID, bank card and mobile-number shapes. Other formats pass through. **Screenshots are never redacted** — the setting says so next to the toggle.
- **Prompt injection from page content.** The system prompt tells the model to treat page text as reference material and ignore instructions inside it. That is mitigation, not enforcement; a sufficiently crafted page can still steer the model. If you find an injection that survives *and* produces a side effect the user did not approve, that part **is** in scope — report it.
- **Guardrails on irreversible operations are behavioural.** Transfers, payments, orders, approvals, deletions and outbound sends are held back by system-prompt instructions asking the model to explain and wait for consent. There is no technical block. This is an explicit trust boundary of this build; the in-bank production path adds audit trails and step-up authorisation.
- **Synthetic events have `isTrusted === false`.** Deliberate — `chrome.debugger` is not used. Sites that ignore untrusted events are a limitation, not a vulnerability.
- **No authentication, no domain allowlist, no audit log.** Out of scope by design; see the README's "How this differs from an in-bank production build".
- **Self-packed `.crx` is rejected by Chrome** (`CRX_REQUIRED_PROOF_MISSING`). Expected behaviour, not a bug.

## Notes for users

- Treat your endpoint as a party that sees whatever page you ask about. Do not point Titanium at a page you would not paste into that endpoint's chat box.
- Keep **Allow page actions** off unless you are actively using it, and never leave it on while working in a system where a stray click has consequences.
- Quotes without the "from this page" badge were **not** verified against the captured text. Do not trust them as page originals.

---

# 安全策略

[English](#security-policy) | **中文**

## 支持的版本

Titanium 以「加载已解压的扩展程序」方式从本仓库直接运行。安全修复只跟随 `main` 分支最新提交，历史 tag 不回补。

| 版本 | 是否支持 |
|---|---|
| `main`（当前 0.3.x） | ✅ |
| 更早的版本 | ❌ —— 请拉取最新 `main` 并重新加载扩展 |

## 如何报告漏洞

**安全问题请不要开公开 Issue。**

走 GitHub 私密通道：进入 [**Security** 标签页](https://github.com/JialuXu/TitaniumSidebar/security/advisories/new) → **Report a vulnerability**。这会创建一份只有你和维护者可见的私密 advisory 草稿，可以在里面讨论修复方案，修好后再公开披露。

请尽量说明：

- 涉及哪个文件、哪个函数（`extension/core/…` 或 `extension/sidepanel.js`）
- 可复现的具体路径：什么页面能触发、原话提示词是什么、模型或扩展随后做了什么
- 攻击者能拿到什么 —— 页面内容外泄给第三方、执行了用户没同意的动作、在侧边栏里跑起了代码，等等
- 你的浏览器与版本号，以及当时**「允许页面操作」是否开启**

**报告里请勿附带真实 API Key、真实个人信息，或真实银行 / 内部系统的截图。** 请用假数据复现。

首次回复通常在一周内。这是个人项目而非有专职团队的产品，没有正式 SLA，但每份报告都会认真看。

## 范围

### 属于漏洞

- 侧边栏内的 XSS 或脚本执行（Markdown 渲染前会整体 HTML 转义 —— 能绕过就是真 bug）
- 脱敏绕过：命中脱敏规则的内容仍以明文发出
- 在**未开启「允许页面操作」**的情况下触发了页面动作
- 作用对象错乱：`ref` / session / tabId 判定失误，导致动作落到用户并没在看的元素或标签页上
- API Key 或已读取的页面内容流向用户配置的接口**之外**的任何地方
- 注入函数逃逸到宿主页面的特权上下文，或在 isolated world 的 `window.__titanium` 之外污染宿主页面全局

### 不属于漏洞 —— 设计使然，已知并接受

以下是设计取舍而非缺陷，列出来是为了不让你白花时间：

- **`host_permissions: ["<all_urls>"]`。** 扩展的定位就是在任意网页可用，权限范围宽是功能本身；它同时覆盖 `captureVisibleTab`，并让扩展上下文调用接口不受 CORS 限制。
- **页面内容与 API Key 会发往你自己配置的接口。** 这就是产品本身。扩展没有埋点、没有分析、没有自己的服务端；Key 明文存在 `chrome.storage.local`，安全性等同于你的浏览器用户配置。
- **脱敏是正则尽力而为，不是安全控制。** 它覆盖常见的身份证、银行卡、手机号形态，其他格式会漏。**截图完全不脱敏** —— 设置项旁的灰字已明示。
- **来自页面内容的提示词注入。** system prompt 已要求模型把页面文字当参考资料、忽略其中的指令性文字。这是缓解而非强制，精心构造的页面仍可能带偏模型。但如果你找到一条注入**既能突破，又产生了用户未同意的副作用**，那部分**属于**漏洞，请报告。
- **不可逆操作的护栏是行为约束。** 转账、支付、下单、提交审批、删除、对外发送，靠的是 system prompt 要求模型先说明后果、等待用户明确同意，没有技术层面的硬拦截。这是本版本明确的信任边界；行内生产版会补上审计留痕与二次授权。
- **合成事件的 `isTrusted` 为 false。** 刻意为之 —— 本项目不使用 `chrome.debugger`。少数站点据此忽略事件属于已知限制，不是漏洞。
- **无鉴权、无域名白名单、无审计日志。** 按设计不在本版本范围，见 README 的「与行内生产版的差异」。
- **自行打包的 `.crx` 被 Chrome 拒绝**（`CRX_REQUIRED_PROOF_MISSING`）。这是预期行为。

## 给使用者的提醒

- 把你配置的接口视作「能看到你所提问页面」的一方。不愿意粘贴进那个接口聊天框的页面，就不要让 Titanium 去读。
- 不用的时候把**「允许页面操作」**关掉；在误点一下就会有后果的系统里，绝不要让它长期开着。
- 没有「来自当前页面」徽标的引用块**未经**原文校验，不要当作页面原话采信。
