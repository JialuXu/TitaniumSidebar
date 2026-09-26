// 约束：发版时各处版本号一致（manifest、SECURITY.md 中英两处、bug 报告模板）；
// 设置抽屉的版本号由外壳从 manifest 读取，不在 HTML 里写死
//
// 每次发版都要同时改这几处，漏一处就会让 bug 报告里的版本与实际功能对不上。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { REPO_ROOT } from '../helpers/core.mjs';

const read = (rel) => fs.readFileSync(new URL(rel, REPO_ROOT), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));

test('manifest 是 MV3，版本号是三段数字', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test('SECURITY.md 中英两处的当前版本与 manifest 一致', () => {
  const security = read('SECURITY.md');
  assert.ok(security.includes(`(currently ${manifest.version})`), '英文段');
  assert.ok(security.includes(`（当前 ${manifest.version}）`), '中文段');
});

test('bug 报告模板的版本示例与 manifest 一致', () => {
  assert.ok(read('.github/ISSUE_TEMPLATE/bug_report.yml').includes(`placeholder: "${manifest.version}"`));
});

test('设置抽屉的版本号不写死在 HTML 里（由外壳从 manifest 读取）', () => {
  assert.doesNotMatch(read('extension/sidepanel.html'), /\bv\d+\.\d+\.\d+\b/);
  assert.ok(read('extension/sidepanel.js').includes('chrome.runtime.getManifest().version'));
});

test('权限清单保持最小（新增权限需要在 PR 里说明理由，并同步修改这里）', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['scripting', 'sidePanel', 'storage']);
  assert.ok(!manifest.permissions.includes('debugger'));
});
