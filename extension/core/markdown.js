// core/markdown.js —— 小型 Markdown 渲染器（平台无关层）
//
// 安全策略：渲染前先将全文整体 HTML 转义，解析器针对“已转义文本”编写。由此：
//   1. 块引用识别匹配行首 &gt;（而非 >）；
//   2. 行内代码与围栏代码块内容已是转义态，直接放入 <code>/<pre>，不二次转义；
//   3. 链接 href 中的 & 和 " 已成 &amp;/&quot;，属性无法被逃逸，
//      唯一剩余注入面是 URL scheme——只放行 http(s):// 与 #，其余按纯文本输出。
//
// 支持子集：标题 h1–h4、加粗/斜体、有序/无序列表（单层）、行内代码、
// 围栏代码块（带复制按钮，csv 块另有下载按钮，按钮事件均由外壳委托绑定）、表格、分隔线、链接、引用块。
// 流式渲染由外壳负责：每次收到 delta 后用累计全文全量重渲当前消息即可，
// 未闭合的围栏代码块会被自然渲染到文末。

import { t } from './i18n.js';

/** HTML 转义（& < > " '） */
export function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 行内解析：先抽出行内代码保护其内容不被加粗/斜体规则命中，
// 再依次处理粗体、斜体、链接，最后回填代码占位符。
function renderInline(text) {
  const codeSpans = [];
  let out = text.replace(/`([^`\n]+)`/g, (_, code) => {
    codeSpans.push(code);
    return `\u0000${codeSpans.length - 1}\u0000`;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    if (!/^(https?:\/\/|#)/i.test(href)) return m; // 可疑 scheme 按纯文本输出
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codeSpans[+i]}</code>`);
  return out;
}

// 表格行拆分：去掉首尾空列后按 | 分列
function splitTableRow(row) {
  const cells = row.trim().split('|');
  if (cells.length && cells[0].trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// 表格分隔行判定（如 | --- | :---: |），要求同时含 - 和 |，避免误吞分隔线
function isTableSeparator(line) {
  return (
    /^\s*\|?[\s:\-|]+\|?\s*$/.test(line) && line.includes('-') && line.includes('|')
  );
}

// 表格起始判定：当前行含 | 且下一行是分隔行
function isTableStart(lines, i) {
  return (
    lines[i].includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])
  );
}

const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * 渲染 Markdown 为安全 HTML 字符串。
 * @param {string} mdText 原始 Markdown 文本
 * @returns {string}
 */
export function renderMarkdown(mdText) {
  const lines = escapeHtml(mdText).split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 围栏代码块（宽松匹配 info string；未闭合时渲染到文末——流式中途状态）
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      const lang = fence[1].trim().split(/\s+/)[0];
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合行（无闭合行时已到文末）
      // csv 块附下载按钮：金融场景下 CSV 的归宿多半是 Excel，落盘比复制粘贴顺手
      const downloadBtn =
        lang.toLowerCase() === 'csv'
          ? `<button type="button" class="md-copy-btn" data-role="download-csv">${t('md.download')}</button>`
          : '';
      html.push(
        '<div class="md-codeblock">' +
          `<div class="md-codeblock-head"><span class="md-codeblock-lang">${lang || t('md.code')}</span>` +
          downloadBtn +
          `<button type="button" class="md-copy-btn" data-role="copy-code">${t('md.copy')}</button></div>` +
          `<pre><code>${code.join('\n')}</code></pre></div>`
      );
      continue;
    }

    // 标题 h1–h4（h5/h6 不在支持子集内，按普通段落处理）
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // 分隔线
    if (HR_RE.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }

    // 引用块：连续 &gt; 行合并为一个 blockquote（出处标注的载体）
    if (/^&gt;/.test(line.trim())) {
      const quote = [];
      while (i < lines.length && /^&gt;/.test(lines[i].trim())) {
        quote.push(lines[i].trim().replace(/^&gt;\s?/, ''));
        i++;
      }
      html.push(
        `<blockquote>${quote.map((q) => renderInline(q)).join('<br>')}</blockquote>`
      );
      continue;
    }

    // 表格
    if (isTableStart(lines, i)) {
      const header = splitTableRow(line);
      i += 2; // 跳过表头行与分隔行
      const bodyRows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      let table = '<div class="md-table-wrap"><table><thead><tr>';
      table += header.map((h) => `<th>${renderInline(h)}</th>`).join('');
      table += '</tr></thead><tbody>';
      for (const row of bodyRows) {
        table +=
          '<tr>' +
          header.map((_, ci) => `<td>${renderInline(row[ci] || '')}</td>`).join('') +
          '</tr>';
      }
      table += '</tbody></table></div>';
      html.push(table);
      continue;
    }

    // 无序列表（单层）
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      html.push('<ul>' + items.map((it) => `<li>${renderInline(it)}</li>`).join('') + '</ul>');
      continue;
    }

    // 有序列表（单层）
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      html.push('<ol>' + items.map((it) => `<li>${renderInline(it)}</li>`).join('') + '</ol>');
      continue;
    }

    // 段落：连续普通行合并，行间以 <br> 保留换行
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|```|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i]) &&
      !/^&gt;/.test(lines[i].trim()) &&
      !HR_RE.test(lines[i]) &&
      !isTableStart(lines, i)
    ) {
      para.push(lines[i]);
      i++;
    }
    html.push(`<p>${para.map((l) => renderInline(l)).join('<br>')}</p>`);
  }

  return html.join('\n');
}
