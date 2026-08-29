'use strict';
// KMD Studio API layer: route dispatch + directly-testable methods.
// Contract: docs/studio-contract.md "src/studio/api.js".
const fs = require('node:fs');
const path = require('node:path');
const { scaffold } = require('../scaffold');
const { buildSite } = require('../compiler');
const { countTokens } = require('../tokens');
const { resolveProvider, runPrompt } = require('../ai');

const VERSION = '0.1.0';
const RECENTS_MAX = 8;

// Fixed Chinese instruction templates for the non-custom AI actions.
// Each wraps the selected text (`context`); `custom` passes prompt verbatim.
const AI_ACTIONS = {
  polish: (ctx) =>
    `请润色下面这段 Markdown 文本，修正语病、提升表达，保持原有结构与含义不变。只输出润色后的 Markdown，不要输出任何解释。\n\n${ctx}`,
  continue: (ctx) =>
    `请续写下面这段 Markdown 文本，保持原有的风格、语气与格式。只输出续写的内容，不要重复已有文本，不要输出任何解释。\n\n${ctx}`,
  'translate-en': (ctx) =>
    `请将下面这段 Markdown 文本翻译成英文，保持 Markdown 格式与结构（标题、列表、代码块、链接等）不变。只输出翻译结果，不要输出任何解释。\n\n${ctx}`,
  summarize: (ctx) =>
    `请将下面这段 Markdown 文本总结为要点列表，只输出 Markdown 无序列表，每条要点一句话，不要输出任何解释。\n\n${ctx}`,
};

// Error carrying an HTTP status; handle() maps it to { error } JSON.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Case-normalized absolute path (Windows paths from the fs browser arrive as
// C:\... and the FS is case-insensitive; normalize both sides before comparing).
function normalizeAbs(p) {
  const abs = path.resolve(String(p));
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// createApi({ cwd, env, onLog, onShutdown }) -> { handle, status, listFs,
// openProject, createProject, currentProject, fileTree, readFile, writeFile,
// newFile, renameFile, deleteFile, build, aiComplete, shutdown }
// Direct methods return the success payload; failures throw httpError(status).
function createApi(opts = {}) {
  const { cwd = process.cwd(), env = process.env, onLog = () => {} } = opts;
  const onShutdown = typeof opts.onShutdown === 'function' ? opts.onShutdown : () => {};

  let project = null; // { path, name } | null
  const recentsFile = path.join(cwd, '.kmd-studio.json');
  let recents = loadRecents();

  function loadRecents() {
    try {
      const data = JSON.parse(fs.readFileSync(recentsFile, 'utf8'));
      if (data && Array.isArray(data.recents)) {
        return data.recents
          .filter((r) => r && typeof r.path === 'string')
          .map((r) => ({ path: r.path, name: typeof r.name === 'string' ? r.name : path.basename(r.path) }))
          .slice(0, RECENTS_MAX);
      }
    } catch {
      // missing or corrupt -> start empty
    }
    return [];
  }

  function saveRecents() {
    try {
      fs.writeFileSync(recentsFile, JSON.stringify({ recents }, null, 2), 'utf8');
    } catch {
      // best-effort persistence only
    }
  }

  function pushRecent(p) {
    const norm = normalizeAbs(p.path);
    recents = recents.filter((r) => normalizeAbs(r.path) !== norm);
    recents.unshift({ path: p.path, name: p.name });
    if (recents.length > RECENTS_MAX) recents.length = RECENTS_MAX;
    saveRecents();
  }

  function requireProject() {
    if (!project) throw httpError(400, 'no-project');
    return project;
  }

  // Resolve a POSIX-style rel path inside the open project; traversal-safe.
  function resolveInProject(rel) {
    const p = requireProject();
    if (typeof rel !== 'string' || rel.length === 0) throw httpError(400, '缺少 path');
    const abs = path.resolve(p.path, rel);
    const root = normalizeAbs(p.path);
    const norm = normalizeAbs(abs);
    if (norm !== root && !norm.startsWith(root + path.sep)) {
      throw httpError(400, `路径越出项目目录：${rel}`);
    }
    return abs;
  }

  function assertMd(abs, rel) {
    if (!abs.toLowerCase().endsWith('.md')) throw httpError(400, `只允许 .md 文件：${rel}`);
  }

  function status() {
    const provider = resolveProvider(env);
    return {
      version: VERSION,
      cwd,
      provider: {
        baseUrl: provider.baseUrl,
        model: provider.model,
        hasKey: provider.hasKey,
        keyPreview:
          provider.hasKey && provider.apiKey
            ? `${provider.apiKey.slice(0, 7)}…${provider.apiKey.slice(-4)}`
            : null,
      },
    };
  }

  // listFs(dirPath): no path -> drive list (Windows); else directories only.
  function listFs(dirPath) {
    if (!dirPath) {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        if (fs.existsSync(d)) drives.push(d);
      }
      return { drives };
    }
    const abs = path.resolve(String(dirPath));
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      throw httpError(400, `无法读取目录 ${abs}：${err.message}`);
    }
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      dirs.push({ name: e.name, path: path.join(abs, e.name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(abs);
    return { path: abs, parent: parent === abs ? null : parent, dirs, files: [] };
  }

  function hasAnyMarkdown(root) {
    let found = false;
    (function walk(dir) {
      if (found) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found) return;
        if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules' || e.name === 'site') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) found = true;
      }
    })(root);
    return found;
  }

  async function openProject(dirPath) {
    if (typeof dirPath !== 'string' || dirPath.length === 0) throw httpError(400, '缺少 path');
    const abs = path.resolve(dirPath);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      throw httpError(400, `目录不存在：${abs}`);
    }
    if (!st.isDirectory()) throw httpError(400, `不是目录：${abs}`);
    project = { path: abs, name: path.basename(abs) };
    pushRecent(project);
    return { project, hasDocs: hasAnyMarkdown(abs) };
  }

  async function createProject(dirPath) {
    if (typeof dirPath !== 'string' || dirPath.length === 0) throw httpError(400, '缺少 path');
    const abs = path.resolve(dirPath);
    try {
      scaffold(abs);
    } catch (err) {
      throw httpError(400, err && err.message ? err.message : String(err));
    }
    return openProject(abs);
  }

  function currentProject() {
    return { project, recents: recents.map((r) => ({ path: r.path, name: r.name })) };
  }

  // Recursive *.md tree: dirs first, skip dotfiles/_-prefix/node_modules/site.
  function fileTree() {
    const p = requireProject();
    function walk(dir, relBase) {
      const nodes = [];
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return nodes; // unreadable dir -> empty subtree
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules' || e.name === 'site') continue;
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        if (e.isDirectory()) {
          nodes.push({ name: e.name, rel, type: 'dir', children: walk(path.join(dir, e.name), rel) });
        } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
          nodes.push({ name: e.name, rel, type: 'file' });
        }
      }
      nodes.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      );
      return nodes;
    }
    return { tree: walk(p.path, '') };
  }

  function readFile(rel) {
    const abs = resolveInProject(rel);
    let content;
    try {
      content = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      throw httpError(400, `无法读取文件 ${rel}：${err.message}`);
    }
    return { content, tokens: countTokens(content) };
  }

  function writeFile(rel, content) {
    const abs = resolveInProject(rel);
    assertMd(abs, rel);
    const text = typeof content === 'string' ? content : String(content ?? '');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
    return { ok: true, tokens: countTokens(text) };
  }

  function newFile(rel) {
    const abs = resolveInProject(rel);
    assertMd(abs, rel);
    if (fs.existsSync(abs)) throw httpError(400, `文件已存在：${rel}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, '# 标题\n', 'utf8');
    return { ok: true };
  }

  function renameFile(from, to) {
    const absFrom = resolveInProject(from);
    const absTo = resolveInProject(to);
    assertMd(absTo, to);
    try {
      fs.mkdirSync(path.dirname(absTo), { recursive: true });
      fs.renameSync(absFrom, absTo);
    } catch (err) {
      throw httpError(400, `重命名失败：${err.message}`);
    }
    return { ok: true };
  }

  function deleteFile(rel) {
    const abs = resolveInProject(rel);
    try {
      fs.rmSync(abs);
    } catch (err) {
      throw httpError(400, `删除失败：${err.message}`);
    }
    return { ok: true };
  }

  // Build the open project: srcDir = project root, outDir = <project>/site,
  // outDir excluded from the md walk so site/*.md copies are never recompiled.
  async function build() {
    const p = requireProject(); // 400 when no project open
    const outDir = path.join(p.path, 'site');
    const useAi = resolveProvider(env).hasKey;
    const t0 = Date.now();
    const r = await buildSite(p.path, {
      outDir,
      excludeDirs: [outDir],
      useAi,
      useCache: true,
      cacheDir: path.join(p.path, '.kmd-cache'),
      env,
      onLog,
    });
    return {
      pages: r.pages.length,
      ms: Date.now() - t0,
      ai: r.aiTotals,
      indexUrl: '/preview/index.html',
    };
  }

  // aiComplete({ prompt, context, action }) -> { markdown } | { error }.
  // runPrompt failures are client-friendly: still HTTP 200 with { error };
  // 'no-api-key' passes through verbatim.
  async function aiComplete(body = {}) {
    const { prompt, context, action = 'custom' } = body;
    let finalPrompt;
    if (action === 'custom') {
      finalPrompt = typeof prompt === 'string' ? prompt : String(prompt ?? '');
    } else if (AI_ACTIONS[action]) {
      finalPrompt = AI_ACTIONS[action](typeof context === 'string' ? context : String(context ?? ''));
    } else {
      throw httpError(400, `未知 action：${action}`);
    }
    try {
      const markdown = await runPrompt(finalPrompt, { env });
      return { markdown };
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  }

  // Respond first; close + exit 150ms later (onShutdown supplied by server.js).
  async function shutdown() {
    setTimeout(() => {
      try {
        onShutdown();
      } catch {
        // still exit
      }
      process.exit(0);
    }, 150);
    return { ok: true };
  }

  // Low-level route dispatch used by server.js (body already JSON-parsed).
  async function handle(req, res, body) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = req.method;
    const b = body && typeof body === 'object' ? body : {};
    try {
      if (method === 'GET' && pathname === '/api/status') return sendJson(res, 200, status());
      if (method === 'GET' && pathname === '/api/fs/list') return sendJson(res, 200, listFs(url.searchParams.get('path')));
      if (method === 'POST' && pathname === '/api/project/open') return sendJson(res, 200, await openProject(b.path));
      if (method === 'POST' && pathname === '/api/project/create') return sendJson(res, 200, await createProject(b.path));
      if (method === 'GET' && pathname === '/api/project/current') return sendJson(res, 200, currentProject());
      if (method === 'GET' && pathname === '/api/files') return sendJson(res, 200, fileTree());
      if (method === 'GET' && pathname === '/api/file') return sendJson(res, 200, readFile(url.searchParams.get('path')));
      if (method === 'POST' && pathname === '/api/file') return sendJson(res, 200, writeFile(b.path, b.content));
      if (method === 'POST' && pathname === '/api/file/new') return sendJson(res, 200, newFile(b.path));
      if (method === 'POST' && pathname === '/api/file/rename') return sendJson(res, 200, renameFile(b.from, b.to));
      if (method === 'POST' && pathname === '/api/file/delete') return sendJson(res, 200, deleteFile(b.path));
      if (method === 'POST' && pathname === '/api/build') return sendJson(res, 200, await build());
      if (method === 'POST' && pathname === '/api/ai/complete') return sendJson(res, 200, await aiComplete(b));
      if (method === 'POST' && pathname === '/api/heartbeat') return sendJson(res, 200, { ok: true });
      if (method === 'POST' && pathname === '/api/shutdown') return sendJson(res, 200, await shutdown());
      return sendJson(res, 404, { error: 'not-found' });
    } catch (err) {
      const statusCode = err && err.status ? err.status : 500;
      return sendJson(res, statusCode, { error: err && err.message ? err.message : String(err) });
    }
  }

  return {
    handle,
    status,
    listFs,
    openProject,
    createProject,
    currentProject,
    fileTree,
    readFile,
    writeFile,
    newFile,
    renameFile,
    deleteFile,
    build,
    aiComplete,
    shutdown,
  };
}

module.exports = { createApi };
