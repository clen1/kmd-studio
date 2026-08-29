'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildFile, buildSite } = require('../src/compiler');

// No network in these tests: useAi:false never touches ai.js, and the
// no-key path must short-circuit before any fetch. The success-path test
// seeds a disk cache entry so ai.js answers without fetching.

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
}

const AI_PROMPT = '用三句话总结 KMD。';

const INDEX_MD = `---
title: 首页
description: 测试首页
---

# 你好 KMD

一段正文。

\`\`\`ai
${AI_PROMPT}
\`\`\`
`;

const GUIDE_MD = `# 指南

\`\`\`js
const x = 1;
\`\`\`
`;

const DEEP_MD = `# 深层页面

内容。
`;

function makeSite() {
  const dir = tmp('kmd-src-');
  write(path.join(dir, 'index.md'), INDEX_MD);
  write(path.join(dir, 'guide.md'), GUIDE_MD);
  write(path.join(dir, 'sub', 'deep.md'), DEEP_MD);
  write(path.join(dir, '_draft.md'), '# 草稿\n'); // must be skipped
  write(path.join(dir, '.hidden.md'), '# 隐藏\n'); // must be skipped
  return dir;
}

test('buildSite useAi:false: html+md written, subdirs mirrored, llms.txt, --no-ai offline wrapper', async () => {
  const src = makeSite();
  const out = path.join(tmp('kmd-out-'), 'site');
  fs.mkdirSync(out, { recursive: true });
  write(path.join(out, 'junk.txt'), 'junk'); // must be cleaned by buildSite

  const r = await buildSite(src, { outDir: out, siteTitle: '测试站', useAi: false, env: {} });

  assert.equal(r.outDir, out);
  assert.ok(!fs.existsSync(path.join(out, 'junk.txt')), 'outDir was not cleaned');

  for (const p of [
    'index.html',
    'index.md',
    'guide.html',
    'guide.md',
    path.join('sub', 'deep.html'),
    path.join('sub', 'deep.md'),
  ]) {
    assert.ok(fs.existsSync(path.join(out, p)), `missing output ${p}`);
  }
  // original source copied verbatim
  assert.equal(fs.readFileSync(path.join(out, 'index.md'), 'utf8'), INDEX_MD);
  // skipped inputs produced nothing
  assert.ok(!fs.existsSync(path.join(out, '_draft.html')));
  assert.ok(!fs.existsSync(path.join(out, '.hidden.html')));

  // root index.md exists -> it is the index page; pages sorted by url
  assert.deepEqual(
    r.pages.map((p) => p.url),
    ['guide.html', 'index.html', 'sub/deep.html'],
  );
  const indexPage = r.pages.find((p) => p.url === 'index.html');
  assert.equal(indexPage.title, '首页');
  assert.equal(indexPage.description, '测试首页');
  for (const p of r.pages) assert.ok(Number.isInteger(p.tokens) && p.tokens > 0);

  // llms.txt links each page's .md relative path
  const llms = fs.readFileSync(path.join(out, 'llms.txt'), 'utf8');
  assert.equal(llms, r.llmsTxt);
  assert.match(llms, /# 测试站/);
  assert.match(llms, /\(index\.md\)/);
  assert.match(llms, /\(guide\.md\)/);
  assert.match(llms, /\(sub\/deep\.md\)/);

  // ai fence -> offline wrapper with the --no-ai note; no placeholder left
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(!html.includes('<!--AI_BLOCK'), 'placeholder left in html');
  assert.match(html, /<section class="ai-block ai-offline">/);
  assert.match(html, /构建时使用了 --no-ai，AI 块未执行。/);
  assert.match(html, /<details class="ai-prompt"><summary>查看 Prompt<\/summary><pre>用三句话总结 KMD。<\/pre>/);

  assert.deepEqual(r.aiTotals, { total: 1, cached: 0, ran: 0, errors: 0 });
});

test('buildSite useAi:true without API key: no-api-key offline wrapper, error counted', async () => {
  const src = makeSite();
  const out = path.join(tmp('kmd-out-'), 'site');
  // env:{} guarantees no key regardless of the developer's shell
  const r = await buildSite(src, { outDir: out, useAi: true, useCache: false, env: {} });

  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(!html.includes('<!--AI_BLOCK'), 'placeholder left in html');
  assert.match(html, /<section class="ai-block ai-offline">/);
  assert.match(html, /未配置 API Key，编译时跳过。设置 KMD_AI_API_KEY 后重新构建即可生成内容。/);

  assert.equal(r.aiTotals.total, 1);
  assert.equal(r.aiTotals.errors, 1);
  assert.equal(r.aiTotals.ran, 0);
  assert.equal(r.aiTotals.cached, 0);
});

test('buildSite useAi:true with seeded cache: success wrapper renders block markdown', async () => {
  const src = makeSite();
  const out = path.join(tmp('kmd-out-'), 'site');
  const cacheDir = path.join(out, '.kmd-cache');

  // Pre-seed the exact cache entry ai.js would write (contract: sha256 of
  // model + '\n' + prompt -> { model, prompt, markdown, at }).
  const model = 'kimi-k2-0905-preview';
  const key = crypto.createHash('sha256').update(`${model}\n${AI_PROMPT}`).digest('hex');
  write(
    path.join(cacheDir, `${key}.json`),
    JSON.stringify({ model, prompt: AI_PROMPT, markdown: '这是 **AI** 生成的要点。', at: new Date().toISOString() }),
  );

  const r = await buildSite(src, {
    outDir: out,
    useAi: true,
    useCache: true,
    cacheDir,
    env: { KMD_AI_API_KEY: 'sk-test-only' }, // cache hit must not fetch
  });

  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /<section class="ai-block"><div class="ai-block-badge">✦ AI<\/div><div class="ai-block-content">/);
  assert.match(html, /<strong>AI<\/strong>/); // block markdown rendered
  assert.ok(!html.includes('<section class="ai-block ai-offline">'), 'unexpected offline wrapper');
  assert.equal(r.aiTotals.cached, 1);
  assert.equal(r.aiTotals.errors, 0);
});

test('buildSite without root index.md: renderIndex generates index.html listing all pages', async () => {
  const src = tmp('kmd-src-');
  write(path.join(src, 'b.md'), '# B 页面\n');
  write(path.join(src, 'a.md'), '# A 页面\n');
  const out = path.join(tmp('kmd-out-'), 'site');

  await buildSite(src, { outDir: out, useAi: false, env: {} });

  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.match(html, /page-list/);
  assert.match(html, /a\.html/);
  assert.match(html, /b\.html/);
});

test('buildFile: single file into a mirrored subdirectory, full return shape', async () => {
  const src = makeSite();
  const out = tmp('kmd-out-');
  const r = await buildFile(path.join(src, 'sub', 'deep.md'), {
    outDir: path.join(out, 'sub'),
    siteTitle: 'T',
    description: 'D',
    useAi: false,
    env: {},
    pagePath: 'sub/deep.html',
  });

  assert.equal(r.outFile, path.join(out, 'sub', 'deep.html'));
  assert.equal(r.mdOutFile, path.join(out, 'sub', 'deep.md'));
  assert.ok(fs.existsSync(r.outFile));
  assert.ok(fs.existsSync(r.mdOutFile));
  assert.equal(fs.readFileSync(r.mdOutFile, 'utf8'), DEEP_MD);
  assert.equal(r.title, '深层页面'); // from first h1
  assert.equal(r.description, undefined); // no frontmatter description
  assert.ok(Number.isInteger(r.tokens) && r.tokens > 0);
  assert.deepEqual(r.ai, { total: 0, cached: 0, ran: 0, errors: 0 });
  assert.deepEqual(
    Object.keys(r).sort(),
    ['ai', 'description', 'flags', 'mdOutFile', 'outFile', 'title', 'tokens'],
  );
});

test('buildFile: frontmatter title wins over first h1', async () => {
  const src = tmp('kmd-src-');
  write(path.join(src, 'page.md'), '---\ntitle: 自定义标题\n---\n\n# 正文标题\n');
  const out = tmp('kmd-out-');
  const r = await buildFile(path.join(src, 'page.md'), { outDir: out, useAi: false, env: {} });
  assert.equal(r.title, '自定义标题');
});
