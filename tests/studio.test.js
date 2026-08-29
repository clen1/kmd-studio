'use strict';
// KMD Studio backend tests. Contract: docs/studio-contract.md "tests/studio.test.js".
// Direct createApi methods (not HTTP) for most coverage; one end-to-end HTTP
// test at the bottom. No network: env without key everywhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApi } = require('../src/studio/api');
const { studioServer } = require('../src/studio/server');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Assert a direct-method call rejects with an httpError carrying `status`.
async function rejects400(promise, status = 400) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.status, status, `expected status ${status}, got ${err.status} (${err.message})`);
    return true;
  });
}

test('status: shape with no-key env', async () => {
  const cwd = tmp('kmd-studio-');
  const api = createApi({ cwd, env: {} });
  const s = api.status();
  assert.equal(s.version, '0.1.0');
  assert.equal(s.cwd, cwd);
  assert.equal(s.provider.hasKey, false);
  assert.equal(s.provider.keyPreview, null);
  assert.equal(typeof s.provider.baseUrl, 'string');
  assert.equal(typeof s.provider.model, 'string');

  const keyed = createApi({ cwd, env: { KMD_AI_API_KEY: 'sk-abcd1234567890wxyz' } });
  const p = keyed.status().provider;
  assert.equal(p.hasKey, true);
  assert.equal(p.keyPreview, 'sk-abcd…wxyz');
});

test('listFs: drives, dir listing, skip rules, unreadable dir -> 400', async () => {
  const cwd = tmp('kmd-studio-');
  const api = createApi({ cwd, env: {} });

  if (process.platform === 'win32') {
    const roots = api.listFs();
    assert.ok(Array.isArray(roots.drives));
    assert.ok(roots.drives.length > 0);
    assert.ok(roots.drives.every((d) => /^[A-Z]:\\$/.test(d)));
  }

  const dir = tmp('kmd-fs-');
  fs.mkdirSync(path.join(dir, 'b-dir'));
  fs.mkdirSync(path.join(dir, 'a-dir'));
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'file.txt'), 'x'); // files are not listed

  const r = api.listFs(dir);
  assert.equal(r.path, dir);
  assert.deepEqual(
    r.dirs.map((d) => d.name),
    ['a-dir', 'b-dir'],
  );
  assert.equal(r.dirs[0].path, path.join(dir, 'a-dir'));
  assert.deepEqual(r.files, []);
  assert.equal(r.parent, path.dirname(dir));
});

test('listFs: unreadable dir rejects 400 (direct)', async () => {
  const api = createApi({ cwd: tmp('kmd-studio-'), env: {} });
  await rejects400(Promise.resolve().then(() => api.listFs(path.join(os.tmpdir(), 'kmd-no-such-dir-xyz'))));
});

test('createProject + openProject + recents dedupe and persistence', async () => {
  const cwd = tmp('kmd-studio-');
  const api = createApi({ cwd, env: {} });

  const a = path.join(cwd, 'proj-a');
  const r1 = await api.createProject(a);
  assert.equal(r1.project.path, a);
  assert.equal(r1.project.name, 'proj-a');
  assert.equal(r1.hasDocs, true); // scaffold ships docs/*.md
  assert.ok(fs.existsSync(path.join(a, 'kmd.config.json')));

  // scaffold refuses non-empty dir -> 400
  await rejects400(api.createProject(a));

  const b = path.join(cwd, 'proj-b');
  fs.mkdirSync(b);
  const r2 = await api.openProject(b);
  assert.equal(r2.hasDocs, false);

  // open non-existent -> 400
  await rejects400(api.openProject(path.join(cwd, 'nope')));

  // recents: most-recent-first, dedupe on re-open
  await api.openProject(a);
  const cur = api.currentProject();
  assert.equal(cur.project.path, a);
  assert.deepEqual(
    cur.recents.map((r) => r.name),
    ['proj-a', 'proj-b'],
  );

  // persisted to <cwd>/.kmd-studio.json and reloaded by a fresh api
  const saved = JSON.parse(fs.readFileSync(path.join(cwd, '.kmd-studio.json'), 'utf8'));
  assert.equal(saved.recents.length, 2);
  const api2 = createApi({ cwd, env: {} });
  assert.equal(api2.currentProject().recents.length, 2);

  // max 8
  for (let i = 0; i < 10; i++) {
    const d = path.join(cwd, `p${i}`);
    fs.mkdirSync(d);
    await api2.openProject(d);
  }
  assert.equal(api2.currentProject().recents.length, 8);
});

test('recents: corrupt .kmd-studio.json tolerated', () => {
  const cwd = tmp('kmd-studio-');
  fs.writeFileSync(path.join(cwd, '.kmd-studio.json'), 'not json{{{');
  const api = createApi({ cwd, env: {} });
  assert.deepEqual(api.currentProject(), { project: null, recents: [] });
});

test('fileTree: shape and skip rules', async () => {
  const cwd = tmp('kmd-studio-');
  const api = createApi({ cwd, env: {} });
  await rejects400(Promise.resolve().then(() => api.fileTree())); // no project

  const proj = path.join(cwd, 'proj');
  await api.createProject(proj);
  // noise that must be skipped
  fs.mkdirSync(path.join(proj, 'site'));
  fs.writeFileSync(path.join(proj, 'site', 'built.md'), '# built\n');
  fs.mkdirSync(path.join(proj, 'node_modules'));
  fs.writeFileSync(path.join(proj, 'node_modules', 'dep.md'), '# dep\n');
  fs.writeFileSync(path.join(proj, '_draft.md'), '# draft\n');
  fs.writeFileSync(path.join(proj, '.hidden.md'), '# hidden\n');
  fs.writeFileSync(path.join(proj, 'notes.md'), '# notes\n');
  fs.writeFileSync(path.join(proj, 'image.png'), 'png'); // non-md not listed

  const { tree } = api.fileTree();
  assert.equal(tree.length, 2); // docs dir + notes.md, dirs first
  assert.equal(tree[0].type, 'dir');
  assert.equal(tree[0].name, 'docs');
  assert.equal(tree[0].rel, 'docs');
  assert.ok(Array.isArray(tree[0].children));
  assert.ok(tree[0].children.every((c) => c.type === 'file' && c.name.endsWith('.md')));
  assert.equal(tree[0].children[0].rel.startsWith('docs/'), true);
  assert.deepEqual(
    tree[0].children.map((c) => c.name).sort(),
    ['ai-blocks.md', 'getting-started.md', 'index.md', 'syntax-showcase.md'],
  );
  assert.equal(tree[1].type, 'file');
  assert.equal(tree[1].name, 'notes.md');
  assert.equal(tree[1].rel, 'notes.md');
});

test('writeFile/readFile roundtrip; traversal and non-md rejected', async () => {
  const cwd = tmp('kmd-studio-');
  const api = createApi({ cwd, env: {} });
  await api.createProject(path.join(cwd, 'proj'));

  const w = api.writeFile('notes/a.md', '# 你好\n\n世界\n');
  assert.equal(w.ok, true);
  assert.equal(w.tokens, require('../src/tokens').countTokens('# 你好\n\n世界\n'));

  const r = api.readFile('notes/a.md');
  assert.equal(r.content, '# 你好\n\n世界\n');
  assert.equal(r.tokens, w.tokens);

  // traversal rejected
  await rejects400(Promise.resolve().then(() => api.writeFile('../evil.md', 'x')));
  await rejects400(Promise.resolve().then(() => api.writeFile('..\\evil.md', 'x')));
  await rejects400(Promise.resolve().then(() => api.readFile('../kmd.config.json')));
  // non-md write rejected
  await rejects400(Promise.resolve().then(() => api.writeFile('a.txt', 'x')));
});

test('newFile conflict, renameFile, deleteFile', async () => {
  const cwd = tmp('kmd-studio-');
  const api = createApi({ cwd, env: {} });
  await api.createProject(path.join(cwd, 'proj'));

  assert.deepEqual(api.newFile('fresh.md'), { ok: true });
  assert.equal(api.readFile('fresh.md').content, '# 标题\n');
  await rejects400(Promise.resolve().then(() => api.newFile('fresh.md'))); // exists

  assert.deepEqual(api.renameFile('fresh.md', 'sub/renamed.md'), { ok: true });
  assert.equal(api.readFile('sub/renamed.md').content, '# 标题\n');
  await rejects400(Promise.resolve().then(() => api.renameFile('../x.md', 'y.md')));
  await rejects400(Promise.resolve().then(() => api.renameFile('sub/renamed.md', '../y.md')));

  assert.deepEqual(api.deleteFile('sub/renamed.md'), { ok: true });
  await rejects400(Promise.resolve().then(() => api.readFile('sub/renamed.md')));
  await rejects400(Promise.resolve().then(() => api.deleteFile('sub/renamed.md')));
});

test('build: no project -> 400; scaffolded project builds; site/*.md not recompiled', async () => {
  const cwd = tmp('kmd-studio-');
  const api = createApi({ cwd, env: {} }); // no key -> useAi false, no network
  await rejects400(api.build());

  const proj = path.join(cwd, 'proj');
  await api.createProject(proj);

  const r1 = await api.build();
  assert.ok(r1.pages > 0);
  assert.equal(r1.indexUrl, '/preview/index.html');
  assert.equal(typeof r1.ms, 'number');
  assert.deepEqual(Object.keys(r1.ai).sort(), ['cached', 'errors', 'ran', 'total']);
  assert.ok(fs.existsSync(path.join(proj, 'site', 'index.html')));
  assert.ok(fs.existsSync(path.join(proj, 'site', 'docs', 'index.html')));
  // source .md copied verbatim into site/
  assert.ok(fs.existsSync(path.join(proj, 'site', 'docs', 'index.md')));

  // second build: copied site/*.md must NOT be recompiled (excludeDirs)
  const r2 = await api.build();
  assert.equal(r2.pages, r1.pages);
});

test('aiComplete: no-api-key passes through verbatim as { error } (HTTP 200 shape)', async () => {
  const cwd = tmp('kmd-studio-');
  const api = createApi({ cwd, env: {} });
  const r = await api.aiComplete({ prompt: '润色这段文字', context: '原文', action: 'polish' });
  assert.deepEqual(r, { error: 'no-api-key' });
  const c = await api.aiComplete({ prompt: 'x' }); // custom, default action
  assert.deepEqual(c, { error: 'no-api-key' });
  await rejects400(Promise.resolve().then(() => api.aiComplete({ action: 'bogus' })));
});

test('end-to-end HTTP: token 401/200, heartbeat, preview 404, root asset', async (t) => {
  const cwd = tmp('kmd-studio-');
  const handle = await studioServer({ port: 0, cwd, env: {}, watchdog: false });
  t.after(() => handle.close());
  const base = `http://127.0.0.1:${handle.port}`;

  assert.match(handle.url, new RegExp(`^http://127\\.0\\.0\\.1:${handle.port}/\\?k=[0-9a-f]{32}$`));
  assert.equal(handle.getState().project, null);

  // / serves the UI index when the frontend agent's files exist; tolerate 404.
  const root = await fetch(`${base}/`);
  if (fs.existsSync(path.join(__dirname, '..', 'src', 'studio', 'ui', 'index.html'))) {
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type'), /text\/html/);
  } else {
    assert.equal(root.status, 404);
  }

  // token middleware
  const noToken = await fetch(`${base}/api/status`);
  assert.equal(noToken.status, 401);
  const wrongToken = await fetch(`${base}/api/status`, { headers: { 'X-KMD-Token': 'nope' } });
  assert.equal(wrongToken.status, 401);
  const ok = await fetch(`${base}/api/status`, { headers: { 'X-KMD-Token': handle.token } });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.version, '0.1.0');

  // heartbeat route
  const hb = await fetch(`${base}/api/heartbeat`, {
    method: 'POST',
    headers: { 'X-KMD-Token': handle.token },
  });
  assert.equal(hb.status, 200);
  assert.deepEqual(await hb.json(), { ok: true });

  // preview without project -> 404 JSON, no token required
  const prev = await fetch(`${base}/preview/index.html`);
  assert.equal(prev.status, 404);
  assert.deepEqual(await prev.json(), { error: 'no-project' });

  // malformed JSON -> 400 { error }
  const bad = await fetch(`${base}/api/project/open`, {
    method: 'POST',
    headers: { 'X-KMD-Token': handle.token, 'Content-Type': 'application/json' },
    body: '{oops',
  });
  assert.equal(bad.status, 400);
  assert.equal(typeof (await bad.json()).error, 'string');

  // open + build over HTTP, then preview serves the built page
  const proj = path.join(cwd, 'proj');
  const opened = await fetch(`${base}/api/project/create`, {
    method: 'POST',
    headers: { 'X-KMD-Token': handle.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: proj }),
  });
  assert.equal(opened.status, 200);
  assert.equal(handle.getState().project.path, proj);
  const built = await fetch(`${base}/api/build`, {
    method: 'POST',
    headers: { 'X-KMD-Token': handle.token },
  });
  assert.equal(built.status, 200);
  const builtBody = await built.json();
  assert.ok(builtBody.pages > 0);
  const page = await fetch(`${base}/preview/docs/index.html`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  // traversal out of the preview root -> 404, never serves outside files
  const trav = await fetch(`${base}/preview/..%2F..%2Fkmd.config.json`);
  assert.equal(trav.status, 404);
});
