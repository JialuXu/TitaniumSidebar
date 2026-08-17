# Titanium — AI Sidebar for the Web

**English** | [中文](README.zh-CN.md)

A lightweight Chrome / Edge extension: open a sidebar on any web page and chat with an AI about it. When you send a message, the extension reads the text of the current page and passes it along as context, so the AI answers with the page in hand.

- **Bring your own model** — any OpenAI-compatible endpoint (DeepSeek, self-hosted Ollama / vLLM, …); your API key never leaves your browser
- **Reads the page only on demand** — captured when you send a message; opening the sidebar fires no requests
- **Hybrid perception** — page text plus a structural outline by default, and the model can call tools as needed: full-text search, interactive element list, highlight on page, full table extraction, element HTML inspection, viewport screenshots (optional, needs a vision model)
- **Page actions** (off by default) — once enabled the AI can click, type, select, press keys, scroll, navigate and manage tabs
- **Redaction before sending** — phone numbers, national ID numbers and bank card numbers are masked by default (screenshots excepted)
- **Verifiable quotes** — a passage only earns the "from this page" badge if it matches the captured page text verbatim
- **Fully bilingual (English / 简体中文)** — interface, system prompt, tool text and the AI's answer language switch together; picked from your browser language on first run, changeable in settings
- **Zero dependencies** — plain HTML/CSS/JS, no build step, no third-party libraries, no CDN; installs and runs fully offline

## Installation

1. Download or clone this repository
2. Open `chrome://extensions` or `edge://extensions` and turn on **Developer mode** in the top-right corner
3. Click **Load unpacked** and select this repository's `extension/` directory
4. Click the extension icon in the toolbar to open the sidebar

> Load the **unpacked** `extension/` directory. Do not use "Pack extension" and then drag the resulting `.crx` in — Chrome only accepts CRX files signed by the Web Store and rejects self-packed ones with `CRX_REQUIRED_PROOF_MISSING`. To roll the extension out across an organisation, force-install it through enterprise policy (`ExtensionInstallForcelist` pointing at a self-hosted update manifest) or publish it to the store as unlisted; policy-installed extensions skip that signature check.

### Browser support

| Browser | Requirement |
|---|---|
| Chrome / Chromium | **114 or newer.** The `chrome.sidePanel` API arrived in 114; the manifest declares `minimum_chrome_version: 114`, so older builds refuse to install. |
| Microsoft Edge | **117 or newer recommended.** Edge rolled the sidebar API out to stable in stages from 115 onwards; on 114–116 the extension may install yet never show a panel. |
| Firefox / Safari | Not supported. Neither offers the Manifest V3 side panel API, and Firefox is out of scope by design. |

The extension is Manifest V3 only and uses ES2020+ with no build step or transpilation — there is no legacy fallback path. Check your build under `chrome://version` or `edge://version`.

## Configuration

Click the gear icon in the top-right of the sidebar, fill in the endpoint, model name and API key, optionally hit **Test connection**, then save.

| Setting | DeepSeek official API | Self-hosted (Ollama / vLLM, …) |
|---|---|---|
| Endpoint (baseUrl) | `https://api.deepseek.com/v1` | e.g. `http://localhost:11434/v1` |
| Model name | `deepseek-chat` | whatever you deployed, e.g. `qwen2.5:14b` |
| API key | create one at the [DeepSeek platform](https://platform.deepseek.com) | leave empty if the service needs no auth |

> The baseUrl usually has to end with `/v1` — the extension appends `/chat/completions` to it. Check this first if the connection test returns 404.

The settings drawer also holds: language (applies immediately), redaction before sending, "model supports vision" (enables the screenshot tool — note screenshots are not redacted), and "allow page actions". The extension contains no analytics or telemetry; page content goes only to the endpoint you configured, and your settings and key live solely in `chrome.storage.local`.

## Usage

- **When the page is read** — the current page is captured when you send your *first* message; the status bar then shows "Read: {page title} · {N} characters · {M} interactive elements". Later messages in the same conversation do not re-read it. Click the status bar to inspect exactly what was captured.
- **Re-read** — after the page changes (for example an in-app navigation), click **Re-read** and your next message will carry the new content.
- **Perception tools** — the model calls them on its own and the sidebar shows a live activity line for each. Ask "where is X on this page" and the AI draws a highlight box for three seconds; ask it to "extract table N in full" and you get the whole table, free of the body-text truncation limit. Requires an endpoint that supports function calling (DeepSeek and most gateways do); if it does not, the extension falls back to plain text.
- **Source badge** — a blockquote gets the "from this page" badge only if it matches the captured page text verbatim. Treat quotes without a badge with suspicion.
- **Shortcuts** — Enter sends, Shift+Enter inserts a newline; streaming replies can be stopped at any time; hover a reply to copy it or regenerate; **New chat** clears the history.
- **Pages that cannot be read** — browser-internal pages (`chrome://`), extension stores and the like are off limits; the AI then answers from your question alone.

## Skills (preset)

A skill is a session-scoped prompt pack — plain instructions, no code — that puts the AI into a specific task mode. Three presets ship with this version:

- **Table to CSV** — transcribes page tables in full into a ` ```csv ` code block, with proper quoting and every figure kept exactly as the page shows it; the block can be copied or downloaded as a .csv file that opens directly in Excel.
- **Financial statements** — identifies the statements and reporting period, shows the formula behind every ratio, and strictly separates figures copied from the page from figures it derived.
- **Market digest** — organises and explains the market data the page shows, never predicts or gives buy/sell advice, and ends every reply with a fixed disclaimer line.

Attach one via the **+** menu → **Attach a Skill**, or from the suggestion bar that appears when you are on a matching finance site (quote pages suggest Market digest, disclosure sites suggest Financial statements). The suggestion bar only reads the tab's URL — it never injects scripts or reads page content. The active skill shows as a removable chip above the input box; it lasts for the current conversation and **New chat** clears it.

## Page actions (off by default)

Enable them with the "Allow page actions" toggle in the settings drawer or "Page actions" in the **+** menu next to the input box (the two are the same switch); the first time you turn it on, you get a risk confirmation. Once enabled the AI does more than look: it can click buttons, fill inputs, pick dropdown options, press Enter, scroll, navigate to a URL and open or close tabs — good for "fill this form with the details above" or "open that page and summarise it".

Every action appears in the conversation as a prominent activity line, and you can hit **Stop** at any point during streaming — pending actions are skipped. For irreversible operations (transfers, payments, orders, approval submissions, deletions) the AI explains what it is about to do and waits for your explicit go-ahead. After a navigation, element numbers reset and the status bar notes that your next message will re-read the page. While the switch is off, action tools are not registered with the model at all.

**Known limitations**: actions are dispatched as synthetic events (`isTrusted` is false), which a handful of strictly validating sites ignore; custom dropdown widgets need the AI to open them and click an option. Do not enable this while working with business data you do not want touched.

## How this differs from an in-bank production build

SSO/4A authentication, a domain allowlist, gateway-side redaction and audit logs, per-system extraction adapters, OCR for scanned documents, and audit trails plus step-up authorisation for page actions — all covered by existing in-bank capabilities and out of scope for this build.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `CRX_REQUIRED_PROOF_MISSING` while installing | You packed the `.crx` yourself; Chrome only accepts store-signed packages. Load the unpacked `extension/` directory, or deploy through enterprise policy |
| Installs fine but no sidebar opens | Your browser is below the version floor — check `chrome://version` (Chrome 114+, Edge 117+) |
| 401 error | Verify the API key |
| 404 error | Check that the baseUrl ends with `/v1` |
| Network failure | Confirm the endpoint is reachable; make sure a local service is actually running |
| "Endpoint does not support tool calling / image input, degraded" | The endpoint or model lacks that capability — this is the normal fallback; switch to one that supports it |
| "Tab switched, please re-read" | You changed tabs mid-conversation; click **Re-read** and continue |
| Clicks / typing have no effect | A few sites ignore synthetic events; the element numbers may also be stale — ask the AI to list the elements again and retry |

## Contributing and security

- **Contributing** — [CONTRIBUTING.md](CONTRIBUTING.md). Read the hard constraints first: zero dependencies and no build step, `core/` stays platform-independent (no `chrome.*`), injected functions stay self-contained, and every user- *and* model-facing string lives in `core/i18n.js` in both languages. `main` is protected, so fork and open a PR.
- **Code of conduct** — [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).
- **Security** — [SECURITY.md](SECURITY.md). Report vulnerabilities privately through the [Security tab](https://github.com/JialuXu/TitaniumSidebar/security/advisories/new), never in a public issue. It also spells out what is *not* a vulnerability here: redaction is regex best-effort, screenshots are never redacted, and the guardrail on irreversible actions is a prompt-level one, not a technical block.
- **Licence** — [MIT](LICENSE).

---

Titanium · Design by Xujl
