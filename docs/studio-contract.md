# KMD Studio — Desktop App Contract (v2, supersedes nothing, extends v1)

KMD Studio turns KMD into a desktop application: a local HTTP server on
127.0.0.1 + a Chromium "app mode" window (Edge/Chrome `--app=`, both present on
the target machine). Zero external dependencies, same rules as v1: CommonJS,
Node >= 18, `node:*` builtins only, LF, English code comments, Chinese UI
strings. All v1 contracts remain valid; Studio reuses parser/compiler/ai/tokens
/scaffold as libraries.

## Architecture

```
kmd app [projectPath]        # new CLI command (bin/kmd.js, additive)
  -> src/studio/launch.js    # find Edge/Chrome, spawn --app=<url>, fallback: default browser
  -> src/studio/server.js    # studioServer({ port: 0|n }) -> http server on 127.0.0.1
      routes:
        /                     -> src/studio/ui/index.html
        /app.css /app.js /favicon.svg
        /api/*                -> src/studio/api.js  (JSON, token-authed)
        /preview/*            -> static serve of <currentProject>/site (built output)
```

Server binds `127.0.0.1` only. On start it generates a random hex **token**
(16 bytes); the launch URL is `http://127.0.0.1:<port>/?k=<token>`. UI JS reads
the token from `location.search` and sends it as `X-KMD-Token` header on every
`/api/*` call. API rejects missing/wrong tokens with 401. `/preview/*` and UI
assets require no token.

## File ownership (Studio phase)

```
Agent E (backend):
  src/studio/server.js      NEW
  src/studio/api.js         NEW
  src/studio/launch.js      NEW
  src/ai.js                 EDIT: add runPrompt() export (additive, keep all existing exports/tests green)
  bin/kmd.js                EDIT: add `app [path]` command (additive)
  tests/studio.test.js      NEW
  tests/ai.test.js          EDIT: add runPrompt tests (additive)
  KMD.bat                   NEW (repo root, CRLF line endings!)
  README.md                 EDIT: add 桌面应用 section (additive)

Agent F (frontend):
  src/studio/ui/index.html  NEW
  src/studio/ui/app.css     NEW
  src/studio/ui/app.js      NEW
  src/studio/ui/favicon.svg NEW
```

Backend agent must NOT write anything under src/studio/ui/ (for api tests,
create throwaway fixtures in temp dirs instead). Frontend agent codes strictly
against the API spec below; test by manual reasoning, there is no browser test
runner — the parent agent will screenshot-verify.

## src/ai.js addition (Agent E)

```js
async function runPrompt(prompt, opts)
// opts: { env = process.env, model?, temperature?, fetchImpl = globalThis.fetch, timeoutMs = 90000 }
// -> string (markdown result). THROWS Error with clear message when
//    no apiKey ('no-api-key' as message, exact) or on http/network failure
//    (same message formats as fillAiBlocks). NO caching (interactive use).
// Shares provider resolution + request code with fillAiBlocks (refactor
// internals as needed, but keep every v1 export signature + behavior intact).
```

## src/studio/server.js (Agent E)

```js
const { studioServer } = require('./studio/server');
const handle = await studioServer({ port = 0, cwd = process.cwd(), env = process.env,
                                    onLog = () => {} });
// -> { url, token, port, close(), getState, api }
// url: `http://127.0.0.1:${port}/?k=${token}`
// getState(): { project: { path, name } | null }
```

- Serves the three UI assets + favicon from `src/studio/ui/` (read at request
  time, correct MIME: html/css/js/svg).
- `/preview/*` -> files under `<state.project.path>/site`; 404 JSON when no
  project open; traversal-safe; html files served as-is (no injection —
  the UI reloads the iframe itself after builds).
- `/api/*` -> delegated to `api.handle(req, res, body, ctx)` (see api.js).
  Token middleware runs here (except: none exempt).
- **Heartbeat watchdog**: `POST /api/heartbeat` resets a timer; if no heartbeat
  for 45s, the server closes and `process.exit(0)` (the app window was closed).
  Watchdog starts only after the FIRST heartbeat (grace: none needed before).
  `close()` clears the timer. Exported `studioServer` must accept
  `watchdog: false` opt to disable in tests.
- JSON helpers: send JSON with correct headers; body parsing with 10MB cap;
  malformed JSON -> 400 `{ error }`.
- All errors -> `{ error: message }` with sensible status codes; never crash
  the process on a bad request.

## src/studio/api.js (Agent E)

```js
const api = createApi({ cwd, env, onLog });
// createApi returns an object exposing:
//   await api.handle(req, res, body)   // low-level route dispatch used by server.js
// plus DIRECTLY TESTABLE methods (tests use these, not HTTP):
//   status(), listFs(path), openProject(path), createProject(path),
//   currentProject(), fileTree(), readFile(rel), writeFile(rel, content),
//   newFile(rel), renameFile(from, to), deleteFile(rel),
//   build(), aiComplete({ prompt, context, action }), shutdown()
```

State: `currentProject = { path, name } | null`, recents persisted at
`<cwd>/.kmd-studio.json` (best-effort read/write, tolerate corrupt/missing).

### Routes (all JSON; `{ error }` on failure)

| Method & path | Handler -> response |
| --- | --- |
| GET  `/api/status` | `{ version: '0.1.0', cwd, provider: { baseUrl, model, hasKey, keyPreview } }` — keyPreview = `sk-abcd…wxyz` or null (via resolveProvider(env)) |
| GET  `/api/fs/list?path=` | path empty/absent -> `{ drives: ['C:\\', ...] }` (probe A-Z with fs.existsSync, Windows-only ok); else `{ path, parent, dirs: [{name, path}], files: [] }` — directories only, sorted, skip dotfiles/node_modules; unreadable dir -> 400 error |
| POST `/api/project/open` `{ path }` | must be an existing directory; sets current, pushes to recents (max 8, dedupe, most-recent-first); -> `{ project: { path, name }, hasDocs }` |
| POST `/api/project/create` `{ path }` | scaffold(path) from src/scaffold.js (its throw on non-empty dir -> 400); then same as open |
| GET  `/api/project/current` | `{ project, recents: [{ path, name }] }` |
| GET  `/api/files` | recursive md tree of project: `{ tree: [node] }`, node = `{ name, rel, type: 'file'\|'dir', children? }`, files = `*.md` only, dirs first, skip dotfiles/_-prefix/node_modules/site |
| GET  `/api/file?path=rel` | `{ content, tokens }` (countTokens) |
| POST `/api/file` `{ path, content }` | upsert (mkdir -p parents); path must stay inside project, `.md` only -> `{ ok: true, tokens }` |
| POST `/api/file/new` `{ path }` | fails if exists -> `{ ok: true }` (empty template `# 标题\n`) |
| POST `/api/file/rename` `{ from, to }` | -> `{ ok: true }` |
| POST `/api/file/delete` `{ path }` | -> `{ ok: true }` |
| POST `/api/build` | buildSite(projectPath, { outDir: <project>/site, useAi, useCache: true, cacheDir: <project>/.kmd-cache, env, onLog }) BUT skip the outDir during the walk (see below); -> `{ pages: n, ms, ai: {total,cached,ran,errors}, indexUrl: '/preview/index.html' }`; no project -> 400 |
| POST `/api/ai/complete` `{ prompt, context?, action? }` | action in `polish\|continue\|translate-en\|summarize\|custom`; non-custom actions build a fixed Chinese instruction template wrapping `context`; calls runPrompt -> `{ markdown }`; runPrompt throw -> 200 with `{ error: message }` (client-friendly); `no-api-key` passes through verbatim |
| POST `/api/heartbeat` | `{ ok: true }` (also resets watchdog — handled in server.js) |
| POST `/api/shutdown` | respond `{ ok: true }`, then `close()` + process.exit(0) after 150ms |

Build-outDir-skip problem: `buildSite(srcDir)` walks `*.md` under srcDir; when
srcDir == project root and outDir == `<project>/site`, the copied `.md` files
in site/ would be re-compiled on the next build. Agent E: pass a new optional
`excludeDirs?: string[]` (absolute paths) opt into buildSite — ADD this opt to
src/compiler.js additively (document in code, keep v1 behavior default), and
pass `[outDir]` from the studio api. Also `site` is already skipped by the
fileTree route above.

All rel paths: POSIX-style, resolved with node:path then verified to start
with the resolved project path (traversal-safe). Windows absolute paths from
the fs browser arrive as `C:\...` — normalize both sides before comparing.

## src/studio/launch.js (Agent E)

```js
const { launchApp } = require('./studio/launch');
launchApp(url)  // fire-and-forget, never throws
// Edge candidates: %ProgramFiles(x86)% / %ProgramFiles% / %LocalAppData% Microsoft\Edge\Application\msedge.exe
// Chrome candidates: same roots Google\Chrome\Application\chrome.exe
// spawn(browser, [`--app=${url}`, '--window-size=1440,900', '--new-window'],
//       { detached: true, stdio: 'ignore' }).unref()
// none found -> open default browser: Windows `cmd /c start "" "<url>"`,
// darwin `open`, linux `xdg-open`. Also export findBrowser() -> path|null (for tests).
```

## bin/kmd.js addition (Agent E)

`kmd app [projectPath] [--port N]`: starts studioServer (cwd = process.cwd()),
if projectPath given and valid -> openProject it; prints 本地地址 (without the
token) + 提示关闭窗口即退出; then launchApp(url). `--no-launch` flag: skip
launchApp (for headless testing). Help text updated.

## KMD.bat (Agent E) — repo root, CRLF

```bat
@echo off
rem KMD Studio launcher
node "%~dp0bin\kmd.js" app %*
```

## Studio UI (Agent F) — src/studio/ui/{index.html,app.css,app.js,favicon.svg}

Vanilla HTML/CSS/JS, zero deps, Chinese UI, dark+light via CSS variables and a
`data-theme` on `<html>` (toggle button, localStorage 'kmd-studio-theme',
default follows system). Token: read once from `location.search` `k` param,
then `history.replaceState` to strip it from the visible URL; send as
`X-KMD-Token` header on every fetch. Heartbeat: POST /api/heartbeat every 5s
(also pause when document.hidden, but ensure at least one beat per 40s while
visible — simplest: keep beating even when hidden).

### Screen 1 — Home (`#screen-home`)

- Centered card, app logo (inline SVG diamond ✦ mark) + `KMD Studio` + tagline
  `AI 时代的 Markdown 工作台`.
- AI status chip from /api/status: `AI 已连接 · {model}` (green dot) or
  `AI 未配置` (gray dot, tooltip/click -> modal explaining KMD_AI_API_KEY etc.)
- Buttons: `打开项目…`, `新建项目…`; below: 最近项目 list (name + path, click
  opens). Empty recents -> muted hint text.
- Folder browser modal (shared by both buttons): breadcrumb + drive list when
  at roots; directory rows (folder icon + name, click to enter); footer:
  current path text, `选择此文件夹` (open mode) or name input + `在此新建` (create
  mode), cancel. Create mode POSTs /api/project/create { path: join(current,
  name) }.
- On success (open/create): switch to workspace screen.

### Screen 2 — Workspace (`#screen-workspace`)

Layout (CSS grid): top bar / left file tree / center editor / right preview.

- **Top bar**: brand mark + project name; current file rel path; doc token
  count (`1,234 tokens`, updates live as you type with the client-side copy of
  the countTokens heuristic); buttons: `新建文档`, `⟳ 构建` (shows spinner
  while building, then toast `已构建 N 页 · Xms · AI 块 a/b`), `AI 操作 ▾`
  dropdown (润色 / 续写 / 翻译成英文 / 总结要点 — disabled with lock tooltip
  when provider.hasKey false), theme toggle, `✕ 退出` (confirm -> /api/shutdown
  -> show 已退出，可关闭窗口 page).
- **File tree**: from /api/files; dirs collapsible; active file highlighted;
  click loads file; 刷新 button; right-click NOT required (rename/delete via
  small hover icons calling the routes with prompt()/confirm() dialogs).
- **Editor** (`<textarea>` + toolbar): monospace, generous padding, line-height
  1.7; Tab inserts 2 spaces; Ctrl/Cmd+S saves; toolbar buttons wrap/insert at
  selection: **B** `**sel**`, *I* `*sel*`, 链接 `[sel](url)`, 代码 fence,
  H2 `## `, 表格 template, Callout `> [!note]` template, `✦ AI 块` inserts
  ```` ```ai ```` template. Autosave: 800ms after last keystroke -> POST
  /api/file -> then POST /api/build -> refresh preview iframe via
  `iframe.src = '/preview/index.html?t=' + Date.now()`... actually reload the
  CURRENT preview page: track iframe contentWindow location pathname, re-set
  same path with cache-bust query; on iframe load error keep old page. Save
  status indicator (已保存 / 保存中… / 未保存).
- **Preview**: `<iframe>` filling the pane, sandbox not required (same-origin
  anyway); when project has no build yet, show placeholder pane with `点击构建`
  button. Mapping current doc rel `guide.md` -> `/preview/guide.html`.
- **AI actions flow**: user selects text in textarea (empty selection for
  续写 = use whole doc as context) -> pick action -> button shows 生成中… ->
  POST /api/ai/complete -> on `{ markdown }`: 润色/翻译 REPLACE the selection,
  续写 INSERTS after cursor, 总结 inserts at cursor as a `> [!tip] 总结`
  callout; on `{ error }`: error toast/modal (special-case `no-api-key` with
  setup instructions).
- **Toasts** bottom-right for success/error. All fetches: `api(path, opts)`
  helper handling 401 (show 会话失效 fatal overlay) and network errors.
- On load: GET /api/project/current — project open -> workspace; else home.

### Visual direction

Match the v1 theme family (indigo/violet accent, refined neutrals, 8-12px
radii) but as an IDE: denser, panels with 1px borders and subtle separators,
13-14px UI font, top bar 48px with blurred backdrop, tree ~220px, editor/preview
split 1:1 resizable via draggable divider (store ratio in localStorage).
favicon.svg: rounded-square gradient (indigo->violet) with white ✦.

## tests/studio.test.js (Agent E)

node:test, temp dirs, `watchdog: false`. Cover: createApi methods directly —
status shape (no key env), listFs drives + dir listing + traversal rejection,
createProject + openProject + recents dedupe, fileTree shape/skip rules,
writeFile/readFile roundtrip + traversal 400, newFile conflict, rename, delete,
build() on scaffolded project (useAi false via env without key — assert pages>0,
indexUrl, and site/*.md NOT recompiled on second build: second build pages
stays equal), aiComplete no-api-key -> `{ error: 'no-api-key' }`. Plus ONE
end-to-end HTTP test: studioServer on port 0, fetch / (200 html), /api/status
without token -> 401, with X-KMD-Token -> 200. Keep < 10s.
