// core/settings.js —— 配置的形状、旧版迁移与设置文件的生成/解析（平台无关层）
//
// 职责：
//   1. 定义配置的规范形状：多套模型接口（profiles）+ 当前使用的那套（activeProfileId）+ 全局偏好；
//   2. 把任何来源的配置（旧版扁平结构、导入的文件、被手改过的存储）规整成规范形状；
//   3. 生成设置文件内容与解析导入文本。
// 本模块只做纯数据变换：读写存储、下载文件、弹确认框都是外壳的事。
//
// 为什么接口按「套」管理：同一个人在 DeepSeek 官方与行内本地部署之间来回切换是常态，
// 每次重填三个字段既麻烦又容易把 Key 填错。一套 = 名称 + 接口地址 + 模型名 + Key + 是否支持视觉；
// 「模型支持视觉」是模型的属性而非用户偏好，跟着套走，切换后不必再翻开关。
// 脱敏、页面操作、语言是用户偏好，与用哪套接口无关，留在全局。

import { LOCALES } from './i18n.js';

/** 规范形状的缺省值；profiles 为空时由 normalizeConfig 补一套空白，保证界面永远有可选项 */
export const DEFAULT_CONFIG = Object.freeze({
  profiles: [],
  activeProfileId: '',
  maskEnabled: true,
  actionsEnabled: false, // 允许页面操作（点击/输入/跳转），默认关闭
  locale: '',            // 界面与模型文案的语言；空串=跟随浏览器（首次启动时判定）
});

/** 设置文件的身份标记与格式版本：结构不兼容地演进时递增，解析端拒绝比自己新的文件 */
export const SETTINGS_FILE_KIND = 'titanium-settings';
export const SETTINGS_FILE_VERSION = 1;

/** 生成接口套的 id：时间戳 + 随机尾巴，与会话 id 同一思路 */
export function newProfileId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function emptyProfile() {
  return { id: newProfileId(), name: '', baseUrl: '', model: '', apiKey: '', visionEnabled: false };
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** 规整一套接口：字段缺失补空、多余字段丢弃、id 非法时重新生成 */
export function normalizeProfile(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    id: str(src.id) || newProfileId(),
    name: str(src.name),
    baseUrl: str(src.baseUrl),
    model: str(src.model),
    apiKey: str(src.apiKey),
    visionEnabled: Boolean(src.visionEnabled),
  };
}

/**
 * 把任意来源的配置规整成规范形状，返回全新对象、不改动入参。
 *   - 旧版扁平结构（baseUrl/model/apiKey/visionEnabled 直接挂在顶层）迁移为一套接口；
 *     三个字段都为空等价于「从未配置」，不生成迁移套；
 *   - profiles 为空补一套空白；id 重复的后来者重新编号；
 *   - activeProfileId 对不上任何一套时指向第一套；
 *   - 布尔偏好按缺省值补齐，locale 非法归为空串（由外壳按浏览器语言判定）。
 * @param {object|undefined} raw
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  let profiles = Array.isArray(src.profiles) ? src.profiles.map(normalizeProfile) : [];
  if (!Array.isArray(src.profiles)) {
    const legacy = normalizeProfile({
      baseUrl: src.baseUrl, model: src.model, apiKey: src.apiKey, visionEnabled: src.visionEnabled,
    });
    if (legacy.baseUrl || legacy.model || legacy.apiKey) profiles = [legacy];
  }
  const seen = new Set();
  for (const p of profiles) {
    while (seen.has(p.id)) p.id = newProfileId();
    seen.add(p.id);
  }
  if (profiles.length === 0) profiles = [emptyProfile()];
  const activeProfileId = profiles.some((p) => p.id === src.activeProfileId)
    ? src.activeProfileId
    : profiles[0].id;
  return {
    profiles,
    activeProfileId,
    maskEnabled: src.maskEnabled === undefined ? DEFAULT_CONFIG.maskEnabled : Boolean(src.maskEnabled),
    actionsEnabled: Boolean(src.actionsEnabled),
    locale: LOCALES.includes(src.locale) ? src.locale : '',
  };
}

/** 当前使用的那套接口；配置尚未规整（如 profiles 缺失）时也返回一个可用的空套而不是 undefined */
export function activeProfile(config) {
  const profiles = (config && Array.isArray(config.profiles)) ? config.profiles : [];
  return profiles.find((p) => p.id === config.activeProfileId) || profiles[0] || emptyProfile();
}

/** 显示名：名称 → 模型名 → 接口地址的主机名 → 兜底文案（由外壳按当前语言传入） */
export function profileLabel(profile, fallback = '') {
  if (!profile) return fallback;
  if (profile.name) return profile.name;
  if (profile.model) return profile.model;
  if (profile.baseUrl) {
    try {
      return new URL(profile.baseUrl).host || fallback;
    } catch {
      // 地址还没填完整：继续兜底
    }
  }
  return fallback;
}

/**
 * 生成设置文件内容（普通对象，外壳负责 JSON.stringify 与下载）。
 *   - 含 API Key：备份的目的就是重装后不必重填 Key，明文风险由界面文案提醒；
 *   - 不含页面操作开关：那是一次有后果的授权，默认关闭且只能在界面上亲手打开，不随文件流转。
 * @param {object} config
 * @param {Date} [exportedAt]
 */
export function buildSettingsExport(config, exportedAt = new Date()) {
  const c = normalizeConfig(config);
  return {
    kind: SETTINGS_FILE_KIND,
    version: SETTINGS_FILE_VERSION,
    exportedAt: exportedAt.toISOString(),
    profiles: c.profiles,
    activeProfileId: c.activeProfileId,
    maskEnabled: c.maskEnabled,
    locale: c.locale,
  };
}

/**
 * 解析设置文件文本。
 * @param {string} text
 * @returns {{ ok: true, config: object } | { ok: false, reason: 'bad-json'|'bad-kind'|'bad-version' }}
 *   config 已规整，其中 actionsEnabled 恒为 false：文件里本就不该有这个开关，
 *   即便被手工加上也不采信，导入端应保留用户当前的开关状态。
 */
export function parseSettingsImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
  if (!data || typeof data !== 'object' || data.kind !== SETTINGS_FILE_KIND) {
    return { ok: false, reason: 'bad-kind' };
  }
  if (!Number.isInteger(data.version) || data.version < 1 || data.version > SETTINGS_FILE_VERSION) {
    return { ok: false, reason: 'bad-version' };
  }
  return { ok: true, config: normalizeConfig({ ...data, actionsEnabled: false }) };
}
