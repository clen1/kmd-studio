'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdown } = require('../src/parser');

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

test('frontmatter: types, arrays, quotes', () => {
  const src = [
    '---',
    'title: My Doc',
    'draft: false',
    'published: true',
    'views: 42',
    'ratio: 0.5',
    'tags: [a, b, 3]',
    'list: x, y',
    'quoted: "hi, there"',
    '---',
    '',
    'body',
  ].join('\n');
  const r = parseMarkdown(src);
  assert.equal(r.meta.title, 'My Doc');
  assert.equal(r.meta.draft, false);
  assert.equal(r.meta.published, true);
  assert.equal(r.meta.views, 42);
  assert.equal(r.meta.ratio, 0.5);
  assert.deepEqual(r.meta.tags, ['a', 'b', 3]);
  assert.deepEqual(r.meta.list, ['x', 'y']);
  assert.equal(r.meta.quoted, 'hi, there');
  assert.equal(r.html, '<p>body</p>');
});

test('frontmatter: absent and unterminated', () => {
  assert.deepEqual(parseMarkdown('# hi').meta.title, 'hi');
  const r = parseMarkdown('---\ntitle: nope\n'); // no closing ---
  assert.deepEqual(r.meta, {});
});

test('meta.title falls back to first h1 only', () => {
  assert.equal(parseMarkdown('# Hello *World*').meta.title, 'Hello World');
  const r = parseMarkdown('---\ntitle: Set\n---\n\n# Ignored\n');
  assert.equal(r.meta.title, 'Set');
});

// ---------------------------------------------------------------------------
// Headings: slugs, anchors, toc
// ---------------------------------------------------------------------------

test('headings: slug rules, anchors, dedupe, toc h2/h3 only', () => {
  const src = '# Top\n\n## Hello, World!\n\n## Hello World\n\n### 你好 世界\n\n#### deep\n';
  const r = parseMarkdown(src);
  assert.deepEqual(r.toc, [
    { level: 2, text: 'Hello, World!', id: 'hello-world' },
    { level: 2, text: 'Hello World', id: 'hello-world-1' },
    { level: 3, text: '你好 世界', id: '你好-世界' },
  ]);
  assert.ok(r.html.includes('<h2 id="hello-world">Hello, World!<a class="heading-anchor" href="#hello-world" aria-hidden="true">#</a></h2>'));
  assert.ok(r.html.includes('<h3 id="你好-世界">'));
  assert.ok(r.html.includes('<h4 id="deep">'));
});

test('heading: closing hashes stripped, no space no heading', () => {
  const r = parseMarkdown('## title ##\n\n##not a heading\n');
  assert.ok(r.html.includes('<h2 id="title">title<'));
  assert.ok(r.html.includes('<p>##not a heading</p>'));
});

// ---------------------------------------------------------------------------
// Inline constructs
// ---------------------------------------------------------------------------

test('inline: strong, em, nested, del', () => {
  const h = (s) => parseMarkdown(s).html;
  assert.equal(h('**bold**'), '<p><strong>bold</strong></p>');
  assert.equal(h('__bold__'), '<p><strong>bold</strong></p>');
  assert.equal(h('*em*'), '<p><em>em</em></p>');
  assert.equal(h('_em_'), '<p><em>em</em></p>');
  assert.equal(h('~~del~~'), '<p><del>del</del></p>');
  assert.equal(h('**bold and *em* text**'), '<p><strong>bold and <em>em</em> text</strong></p>');
  assert.equal(h('*em and **bold** text*'), '<p><em>em and <strong>bold</strong> text</em></p>');
  assert.equal(h('**bold *em***'), '<p><strong>bold <em>em</em></strong></p>');
});

test('inline: underscore not intra-word', () => {
  const h = (s) => parseMarkdown(s).html;
  assert.equal(h('a_b_c'), '<p>a_b_c</p>');
  assert.equal(h('foo_bar_baz and _yes_'), '<p>foo_bar_baz and <em>yes</em></p>');
});

test('inline: code spans, variable-length fences', () => {
  const h = (s) => parseMarkdown(s).html;
  assert.equal(h('`code`'), '<p><code>code</code></p>');
  assert.equal(h('`a`b`'), '<p><code>a</code>b`</p>');
  assert.equal(h('``a ` b``'), '<p><code>a ` b</code></p>');
  assert.equal(h('`<b>&`'), '<p><code>&lt;b&gt;&amp;</code></p>');
  assert.equal(h('`unclosed'), '<p>`unclosed</p>');
});

test('inline: backslash escapes', () => {
  const h = (s) => parseMarkdown(s).html;
  assert.equal(h('\\*not em\\*'), '<p>*not em*</p>');
  assert.equal(h('\\\\ backslash'), '<p>\\ backslash</p>');
  assert.equal(h('\\a letter'), '<p>\\a letter</p>');
});

test('inline: links, images, titles', () => {
  const h = (s) => parseMarkdown(s).html;
  assert.equal(h('[t](http://x.com)'), '<p><a href="http://x.com">t</a></p>');
  assert.equal(h('[t](http://x.com "T")'), '<p><a href="http://x.com" title="T">t</a></p>');
  assert.equal(h('[*em*](http://x.com)'), '<p><a href="http://x.com"><em>em</em></a></p>');
  assert.equal(h('![alt](img.png)'), '<p class="img-only"><img src="img.png" alt="alt"></p>');
  assert.equal(h('a ![alt](i.png "T") b'), '<p>a <img src="i.png" alt="alt" title="T"> b</p>');
  assert.equal(h('[bad](no close'), '<p>[bad](no close</p>');
});

test('inline: bare autolinks strip trailing punctuation', () => {
  const h = (s) => parseMarkdown(s).html;
  assert.equal(
    h('see https://example.com/a?b=1.'),
    '<p>see <a href="https://example.com/a?b=1">https://example.com/a?b=1</a>.</p>');
  assert.equal(h('wordhttp://x.com'), '<p>wordhttp://x.com</p>');
});

test('inline: hard break on trailing two spaces', () => {
  assert.equal(parseMarkdown('one  \ntwo').html, '<p>one<br>\ntwo</p>');
  assert.equal(parseMarkdown('one\ntwo').html, '<p>one\ntwo</p>');
});

test('inline: raw HTML is escaped (safe by default)', () => {
  const r = parseMarkdown('<script>alert(1)</script>');
  assert.equal(r.html, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  assert.ok(!r.html.includes('<script>'));
});

test('inline: javascript: URLs are neutralized', () => {
  assert.ok(parseMarkdown('[x](javascript:alert(1))').html.includes('href="#"'));
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

test('lists: nested by indentation, ordered start', () => {
  const r = parseMarkdown('- a\n  - b1\n  - b2\n- c\n');
  assert.ok(r.html.includes('<ul>'));
  assert.ok(r.html.includes('<li>a\n<ul>\n<li>b1</li>\n<li>b2</li>\n</ul></li>'));
  assert.ok(r.html.includes('<li>c</li>'));
  const ol = parseMarkdown('3. three\n4. four\n');
  assert.ok(ol.html.startsWith('<ol start="3">'));
});

test('lists: loose list keeps paragraphs, mixed content', () => {
  const r = parseMarkdown('- a\n\n- b\n');
  assert.ok(r.html.includes('<li><p>a</p></li>'));
  assert.ok(r.html.includes('<li><p>b</p></li>'));
});

test('lists: task items checked and unchecked', () => {
  const r = parseMarkdown('- [x] done\n- [ ] todo\n');
  assert.ok(r.html.includes('<li class="task-list-item"><input type="checkbox" disabled checked> done</li>'));
  assert.ok(r.html.includes('<li class="task-list-item"><input type="checkbox" disabled> todo</li>'));
});

// ---------------------------------------------------------------------------
// Blockquotes & callouts
// ---------------------------------------------------------------------------

test('blockquotes: nesting', () => {
  const r = parseMarkdown('> outer\n> > inner\n');
  assert.ok(r.html.includes('<blockquote>\n<p>outer</p>\n<blockquote>\n<p>inner</p>\n</blockquote>\n</blockquote>'));
});

test('callouts: all five types with default titles', () => {
  const titles = { note: 'Note', tip: 'Tip', important: 'Important', warning: 'Warning', caution: 'Caution' };
  for (const [type, title] of Object.entries(titles)) {
    const r = parseMarkdown('> [!' + type + ']\n> body\n');
    assert.ok(
      r.html.includes('<div class="callout callout-' + type + '"><p class="callout-title">' + title + '</p>\n<p>body</p>\n</div>'),
      type + ': ' + r.html);
  }
});

test('callouts: custom title, case-insensitive', () => {
  const r = parseMarkdown('> [!WARNING] Watch out\n> body\n');
  assert.ok(r.html.includes('<div class="callout callout-warning"><p class="callout-title">Watch out</p>'));
});

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

test('tables: alignment, wrap, escaping in cells', () => {
  const src = '| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n';
  const r = parseMarkdown(src);
  assert.ok(r.html.includes('<div class="table-wrap"><table>'));
  assert.ok(r.html.includes('<th style="text-align:left">a</th>'));
  assert.ok(r.html.includes('<th style="text-align:center">b</th>'));
  assert.ok(r.html.includes('<th style="text-align:right">c</th>'));
  assert.ok(r.html.includes('<td style="text-align:left">1</td>'));
  assert.ok(r.html.includes('</tbody>'));
});

test('tables: not a table without header pipe', () => {
  const r = parseMarkdown('foo\n---\n');
  assert.ok(!r.html.includes('<table>'));
});

// ---------------------------------------------------------------------------
// Code fences, AI fences, mermaid
// ---------------------------------------------------------------------------

test('code fences: lang, highlighting, no-lang, tilde fences', () => {
  const js = parseMarkdown('```js\nconst a = 1;\n```\n');
  assert.ok(js.html.includes('<pre class="codeblock" data-lang="js"><code>'));
  assert.ok(js.html.includes('<span class="tk-kw">const</span>'));
  const plain = parseMarkdown('```\nplain <x>\n```\n');
  assert.ok(plain.html.includes('<pre class="codeblock"><code>plain &lt;x&gt;</code></pre>'));
  const tilde = parseMarkdown('~~~python\nprint(1)\n~~~\n');
  assert.ok(tilde.html.includes('data-lang="python"'));
});

test('code fences: unknown language still wrapped, escaped', () => {
  const r = parseMarkdown('```cobol\nA < B\n```\n');
  assert.ok(r.html.includes('<pre class="codeblock" data-lang="cobol"><code>A &lt; B</code></pre>'));
  assert.ok(!r.html.includes('<span'));
});

test('ai fences: placeholder, prompt, config parsing', () => {
  const r = parseMarkdown('```ai model=kimi-k2 temperature=0.3\nSummarize this.\n```\n');
  assert.ok(r.html.includes('<!--AI_BLOCK:0-->'));
  assert.equal(r.aiBlocks.length, 1);
  assert.deepEqual(r.aiBlocks[0], {
    id: 0,
    prompt: 'Summarize this.',
    config: { model: 'kimi-k2', temperature: 0.3 },
  });
  assert.equal(typeof r.aiBlocks[0].config.temperature, 'number');
  const two = parseMarkdown('```ai\none\n```\n\n```ai model=x\ntwo\n```\n');
  assert.equal(two.aiBlocks.length, 2);
  assert.ok(two.html.includes('<!--AI_BLOCK:0-->') && two.html.includes('<!--AI_BLOCK:1-->'));
  assert.deepEqual(two.aiBlocks[0].config, {});
});

test('ai fences with allowAi:false render as code blocks', () => {
  const r = parseMarkdown('```ai model=x\nSummarize\n```\n', { allowAi: false });
  assert.deepEqual(r.aiBlocks, []);
  assert.ok(!r.html.includes('AI_BLOCK'));
  assert.ok(r.html.includes('<pre class="codeblock" data-lang="ai"><code>Summarize</code></pre>'));
});

test('mermaid fence -> pre.mermaid + flag', () => {
  const r = parseMarkdown('```mermaid\ngraph TD\n```\n');
  assert.ok(r.html.includes('<pre class="mermaid">graph TD</pre>'));
  assert.equal(r.flags.mermaid, true);
  assert.equal(parseMarkdown('# x').flags.mermaid, false);
});

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

test('math: inline and display, flags, escaping', () => {
  const r = parseMarkdown('inline $e^x$ here\n\n$$\nx = 1 < 2\n$$\n');
  assert.ok(r.html.includes('<span class="math math-inline">\\(e^x\\)</span>'));
  assert.ok(r.html.includes('<div class="math math-display">\\[x = 1 &lt; 2\\]</div>'));
  assert.equal(r.flags.math, true);
  assert.equal(parseMarkdown('# x').flags.math, false);
  // currency stays literal
  assert.ok(parseMarkdown('$5 and $6').html.includes('$5 and $6'));
});

// ---------------------------------------------------------------------------
// Footnotes
// ---------------------------------------------------------------------------

test('footnotes: refs, numbering, section, multi-line defs', () => {
  const src = 'Text[^a] and more[^b].\n\n[^a]: First note\n[^b]: Second note\n    continued line\n';
  const r = parseMarkdown(src);
  assert.ok(r.html.includes('<sup class="footnote-ref" id="fnref-a"><a href="#fn-a">1</a></sup>'));
  assert.ok(r.html.includes('<sup class="footnote-ref" id="fnref-b"><a href="#fn-b">2</a></sup>'));
  assert.ok(r.html.includes('<section class="footnotes"><hr><ol>'));
  assert.ok(r.html.includes('<li id="fn-a">First note <a class="footnote-backref" href="#fnref-a">↩</a></li>'));
  assert.ok(r.html.includes('continued line'));
  assert.ok(r.html.indexOf('footnotes') > r.html.indexOf('Text'));
});

test('footnotes: defs inside code fences are not extracted', () => {
  const r = parseMarkdown('```\n[^x]: not a def\n```\n');
  assert.ok(!r.html.includes('footnotes'));
  assert.ok(r.html.includes('[^x]: not a def'));
});

// ---------------------------------------------------------------------------
// HR, misc
// ---------------------------------------------------------------------------

test('hr only after blank line or at document start', () => {
  assert.ok(parseMarkdown('a\n\n---\n').html.includes('<hr>'));
  assert.ok(parseMarkdown('---\n').html.includes('<hr>'));
  assert.ok(!parseMarkdown('a\n---\n').html.includes('<hr>'));
});

test('empty and weird input never throws', () => {
  assert.equal(parseMarkdown('').html, '');
  assert.equal(parseMarkdown(null).html, '');
  assert.equal(parseMarkdown('\n\n\n').html, '');
  assert.equal(parseMarkdown('***\n\n**a\n\n` `\n').flags.math, false);
});
