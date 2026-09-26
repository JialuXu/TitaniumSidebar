# 自动化测试

`extension/core/` 的零依赖自动化测试。只用 Node 自带的 `node:test` 与 `node:assert`：没有 `package.json`，也不用 `npm install`。`tests/` 不属于扩展本身，加载扩展时不会用到它。

## 运行

需要 **Node.js ≥ 22.7**（`extension/` 下的 `.js` 是 ES Module，但没有 `package.json` 声明 `"type": "module"`；从 22.7 起 Node 会自动识别）。

```sh
# 在仓库根目录
node --test "tests/**/*.test.mjs"

# 只跑一个文件 / 只跑名字匹配的用例
node --test tests/unit/llm-client.test.mjs
node --test --test-name-pattern="第 29 条" "tests/**/*.test.mjs"
```

glob 要加引号，由 Node 自己展开，Windows 下也能用。每次推送到 `main` 和每个 PR 都会由 `.github/workflows/test.yml` 自动跑一遍。

## 目录

```
tests/
├── helpers/                 替身与路径，不含断言
│   ├── core.mjs             extension/ 路径的唯一入口（静态检查读源码时用）
│   ├── fake-llm.mjs         假的 OpenAI 兼容接口：替换 fetch，按分片吐 SSE
│   └── memory-storage.mjs   内存版 storage（get / set / remove），可模拟配额满
├── unit/                    core 各模块的行为测试，一个模块一个文件，与模块同名
│   └── <模块名>.test.mjs
└── contracts/               仓库硬性约束的静态检查（读源码，不跑业务逻辑）
    ├── core-boundary.test.mjs   core 不调 chrome.*、只 import core 内部模块、注入函数自包含
    ├── i18n-catalog.test.mjs    中英两套 key 与占位符一致、代码与 HTML 里用到的 key 都有定义
    └── release.test.mjs         manifest / SECURITY.md / bug 报告模板的版本号一致、权限最小
```

## 覆盖范围

| 覆盖到的 | 仍靠手动验收（[docs/acceptance.md](../docs/acceptance.md)） |
|---|---|
| 回合编排（tool 链配对、400 降级、同批跳转中止、轮数上限、中止占位、截图跟随消息）、重新生成前的回退、流式解析与错误分类、脱敏、引用校验、页面同步与差异、请求链组装与压缩、上下文估算、历史淘汰、设置迁移与导入导出、Markdown 渲染、工具分发的闸门与预算、提示词拼装、技能匹配、活动行文案 | 外壳 `sidepanel.js`（界面渲染、`chrome.*` 接线与 provider）；注入页面的函数在真实 DOM 里的行为（`snapshot.js`、`actions.js`、`highlight.js`、`settle.js`）；截图标注（`annotate.js`，依赖 `OffscreenCanvas`）；真实模型接口的表现 |

对应验收标准的用例，名字里写了「第 N 条」，可以用 `--test-name-pattern` 单独跑。

## 写测试的约定

- **测试代码只放在 `tests/`**，不往 `extension/` 里加任何测试专用的导出或分支。需要读未导出的内容时读源码（参考 `contracts/i18n-catalog.test.mjs` 的做法）。
- 文件名用 `.test.mjs`，被 `node --test` 自动发现；`helpers/` 里的文件不带 `.test`，不会被当成测试跑。
- `unit/` 用静态 `import '../../extension/core/<模块>.js'`，改了模块的行为就在同名测试文件里补用例。
- 语言是模块级单例：用到文案的测试文件在 `beforeEach` 里 `setLocale('zh')`，断言文案时用 `t('key')` 生成期望值，不要抄写整句文案。
- 不连任何真实网络：接口一律用 `helpers/fake-llm.mjs`，存储一律用 `helpers/memory-storage.mjs`。
- 注释用中文，与代码库一致。

---

# Automated tests

Zero-dependency tests for `extension/core/`, built only on Node's own `node:test` and `node:assert` — no `package.json`, no `npm install`. `tests/` is not part of the extension.

Run from the repo root with **Node.js ≥ 22.7**:

```sh
node --test "tests/**/*.test.mjs"
```

`unit/` holds one behaviour test file per core module, including the agent loop in `agent.js`; `contracts/` holds static checks of the repository's hard constraints (no `chrome.*` in core, self-contained injected functions, bilingual catalogs in sync, version numbers consistent). The shell, the injected functions' behaviour in a real DOM and real model endpoints are still covered by the manual checklist in [docs/acceptance.md](../docs/acceptance.md). Keep test code inside `tests/` — never add test-only exports or branches to `extension/`.
