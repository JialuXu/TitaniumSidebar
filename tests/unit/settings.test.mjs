// core/settings.js —— 配置形状、旧版迁移与设置文件（验收标准第 22、23、34 条）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseContextWindow, normalizeProfile, normalizeConfig, activeProfile, profileLabel,
  buildSettingsExport, parseSettingsImport, SETTINGS_FILE_KIND, SETTINGS_FILE_VERSION,
  formatContextWindow, mergeImportedConfig,
} from '../../extension/core/settings.js';

test('上下文窗口：接受 128000 / 128k / 1.5M / 带千分位', () => {
  assert.equal(parseContextWindow('128000'), 128000);
  assert.equal(parseContextWindow('128k'), 128000);
  assert.equal(parseContextWindow(' 128 K '), 128000);
  assert.equal(parseContextWindow('1.5M'), 1500000);
  assert.equal(parseContextWindow('128,000'), 128000);
  assert.equal(parseContextWindow('128，000'), 128000);
  assert.equal(parseContextWindow(12.6), 13);
});

test('上下文窗口：空、非法、非正数一律为 0（表示没填）', () => {
  for (const v of ['', 'abc', '12g', '0k', -5, 0, NaN, Infinity, null, undefined]) {
    assert.equal(parseContextWindow(v), 0, `输入 ${String(v)}`);
  }
});

test('规整一套接口：去空白、丢多余字段、补 id', () => {
  const p = normalizeProfile({ name: ' 本地 ', baseUrl: ' http://x/v1 ', extra: 1, visionEnabled: 'yes', contextWindow: '16k' });
  assert.equal(p.name, '本地');
  assert.equal(p.baseUrl, 'http://x/v1');
  assert.equal(p.visionEnabled, true);
  assert.equal(p.contextWindow, 16000);
  assert.ok(p.id);
  assert.equal('extra' in p, false);
  assert.deepEqual(Object.keys(normalizeProfile(null)).sort(),
    ['apiKey', 'baseUrl', 'contextWindow', 'id', 'model', 'name', 'visionEnabled']);
});

test('从未配置：补一套空白接口并选中它，偏好取缺省', () => {
  const c = normalizeConfig(undefined);
  assert.equal(c.profiles.length, 1);
  assert.equal(c.activeProfileId, c.profiles[0].id);
  assert.equal(c.maskEnabled, true);
  assert.equal(c.actionsEnabled, false);
  assert.equal(c.locale, '');
});

test('旧版扁平配置迁移为一套接口', () => {
  const c = normalizeConfig({
    baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-1', visionEnabled: true, maskEnabled: false,
  });
  assert.equal(c.profiles.length, 1);
  assert.deepEqual(
    { ...c.profiles[0], id: undefined },
    { id: undefined, name: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-1', visionEnabled: true, contextWindow: 0 }
  );
  assert.equal(c.activeProfileId, c.profiles[0].id);
  assert.equal(c.maskEnabled, false);
});

test('重复 id 的后来者重新编号，当前套对不上时指向第一套', () => {
  const c = normalizeConfig({ profiles: [{ id: 'a', name: '1' }, { id: 'a', name: '2' }], activeProfileId: 'zzz' });
  assert.equal(c.profiles[0].id, 'a');
  assert.notEqual(c.profiles[1].id, 'a');
  assert.equal(c.activeProfileId, 'a');
  assert.equal(normalizeConfig({ profiles: [{ id: 'a' }, { id: 'b' }], activeProfileId: 'b' }).activeProfileId, 'b');
});

test('非法语言归为空串，合法语言保留', () => {
  assert.equal(normalizeConfig({ locale: 'fr' }).locale, '');
  assert.equal(normalizeConfig({ locale: 'en' }).locale, 'en');
});

test('不改动入参', () => {
  const raw = { profiles: [{ id: 'a', name: ' x ' }], activeProfileId: 'a' };
  const snapshot = structuredClone(raw);
  normalizeConfig(raw);
  assert.deepEqual(raw, snapshot);
});

test('activeProfile 在配置未规整时也返回可用的一套', () => {
  assert.equal(activeProfile({ profiles: [{ id: 'a' }, { id: 'b' }], activeProfileId: 'b' }).id, 'b');
  assert.equal(activeProfile({ profiles: [{ id: 'a' }], activeProfileId: 'x' }).id, 'a');
  assert.ok(activeProfile({}).id);
});

test('显示名：名称 → 模型名 → 主机名 → 兜底', () => {
  assert.equal(profileLabel({ name: 'N', model: 'M', baseUrl: 'http://h:1/v1' }), 'N');
  assert.equal(profileLabel({ model: 'M', baseUrl: 'http://h:1/v1' }), 'M');
  assert.equal(profileLabel({ baseUrl: 'http://h:1/v1' }), 'h:1');
  assert.equal(profileLabel({ baseUrl: 'not a url' }, '未命名'), '未命名');
  assert.equal(profileLabel(null, '未命名'), '未命名');
});

test('导出：含 API Key 与上下文窗口，不含页面操作开关', () => {
  const at = new Date('2026-09-26T00:00:00Z');
  const out = buildSettingsExport({
    profiles: [{ id: 'a', apiKey: 'sk-secret', contextWindow: '128k' }], activeProfileId: 'a', actionsEnabled: true, locale: 'en',
  }, at);
  assert.equal(out.kind, SETTINGS_FILE_KIND);
  assert.equal(out.version, SETTINGS_FILE_VERSION);
  assert.equal(out.exportedAt, '2026-09-26T00:00:00.000Z');
  assert.equal(out.profiles[0].apiKey, 'sk-secret');
  assert.equal(out.profiles[0].contextWindow, 128000);
  assert.equal('actionsEnabled' in out, false);
  assert.equal(out.locale, 'en');
});

test('导入：导出的文件原样恢复，且页面操作恒为关闭', () => {
  const file = buildSettingsExport({ profiles: [{ id: 'a', model: 'm', apiKey: 'k' }], activeProfileId: 'a', maskEnabled: false });
  const res = parseSettingsImport(JSON.stringify({ ...file, actionsEnabled: true }));
  assert.equal(res.ok, true);
  assert.equal(res.config.actionsEnabled, false);
  assert.equal(res.config.maskEnabled, false);
  assert.deepEqual(res.config.profiles, file.profiles);
});

test('导入：损坏文件、别的 JSON、更新版本的文件都拒绝', () => {
  assert.deepEqual(parseSettingsImport('{oops'), { ok: false, reason: 'bad-json' });
  assert.deepEqual(parseSettingsImport('{"hello":1}'), { ok: false, reason: 'bad-kind' });
  assert.deepEqual(parseSettingsImport('null'), { ok: false, reason: 'bad-kind' });
  for (const version of [0, SETTINGS_FILE_VERSION + 1, '1', 1.5]) {
    assert.deepEqual(
      parseSettingsImport(JSON.stringify({ kind: SETTINGS_FILE_KIND, version })),
      { ok: false, reason: 'bad-version' },
      `version=${JSON.stringify(version)}`
    );
  }
});

test('第 34 条：上下文窗口回显，整千按 k，与输入写法互逆', () => {
  assert.equal(formatContextWindow(0), '');
  assert.equal(formatContextWindow(128000), '128k');
  assert.equal(formatContextWindow(1500000), '1500k');
  assert.equal(formatContextWindow(32768), '32768');
  for (const v of ['128k', '32768', '1.5M']) assert.equal(parseContextWindow(formatContextWindow(parseContextWindow(v))), parseContextWindow(v));
});

test('第 23 条：导入合并保留当前的页面操作开关，文件未记语言时沿用当前', () => {
  const current = normalizeConfig({ actionsEnabled: true, locale: 'en' });
  const file = parseSettingsImport(JSON.stringify({ ...buildSettingsExport(normalizeConfig({ maskEnabled: false })), locale: undefined }));
  const merged = mergeImportedConfig(current, file.config);
  assert.equal(merged.actionsEnabled, true);
  assert.equal(merged.maskEnabled, false);
  assert.equal(merged.locale, 'en');
  // 文件里手工加上的开关不采信：当前关着就还是关着
  const forged = parseSettingsImport(JSON.stringify({ ...buildSettingsExport(normalizeConfig()), actionsEnabled: true }));
  assert.equal(mergeImportedConfig(normalizeConfig(), forged.config).actionsEnabled, false);
});
