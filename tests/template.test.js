'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPage, renderIndex } = require('../src/template');

const BASE = {
  title: '快速上手',
  siteTitle: 'KMD Docs',
  bodyHtml: '<p class="lead">你好，<em>世界</em></p>',
  toc: [],
  flags: { mermaid: false, math: false },
  pagePath: 'guide.html',
  generatedAt: '2026-07-18T08:00:00.000Z',
};

test('renderPage escapes title and description', () => {
  const html = renderPage({
    ...BASE,
    title: 'a <b> & "c"',
    description: 'x <script> "q"',
  });
  assert.ok(html.includes('<title>a &lt;b&gt; &amp; &quot;c&quot; · KMD Docs</title>'));
  assert.ok(html.includes('content="x &lt;script&gt; &quot;q&quot;"'));
  assert.ok(!html.includes('<title>a <b>'));
});

test('renderPage inlines theme.css inside <style>', () => {
  const html = renderPage(BASE);
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(match, 'a <style> block exists');
  assert.ok(match[1].includes('.markdown-body'));
  assert.ok(match[1].includes('.callout-note'));
  assert.ok(match[1].includes('.tk-kw'));
});

test('toc nav rendered when toc non-empty, omitted when empty', () => {
  const withToc = renderPage({
    ...BASE,
    toc: [
      { level: 2, text: '安装', id: 'install' },
      { level: 3, text: '子章节', id: 'sub' },
      { level: 2, text: '使用', id: 'usage' },
    ],
  });
  assert.ok(withToc.includes('<nav class="toc" aria-label="目录">'));
  assert.ok(withToc.includes('href="#install"'));
  // Nested structure: level-3 item lives in a nested <ul> under its parent.
  assert.ok(
    withToc.includes(
      '<ul><li><a href="#install">安装</a><ul><li><a href="#sub">子章节</a></li></ul></li>' +
        '<li><a href="#usage">使用</a></li></ul>'
    )
  );

  const without = renderPage(BASE);
  assert.ok(!without.includes('<nav class="toc"'));
});

test('KaTeX assets included only when flags.math', () => {
  const on = renderPage({ ...BASE, flags: { math: true, mermaid: false } });
  assert.ok(on.includes('cdn.jsdelivr.net/npm/katex'));
  assert.ok(on.includes('renderMathInElement'));
  assert.ok(on.includes("{ left: '\\\\(', right: '\\\\)', display: false }"));
  assert.ok(on.includes('throwOnError: false'));

  const off = renderPage(BASE);
  assert.ok(!off.includes('katex'));
  assert.ok(!off.includes('renderMathInElement'));
});

test('mermaid loader included only when flags.mermaid', () => {
  const on = renderPage({ ...BASE, flags: { math: false, mermaid: true } });
  assert.ok(on.includes('cdn.jsdelivr.net/npm/mermaid'));
  assert.ok(on.includes("querySelector: 'pre.mermaid'"));

  const off = renderPage(BASE);
  assert.ok(!off.includes('mermaid.esm.min.mjs'));
});

test('theme toggle and copy button runtime present', () => {
  const html = renderPage(BASE);
  assert.ok(html.includes('id="theme-toggle"'));
  assert.ok(html.includes('aria-label="切换主题"'));
  assert.ok(html.includes('🌓'));
  assert.ok(html.includes('kmd-theme'));
  assert.ok(html.includes("querySelectorAll('pre.codeblock')"));
  assert.ok(html.includes('copy-btn'));
  assert.ok(html.includes('复制'));
  assert.ok(html.includes('已复制'));
  assert.ok(html.includes('navigator.clipboard'));
  assert.ok(html.includes('1500'));
});

test('bodyHtml is passed through verbatim', () => {
  const body =
    '<pre class="codeblock" data-lang="js"><code>const a = 1 &lt; 2;</code></pre><section class="ai-block">x</section>';
  const html = renderPage({ ...BASE, bodyHtml: body });
  assert.ok(html.includes(body));
});

test('shell structure hooks and footer date', () => {
  const html = renderPage(BASE);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<html lang="zh-CN">'));
  assert.ok(html.includes('<header class="topbar">'));
  assert.ok(html.includes('<a class="brand" href="index.html">KMD Docs</a>'));
  assert.ok(html.includes('<main class="markdown-body">'));
  assert.ok(html.includes('<footer class="site-footer">由 KMD 生成 · 2026-07-18</footer>'));
});

test('brand link respects pagePath depth', () => {
  const deep = renderPage({ ...BASE, pagePath: 'sub/deep/guide.html' });
  assert.ok(deep.includes('href="../../index.html"'));
  const shallow = renderPage(BASE);
  assert.ok(shallow.includes('href="index.html"'));
});

test('renderIndex lists page links in cards and reuses the shell', () => {
  const html = renderIndex({
    siteTitle: 'KMD Docs',
    description: '零依赖 Markdown 编译器',
    pages: [
      { title: '快速上手', url: 'guide.html', description: '五分钟构建第一个站点' },
      { title: '语法参考', url: 'syntax.html' },
    ],
    generatedAt: '2026-07-18T08:00:00.000Z',
  });
  assert.ok(html.includes('<ul class="page-list">'));
  assert.ok(html.includes('href="guide.html"'));
  assert.ok(html.includes('快速上手'));
  assert.ok(html.includes('五分钟构建第一个站点'));
  assert.ok(html.includes('href="syntax.html"'));
  assert.ok(html.includes('语法参考'));
  // Same shell: topbar, footer, inlined theme, single title (no duplication).
  assert.ok(html.includes('<title>KMD Docs</title>'));
  assert.ok(html.includes('<header class="topbar">'));
  assert.ok(html.includes('由 KMD 生成 · 2026-07-18'));
  assert.ok(html.includes('.markdown-body'));
  assert.ok(!html.includes('<nav class="toc"'));
});
