'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { highlight } = require('../src/highlight');

test('js: keywords, strings, numbers, comments, functions', () => {
  const html = highlight('const x = "hi"; // note\nfoo(42);', 'js');
  assert.ok(html.includes('<span class="tk-kw">const</span>'));
  assert.ok(html.includes('<span class="tk-str">&quot;hi&quot;</span>'));
  assert.ok(html.includes('<span class="tk-com">// note</span>'));
  assert.ok(html.includes('<span class="tk-fn">foo</span>'));
  assert.ok(html.includes('<span class="tk-num">42</span>'));
});

test('js: output is fully escaped', () => {
  const html = highlight('if (a < b) { x = ">" }', 'js');
  assert.ok(!html.includes('a < b'));
  assert.ok(html.includes('&lt;'));
  assert.ok(html.includes('&gt;'));
  assert.ok(html.includes('&quot;'));
});

test('json: keys, strings, numbers, booleans', () => {
  const html = highlight('{"a": 1, "b": "x", "c": true}', 'json');
  assert.ok(html.includes('<span class="tk-key">&quot;a&quot;</span>'));
  assert.ok(html.includes('<span class="tk-num">1</span>'));
  assert.ok(html.includes('<span class="tk-str">&quot;x&quot;</span>'));
  assert.ok(html.includes('<span class="tk-kw">true</span>'));
});

test('python: keywords, comments, strings, functions', () => {
  const html = highlight('def f(x):\n    # c\n    return "s"', 'python');
  assert.ok(html.includes('<span class="tk-kw">def</span>'));
  assert.ok(html.includes('<span class="tk-fn">f</span>'));
  assert.ok(html.includes('<span class="tk-com"># c</span>'));
  assert.ok(html.includes('<span class="tk-kw">return</span>'));
  assert.ok(html.includes('<span class="tk-str">&quot;s&quot;</span>'));
});

test('html: tags, attributes, values, escaping', () => {
  const html = highlight('<div class="x">hi</div>', 'html');
  assert.ok(html.includes('<span class="tk-tag">&lt;div</span>'));
  assert.ok(html.includes('<span class="tk-attr">class</span>'));
  assert.ok(html.includes('<span class="tk-val">&quot;x&quot;</span>'));
  assert.ok(html.includes('</span>hi<span'));
  assert.ok(!html.includes('<div'));
});

test('bash: comments, keywords, strings', () => {
  const html = highlight('# c\nif [ -f x ]; then\necho "hi"\nfi', 'bash');
  assert.ok(html.includes('<span class="tk-com"># c</span>'));
  assert.ok(html.includes('<span class="tk-kw">if</span>'));
  assert.ok(html.includes('<span class="tk-str">&quot;hi&quot;</span>'));
});

test('diff: add/del/hunk lines', () => {
  const html = highlight('@@ -1 +1 @@\n-old\n+new\n same', 'diff');
  assert.ok(html.includes('<span class="tk-fn">@@ -1 +1 @@</span>'));
  assert.ok(html.includes('<span class="tk-del">-old</span>'));
  assert.ok(html.includes('<span class="tk-add">+new</span>'));
  assert.ok(html.includes('\n same'));
});

test('aliases share implementations', () => {
  const code = 'const a = 1; // x';
  assert.equal(highlight(code, 'jsx'), highlight(code, 'js'));
  assert.equal(highlight('def f(): pass', 'py'), highlight('def f(): pass', 'python'));
  assert.equal(highlight('echo hi', 'sh'), highlight('echo hi', 'bash'));
  assert.equal(highlight('a: 1', 'yml'), highlight('a: 1', 'yaml'));
});

test('unknown language: escaped plain text, no spans', () => {
  const html = highlight('foo <bar> & "baz"', 'cobol');
  assert.equal(html, 'foo &lt;bar&gt; &amp; &quot;baz&quot;');
  assert.ok(!html.includes('<span'));
  assert.equal(highlight('x', ''), 'x');
  assert.equal(highlight(null, 'js'), '');
});

test('css, yaml, sql, md, go, rust, c, java produce spans', () => {
  assert.ok(highlight('.a { color: #fff; }', 'css').includes('tk-'));
  assert.ok(highlight('key: value # c', 'yaml').includes('<span class="tk-key">key</span>'));
  assert.ok(highlight('SELECT * FROM t', 'sql').includes('<span class="tk-kw">SELECT</span>'));
  assert.ok(highlight('# Title\n\n- item', 'md').includes('tk-kw'));
  assert.ok(highlight('func main() {}', 'go').includes('<span class="tk-kw">func</span>'));
  assert.ok(highlight('fn main() {}', 'rust').includes('<span class="tk-kw">fn</span>'));
  assert.ok(highlight('int main() { return 0; }', 'c').includes('<span class="tk-kw">int</span>'));
  assert.ok(highlight('public class A {}', 'java').includes('<span class="tk-kw">class</span>'));
});

test('adversarial input does not blow up', () => {
  const nasty = '"'.repeat(2000) + '('.repeat(2000) + 'a'.repeat(2000) + '*'.repeat(2000);
  for (const lang of ['js', 'json', 'python', 'html', 'css', 'yaml', 'bash', 'sql']) {
    const start = Date.now();
    const out = highlight(nasty, lang);
    assert.equal(typeof out, 'string');
    assert.ok(Date.now() - start < 1000, lang + ' too slow');
  }
});
