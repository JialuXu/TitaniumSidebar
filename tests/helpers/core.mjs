// tests/helpers/core.mjs —— 定位被测代码的唯一入口
//
// 测试代码与扩展代码分开存放：tests/ 只从这里拿到 extension/ 的路径，
// 以后目录若有调整，只改这一处。

import { fileURLToPath } from 'node:url';

/** 仓库根目录的 file: URL */
export const REPO_ROOT = new URL('../../', import.meta.url);

/** extension/core/ 的 file: URL */
export const CORE_DIR = new URL('extension/core/', REPO_ROOT);

/** extension/ 的 file: URL */
export const EXTENSION_DIR = new URL('extension/', REPO_ROOT);

/** 某个 core 模块的 file: URL，例如 coreUrl('masker.js') */
export function coreUrl(name) {
  return new URL(name, CORE_DIR);
}

/** 某个 core 模块的文件系统路径（读源码做静态检查时用） */
export function corePath(name) {
  return fileURLToPath(coreUrl(name));
}
