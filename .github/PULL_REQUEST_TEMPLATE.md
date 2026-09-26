<!--
提 PR 前请先读 CONTRIBUTING.md 的「硬性约束」一节。
Please read the "Hard constraints" section of CONTRIBUTING.md before opening a PR.
-->

## 改了什么 / What changed

<!-- 一两句说明。关联 Issue 请写 Closes #123 / One or two sentences. Link issues with "Closes #123". -->

## 为什么 / Why

<!-- 解决的问题或场景 / The problem or the situation this addresses -->

## 怎么验证的 / How it was verified

<!--
CI 只跑 core/ 的自动化测试；外壳与页面上的行为仍需手动验证，请写清楚你实际跑了什么。
CI only runs the automated tests for core/ — the shell and on-page behaviour still need a manual pass. Say what you actually ran.
-->

- 浏览器与版本 / Browser and version:
- 验证步骤 / Steps taken:

## 自检 / Checklist

- [ ] `node --test "tests/**/*.test.mjs"` 全部通过；改了 core 行为的，在 `tests/unit/` 补了或更新了用例 / All tests pass; core behaviour changes come with new or updated cases in `tests/unit/`
- [ ] 没有引入 npm 包、构建步骤或外部 CDN 资源 / No npm packages, build step or external CDN resources
- [ ] `core/` 里没有新增 `chrome.*` 调用 —— `git grep -n "chrome\." extension/core/ | grep -vE ':[0-9]+:\s*(//|\*)'` 无输出 / No new `chrome.*` calls in `core/` — the filtered grep prints nothing
- [ ] 改动过的注入函数仍然完全自包含（函数体内零模块级引用，返回值 JSON 可序列化）/ Injected functions I touched are still fully self-contained
- [ ] 新增的面向用户或面向模型的文案都进了 `core/i18n.js`，且 `ZH` / `EN` 两套**都**补齐了 / All new user-facing and model-facing strings go through `core/i18n.js`, with **both** catalogs updated
- [ ] 中英两种语言下都实际看过效果（界面 + 控制台里的请求体）/ Verified in both languages (UI and the request body in the console)
- [ ] 注释用中文，没留调试 `console.log` 或注释掉的死代码 / Comments in Chinese, no leftover debug logs or commented-out code
- [ ] 没有新增 `manifest.json` 的权限；若有，已在上文说明理由 / No new `manifest.json` permissions, or justified above

<!-- 涉及页面动作或权限变更的 PR，请额外说明它对用户的风险边界有什么影响。
     If this PR touches page actions or permissions, also describe how it shifts the risk boundary for users. -->
