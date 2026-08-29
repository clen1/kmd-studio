#!/usr/bin/env node
'use strict';
// KMD CLI. Contract: docs/contracts.md "bin/kmd.js (Agent D)".
// Sibling modules are lazy-required per command so `help`/`init` work standalone.
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');

const USAGE = `KMD — 零依赖 AI Markdown 编译器

用法:
  node bin/kmd.js <命令> [参数]

命令:
  build <src...> [-o outDir] [--no-ai] [--no-cache]      编译 Markdown 为静态站点
  serve <src> [-o outDir] [-p port] [--no-ai] [--no-cache]  本地预览,改动自动刷新
  app [projectPath] [--port N] [--no-launch]              启动 KMD Studio 桌面应用
  expand <file.md> [-o out.md]                           把 AI 块展开为普通 Markdown
  tokens <src...>                                        统计 token 用量
  init [dir]                                             生成示例项目(默认 ./kmd-docs)
  help                                                   显示本帮助

  不带参数运行时(例如双击 KMD.exe):直接启动 KMD Studio 桌面应用。

说明:
  · build 的 src 为单个目录时构建整个站点(自动生成索引页与 llms.txt);
    src 为一个或多个 .md 文件(或混合目录)时,逐个编译进同一输出目录。
  · AI 块默认启用,环境变量:KMD_AI_API_KEY / KMD_AI_BASE_URL / KMD_AI_MODEL
    (兼容 OPENAI_API_KEY / OPENAI_BASE_URL / MOONSHOT_API_KEY)。
  · 配置文件 <cwd>/kmd.config.json 提供 siteTitle/description/outDir/port,
    命令行参数优先。
`;

function fail(msg) {
  console.error(`错误:${msg}`);
  console.error('运行 node bin/kmd.js help 查看用法。');
  process.exit(1);
}

// Hand-rolled argv parsing: positionals + -o/--output, -p/--port,
// --no-ai, --no-cache, --no-launch, -h/--help.
function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--output') {
      flags.output = argv[++i];
      if (flags.output === undefined) fail(`${a} 需要一个路径参数`);
    } else if (a === '-p' || a === '--port') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0 || v > 65535) fail(`${a} 需要一个 0-65535 的端口号`);
      flags.port = v;
    } else if (a === '--no-ai') {
      flags.ai = false;
    } else if (a === '--no-cache') {
      flags.cache = false;
    } else if (a === '--no-launch') {
      flags.launch = false;
    } else if (a === '-h' || a === '--help') {
      flags.help = true;
    } else if (a.startsWith('-') && a !== '-') {
      fail(`未知参数:${a}`);
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

// Recursively collect *.md; skip dotfiles, node_modules, names starting with _.
function findMdFiles(root) {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name.startsWith('_') || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  })(root);
  return out.sort();
}

function statOrFail(p) {
  try {
    return fs.statSync(p);
  } catch {
    fail(`路径不存在:${p}`);
  }
}

// `[ai] provider: {baseUrl} model: {model} key: {first7…last4 | missing}`
function printProviderLine() {
  const { resolveProvider } = require('../src/ai');
  const p = resolveProvider(process.env);
  const key = p.hasKey && p.apiKey ? `${p.apiKey.slice(0, 7)}…${p.apiKey.slice(-4)}` : 'missing';
  console.log(`[ai] provider: ${p.baseUrl} model: ${p.model} key: ${key}`);
}

function logAiTotals(t) {
  if (t && t.total > 0) {
    console.log(`[ai] 共 ${t.total} 块:执行 ${t.ran},命中缓存 ${t.cached},失败 ${t.errors}`);
  }
}

async function cmdBuild(srcs, flags) {
  if (srcs.length === 0) fail('build 需要至少一个 <src>(文件或目录)');
  const config = loadConfig(process.cwd());
  const { buildFile, buildSite } = require('../src/compiler');
  const outDir = flags.output || config.outDir;
  const useAi = flags.ai !== false;
  const useCache = flags.cache !== false;
  const onLog = (msg) => console.log(msg);
  const common = {
    outDir,
    siteTitle: config.siteTitle,
    description: config.description,
    useAi,
    useCache,
    onLog,
  };
  const stats = srcs.map((s) => statOrFail(s));
  if (useAi) printProviderLine();

  if (srcs.length === 1 && stats[0].isDirectory()) {
    const r = await buildSite(srcs[0], common);
    console.log(`已构建 ${r.pages.length} 个页面 -> ${r.outDir}`);
    console.log(`llms.txt -> ${path.join(r.outDir, 'llms.txt')}`);
    logAiTotals(r.aiTotals);
    return;
  }
  // Files (and any directories) -> build every *.md into one flat outDir.
  const files = [];
  srcs.forEach((s, i) => {
    if (stats[i].isDirectory()) files.push(...findMdFiles(s));
    else files.push(s);
  });
  if (files.length === 0) fail('没有找到任何 .md 文件');
  const totals = { total: 0, cached: 0, ran: 0, errors: 0 };
  for (const f of files) {
    const r = await buildFile(f, common);
    totals.total += r.ai.total;
    totals.cached += r.ai.cached;
    totals.ran += r.ai.ran;
    totals.errors += r.ai.errors;
    console.log(`✓ ${f} -> ${r.outFile} (${r.tokens} tokens)`);
  }
  console.log(`已构建 ${files.length} 个页面 -> ${outDir}`);
  logAiTotals(totals);
}

// fs.watch recursive:true with fallback to watching each subdirectory.
function watchSource(target, onEvent) {
  try {
    return [fs.watch(target, { recursive: true }, onEvent)];
  } catch {
    // fallback (non-recursive platforms / file target)
  }
  const watchers = [];
  if (!fs.statSync(target).isDirectory()) {
    watchers.push(fs.watch(target, onEvent));
    return watchers;
  }
  (function walk(dir) {
    try {
      watchers.push(fs.watch(dir, onEvent));
    } catch {
      // unreadable dir -> skip
    }
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        walk(path.join(dir, e.name));
      }
    }
  })(target);
  return watchers;
}

async function cmdServe(srcs, flags) {
  if (srcs.length !== 1) fail('serve 需要且仅需要一个 <src>(文件或目录)');
  const config = loadConfig(process.cwd());
  const { buildFile, buildSite } = require('../src/compiler');
  const { serve } = require('../src/server');
  const src = srcs[0];
  const isDir = statOrFail(src).isDirectory();
  const outDir = flags.output || config.outDir;
  const port = flags.port !== undefined ? flags.port : config.port;
  const useAi = flags.ai !== false;
  const useCache = flags.cache !== false;
  const onLog = (msg) => console.log(msg);
  const common = {
    outDir,
    siteTitle: config.siteTitle,
    description: config.description,
    useAi,
    useCache,
    onLog,
  };
  const rebuild = () => (isDir ? buildSite(src, common) : buildFile(src, common));

  if (useAi) printProviderLine();
  await rebuild();
  const handle = await serve({ root: outDir, port });
  console.log(`本地地址:${handle.url}`);
  console.log('正在监听文件变化,按 Ctrl+C 退出。');

  // Debounced rebuild (~100ms); ignore events coming from the output dir
  // itself to avoid rebuild loops when outDir lives inside src.
  const outAbs = path.resolve(outDir);
  let timer = null;
  const pending = new Set();
  const onEvent = (event, filename) => {
    if (filename) {
      const abs = path.resolve(src, filename.toString());
      if (abs === outAbs || abs.startsWith(outAbs + path.sep)) return;
      pending.add(filename.toString());
    }
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const changed = [...pending];
      pending.clear();
      const t0 = Date.now();
      try {
        await rebuild();
        console.log(`已重新构建(${changed.join(', ') || '文件变化'},${Date.now() - t0}ms)`);
        handle.broadcastReload();
      } catch (err) {
        console.error(`重新构建失败:${err.message}`);
      }
    }, 100);
  };
  const watchers = watchSource(src, onEvent);

  process.on('SIGINT', () => {
    clearTimeout(timer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    handle.close();
    console.log('\n再见。');
    process.exit(0);
  });
}

function isClosingFence(line, fence) {
  const m = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
  return Boolean(m) && m[1][0] === fence.char && m[1].length >= fence.len;
}

// Replace each ```ai fence in the ORIGINAL markdown with the generated
// markdown (or an HTML comment carrying the error), in document order.
function expandAiFences(src, blocks) {
  const lines = src.split('\n');
  const out = [];
  let fence = null; // { char, len } of the open non-ai fence
  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (isClosingFence(line, fence)) fence = null;
      out.push(line);
      continue;
    }
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const open = { char: m[1][0], len: m[1].length };
    const lang = (m[2].trim().split(/\s+/)[0] || '').toLowerCase();
    if (lang !== 'ai') {
      fence = open;
      out.push(line);
      continue;
    }
    // ai fence: skip to its closing fence, emit expansion
    let j = i + 1;
    while (j < lines.length && !isClosingFence(lines[j], open)) j++;
    const block = blocks[idx++] || {};
    if (block.error) {
      out.push(`<!-- ai-error: ${String(block.error).replace(/--/g, '-')} -->`);
    } else {
      out.push('<!-- ai-generated -->');
      out.push(block.markdown != null ? String(block.markdown) : '');
    }
    i = j; // loop increment moves past the closing fence (or EOF)
  }
  return out.join('\n');
}

async function cmdExpand(args, flags) {
  if (args.length !== 1) fail('expand 需要且仅需要一个 <file.md>');
  const { parseMarkdown } = require('../src/parser');
  const { fillAiBlocks } = require('../src/ai');
  const file = args[0];
  statOrFail(file);
  const src = fs.readFileSync(file, 'utf8');
  const parsed = parseMarkdown(src);
  const blocks = parsed.aiBlocks || [];
  if (blocks.length > 0) {
    // progress goes to stderr so stdout stays pure markdown
    await fillAiBlocks(blocks, {
      env: process.env,
      useCache: flags.cache !== false,
      onLog: (msg) => console.error(msg),
    });
  }
  const out = expandAiFences(src, blocks);
  if (flags.output) {
    fs.writeFileSync(flags.output, out, 'utf8');
    console.log(`已写入 ${flags.output}`);
  } else {
    process.stdout.write(out);
  }
}

function cmdTokens(srcs) {
  if (srcs.length === 0) fail('tokens 需要至少一个 <src>(文件或目录)');
  const { estimateReport } = require('../src/tokens');
  const files = [];
  for (const s of srcs) {
    if (statOrFail(s).isDirectory()) files.push(...findMdFiles(s));
    else files.push(s);
  }
  if (files.length === 0) fail('没有找到任何 .md 文件');
  const rows = estimateReport(
    files.map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') })),
  );
  const total = rows.reduce((acc, r) => ({ chars: acc.chars + r.chars, tokens: acc.tokens + r.tokens }), { chars: 0, tokens: 0 });
  const wPath = Math.max(5, ...rows.map((r) => r.path.length));
  const wChars = Math.max(5, String(total.chars).length);
  const wTokens = Math.max(6, String(total.tokens).length);
  const line = (p, c, t) =>
    `${p.padEnd(wPath)}  ${String(c).padStart(wChars)}  ${String(t).padStart(wTokens)}`;
  console.log(line('path', 'chars', 'tokens'));
  for (const r of rows) console.log(line(r.path, r.chars, r.tokens));
  console.log(line('total', total.chars, total.tokens));
}

function cmdInit(args) {
  const { scaffold } = require('../src/scaffold');
  const dir = args[0] || './kmd-docs';
  const r = scaffold(path.resolve(dir));
  console.log(`已生成示例项目:${dir}`);
  for (const f of r.created) console.log(`  + ${path.relative(process.cwd(), f)}`);
  console.log('');
  console.log('下一步:');
  console.log(`  node bin/kmd.js build ${path.join(dir, 'docs')} -o ${path.join(dir, 'site')}`);
  console.log(`  node bin/kmd.js serve ${path.join(dir, 'docs')} -o ${path.join(dir, 'site')}`);
}

// `kmd app [projectPath] [--port N] [--no-launch]` — KMD Studio desktop app:
// local server on 127.0.0.1 + Chromium app-mode window (see docs/studio-contract.md).
async function cmdApp(args, flags) {
  const { studioServer } = require('../src/studio/server');
  const { launchApp } = require('../src/studio/launch');
  const port = flags.port !== undefined ? flags.port : 0;
  const handle = await studioServer({
    port,
    cwd: process.cwd(),
    env: process.env,
    onLog: (msg) => console.log(msg),
  });
  if (args[0]) {
    try {
      await handle.api.openProject(args[0]);
      console.log(`已打开项目:${handle.getState().project.path}`);
    } catch (err) {
      await handle.close();
      fail(`无法打开项目:${err.message}`);
    }
  }
  console.log(`本地地址:http://127.0.0.1:${handle.port}`);
  if (process.env.KMD_DEBUG) console.log(`调试地址:${handle.url}`);
  console.log('提示:关闭应用窗口即自动退出。');
  if (flags.launch !== false && !process.env.KMD_NO_LAUNCH) launchApp(handle.url);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    process.stdout.write(USAGE);
    return;
  }
  if (!cmd) {
    // No arguments (e.g. double-clicking the packaged exe): launch Studio.
    await cmdApp([], {});
    return;
  }
  const { args, flags } = parseArgs(argv.slice(1));
  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  switch (cmd) {
    case 'build':
      await cmdBuild(args, flags);
      break;
    case 'serve':
      await cmdServe(args, flags);
      break;
    case 'app':
      await cmdApp(args, flags);
      break;
    case 'expand':
      await cmdExpand(args, flags);
      break;
    case 'tokens':
      cmdTokens(args);
      break;
    case 'init':
      cmdInit(args);
      break;
    default:
      fail(`未知命令:${cmd}`);
  }
}

main().catch((err) => {
  console.error(`错误:${err && err.message ? err.message : err}`);
  process.exit(1);
});
