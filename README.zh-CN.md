# pi-search

[English](README.md)

> [!NOTE]
> 本项目已停止维护。

为 [Pi](https://pi.dev) 提供精简高效的网页搜索与内容提取扩展，包含两个明确的工具（`search` 与 `fetch`）、一个交互式 `/search` 命令，并内置 9 家主流 Provider。

[参与贡献](CONTRIBUTING.md) · [更新记录](CHANGELOG.md) · [安全策略](SECURITY.md)

## 核心能力

- 两个极简工具：`search` 与 `fetch`，强制显式传入 `providers` 参数
- 交互式 `/search` 命令：一键查看 Provider 状态、录入与删除 API Key
- 多 Provider 并发（上限 3 并发）：保序返回、部分失败容错聚合
- 内置 9 家 Provider：Tavily、AnySearch、Jina、Exa、Serper、Firecrawl、Brave、TinyFish 与 SerpApi
- 统一凭据优先级：`stored > env > keyless`，本地 Key 存入 `<agent-dir>/extensions/pi-search/config.json`（严格 0600 权限）
- 文件级即插即用自定义 Provider 适配器：放入 `<agent-dir>/extensions/pi-search/providers/` 即可生效
- 输出预算严格受限：硬顶在 Pi 默认的 2,000 行或 50 KiB 限制内，超限完整内容安全写入临时文件

## 安装

需要 Node.js 22.19.0 或更高版本以及 Pi。

```sh
pi install npm:@hyav/pi-search
```

安装后，pi-search 会注册 `/search` 命令，并根据已配置的候选 Provider 动态注册 `search` 和 `fetch`。

## 内置 Provider

| 提供商 | 支持方法 | 对应环境变量 | 免 Key | 简要说明 |
|---|---|---|---|---|
| Tavily | search, fetch | `TAVILY_API_KEY` | 是 | 通用搜索与高信噪比正文提取 |
| AnySearch | search, fetch | `ANYSEARCH_API_KEY` | 是 | 多引擎聚合搜索与结构化提取 |
| Jina | fetch | `JINA_API_KEY` | 是 | 网页与 PDF 快速转 Markdown 读取器 |
| Exa | search, fetch | `EXA_API_KEY` | 否 | 语义 / 神经搜索与内容检索 |
| Serper | search | `SERPER_API_KEY` | 否 | Google 搜索结果与摘要 API |
| Firecrawl | search, fetch | `FIRECRAWL_API_KEY` | 否 | 网页爬取与搜索，返回干净的 Markdown |
| Brave | search | `BRAVE_API_KEY` | 否 | 独立网页索引搜索 |
| TinyFish | search, fetch | `TINYFISH_API_KEY` | 否 | 高速 AI 搜索引擎与网页提取服务 |
| SerpApi | search | `SERPAPI_API_KEY` | 否 | Google 及多引擎 SERP 抓取 API |

Tavily、AnySearch 和 Jina 支持免 Key 开箱即用。配置可选的 API Key 可获得更高的调用配额与并发限制。

## 配置

### 交互式 `/search` 命令

在 Pi 内运行 `/search` 命令查看当前各 Provider 状态、录入或清除 API Key：

```text
/search
```

通过 `/search` 录入的 Key 会以原子写入方式保存至 `<agent-dir>/extensions/pi-search/config.json`，并自动设置 0600 文件权限。保存或清除后，工具定义与提示词即时动态更新。

### 凭据优先级

凭据解析顺序如下：

1. **Stored**：`<agent-dir>/extensions/pi-search/config.json` 中的 `apiKeys` 配置
2. **Environment**：Provider 声明的环境变量（如 `TAVILY_API_KEY`）
3. **Keyless**：内置免 Key 能力（如 Jina fetch）

`<agent-dir>` 由 `PI_CODING_AGENT_DIR` 解析，默认为 `~/.pi/agent`。

### 配置文件选项

`<agent-dir>/extensions/pi-search/config.json` 示例：

```json
{
  "apiKeys": {
    "tavily": "tvly-...",
    "exa": "..."
  },
  "defaults": {
    "max_results": 8
  }
}
```

可选的整数配置 `defaults.max_results` 为 `search` 未指定 `max_results` 时的默认返回条数（有效范围：1–20）。

## 使用

### `search`

在指定的 Provider 列表中执行搜索，支持并发与结果聚合。

```json
{
  "query": "nodejs 22 release notes",
  "providers": ["tavily", "brave"],
  "max_results": 5
}
```

- `query`（必填）：搜索查询关键词。
- `providers`（必填）：候选 Provider 名称数组。常规检索建议指定单一合适 Provider；需要交叉比对或广度覆盖时传入多个 Provider。
- `max_results`（可选）：每个 Provider 返回的最大结果条数（默认使用配置值或 5）。

### `fetch`

通过指定的 Provider 抓取并提取网页内容。

```json
{
  "url": "https://example.com/article",
  "providers": ["jina"]
}
```

- `url`（必填）：目标 HTTP(S) URL。
- `providers`（必填）：候选 Provider 名称数组（例如 `["jina"]` 或 `["firecrawl"]`）。

## 自定义 Provider

在代理目录下添加普通的 TypeScript 或 JavaScript 文件：

```text
<agent-dir>/extensions/pi-search/providers/
  my-provider.ts
```

每个文件使用 `defineProvider` 默认导出一个 `Provider` 对象：

```ts
import { defineProvider, type ProviderContext } from "@hyav/pi-search";

export default defineProvider({
  name: "my-provider",
  label: "My Provider",
  envVar: "MY_PROVIDER_API_KEY",
  searchHint: "用于特定领域的专业搜索。",
  fetchHint: "用于特定站点的内容提取。",

  async search(query: string, maxResults: number, ctx: ProviderContext) {
    const res = await ctx.request(`https://api.myprovider.com/search?q=${encodeURIComponent(query)}&n=${maxResults}`);
    const data = await res.json();
    return {
      results: data.items.map((item: any) => ({
        title: item.title,
        url: item.link,
        snippet: item.snippet,
      })),
    };
  },

  async fetch(url: string, ctx: ProviderContext) {
    const res = await ctx.request(`https://api.myprovider.com/extract?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    return {
      title: data.title,
      text: data.content,
    };
  },
});
```

详见[适配器扩展契约](https://github.com/hyav/pi-search/blob/v0.2.0/docs/adapter-extensions.zh-CN.md)。编辑或添加文件后，在 Pi 内执行 `/reload` 即可重新加载适配器。

## 安全与隐私说明

- 外部网络访问：搜索关键词与抓取 URL 会发送至显式指定的外部 Provider，受其服务条款与数据政策约束。
- 自定义适配器：`<agent-dir>/extensions/pi-search/providers/` 下的文件属于用户提供的代码，会以 Pi 的完整系统权限执行；只安装你信任的适配器。
- SSRF 防护：URL 在发起网络请求前均经过合法 HTTP(S) 校验；Provider 上下文强制执行 30 秒超时与 10 MiB 最大响应体限制。
- 输出限制：工具返回文本严格限制在 2,000 行或 50 KiB 以内。超限时完整内容落盘至仅当前用户可读的临时文件（0600 权限），并将路径报告给模型。

## 许可证

[MIT](LICENSE)
