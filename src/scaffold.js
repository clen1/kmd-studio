'use strict';
// `kmd init` scaffolding. Contract: docs/contracts.md "src/scaffold.js (Agent D)".
const fs = require('node:fs');
const path = require('node:path');

// NOTE: sample docs live in template literals; backticks are escaped (\`) and
// TeX backslashes doubled (\\). No ${...} sequences may appear in the content.

const CONFIG_JSON = JSON.stringify(
  {
    siteTitle: 'KMD 示例文档',
    description: '一个由 KMD 生成的 AI 时代文档站',
    outDir: 'site',
    port: 4173,
    ai: {},
  },
  null,
  2,
) + '\n';

const GITIGNORE = 'site/\n.kmd-cache/\n';

const INDEX_MD = `---
title: 首页
description: KMD 示例文档站
---

# 欢迎使用 KMD

KMD 是一个**零依赖**的 AI 时代 Markdown 编译器：用 Markdown 写作，编译期注入 AI 生成内容，输出对人和 LLM 都友好的静态站点。

> [!note] 这是一个示例站点
> 由 \`kmd init\` 生成，四篇文档覆盖 KMD 的核心能力，直接 \`build\` 即可看到效果。

## 从这里开始

- [ ] 读一遍 [快速开始](getting-started.html)
- [ ] 学会写 [AI 块](ai-blocks.html)
- [ ] 翻一遍 [语法大全](syntax-showcase.html)
- [ ] 换成自己的内容，重新构建

## 为什么是 KMD

| 特性 | 说明 |
| --- | --- |
| 零依赖 | 只用 node:* 内置模块，克隆下来就能跑 |
| AI 块 | 编译期调用大模型，结果固化进 HTML，运行时零成本 |
| 双产物 | 每页同时输出 .html 与原始 .md |
| llms.txt | 自动生成 LLM 友好的站点索引 |
`;

const GETTING_STARTED_MD = `---
title: 快速开始
description: 三分钟跑通 KMD 的完整流程
---

# 快速开始

KMD 不需要 \`npm install\`[^zero]，Node.js 18 以上即可运行。

[^zero]: 全部功能基于 node:* 内置模块实现，依赖树为空。

## 三步上手

\`\`\`bash
# 1. 生成示例项目(docs/ + kmd.config.json)
node bin/kmd.js init my-docs

# 2. 构建静态站点(HTML + 原始 md + llms.txt)
node bin/kmd.js build my-docs/docs -o my-docs/site

# 3. 本地预览,改完 Markdown 自动刷新
node bin/kmd.js serve my-docs/docs -o my-docs/site
\`\`\`

> [!tip] 一步到位
> 在仓库根目录执行 \`npm run demo\`，自动完成 init + build。

## 配置文件

项目根目录的 \`kmd.config.json\`：

\`\`\`json
{
  "siteTitle": "我的文档",
  "description": "项目文档站",
  "outDir": "site",
  "port": 4173,
  "ai": {}
}
\`\`\`

命令行参数（如 \`-o\`、\`-p\`）会覆盖同名配置项。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| \`build <src...>\` | 编译文件或整个目录为静态站点 |
| \`serve <src>\` | 构建并启动实时刷新预览 |
| \`expand <file.md>\` | 把 AI 块展开成普通 Markdown |
| \`tokens <src...>\` | 估算各文件的 token 用量 |
| \`init [dir]\` | 生成示例项目 |

> [!important] 输出目录会被清空
> \`build\` 每次都会先清空输出目录里的内容再写入，别把手写文件放进去。
`;

const AI_BLOCKS_MD = `---
title: AI 块
description: 编译期执行的 AI 生成块
---

# AI 块

在 Markdown 里写一个 ai 围栏，KMD 会在**编译时**调用大模型，把返回的 Markdown 渲染后固化进 HTML。访问者看到的是纯静态内容，没有任何运行时调用。

## 配置密钥

\`\`\`bash
# macOS / Linux
export KMD_AI_API_KEY=sk-你的密钥

# Windows (cmd)
set KMD_AI_API_KEY=sk-你的密钥
\`\`\`

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| \`KMD_AI_API_KEY\` | API 密钥 | 无（缺失时 AI 块渲染为离线占位框） |
| \`KMD_AI_BASE_URL\` | OpenAI 兼容接口地址 | \`https://api.moonshot.cn/v1\` |
| \`KMD_AI_MODEL\` | 模型 | \`kimi-k2-0905-preview\` |

> [!warning] 密钥只存在于编译期
> 密钥不会写入任何产物；没有密钥站点照样构建，AI 块显示为占位框。

## 示例一：总结

\`\`\`ai
把下面这段文字总结为恰好 3 条要点，中文无序列表，每条不超过 30 字：

KMD 是一个零依赖的 Markdown 编译器。它在编译期执行文档里的 AI 块，把大模型生成的内容固化成静态 HTML；同时输出原始 Markdown 与 llms.txt，让站点对人类和 LLM 同样友好。产物无需任何运行时，可部署到任意静态托管。
\`\`\`

## 示例二：SEO 描述

\`\`\`ai
为"零依赖 AI Markdown 编译器"的产品首页写一段 80 字以内的中文 SEO description，包含关键词 Markdown、AI、零依赖，只输出 description 本身。
\`\`\`

## 示例三：解释代码（带块级配置）

围栏信息串里可以写 \`key=value\` 覆盖模型与温度：

\`\`\`ai model=kimi-k2 temperature=0.3
用中文逐行解释下面这段 JavaScript，先给一句话总结：

function debounce(fn, ms) {
  let t = null;
  return function () {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}
\`\`\`

> [!note] 缓存
> 相同模型 + 相同提示词会命中输出目录下的 \`.kmd-cache\`，重复构建不再消耗额度；\`--no-cache\` 可关闭。
`;

const SYNTAX_SHOWCASE_MD = `---
title: 语法大全
description: KMD 支持的 Markdown 语法，一页看完
---

# 语法大全

正文里可以混排 **加粗**、*斜体*、~~删除线~~、\`行内代码\` 和 [链接](https://www.moonshot.cn)。

> 普通引用
>
> > 嵌套引用也没问题。

---

## 五种提示框

> [!note]
> Note：补充说明。

> [!tip] 小技巧
> Tip：标题可以自定义。

> [!important]
> Important：重要信息。

> [!warning]
> Warning：需要注意。

> [!caution]
> Caution：高危操作。

## 表格（支持对齐）

| 对齐 | 标记 | 效果 |
| :--- | :---: | ---: |
| 左 | \`:---\` | 默认 |
| 中 | \`:---:\` | 居中 |
| 右 | \`---:\` | 右对齐 |

## 任务列表

- [x] 已完成：GFM 表格
- [x] 已完成：任务列表
- [ ] 未完成：暂不支持 Setext 标题

## 代码高亮

\`\`\`js
// JavaScript
function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
console.log(fib(10));
\`\`\`

\`\`\`python
# Python
def quicksort(xs):
    if len(xs) <= 1:
        return xs
    p = xs[0]
    return quicksort([x for x in xs[1:] if x < p]) + [p] + quicksort([x for x in xs[1:] if x >= p])
\`\`\`

\`\`\`diff
- const name = 'world';
+ const name = 'KMD';
\`\`\`

## Mermaid 图

\`\`\`mermaid
graph LR
  A[Markdown] --> B[KMD 编译器]
  B --> C[HTML]
  B --> D[llms.txt]
  B --> E[原始 .md]
\`\`\`

## 数学公式

行内公式 $E = mc^2$，以及块级公式：

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

## 脚注

代码高亮由内置引擎完成[^hl]，公式由 KaTeX 在浏览器端渲染[^katex]。

[^hl]: 基于正则的词法着色，零第三方包。
[^katex]: CDN 不可用时公式以 TeX 源码展示，不影响阅读。
`;

const FILES = [
  ['kmd.config.json', CONFIG_JSON],
  ['.gitignore', GITIGNORE],
  [path.join('docs', 'index.md'), INDEX_MD],
  [path.join('docs', 'getting-started.md'), GETTING_STARTED_MD],
  [path.join('docs', 'ai-blocks.md'), AI_BLOCKS_MD],
  [path.join('docs', 'syntax-showcase.md'), SYNTAX_SHOWCASE_MD],
];

// scaffold(dir) -> { created: [paths...] }
// Creates dir if missing; refuses (throws) if dir exists and is non-empty.
function scaffold(dir) {
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) {
      throw new Error(`无法初始化：${dir} 已存在且不是目录`);
    }
    if (fs.readdirSync(dir).length > 0) {
      throw new Error(`无法初始化：目录 ${dir} 非空，请换一个目录或清空后再试`);
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  for (const [rel, content] of FILES) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    created.push(file);
  }
  return { created };
}

module.exports = { scaffold };
