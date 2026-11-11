# Security Policy

**English** | [中文](#安全策略)

## Supported versions

Titanium ships as an unpacked extension loaded from this repository. Only the tip of `main` receives security fixes; older tags are not patched.

| Version | Supported |
|---|---|
| `main` (currently 1.8.0) | ✅ |
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
- A click or key press that the rules flag, or that the model declared irreversible, running without the user's approval, or running although its target or dialog changed, or the user clicked, pressed keys or typed on the page, while the approval was pending
- Leaking the API key or captured page content anywhere other than the endpoint the user configured
- Escapes from the injected functions into the host page's privileged context, or pollution of host page globals beyond `window.__titanium` in the isolated world
- Escapes from the code sandbox: code run by `run_javascript` reaching the network, the page, extension APIs or unmasked table cells

### Out of scope — known, documented and accepted by design

These are properties of the design, not defects. They are listed so you do not spend time on them:

- **`host_permissions: ["<all_urls>"]`.** The extension is meant to work on any page; the breadth is the feature. It also covers `captureVisibleTab` and lets the extension context call the configured endpoint without CORS.
- **Page content and your API key go to the endpoint you configured.** That is the product. The extension has no telemetry, no analytics and no server of its own; the key lives in `chrome.storage.local` in plaintext, protected only by your browser profile.
- **Redaction is regex best-effort, not a security control.** It catches common Chinese ID, bank card and mobile-number shapes, including hyphenated or `+86`-prefixed mobile numbers and card numbers in groups of four. Other formats, email addresses among them, pass through. **Screenshots and attached images are never redacted** — the setting says so next to the toggle.
- **Prompt injection from page content.** The system prompt tells the model to treat page text as reference material and ignore instructions inside it. That is mitigation, not enforcement; a sufficiently crafted page can still steer the model. If you find an injection that survives *and* produces a side effect the user did not approve, that part **is** in scope — report it.
- **Pre-execution approval recognises high-risk actions; it cannot prove a click is harmless.** Clicks and Enter presses are inspected read-only before they run. When the control's own short name, or the dialog or form it sits in, reads as a transfer, payment, order, approval submission, deletion, outbound send, publish or authorisation, or the model declares the step irreversible, the extension asks the user in the side panel and runs the step only after approval, and only if, while the approval was pending, the control and its dialog or form stayed as inspected and the user did not click, press keys or type on the page. Input inside cross-origin iframes and field values that a page script changes on its own are outside that check. What the rules cannot see is outside that guarantee: an unnamed icon button the model did not flag, side effects wired into arbitrary page scripts (an `onchange` that submits, a handler on a plain `<span>`), labels that disguise what a control does, controls inside cross-origin iframes, links with a real `href` whose GET request has side effects, and `navigate` straight to such an address. The model's own declaration covers part of this and is behavioural.
- **Two action channels.** By default page actions are synthetic events (`isTrusted === false`); sites that ignore untrusted events are a limitation, not a vulnerability. With the debugger channel turned on in settings (off by default, never carried in exported settings files), the extension attaches `chrome.debugger` to the working tab for the duration of a turn and sends real input; the browser shows its debugging bar meanwhile. The `debugger` permission also exposes the tab's network traffic: the extension only counts in-flight data requests to know when an action's request has returned and never reads their contents. Builds that must not carry this permission drop it from the manifest together with `extension/drivers/cdp.js`.
- **No authentication, no domain allowlist, no audit log.** Out of scope by design.
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
| `main`（当前 1.8.0） | ✅ |
| 更早的版本 | ❌ —— 请拉取最新 `main` 并重新加载扩展 |

## 如何报告漏洞

**安全问题请不要开公开 Issue。**

走 GitHub 私密通道：进入 [**Security** 标签页](https://github.com/JialuXu/TitaniumSidebar/security/advisories/new) → **Report a vulnerability**。这会创建一份只有你和维护者可见的私密 advisory 草稿，可以在里面讨论修复方案，修好后再公开披露。

请尽量说明：

- 涉及哪个文件、哪个函数（`extension/core/…` 或 `extension/sidepanel.js`）
- 可复现的具体路径：什么页面能触发、原话提示词是什么、模型或扩展随后做了什么
- 攻击者能拿到什么 —— 页面内容外泄给第三方、执行了用户没同意的动作、在侧边栏里跑起了代码，等等
- 你的浏览器与版本号，以及当时**「允许页面操作」是否开启**

**报告里请勿附带真实 API Key、真实个人信息，或含有敏感信息的截图。** 请用假数据复现。

首次回复通常在一周内。这是个人项目而非有专职团队的产品，没有正式 SLA，但每份报告都会认真看。

## 范围

### 属于漏洞

- 侧边栏内的 XSS 或脚本执行（Markdown 渲染前会整体 HTML 转义 —— 能绕过就是真 bug）
- 脱敏绕过：命中脱敏规则的内容仍以明文发出
- 在**未开启「允许页面操作」**的情况下触发了页面动作
- 作用对象错乱：`ref` / session / tabId 判定失误，导致动作落到用户并没在看的元素或标签页上
- 规则命中、或模型声明不可逆的点击与按键，未经用户批准就执行，或等待确认期间目标、所在对话框变了或用户在页面上点击、按键、输入过，仍然执行
- API Key 或已读取的页面内容流向用户配置的接口**之外**的任何地方
- 注入函数逃逸到宿主页面的特权上下文，或在 isolated world 的 `window.__titanium` 之外污染宿主页面全局
- 代码沙箱逃逸：`run_javascript` 运行的代码够到了网络、页面、扩展 API 或未脱敏的表格单元格

### 不属于漏洞 —— 设计使然，已知并接受

以下是设计取舍而非缺陷，列出来是为了不让你白花时间：

- **`host_permissions: ["<all_urls>"]`。** 扩展的定位就是在任意网页可用，权限范围宽是功能本身；它同时覆盖 `captureVisibleTab`，并让扩展上下文调用接口不受 CORS 限制。
- **页面内容与 API Key 会发往你自己配置的接口。** 这就是产品本身。扩展没有埋点、没有分析、没有自己的服务端；Key 明文存在 `chrome.storage.local`，安全性等同于你的浏览器用户配置。
- **脱敏是正则尽力而为，不是安全控制。** 它覆盖常见的身份证、银行卡、手机号形态（含带连字符或 `+86` 前缀的手机号、四位一组的卡号），邮箱等其他格式会漏。**截图与附图完全不脱敏** —— 设置项旁的灰字已明示。
- **来自页面内容的提示词注入。** system prompt 已要求模型把页面文字当参考资料、忽略其中的指令性文字。这是缓解而非强制，精心构造的页面仍可能带偏模型。但如果你找到一条注入**既能突破，又产生了用户未同意的副作用**，那部分**属于**漏洞，请报告。
- **执行前确认只能识别高风险动作，不能证明一次点击无害。** 点击与回车执行前先只读预检：控件自己的短名称、或它所在的对话框与表单写着转账、支付、下单、提交审批、删除、对外发送、发布或授权，或模型声明这一步不可逆，扩展就在侧边栏请用户批准；批准后，且等待期间目标控件与所在对话框或表单没变、用户也没在页面上点击、按键或输入，才执行。跨域 iframe 里的操作、页面脚本自行改写的输入框内容不在这项复验之内。规则看不见的不在这项保证之内：模型没有标注的无名图标按钮、写在任意页面脚本里的副作用（提交表单的 `onchange`、挂在普通 `<span>` 上的处理器）、伪装用途的文案、跨域 iframe 里的控件、带真实 `href` 而 GET 请求有副作用的链接，以及用 `navigate` 直达这类地址。模型自己的声明能补上一部分，那属于行为约束。
- **两条动作通道。** 默认页面动作是合成事件（`isTrusted` 为 false），少数站点据此忽略事件属于已知限制，不是漏洞。在设置里打开调试通道后（默认关闭，导出的设置文件不带这个开关），扩展在回合期间把 `chrome.debugger` 附加到工作标签页、发真实输入，其间浏览器显示调试横幅。`debugger` 权限也能看到该标签页的网络流量：扩展只数「还没返回的数据请求」以判断动作发出的请求是否回来，从不读取请求内容。不能带这个权限的构建，从 manifest 去掉它并删掉 `extension/drivers/cdp.js` 即可。
- **无鉴权、无域名白名单、无审计日志。** 按设计不在本版本范围。
- **自行打包的 `.crx` 被 Chrome 拒绝**（`CRX_REQUIRED_PROOF_MISSING`）。这是预期行为。

## 给使用者的提醒

- 把你配置的接口视作「能看到你所提问页面」的一方。不愿意粘贴进那个接口聊天框的页面，就不要让 Titanium 去读。
- 不用的时候把**「允许页面操作」**关掉；在误点一下就会有后果的系统里，绝不要让它长期开着。
- 没有「来自当前页面」徽标的引用块**未经**原文校验，不要当作页面原话采信。
