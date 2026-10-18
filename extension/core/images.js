// core/images.js —— 用户附图的规整（平台无关层，只用标准 Web API）
//
// 用户粘贴、拖入或选择的图片原样发出去往往太大：Retina 截屏动辄几 MB，base64 再涨三成，
// 本地部署前面的反向代理（nginx 默认 1MB）直接 413，附图随会话落库也很快把存储配额吃满。
// 所以入口处统一规整一次：像素总数压到 MAX_PIXELS 以内，小而常见的 PNG/JPEG 原样保留（无损），
// 其余重编码成 JPEG。按总像素而不是长边限：手机长截图按长边压会变成一条看不清字的细条。
// 只发 PNG/JPEG：各家后端都认，WebP、GIF 在 llama.cpp 一类实现上解不开。
// 解码与重编码要 createImageBitmap / OffscreenCanvas（Node 里没有），收不收、缩多少拆成纯函数。

/** 每条消息最多附几张 */
export const MAX_IMAGES = 4;

/** 原文件上限：再大的图光解码就要占几百 MB 内存，直接拒收 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 像素总数上限，与截图的长边上限（annotate.js 的 1568）同一量级 */
export const MAX_PIXELS = 1568 * 1568;

// 不超像素上限、也不超过这个字节数的 PNG/JPEG 原样保留，否则重编码
const KEEP_BYTES = 1024 * 1024;
const KEEP_TYPES = new Set(['image/png', 'image/jpeg']);
// 与截图同一档质量：文字边缘仍清楚，体积约为同尺寸 PNG 的三分之一
const JPEG_QUALITY = 0.85;

/**
 * 收不收这个文件。按 MIME 粗筛，真能不能解码要等 prepareImage 试过才知道。
 * @param {{ type?: string, size?: number }} file
 * @returns {'type'|'size'|null} 拒收原因；可以收时为 null
 */
export function checkImageFile(file) {
  if (!file || !/^image\//.test(file.type || '')) return 'type';
  if (file.size > MAX_FILE_BYTES) return 'size';
  return null;
}

/**
 * 输出尺寸：等比缩小到像素总数不超过 maxPixels，不放大。
 * 向下取整：四舍五入两边各多出半个像素，乘起来就越过上限了
 * @returns {{ w: number, h: number }}
 */
export function fitPixels(w, h, maxPixels = MAX_PIXELS) {
  const k = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)) };
}

/** 原样保留还是重编码：常见格式、尺寸与体积都在限内才原样保留 */
export function keepsOriginal(file, w, h) {
  return KEEP_TYPES.has(file.type) && file.size <= KEEP_BYTES && w * h <= MAX_PIXELS;
}

/**
 * 把一个图片文件规整成发给模型的 data URL。
 * @param {Blob} file 粘贴、拖入或选择得到的文件
 * @returns {Promise<{ ok: true, url: string } | { ok: false, reason: 'type'|'size'|'decode' }>}
 *   decode：浏览器解不开（SVG、HEIC、扩展名是图片其实不是）
 */
export async function prepareImage(file) {
  const reason = checkImageFile(file);
  if (reason) return { ok: false, reason };
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    if (keepsOriginal(file, bitmap.width, bitmap.height)) return { ok: true, url: await dataUrlOf(file) };
    const size = fitPixels(bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(size.w, size.h);
    const ctx = canvas.getContext('2d');
    // JPEG 没有透明通道：先铺白，否则透明处会变成黑底
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.drawImage(bitmap, 0, 0, size.w, size.h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    return { ok: true, url: await dataUrlOf(blob) };
  } catch {
    return { ok: false, reason: 'decode' };
  } finally {
    if (bitmap) bitmap.close();
  }
}

function dataUrlOf(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
