# KMD

KMD 是一个**零依赖**的 AI 时代 Markdown 编译器：用 Markdown 写作，在编译期执行文档里的 AI 块，把大模型生成的内容固化成静态 HTML；同时输出原始 `.md` 与 `llms.txt`，让你的文档站对人类和 LLM 同样友好。

## 是什么

- 输入：普通 Markdown 文件（GFM 语法 + 提示框 + 数学公式 + Mermaid + AI 块）。
- 输出：一个纯静态站点——每页一个 `.html`、一份原始 `.md`，外加 `llms.txt`。
- AI 块在**构建时**执行一次，结果直接写进 HTML；访问站点没有任何运行时调用、不需要 API Key。
- 整个工具只用 Node.js（>= 18）内置模块实现，**没有任何 npm 依赖**。

## 快速开始

项目尚未发布到 npm，直接用 `node bin/kmd.js` 运行：

```bash
# 1. 生成示例项目(docs/ 四篇示例文档 + kmd.config.json)
node bin/kmd.js init my-docs

# 2. 构建静态站点(输出到 my-docs/site)
node bin/kmd.js build my-docs/docs -o my-docs/site

# 3. 本地预览,改动 Markdown 后浏览器自动刷新
node bin/kmd.js serve my-docs/docs -o my-docs/site
```

也可以一步到位：

```bash
npm run demo   # 等价于 init demo + build demo/docs -o demo/site
```

没有配置 API Key 也能构建：AI 块会渲染成"离线占位框"，配置 Key 后重新构建即自动补上内容。

## AI 块

在 Markdown 里写一个 ` ```ai ` 围栏，内容是提示词。构建时 KMD 调用 OpenAI 兼容接口，把返回的 Markdown 渲染成带 `✦ AI` 徽标的内容块：

````markdown
```ai
把下面这段文字总结为恰好 3 条要点,中文无序列表:

KMD 是一个零依赖的 Markdown 编译器……
```
````

围栏信息串支持 `key=value` 形式的块级配置，可覆盖模型与温度：

````markdown
```ai model=kimi-k2 temperature=0.3
用中文逐行解释这段代码……
```
````

### 环境变量

| 环境变量 | 说明 | 默认值 |
| --- | --- | --- |
| `KMD_AI_API_KEY` | API 密钥（也读 `OPENAI_API_KEY`、`MOONSHOT_API_KEY`） | 无 |
| `KMD_AI_BASE_URL` | OpenAI 兼容接口地址（也读 `OPENAI_BASE_URL`） | `https://api.moonshot.cn/v1` |
| `KMD_AI_MODEL` | 模型名 | `kimi-k2-0905-preview` |

- 密钥只用于编译期，不会写入任何产物。
- 相同"模型 + 提示词"的结果缓存在输出目录的 `.kmd-cache/` 中，重复构建不消耗额度；`--no-cache` 关闭。
- 构建开始时会打印一行脱敏的 provider 信息：`[ai] provider: … model: … key: sk-abcd…wxyz`。

## 命令参考

```
node bin/kmd.js build <src...> [-o outDir] [--no-ai] [--no-cache]
node bin/kmd.js serve <src> [-o outDir] [-p port] [--no-ai] [--no-cache]
node bin/kmd.js expand <file.md> [-o out.md]
node bin/kmd.js tokens <src...>
node bin/kmd.js init [dir]
node bin/kmd.js help
```

- `build`：`src` 是单个目录时构建整个站点（自动补齐索引页与 `llms.txt`，子目录结构原样镜像）；是一个或多个 `.md` 文件时逐个编译进同一输出目录。
- `serve`：先构建一次，再启动本地静态服务（默认端口 `4173`），监听源文件变化，保存后自动重新构建并刷新浏览器，`Ctrl+C` 退出。
- `expand`：把文件里的每个 ` ```ai ` 围栏替换为生成的 Markdown（失败则为错误注释），结果写到 `-o` 指定文件或标准输出。
- `tokens`：按 KMD 的估算规则（CJK 每字 1 token，其余约每 4 字符 1 token）打印每个文件的字符数 / token 数及合计。
- `init`：在目标目录（默认 `./kmd-docs`）生成示例项目；目录非空时拒绝执行。

### 配置文件

命令执行时会读取当前目录的 `kmd.config.json`，命令行参数优先于配置：

```json
{
  "siteTitle": "我的文档",
  "description": "项目文档站",
  "outDir": "site",
  "port": 4173,
  "ai": {}
}
```

## 语法支持表

| 语法 | 支持情况 |
| --- | --- |
| 标题（ATX `#`~`######`，自动锚点与目录） | ✅ |
| 加粗 / 斜体 / 删除线 / 行内代码 / 链接 / 图片 / 自动链接 | ✅ |
| 列表（有序、无序、嵌套、任务列表） | ✅ |
| 引用块与嵌套引用 | ✅ |
| 提示框 `[!note] [!tip] [!important] [!warning] [!caution]`（可自定义标题） | ✅ |
| 代码围栏（内置零依赖高亮，20+ 种语言） | ✅ |
| ` ```mermaid ` 图（浏览器端渲染） | ✅ |
| ` ```ai ` AI 块（编译期执行，可带块级配置） | ✅ |
| GFM 表格（对齐） | ✅ |
| 行内 / 块级数学公式（KaTeX，浏览器端渲染） | ✅ |
| 脚注 `[^id]` | ✅ |
| Frontmatter（`title`、`description` 等） | ✅ |
| 水平线 | ✅ |
| Setext 标题、引用式链接、原生 HTML 嵌入 | ❌（明确不支持，原始 HTML 会被转义） |

## 输出产物

对每篇 `docs/guide.md`，构建后在输出目录得到：

- `guide.html` —— 完整渲染的页面（内联样式，深浅色主题，无外部资源依赖也能看）；
- `guide.md` —— 原始 Markdown 逐字拷贝，供 LLM / 读者直接取用；
- `llms.txt` —— 按 [llmstxt.org](https://llmstxt.org) 规范生成的站点索引，链接到每页的 `.md`；
- 源目录没有根 `index.md` 时，自动生成一个列出全部页面的 `index.html`；
- 启用 AI 时的缓存目录 `.kmd-cache/`。

每次构建会先清空输出目录的内容（保留目录本身），再写入新产物。

## 桌面应用（KMD Studio）

`kmd app` 把 KMD 变成一个本地桌面应用：启动一个只监听 `127.0.0.1` 的 HTTP 服务，并自动用 Edge / Chrome 的应用模式（`--app=`）打开一个无地址栏窗口；找不到 Chromium 时回退到系统默认浏览器。

```bash
node bin/kmd.js app [projectPath] [--port N] [--no-launch]
```

Windows 下也可以直接双击仓库根目录的 `KMD.bat`。

- 打开 / 新建项目（`kmd init` 同款脚手架），左侧文件树、中间编辑器、右侧实时预览；
- 自动保存并增量构建，预览页即时刷新；
- 选中文本后可执行 AI 操作：润色 / 续写 / 翻译成英文 / 总结要点（需配置 `KMD_AI_API_KEY`）；
- 服务启动时生成一次性令牌，UI 通过 `X-KMD-Token` 请求头访问 API；关闭应用窗口后服务 45 秒内心跳停止即自动退出。

## 零依赖设计说明

KMD 的 `package.json` 里没有任何 `dependencies`——不是把依赖打进 bundle，而是根本不需要：

- Markdown 解析、代码高亮、HTML 模板、静态服务器均为自实现，只使用 `node:fs` / `node:path` / `node:http` / `node:crypto` 等内置模块；
- AI 请求直接 `fetch` OpenAI 兼容接口（Node 18+ 全局内置）；
- Mermaid 与 KaTeX 由浏览器从 CDN 按需加载，加载失败时页面依然完整可读；
- 好处：克隆即可运行、审计面极小、没有供应链风险、升级 Node 即完成"依赖升级"。

运行测试：

```bash
npm test   # node --test tests/
```
