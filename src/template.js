'use strict';

// KMD page shell: full HTML documents with the theme inlined and optional
// CDN assets (KaTeX / mermaid) gated behind feature flags. Zero deps.

const { readAsset } = require('./assets');

// Theme stylesheet is read once at module load and inlined into every page.
// Goes through the asset layer so it also works inside a SEA bundle.
const THEME_CSS = readAsset('src/theme.css');

const KATEX_VERSION = '0.16.11';
const MERMAID_VERSION = '11';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Relative prefix back to the site root ('sub/guide.html' -> '../../').
function rootPrefix(pagePath) {
  const depth = String(pagePath || '').split('/').length - 1;
  return depth > 0 ? '../'.repeat(depth) : '';
}

function formatDate(isoString) {
  const s = String(isoString || '');
  return s.length >= 10 ? s.slice(0, 10) : s;
}

// Nested <ul> indented by heading level; empty toc -> no nav at all.
function renderTocNav(toc) {
  if (!Array.isArray(toc) || toc.length === 0) return '';
  const base = Math.min(...toc.map((item) => item.level || 2));
  let prev = base;
  let html = '<ul>';
  toc.forEach((item, index) => {
    const level = item.level || base;
    if (index > 0) {
      if (level > prev) html += '<ul>'.repeat(level - prev);
      else if (level < prev) html += '</li>' + '</ul></li>'.repeat(prev - level);
      else html += '</li>';
    }
    html += '<li><a href="#' + escapeHtml(item.id) + '">' + escapeHtml(item.text) + '</a>';
    prev = level;
  });
  html += '</li>' + '</ul></li>'.repeat(prev - base) + '</ul>';
  return '<nav class="toc" aria-label="目录">' + html + '</nav>';
}

function mathHead() {
  const base = 'https://cdn.jsdelivr.net/npm/katex@' + KATEX_VERSION;
  return [
    '<link rel="stylesheet" href="' + base + '/dist/katex.min.css">',
    '<script defer src="' + base + '/dist/katex.min.js"></script>',
    '<script defer src="' + base + '/dist/contrib/auto-render.min.js"></script>',
  ].join('\n');
}

function mermaidHead() {
  // ESM loader; any failure (offline etc.) just leaves the source text shown.
  return [
    '<script type="module">',
    'try {',
    "  const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@" +
      MERMAID_VERSION +
      "/dist/mermaid.esm.min.mjs');",
    "  mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });",
    "  await mermaid.run({ querySelector: 'pre.mermaid' });",
    "} catch (err) { /* CDN unavailable: page still works, code stays visible */ }",
    '</script>',
  ].join('\n');
}

// Inline client runtime: theme cycling + copy buttons. No external assets.
const CLIENT_JS = `
(function () {
  var docEl = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  var MODES = ['light', 'dark', 'system'];

  function storedTheme() {
    try { return localStorage.getItem('kmd-theme') || 'system'; } catch (e) { return 'system'; }
  }
  function applyTheme(mode) {
    if (MODES.indexOf(mode) === -1) mode = 'system';
    // 'system' removes the attribute so CSS falls back to prefers-color-scheme.
    if (mode === 'system') docEl.removeAttribute('data-theme');
    else docEl.setAttribute('data-theme', mode);
  }
  applyTheme(storedTheme());
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = MODES[(MODES.indexOf(storedTheme()) + 1) % MODES.length];
      try { localStorage.setItem('kmd-theme', next); } catch (e) {}
      applyTheme(next);
    });
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }
  function copyText(text, done) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { done(true); },
        function () { done(legacyCopy(text)); }
      );
    } else {
      done(legacyCopy(text));
    }
  }

  Array.prototype.forEach.call(document.querySelectorAll('pre.codeblock'), function (pre) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = '复制';
    btn.addEventListener('click', function () {
      var code = pre.querySelector('code');
      copyText(code ? code.innerText : pre.innerText, function (ok) {
        btn.textContent = ok ? '已复制' : '复制失败';
        if (ok) btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = '复制';
          btn.classList.remove('copied');
        }, 1500);
      });
    });
    pre.appendChild(btn);
  });
})();
`;

// KaTeX auto-render; deferred CDN scripts run before DOMContentLoaded, so by
// then renderMathInElement exists when the network did. Offline: skip quietly.
const KATEX_INIT_JS = `
document.addEventListener('DOMContentLoaded', function () {
  if (!window.renderMathInElement) return;
  try {
    window.renderMathInElement(document.body, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\\\(', right: '\\\\)', display: false },
        { left: '\\\\[', right: '\\\\]', display: true }
      ],
      throwOnError: false
    });
  } catch (e) {}
});
`;

function buildDocument(opts) {
  const flags = opts.flags || {};
  const title = escapeHtml(opts.title);
  const site = escapeHtml(opts.siteTitle);
  const fullTitle =
    opts.title && opts.title !== opts.siteTitle ? title + ' · ' + site : site || title;

  const headAssets = [];
  if (flags.math) headAssets.push(mathHead());
  if (flags.mermaid) headAssets.push(mermaidHead());

  const inlineJs = CLIENT_JS + (flags.math ? KATEX_INIT_JS : '');
  const tocNav = renderTocNav(opts.toc);

  const parts = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>' + fullTitle + '</title>',
  ];
  if (opts.description) {
    parts.push('<meta name="description" content="' + escapeHtml(opts.description) + '">');
  }
  parts.push('<style>');
  parts.push(THEME_CSS);
  parts.push('</style>');
  if (headAssets.length) parts.push(headAssets.join('\n'));
  parts.push('</head>');
  parts.push('<body>');
  parts.push('<header class="topbar">');
  parts.push(
    '<a class="brand" href="' + rootPrefix(opts.pagePath) + 'index.html">' + site + '</a>'
  );
  parts.push(
    '<div class="topbar-actions"><button id="theme-toggle" type="button" aria-label="切换主题">🌓</button></div>'
  );
  parts.push('</header>');
  parts.push('<div class="layout">');
  if (tocNav) parts.push(tocNav);
  parts.push('<main class="markdown-body">');
  parts.push(opts.bodyHtml == null ? '' : String(opts.bodyHtml));
  parts.push('</main>');
  parts.push('</div>');
  parts.push(
    '<footer class="site-footer">由 KMD 生成 · ' + escapeHtml(formatDate(opts.generatedAt)) + '</footer>'
  );
  parts.push('<script>' + inlineJs + '</script>');
  parts.push('</body>');
  parts.push('</html>');
  return parts.join('\n');
}

function renderPage(opts) {
  const o = opts || {};
  return buildDocument({
    title: o.title,
    siteTitle: o.siteTitle,
    description: o.description,
    bodyHtml: o.bodyHtml,
    toc: o.toc,
    flags: o.flags,
    pagePath: o.pagePath,
    generatedAt: o.generatedAt,
  });
}

function renderIndex(opts) {
  const o = opts || {};
  const pages = Array.isArray(o.pages) ? o.pages : [];
  const items = pages
    .map((page) => {
      const desc = page.description
        ? '<span class="page-card-desc">' + escapeHtml(page.description) + '</span>'
        : '';
      return (
        '<li><a class="page-card" href="' +
        escapeHtml(page.url) +
        '"><span class="page-card-text"><span class="page-card-title">' +
        escapeHtml(page.title) +
        '</span>' +
        desc +
        '</span></a></li>'
      );
    })
    .join('');

  const bodyHtml =
    '<h1>' +
    escapeHtml(o.siteTitle) +
    '</h1>' +
    (o.description ? '<p class="site-desc">' + escapeHtml(o.description) + '</p>' : '') +
    '<ul class="page-list">' +
    items +
    '</ul>';

  return buildDocument({
    title: o.siteTitle,
    siteTitle: o.siteTitle,
    description: o.description,
    bodyHtml,
    toc: [],
    flags: {},
    pagePath: 'index.html',
    generatedAt: o.generatedAt,
  });
}

module.exports = { renderPage, renderIndex };
