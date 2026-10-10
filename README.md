# Titanium

**English** | [中文](README.zh-CN.md)

Titanium is a Chrome / Edge sidebar extension that can be opened on any page. When you send a message, the extension reads the current page and passes it to a model **you configure** — DeepSeek, a local Ollama or vLLM deployment, or any OpenAI-compatible endpoint. The API key is stored only in the browser.

![The AI searches Wikipedia, opens a section from the table of contents, and quotes it. Each step appears as an activity line.](docs/media/actions-en.gif)

## Examples

| Prompt | What happens |
|---|---|
| "In this GitHub repository's Settings, update the description and turn Wiki off." | Opens the settings page, changes those fields, and saves. Each action appears in the conversation and can be stopped |
| "Fill in the application form on this page using the details from my previous message." | Locates the fields and fills them in. Page actions must be enabled first |
| "Put the stocks listed on this page into a table, and compare valuation with performance over the past year." | Reads the quotes and figures on the page, organizes them, and compares them. Quoted numbers match the page |

## Install

1. Clone this repository.
2. Open `chrome://extensions` (Edge: `edge://extensions`), turn on **Developer mode**, choose **Load unpacked**, and select the `extension/` directory.
3. Click the toolbar icon.

Chrome 114 or later, or Edge 117 or later, is required. Load that directory. A self-packed `.crx` is rejected with `CRX_REQUIRED_PROOF_MISSING`. For organisation-wide deployment, use the enterprise policy `ExtensionInstallForcelist`, or publish an unlisted listing in the extension store.

## Configure the model

Click the gear icon, open **Model endpoints**, run **Test connection**, then save.

| | DeepSeek | Local or self-hosted |
|---|---|---|
| Endpoint | `https://api.deepseek.com/v1` | `http://localhost:11434/v1` |
| Model | `deepseek-flash` (V4.1-Flash) | `qwen3.8:27b` (Qwen3.8 27B) |
| Key | [DeepSeek platform](https://platform.deepseek.com) | Leave blank if the service requires no authentication |

The endpoint should end with `/v1`. The extension appends `/chat/completions`. A 404 from the connection test usually means `/v1` is missing.

**+** adds another endpoint. The endpoint selected in the dropdown is the one in use. **Model supports vision** (enables screenshots; screenshots are not redacted) and the context window are stored with each endpoint.

**Export settings** before uninstalling the extension. The file is `titanium-settings.json`, and the API keys in it are plain text. **Import settings** restores it in full. The file does not include the page-actions switch; enable that separately. After a code change, click **Reload** on the extensions page. Saved settings are kept.

## Usage

- **The page is read when you send a message.** Unchanged content is not sent again. A small change, such as paging through a table or expanding a section, is sent as a short diff. A new URL is sent in full. The page chip at the top left shows what was captured; click it to view the text.
- **If the page is still loading,** the extension waits about 2.5 seconds. If the page is still changing, it reads anyway and tells the model. "Loading" and "No data" are not treated as conclusions.
- **Content beyond the first 12,000 characters** is reached by search, then by reading at a position. Each step appears as a line and folds into "Ran N steps" when the answer is complete. An endpoint without tool calling falls back to plain text automatically.
- **"From this page"** appears only when a quotation matches the captured text exactly. Passages read back by position are included in that check.
- **Phone numbers, national ID numbers, and bank card numbers** are masked before the request is sent. Screenshots are not masked.
- **Conversation history is stored on this machine,** up to 50 conversations or 80% of the storage quota. When the limit is exceeded, the oldest records are removed first. If a conversation cannot be saved, the chat shows a notice. Use the history button to restore a conversation and continue.
- **`/compact`** turns earlier turns into a summary for later requests. The text on screen stays as it is. You may add an instruction, for example `/compact keep the financial figures`. Use it before the context grows too long. If an ordinary request has already failed because of length, the summary request fails as well, and the remaining option is **New chat**. A reminder appears at about 70% of the window and again at about 85%. The **+** menu shows the current share. Set **Context window** on each endpoint (`128k`; blank means 64k). The estimate starts from character counts and adjusts when the endpoint reports token usage.
- **Some pages cannot be read,** including `chrome://` and the extension store. Same-origin frames, including `srcdoc` and legacy framesets, are part of the page. Cross-origin frames are counted only; their content is not added to the context.
- Enter sends. Shift+Enter inserts a line break. You can stop generation at any time. Hover a reply to copy it or regenerate it.

## Skills

A skill is a set of instructions for the current conversation. It does not run code. Open **+** and choose **Attach a Skill**. On a matching finance site, a suggestion bar appears; it uses only the tab URL. The active skill is shown above the input and can be removed.

- **Table to CSV** — extracts the full table, with figures as printed, as a downloadable `.csv`
- **Financial statements** — identifies the statements and the reporting period, gives the formula for each ratio, and keeps figures from the page separate from derived figures
- **Market digest** — explains the market data on the page, makes no forecast, and ends every reply with a fixed disclaimer

Quote pages suggest Market digest. Disclosure sites suggest Financial statements.

## Page actions

This is off by default. Turn on **Allow page actions** in settings, or **Page actions** in the **+** menu. Both control the same switch. The first time, confirmation is required.

Once enabled, the model can click, type, select, press keys, scroll, navigate, and open or close tabs. Each action appears as a line in the conversation. **Stop** skips actions that have not yet run. Transfers, payments, orders, approval submissions, and deletions are explained first and wait for explicit agreement. That requirement is part of the prompt. While the switch is off, the model cannot call these tools.

After each action, the extension waits for the page to settle, for up to 5 seconds.

The **debugger channel** is also off by default. Clicks, key presses, and typing are sent through `chrome.debugger` as real input, and the extension waits for the network requests that action started. During the turn, Chrome shows "started debugging this browser". If the debugger cannot attach, or a real click might hit a different element, that step uses a synthetic event instead, and the result says so.

Without the debugger channel, actions are synthetic events (`isTrusted` is false), and a few sites ignore them. Load detection is based on the page content, so a slow response may still be read before the page has filled in. Ask the model to wait and look again. A custom dropdown must be opened before an option can be chosen. Leave page actions disabled for data that should not be changed.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `CRX_REQUIRED_PROOF_MISSING` | Load the unpacked `extension/` directory. A self-packed `.crx` cannot be installed |
| The sidebar does not open | Confirm Chrome 114+ or Edge 117+. Check `chrome://version` |
| Settings are missing after reinstall | Uninstalling clears extension storage. Export before uninstalling and import afterwards. For code changes, use **Reload** |
| 401 | Check the API key |
| 404 | Confirm that the endpoint ends with `/v1` |
| Network failure | The endpoint is unreachable. Confirm that the local service is running |
| Degraded: no tool calling or image input | Expected. The current model does not have that capability |
| "Tab switched" | The tab changed during the conversation. Return to the original page, or ask again about the current one |
| Clicks and typing have no effect | Turn on the debugger channel, or ask the model to list the elements again |

## Further information

[Contributing](CONTRIBUTING.md) · [Code of conduct](CODE_OF_CONDUCT.md) · [Security](SECURITY.md) · [MIT](LICENSE)

Contributions follow these constraints: no dependencies and no build step, `core/` does not call `chrome.*`, injected functions stay self-contained, and user-facing and model-facing text lives in `core/i18n.js` in both languages. The `main` branch is protected: fork the repository, then open a PR.

Report vulnerabilities through the [Security tab](https://github.com/JialuXu/TitaniumSidebar/security/advisories/new), not in a public issue. Limited regex redaction, screenshots that are not redacted, and prompt-level confirmation for irreversible actions are described in the security policy.

---

Titanium · Design by Xujl
