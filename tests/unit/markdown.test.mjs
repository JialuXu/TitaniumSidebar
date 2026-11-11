// core/markdown.js —— 安全 Markdown 渲染（验收标准第 1、20 条）

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, escapeHtml } from '../../extension/core/markdown.js';
import { setLocale } from '../../extension/core/i18n.js';

beforeEach(() => setLocale('zh'));

/* ========== 安全 ========== */

test('escapeHtml 转义五个字符', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

test('原始 HTML 一律按文本输出', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('只放行 http(s) 与 # 链接，其余 scheme 按纯文本', () => {
  assert.ok(!renderMarkdown('[点我](javascript:alert(1))').includes('<a'));
  assert.ok(!renderMarkdown('[点我](data:text/html,x)').includes('<a'));
  assert.equal(
    renderMarkdown('[文档](https://example.com/a?b=1&c=2)'),
    '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">文档</a></p>'
  );
  assert.ok(renderMarkdown('[目录](#sec)').includes('href="#sec"'));
});

test('链接里的引号无法逃出 href 属性', () => {
  const html = renderMarkdown('[x](https://a.test/"onmouseover="alert(1))');
  assert.ok(!/href="[^"]*"onmouseover/.test(html));
});

/* ========== 块级 ========== */

test('标题 h1–h4；h5 按段落处理', () => {
  assert.equal(renderMarkdown('# 一\n#### 四'), '<h1>一</h1>\n<h4>四</h4>');
  assert.equal(renderMarkdown('##### 五'), '<p>##### 五</p>');
});

test('连续引用行合并为一个 blockquote', () => {
  assert.equal(renderMarkdown('> 第一行\n> 第二行'), '<blockquote>第一行<br>第二行</blockquote>');
});

test('表格：表头、正文、缺失单元格补空', () => {
  const html = renderMarkdown('| 年份 | 营收 |\n| --- | ---: |\n| 2024 | **12** |\n| 2025 |');
  assert.equal(html,
    '<div class="md-table-wrap"><table><thead><tr><th>年份</th><th>营收</th></tr></thead><tbody>' +
    '<tr><td>2024</td><td><strong>12</strong></td></tr>' +
    '<tr><td>2025</td><td></td></tr>' +
    '</tbody></table></div>');
});

test('围栏代码块：内容只转义一次，带复制按钮', () => {
  const html = renderMarkdown('```js\nif (a < b && c) {}\n```');
  assert.ok(html.includes('<pre><code>if (a &lt; b &amp;&amp; c) {}</code></pre>'));
  assert.ok(html.includes('data-role="copy-code"'));
  assert.ok(html.includes('<span class="md-codeblock-lang">js</span>'));
  assert.ok(!html.includes('download-csv'));
});

test('csv 代码块另有下载按钮', () => {
  const html = renderMarkdown('```CSV\na,b\n1,2\n```');
  assert.ok(html.includes('data-role="download-csv"'));
});

test('未闭合的围栏（流式中途）渲染到文末', () => {
  assert.ok(renderMarkdown('前文\n```\n代码还在输出').includes('<pre><code>代码还在输出</code></pre>'));
});

test('无序、有序列表与分隔线', () => {
  assert.equal(renderMarkdown('- a\n* b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(renderMarkdown('1. a\n2) b'), '<ol><li>a</li><li>b</li></ol>');
  assert.equal(renderMarkdown('---'), '<hr>');
});

test('段落内换行保留为 <br>，遇到块级元素即断开', () => {
  assert.equal(renderMarkdown('一\n二\n# 标题'), '<p>一<br>二</p>\n<h1>标题</h1>');
});

/* ========== 行内 ========== */

test('行内代码保护其中的星号不被当成加粗', () => {
  assert.equal(renderMarkdown('`**x**` 与 **粗** *斜*'), '<p><code>**x**</code> 与 <strong>粗</strong> <em>斜</em></p>');
});

test('第 47 条：列表按缩进嵌套，有序与无序可以互相嵌套', () => {
  assert.equal(
    renderMarkdown('- 收入\n  - 主营\n  - 其他\n- 成本'),
    '<ul><li>收入<ul><li>主营</li><li>其他</li></ul></li><li>成本</li></ul>',
  );
  assert.equal(
    renderMarkdown('1. 第一步\n   - 细节 a\n     1. 更细\n   - 细节 b\n2. 第二步'),
    '<ol><li>第一步<ul><li>细节 a<ol><li>更细</li></ol></li><li>细节 b</li></ul></li><li>第二步</li></ol>',
  );
  assert.equal(renderMarkdown('- a\n\t- b'), '<ul><li>a<ul><li>b</li></ul></li></ul>'); // 制表符缩进
});

test('第 47 条：列表项之间的空行不打断编号，项下缩进的行并进该项', () => {
  assert.equal(renderMarkdown('1. a\n\n2. b\n\n3. c'), '<ol><li>a</li><li>b</li><li>c</li></ol>');
  assert.equal(renderMarkdown('- a\n  接着说\n- b'), '<ul><li>a<br>接着说</li><li>b</li></ul>');
  // 列表之后的段落照常另起
  assert.equal(renderMarkdown('- a\n\n结论'), '<ul><li>a</li></ul>\n<p>结论</p>');
});

test('第 47 条：被段落隔开的有序列表接着原编号，同层换类型另起一个列表', () => {
  assert.equal(renderMarkdown('1. a\n\n说明\n\n2. b'), '<ol><li>a</li></ol>\n<p>说明</p>\n<ol start="2"><li>b</li></ol>');
  assert.equal(renderMarkdown('- a\n1. b'), '<ul><li>a</li></ul>\n<ol><li>b</li></ol>');
});

test('第 47 条：列表项下面带缩进的代码块照常成块，其后的编号接着原编号', () => {
  const html = renderMarkdown('1. 运行\n   ```sh\n   ls\n     -a\n   ```\n2. 查看');
  assert.match(html, /^<ol><li>运行<\/li><\/ol>\n<div class="md-codeblock">/);
  assert.match(html, /<pre><code>ls\n  -a<\/code><\/pre>/); // 去掉与开围栏等量的缩进
  assert.match(html, /<ol start="2"><li>查看<\/li><\/ol>$/);
  assert.equal(renderMarkdown('- a\n\n---\n\n- b'), '<ul><li>a</li></ul>\n<hr>\n<ul><li>b</li></ul>');
});

test('第 47 条：删除线', () => {
  assert.equal(renderMarkdown('原价 ~~100~~ 现价 80'), '<p>原价 <del>100</del> 现价 80</p>');
  assert.equal(renderMarkdown('`~~不动~~`'), '<p><code>~~不动~~</code></p>');
});
