'use strict';
// Orchestration: md -> site. Contract: docs/contracts.md "src/compiler.js (Agent D)".
const fs = require('node:fs');
const path = require('node:path');
const { parseMarkdown } = require('./parser');
const { fillAiBlocks } = require('./ai');
const { countTokens } = require('./tokens');
const { generateLlmsTxt } = require('./llms');
const { renderPage, renderIndex } = require('./template');

const NO_KEY_NOTE = '未配置 API Key，编译时跳过。设置 KMD_AI_API_KEY 后重新构建即可生成内容。';
const NO_AI_NOTE = '构建时使用了 --no-ai，AI 块未执行。';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Posix-style relative path for URLs (Windows joins with '\').
function toPosix(p) {
  return p.split(path.sep).join('/');
}

// --- AI block wrapper HTML (exact markup from the contract; theme.css styles it) ---

function successWrapper(block) {
  // AI-generated markdown must not recurse into ai fences -> allowAi: false.
  const inner = parseMarkdown(block.markdown, { allowAi: false }).html;
  return `<section class="ai-block"><div class="ai-block-badge">✦ AI</div><div class="ai-block-content">${inner}</div></section>`;
}

function offlineWrapper(note, prompt) {
  return `<section class="ai-block ai-offline"><div class="ai-block-badge">✦ AI</div><div class="ai-block-note">${note}</div><details class="ai-prompt"><summary>查看 Prompt</summary><pre>${escapeHtml(prompt)}</pre></details></section>`;
}

function blockWrapper(block, useAi) {
  if (!useAi) return offlineWrapper(NO_AI_NOTE, block.prompt);
  if (block.error === 'no-api-key') return offlineWrapper(NO_KEY_NOTE, block.prompt);
  if (block.error) return offlineWrapper(`AI 生成失败：${escapeHtml(block.error)}`, block.prompt);
  return successWrapper(block);
}

// Replace every literal <!--AI_BLOCK:N--> placeholder with the wrapper HTML.
function replaceAiBlocks(html, aiBlocks, useAi) {
  return html.replace(/<!--AI_BLOCK:(\d+)-->/g, (literal, n) => {
    const block = aiBlocks[Number(n)];
    return block ? blockWrapper(block, useAi) : literal;
  });
}

// Remove all entries inside dir, keep the dir itself.
// The AI cache (.kmd-cache) is NOT a build artifact: preserve it so repeat
// builds keep hitting the disk cache instead of re-consuming AI quota.
function cleanDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.kmd-cache') continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

// Case-normalized absolute path for directory comparisons (Windows FS is
// case-insensitive; Studio passes excludeDirs that may differ in case).
function normalizeAbs(p) {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

// Recursively collect *.md files; skip dotfiles, node_modules, names starting
// with _, and any directory whose absolute path is in excludeDirs (v2, added
// for KMD Studio: lets buildSite run with srcDir == project root while the
// outDir (<project>/site) full of copied .md files is skipped). Default [].
function findMarkdownFiles(root, excludeDirs) {
  const excluded = new Set((excludeDirs || []).map((d) => normalizeAbs(d)));
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir -> skip, never throw on user input
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (excluded.has(normalizeAbs(full))) continue;
        walk(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  })(root);
  return out.sort();
}

// await buildFile(srcPath, opts)
// opts: { outDir, siteTitle, description, useAi = true, useCache = true,
//         cacheDir = <outDir>/.kmd-cache, env = process.env, onLog }
// (internal extra opt: pagePath — buildSite passes the site-relative html path
//  for nested pages so renderPage gets correct link depth)
// -> { outFile, mdOutFile, title, description, tokens, flags,
//      ai: { total, cached, ran, errors } }
async function buildFile(srcPath, opts = {}) {
  const {
    siteTitle = 'KMD Docs',
    description = '',
    useAi = true,
    useCache = true,
    env = process.env,
    onLog,
  } = opts;
  const outDir = opts.outDir || 'site';
  const cacheDir = opts.cacheDir || path.join(outDir, '.kmd-cache');

  const src = fs.readFileSync(srcPath, 'utf8');
  const parsed = parseMarkdown(src);
  const aiBlocks = parsed.aiBlocks || [];
  const ai = { total: aiBlocks.length, cached: 0, ran: 0, errors: 0 };

  let html = parsed.html;
  if (aiBlocks.length > 0) {
    if (useAi) {
      await fillAiBlocks(aiBlocks, { env, cacheDir, useCache, onLog });
      for (const b of aiBlocks) {
        if (b.error) ai.errors += 1;
        else if (b.fromCache) ai.cached += 1;
        else ai.ran += 1;
      }
    }
    html = replaceAiBlocks(html, aiBlocks, useAi);
  }

  const tokens = countTokens(src);
  const name = path.basename(srcPath).replace(/\.md$/i, '');
  const title = parsed.meta && parsed.meta.title ? String(parsed.meta.title) : name;
  const pageDescription = parsed.meta && parsed.meta.description != null
    ? String(parsed.meta.description)
    : undefined;

  const pageHtml = renderPage({
    title,
    description: pageDescription !== undefined ? pageDescription : description,
    siteTitle,
    bodyHtml: html,
    toc: parsed.toc || [],
    flags: parsed.flags || { mermaid: false, math: false },
    pagePath: opts.pagePath || `${name}.html`,
    generatedAt: new Date().toISOString(),
  });

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${name}.html`);
  const mdOutFile = path.join(outDir, `${name}.md`);
  fs.writeFileSync(outFile, pageHtml, 'utf8');
  fs.copyFileSync(srcPath, mdOutFile); // copy the original source verbatim

  return { outFile, mdOutFile, title, description: pageDescription, tokens, flags: parsed.flags, ai };
}

// await buildSite(srcDir, opts) — same opts as buildFile, plus:
//   excludeDirs?: string[]  absolute dir paths skipped during the *.md walk
//                           (Studio passes [outDir]; default [] keeps v1 behavior)
// -> { pages: [{ title, url, description?, tokens }], outDir, llmsTxt, aiTotals }
async function buildSite(srcDir, opts = {}) {
  const {
    siteTitle = 'KMD Docs',
    description = '',
  } = opts;
  const outDir = opts.outDir || 'site';
  const cacheDir = opts.cacheDir || path.join(outDir, '.kmd-cache');

  const files = findMarkdownFiles(srcDir, opts.excludeDirs);
  cleanDir(outDir);

  const pages = [];
  const aiTotals = { total: 0, cached: 0, ran: 0, errors: 0 };
  let hasRootIndex = false;

  for (const file of files) {
    const rel = path.relative(srcDir, file);
    const relDir = path.dirname(rel);
    const name = path.basename(file).replace(/\.md$/i, '');
    const nested = relDir !== '.';
    const pagePath = nested ? toPosix(path.join(relDir, `${name}.html`)) : `${name}.html`;
    const targetOutDir = nested ? path.join(outDir, relDir) : outDir;
    if (!nested && name === 'index') hasRootIndex = true;

    const r = await buildFile(file, {
      ...opts,
      outDir: targetOutDir,
      cacheDir,
      pagePath,
    });
    aiTotals.total += r.ai.total;
    aiTotals.cached += r.ai.cached;
    aiTotals.ran += r.ai.ran;
    aiTotals.errors += r.ai.errors;

    const page = { title: r.title, url: pagePath, tokens: r.tokens };
    if (r.description !== undefined && r.description !== '') page.description = r.description;
    pages.push(page);
  }

  pages.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  // No root index.md among inputs -> generate a listing page for ALL pages.
  if (!hasRootIndex) {
    const indexHtml = renderIndex({
      siteTitle,
      description,
      pages,
      generatedAt: new Date().toISOString(),
    });
    fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml, 'utf8');
  }

  // llms.txt always; each page's url is its .md relative path.
  const llmsPages = pages.map((p) => {
    const item = { title: p.title, url: p.url.replace(/\.html$/, '.md') };
    if (p.description !== undefined) item.description = p.description;
    return item;
  });
  const llmsTxt = generateLlmsTxt({ siteTitle, description, pages: llmsPages });
  fs.writeFileSync(path.join(outDir, 'llms.txt'), llmsTxt, 'utf8');

  return { pages, outDir, llmsTxt, aiTotals };
}

module.exports = { buildFile, buildSite };
