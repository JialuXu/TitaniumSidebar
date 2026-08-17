// core/annotate.js —— 截图的 Set-of-Marks 标注（平台无关层，仅用标准 canvas API）
//
// 把可交互元素的 ref 编号框画到视口截图上，视觉通道与结构通道由此打通：
// 模型在图上看到编号 [12]，即可用 highlight_element(12) / list_elements 反查同一元素。
//
// 缩放系数不信任 devicePixelRatio：captureVisibleTab 的位图宽 ÷ 视口 CSS 宽实测得出，
// 天然吸收系统 DPR 与页面缩放两个因素，编号框才能与元素严格对齐。

import { t } from './i18n.js';

/**
 * @param {string} dataUrl 原始截图（captureVisibleTab 返回的 data URL）
 * @param {Array<{ ref: number, bbox: { x, y, w, h } }>} marks 视口内元素（CSS 像素 bbox）
 * @param {{ w: number, h: number }} viewport 截图时刻的视口 CSS 尺寸
 * @param {{ maxEdge?: number, quality?: number, maxMarks?: number }} [opts]
 *   maxEdge 输出图长边上限（超出等比缩小，控制发给模型的体积）
 * @returns {Promise<{ dataUrl: string, markCount: number }>} JPEG data URL 与实际标注数
 */
export async function annotateScreenshot(dataUrl, marks, viewport, opts = {}) {
  const { maxEdge = 1568, quality = 0.85, maxMarks = 50 } = opts;

  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(t('err.shotDecode')));
    image.src = dataUrl;
  });

  // 实测缩放：位图像素 / CSS 像素
  const scale = viewport.w ? img.naturalWidth / viewport.w : 1;
  // 输出缩放：长边压到 maxEdge 以内
  const outScale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const k = scale * outScale; // CSS 像素 → 输出图像素

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * outScale);
  canvas.height = Math.round(img.naturalHeight * outScale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // 面积降序取前 maxMarks 个（过小的元素画了也读不清），先画大后画小避免小标签被盖住
  const drawn = (marks || [])
    .filter((m) => m.bbox && m.bbox.w > 0 && m.bbox.h > 0)
    .sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h)
    .slice(0, maxMarks);

  const fontPx = Math.max(10, Math.round(11 * k));
  ctx.lineWidth = Math.max(1.5, 2 * k);
  ctx.font = `600 ${fontPx}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  for (const m of drawn) {
    const x = m.bbox.x * k;
    const y = m.bbox.y * k;
    const w = m.bbox.w * k;
    const h = m.bbox.h * k;
    ctx.strokeStyle = '#d93025';
    ctx.strokeRect(x, y, w, h);
    // 编号标签：优先画在框上方，贴顶时画进框内左上角
    const label = String(m.ref);
    const padX = Math.round(4 * k);
    const labelW = ctx.measureText(label).width + padX * 2;
    const labelH = fontPx + Math.round(4 * k);
    const labelY = y >= labelH ? y - labelH : y;
    ctx.fillStyle = '#d93025';
    ctx.fillRect(x, labelY, labelW, labelH);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + padX, labelY + labelH / 2 + 0.5);
  }

  return { dataUrl: canvas.toDataURL('image/jpeg', quality), markCount: drawn.length };
}
