# KMD Internal Contracts (v1)

KMD is a zero-dependency, AI-era Markdown compiler. This document is the single
source of truth for module APIs and HTML/CSS conventions. Every module MUST
follow it exactly — modules are developed in parallel against this contract.

## Global rules

- Node.js >= 18, **CommonJS** (`require` / `module.exports`). No ESM.
- **Zero external dependencies.** Only `node:*` built-ins. Never run `npm install`.
- All files UTF-8, LF line endings. Use `node:path` for all path handling.
- Code comments in English, terse. User-facing CLI strings may be Chinese.
- Never throw on bad user input in rendering paths — degrade gracefully.
- `package.json` already exists; do not create or modify it.

## File layout & ownership

```
bin/kmd.js            CLI entry (Agent D)
src/parser.js         Markdown -> HTML (Agent A)
src/highlight.js      Zero-dep code highlighter (Agent A)
src/ai.js             AI block execution + cache (Agent B)
src/tokens.js         Token estimation (Agent B)
src/llms.js           llms.txt generation (Agent B)
src/template.js       HTML page shell (Agent C)
src/theme.css         Theme stylesheet, inlined into pages (Agent C)
src/server.js         Static server + SSE live reload (Agent C)
src/compiler.js       Orchestration: md -> site (Agent D)
src/config.js         kmd.config.json loading (Agent D)
src/scaffold.js       `kmd init` scaffolding (Agent D)
tests/*.test.js       node:test tests, one file per module area
README.md             Chinese user-facing docs (Agent D)
```

Each agent owns ONLY its files. Do not read/modify other agents' source files;
code strictly against this contract.

---

## src/parser.js (Agent A)

```js
const { parseMarkdown } = require('./parser');
const result = parseMarkdown(src, options);
// options: { allowAi?: boolean = true }
// result: {
//   html: string,                      // body HTML fragment (no <html> shell)
//   toc: [{ level: 2|3, text, id }],   // h2/h3 only, in document order
//   meta: object,                      // frontmatter data ({} if none)
//   flags: { mermaid: bool, math: bool },
//   aiBlocks: [{ id, prompt, config }],// config: { model?, temperature? }
// }
```

`result.html` contains the literal comment `<!--AI_BLOCK:N-->` (N = index into
`aiBlocks`, starting at 0) at each position where an ` ```ai ` fence appeared.
The compiler replaces each comment with the final AI block HTML (see "AI block
wrapper HTML" below). With `allowAi: false`, ` ```ai ` fences render as ordinary
code blocks with language `ai` and `aiBlocks` is empty — no placeholders.

### Supported syntax

- Frontmatter: file must START with `---\n`; closes at a line that is exactly
  `---`. Simple YAML subset: `key: value` lines; strip surrounding quotes;
  coerce `true`/`false`/numbers; arrays as `key: [a, b]` or comma-separated
  `key: a, b`. Everything else stays a string. Exposed as `meta`.
- ATX headings `#`..`######`, with slugged `id` attributes. Slug: lowercase,
  trim, keep letters/digits/CJK/`-_`, spaces -> `-`, strip other punctuation,
  dedupe repeated slugs with `-1`, `-2`... Append
  `<a class="heading-anchor" href="#ID" aria-hidden="true">#</a>` inside each
  heading. `toc` collects only levels 2-3. If `meta.title` is absent, the first
  h1 text becomes `meta.title`.
- Paragraphs; hard break on trailing two spaces -> `<br>`.
- Inline: `**bold**`, `__bold__`, `*em*`, `_em_` (underscore NOT intra-word),
  `~~del~~`, backtick code spans (variable-length fences, e.g. `` `a`b` ``),
  `[text](url "optional title")`, `![alt](src "title")`, bare autolinks for
  `http(s)://...`, backslash escapes of ASCII punctuation. All raw HTML in the
  source is ESCAPED (safe by default). Escape `& < > "` in text and `& < > " '`
  in attribute values. Nested emphasis (bold inside em etc.) must work.
- Lists: `-`, `*`, `+` and ordered `1.`; nesting via indentation (2+ spaces);
  task items `- [ ]` / `- [x]` ->
  `<li class="task-list-item"><input type="checkbox" disabled checked> text</li>`.
- Blockquotes, nestable. GitHub-style alerts: a quote whose first line is
  `> [!note]` / `[!tip]` / `[!important]` / `[!warning]` / `[!caution]`
  (case-insensitive), optionally followed on the same line by a custom title:
  ```html
  <div class="callout callout-note"><p class="callout-title">Note</p>
  ...rendered inner content...
  </div>
  ```
  Default titles: Note/Tip/Important/Warning/Caution.
- Fenced code blocks ``` or ~~~ . Info string first word = language. Render:
  `<pre class="codeblock" data-lang="LANG"><code>HIGHLIGHTED_HTML</code></pre>`
  where HIGHLIGHTED_HTML comes from `src/highlight.js` `highlight(code, lang)`.
  `data-lang` omitted when no language. Unknown language: highlight() returns
  escaped plain code (still wrapped the same way).
- ` ```mermaid ` -> `<pre class="mermaid">ESCAPED_CODE</pre>` (NOT .codeblock),
  sets `flags.mermaid = true`.
- ` ```ai ` -> placeholder comment (see above), sets nothing in flags.
  Config: extra words in the info string as `key=value` pairs, e.g.
  ` ```ai model=kimi-k2 temperature=0.3 ` -> config `{model:'kimi-k2', temperature:0.3}`
  (temperature coerced to number). Prompt = trimmed fence content.
- Tables (GFM pipes): header row + delimiter row (`---`, `:--`, `:-:`, `--:`)
  controlling alignment via `<th style="text-align:center">` etc. Wrap:
  `<div class="table-wrap"><table>...`.
- Horizontal rule: a line of `---` / `***` / `___` (3+) following a blank line
  or at document start. (Setext headings are intentionally NOT supported.)
- Math: inline `$...$` -> `<span class="math math-inline">\(...\)</span>`;
  block `$$...$$` -> `<div class="math math-display">\[...\]</div>`. TeX source
  HTML-escaped inside. Sets `flags.math = true`. KaTeX auto-render (loaded by
  the template from CDN) processes these delimiters client-side.
- Footnotes: refs `[^id]` -> `<sup class="footnote-ref" id="fnref-id"><a href="#fn-id">n</a></sup>`;
  definitions `[^id]: text` (any top-level position, multi-line via 4-space
  indent) collected and rendered at document end:
  `<section class="footnotes"><hr><ol><li id="fn-id">text <a class="footnote-backref" href="#fnref-id">↩</a></li>...</ol></section>`.
- Images inside paragraphs stand alone; do not wrap lone images in `<p>`
  (emit `<p class="img-only">` if you do wrap — pick one, test it).

Non-goals: setext headings, reference-style links, raw HTML passthrough,
smart punctuation.

---

## src/highlight.js (Agent A)

```js
const { highlight } = require('./highlight');
const html = highlight(code, lang); // -> HTML string, fully escaped, with token spans
```

Token span classes (styled by theme): `.tk-kw` keyword, `.tk-str` string,
`.tk-num` number, `.tk-com` comment, `.tk-fn` function name, `.tk-tag` html tag,
`.tk-attr` html attribute, `.tk-val` html attr value / css value,
`.tk-key` json/yaml key, `.tk-op` operator/punctuation.
Plain code has no spans. Regex-based tokenizing is fine; correctness for
common cases beats completeness. NEVER let a regex blow up on adversarial input
(avoid nested quantifiers).

Languages: `js`, `jsx`, `ts`, `tsx`, `json`, `bash`, `sh`, `python`, `py`,
`html`, `xml`, `css`, `yaml`, `yml`, `md`, `sql`, `go`, `rust`, `c`, `cpp`,
`java`, `diff` (`.tk-add`/`.tk-del` line classes ok). Aliases map to one
implementation. Unknown lang -> HTML-escaped code, no spans.

---

## src/ai.js (Agent B)

```js
const { fillAiBlocks, resolveProvider } = require('./ai');

resolveProvider(env) // env: process.env-like object
// -> { baseUrl, apiKey, model, hasKey }
// baseUrl: env.KMD_AI_BASE_URL || env.OPENAI_BASE_URL || 'https://api.moonshot.cn/v1'
// apiKey:  env.KMD_AI_API_KEY || env.OPENAI_API_KEY || env.MOONSHOT_API_KEY || null
// model:   env.KMD_AI_MODEL || 'kimi-k2-0905-preview'

await fillAiBlocks(blocks, opts);
// blocks: [{ id, prompt, config }] (from parser); MUTATED in place:
//   success -> block.markdown = string, block.fromCache = bool
//   failure -> block.error = string (human-readable reason)
// opts: {
//   env?: object = process.env,
//   cacheDir?: string,        // when set + useCache, disk cache at <cacheDir>/<sha256>.json
//   useCache?: bool = true,
//   fetchImpl?: fn = globalThis.fetch,  // injectable for tests
//   onLog?: (msg: string) => void,      // progress lines like '[ai] block 0: cached'
// }
```

Provider: OpenAI-compatible `POST {baseUrl}/chat/completions`, JSON body
`{ model, messages: [{role:'user', content: prompt}], temperature? }`,
header `Authorization: Bearer <apiKey>`, `Content-Type: application/json`.
Use `opts.fetchImpl`. Timeout 90s via AbortController. Parse
`choices[0].message.content`. Non-2xx -> error with status + first 200 chars
of body. Missing apiKey -> every block gets
`block.error = 'no-api-key'` (exact string; compiler renders an offline box).
Block-level `config.model` / `config.temperature` override provider defaults.
Cache key: sha256 hex of `model + '\n' + prompt`. Cache file JSON:
`{ model, prompt, markdown, at: ISOString }`. Corrupt cache entry -> ignore and
re-fetch. Cache dir created with `{ recursive: true }` only when first write
happens. Run blocks with limited concurrency (3 at a time).

## src/tokens.js (Agent B)

```js
const { countTokens, estimateReport } = require('./tokens');
countTokens(text) // -> integer estimate
// CJK chars (U+3400-U+9FFF, U+F900-U+FAFF, U+3000-U+303F, U+FF00-U+FFEF) count 1 each;
// all remaining chars count ceil(len/4) total.
estimateReport(files) // files: [{ path, text }] -> [{ path, chars, tokens }]
```

## src/llms.js (Agent B)

```js
const { generateLlmsTxt } = require('./llms');
generateLlmsTxt({ siteTitle, description, pages })
// pages: [{ title, url, description? }]  (url relative, e.g. 'guide.html')
// -> llms.txt string per llmstxt.org:
// # {siteTitle}\n\n> {description}\n\n## Docs\n\n- [title](url): description
// (omit '>' line when no description, omit ': description' per item when absent)
```

---

## src/template.js (Agent C)

```js
const { renderPage, renderIndex } = require('./template');

renderPage(opts) // -> full HTML document string
// opts: {
//   title, description?, siteTitle, bodyHtml,
//   toc: [{level,text,id}], flags: {mermaid,math},
//   pagePath: string (e.g. 'guide.html', for relative link depth),
//   generatedAt: ISO string,
// }

renderIndex({ siteTitle, description?, pages, generatedAt })
// pages: [{ title, url, description? }] -> full HTML listing page
```

Page structure (theme.css styles exactly these hooks):

```html
<!doctype html><html lang="zh-CN"><head>
  meta charset/viewport, <title>{title} · {siteTitle}</title>, meta description
  <style>/* ENTIRE theme.css inlined */</style>
  if flags.math:   KaTeX CSS+JS+auto-render from jsdelivr CDN, deferred
  if flags.mermaid: mermaid ESM loader snippet from jsdelivr CDN
</head><body>
<header class="topbar">
  <a class="brand" href="index.html">{siteTitle}</a>
  <div class="topbar-actions"><button id="theme-toggle" aria-label="切换主题">🌓</button></div>
</header>
<div class="layout">
  <nav class="toc" aria-label="目录">…ul of toc (indent by level)…</nav>  <!-- omit nav if toc empty -->
  <main class="markdown-body">{bodyHtml}</main>
</div>
<footer class="site-footer">由 KMD 生成 · {generatedAt date}</footer>
<script>/* inline: theme toggle w/ localStorage 'kmd-theme' (light/dark/system),
   copy button injected into every pre.codeblock, KaTeX auto-render call if math,
   mermaid init if mermaid */</script>
</body></html>
```

Requirements: escape title/description into the shell; default theme = system
preference (`prefers-color-scheme`) unless localStorage overrides; copy button
shows "复制" -> "已复制"; KaTeX auto-render delimiters `\( \) \[ \]`;
mermaid code already sits in `pre.mermaid`; all CDN assets optional (page must
still render fine offline — wrap loaders in try/catch / onerror tolerance).
`renderIndex` reuses the same shell with a simple `<ul class="page-list">`.

## src/theme.css (Agent C)

One stylesheet, CSS custom properties on `:root` and `html[data-theme="dark"]`
overrides (JS sets `data-theme` on `<html>`). Modern doc-site aesthetic:
system font stack + `"LXGW WenKai"` fallback ok but no external font fetch;
max content width ~46rem centered with sidebar TOC sticky at left on wide
screens, collapses above content on <960px. Must style EVERY hook from the
parser contract: `.markdown-body` typography (headings w/ `.heading-anchor`
shown on hover, paragraphs, links, `code` inline, blockquote), `pre.codeblock`
(dark surface always, `data-lang` badge via `::before`, copy button
`.copy-btn`), all `.tk-*` token colors, `.callout` + 5 variants (colored left
border + tinted bg + icon via `.callout-title::before`), `.table-wrap`
(overflow-x auto, striped), `.task-list-item`, `.math`, `pre.mermaid` (centered,
card), `.ai-block` family (`.ai-block`, `.ai-block-badge`, `.ai-block-content`,
`.ai-offline`, `.ai-block-note`, `.ai-prompt`), footnotes, `.toc`, `.topbar`,
`.site-footer`, `.page-list`, plus `::selection`, focus-visible outlines, and
`@media print` (hide chrome, black on white). Aim for genuinely beautiful —
this is the product's face. ~400-600 lines is fine.

## src/server.js (Agent C)

```js
const { serve } = require('./server');
const handle = await serve({ root, port = 4173, host = '127.0.0.1' });
// -> { url, broadcastReload(), close() }
```

Static file server over `root` (directory index: `index.html`; safe path join,
no traversal outside root; correct MIME for html/css/js/svg/png/jpg/webp/ico/
json/md/txt; 404 page). SSE endpoint `GET /__kmd_reload` keeps connection,
`broadcastReload()` sends `data: reload\n\n` to all clients. When serving an
`.html` file, inject before `</body>`:
`<script>new EventSource('/__kmd_reload').onmessage=function(e){if(e.data==='reload')location.reload()}</script>`
(must also work when file lacks `</body>` — append at end). `close()` closes
server + all SSE sockets. Port 0 allowed (OS picks; report real port in `url`).

---

## src/config.js (Agent D)

```js
loadConfig(cwd) // -> { siteTitle, description, outDir, port, ai: {} }
// reads <cwd>/kmd.config.json if present; merges over defaults:
// { siteTitle: 'KMD Docs', description: '', outDir: 'site', port: 4173, ai: {} }
// malformed JSON -> throw with clear message naming the file.
```

## src/compiler.js (Agent D)

```js
const { buildFile, buildSite } = require('./compiler');

await buildFile(srcPath, opts)
// opts: { outDir, siteTitle, description, useAi = true, useCache = true,
//         cacheDir = <outDir>/.kmd-cache, env = process.env, onLog }
// -> { outFile, mdOutFile, title, description, tokens, flags,
//      ai: { total, cached, ran, errors } }

await buildSite(srcDir, opts)  // same opts
// -> { pages: [{ title, url, description?, tokens }], outDir, llmsTxt, aiTotals }
```

Pipeline (buildFile): read md -> `parseMarkdown` -> if `useAi`, `fillAiBlocks`
(then replace each `<!--AI_BLOCK:N-->` with wrapper HTML below; on block.error
render the offline/error variant) -> token count of final plain markdown source
-> `renderPage` -> write `<outDir>/<name>.html`, copy source verbatim to
`<outDir>/<name>.md`. name = basename without `.md` (`index.md` -> `index.html`).

AI block wrapper HTML (compiler builds; theme styles it):

```html
<!-- success -->
<section class="ai-block"><div class="ai-block-badge">✦ AI</div><div class="ai-block-content">RENDERED_MARKDOWN_HTML</div></section>
<!-- error 'no-api-key' -->
<section class="ai-block ai-offline"><div class="ai-block-badge">✦ AI</div><div class="ai-block-note">未配置 API Key，编译时跳过。设置 KMD_AI_API_KEY 后重新构建即可生成内容。</div><details class="ai-prompt"><summary>查看 Prompt</summary><pre>PROMPT_ESCAPED</pre></details></section>
<!-- other errors -->
same as offline but note shows: AI 生成失败：{error}
```

RENDERED_MARKDOWN_HTML = `parseMarkdown(block.markdown, { allowAi: false }).html`
(import parser directly). AI-generated markdown that itself contains ` ```ai `
must NOT recurse (allowAi: false guarantees this).

buildSite: walk srcDir recursively for `*.md` (skip dotfiles, `node_modules`,
names starting with `_`), mirror subdirectory structure into outDir, call
buildFile per file, then: if no `index.md` at root, write `index.html` via
`renderIndex` (root-level pages only? No — ALL pages, sorted by url); always
write `llms.txt` via `generateLlmsTxt` linking each page's `.md` file
(e.g. `guide.md`) plus html as the page url — use the `.md` relative path as
`url` in llms.txt. Clean outDir before build (`rm` contents only, keep dir).

## src/scaffold.js (Agent D)

```js
scaffold(dir) // creates dir if missing; writes:
// kmd.config.json, docs/index.md, docs/getting-started.md, docs/ai-blocks.md,
// docs/syntax-showcase.md, .gitignore (with site/ + .kmd-cache/)
// -> { created: [paths...] }  ; refuses (throws) if dir non-empty
```

The sample docs are the product demo: written in Chinese, showcasing
frontmatter, callouts (all 5), tables, task lists, code in several languages,
mermaid, math, footnotes, and 2-3 genuinely useful ` ```ai ` blocks
(e.g. "把上文总结为 3 条要点", "为这篇文档生成一段 SEO description").

## bin/kmd.js (Agent D)

`#!/usr/bin/env node`, hand-rolled arg parsing (no deps). Exit codes: 0 ok,
1 usage/runtime error (print to stderr). Commands:

```
kmd build <src...> [-o outDir] [--no-ai] [--no-cache]   # src: files or dirs
kmd serve <src> [-o outDir] [-p port] [--no-ai] [--no-cache]
kmd expand <file.md> [-o out.md]                        # AI blocks -> stdout/file
kmd tokens <src...>                                     # table of counts
kmd init [dir]                                          # default ./kmd-docs
kmd help                                                # (also -h/--help, no args)
```

- `build`: file(s) -> buildFile each into outDir; one dir -> buildSite;
  multiple dirs -> sequential buildSite each into outDir/<dirname>? NO — just
  build all *.md found into one site. Keep behavior simple + documented.
- `serve`: build once, then `serve({root: outDir, port})`, print 本地地址,
  watch source with `fs.watch(src, {recursive:true}, debounce 100ms)` ->
  rebuild changed file(s) -> `broadcastReload()`. Log rebuild lines. (Windows:
  recursive watch is supported; wrap in try/catch, fall back to watching each
  subdir.) Ctrl+C exits cleanly.
- `expand`: parse + fillAiBlocks, output the ORIGINAL markdown with each
  ` ```ai ` fence replaced by `<!-- ai-generated -->` + block.markdown (or an
  HTML comment with the error). No HTML rendering.
- `tokens`: resolve srcs to md files, print aligned table: path / chars /
  tokens, plus total row. Pure text output.
- Config: `loadConfig(process.cwd())`; CLI flags override config values.
  Env provider status line printed on build when AI enabled:
  `[ai] provider: {baseUrl} model: {model} key: {sk-...xxxx | missing}`.

## README.md (Agent D)

Chinese. Badges-free, honest. Sections: 是什么 / 快速开始 (npx-style
`node bin/kmd.js ...` since未发布) / AI 块用法与环境变量 / 命令参考 /
语法支持表 / 输出产物（html + md + llms.txt）/ 零依赖设计说明。

## Test expectations

Each agent writes `node:test` tests for its own modules (run:
`node --test tests/<file>`). No network in tests: ai.js tests use injected
`fetchImpl` (success, 500 error, no-key path, cache hit). server tests use
`port: 0` and fetch real HTTP from the test. compiler tests build into
`fs.mkdtemp` dirs and assert output files + AI placeholder replacement with a
stubbed... note compiler has no fetchImpl injection: compiler tests run with
`useAi: false`, plus one test asserting the offline wrapper appears when env
has no key. Keep tests fast (<5s each file).
