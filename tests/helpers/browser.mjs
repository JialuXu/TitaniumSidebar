// tests/helpers/browser.mjs —— 在真实 Chromium 里跑注入函数（tests/dom/ 专用）
//
// snapshot.js / actions.js / highlight.js 的判定依赖真实排版（getBoundingClientRect、
// elementFromPoint、computed style、label 的激活行为），只能在浏览器里验证。
// Playwright 按需临时安装：装了就跑（CI 的 dom 任务会装），没装时 tests/dom/ 整体跳过。

import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

/** 能加载到 playwright 时返回模块，否则返回 null（也认 NODE_PATH 指向的全局安装） */
export function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    return null;
  }
}

/** 读 tests/dom/fixtures/ 下的夹具页面 */
export function fixture(name) {
  return fs.readFileSync(new URL(`../dom/fixtures/${name}`, import.meta.url), 'utf8');
}

/**
 * 按 executeScript 的方式调用注入函数：取函数源码，在页面里重新求值后传入参数。
 * 注入函数因此必须自包含——这里与扩展外壳走的是同一条路。
 */
export function inject(page, fn, args) {
  return page.evaluate(`(${fn.toString()})(${args === undefined ? '' : JSON.stringify(args)})`);
}

/** 等页面把微任务与下一帧里的更新做完（组件库常在 nextTick / requestAnimationFrame 里改 DOM） */
export function settle(page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
}
