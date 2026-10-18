// core/images.js —— 用户附图的收件判定与缩放尺寸（验收标准第 40 条）
// 解码与重编码要 createImageBitmap / OffscreenCanvas，Node 里没有，那部分按验收清单手动验证

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkImageFile, fitPixels, keepsOriginal, prepareImage, MAX_FILE_BYTES, MAX_PIXELS,
} from '../../extension/core/images.js';

test('第 40 条：只收图片类型，原文件超上限拒收', () => {
  assert.equal(checkImageFile({ type: 'image/png', size: 1000 }), null);
  // 粗筛只看 MIME：HEIC 这类浏览器解不开的，由 prepareImage 解码时报 decode
  assert.equal(checkImageFile({ type: 'image/heic', size: 1000 }), null);
  assert.equal(checkImageFile({ type: 'application/pdf', size: 1000 }), 'type');
  assert.equal(checkImageFile({ type: '', size: 1000 }), 'type');
  assert.equal(checkImageFile(null), 'type');
  assert.equal(checkImageFile({ type: 'image/jpeg', size: MAX_FILE_BYTES + 1 }), 'size');
});

test('缩放按总像素等比缩小、不放大：手机长截图不会被压成细条', () => {
  assert.deepEqual(fitPixels(1200, 800), { w: 1200, h: 800 });
  const retina = fitPixels(2880, 1800);
  assert.ok(retina.w * retina.h <= MAX_PIXELS);
  assert.ok(Math.abs(retina.w / retina.h - 1.6) < 0.01);
  // 按长边 1568 压只剩约 229 宽；按总像素还有六七百，字看得清
  const tall = fitPixels(1170, 8000);
  assert.ok(tall.w > 500 && tall.w * tall.h <= MAX_PIXELS);
});

test('小而常见的 PNG/JPEG 原样保留，其余重编码', () => {
  assert.equal(keepsOriginal({ type: 'image/png', size: 300_000 }, 1440, 900), true);
  assert.equal(keepsOriginal({ type: 'image/jpeg', size: 300_000 }, 1440, 900), true);
  assert.equal(keepsOriginal({ type: 'image/webp', size: 300_000 }, 1440, 900), false);
  assert.equal(keepsOriginal({ type: 'image/gif', size: 300_000 }, 1440, 900), false);
  assert.equal(keepsOriginal({ type: 'image/png', size: 3_000_000 }, 1440, 900), false);
  assert.equal(keepsOriginal({ type: 'image/png', size: 300_000 }, 2880, 1800), false);
});

test('不是图片、太大的文件在解码之前就拒收', async () => {
  assert.deepEqual(await prepareImage({ type: 'text/plain', size: 10 }), { ok: false, reason: 'type' });
  assert.deepEqual(await prepareImage({ type: 'image/png', size: MAX_FILE_BYTES + 1 }), { ok: false, reason: 'size' });
});
