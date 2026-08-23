# pi-search

[English](README.md)

为 [Pi](https://pi.dev) 提供由大语言模型（LLM）路由的网页搜索与内容抽取扩展，内置 Tavily 与 AnySearch 搜索，以及 Tavily、AnySearch 和 Jina 网页抽取能力。

[参与贡献](CONTRIBUTING.md) · [更新记录](CHANGELOG.md) · [安全策略](SECURITY.md)

## 核心能力

- 基于 Provider 能力元数据进行 LLM 动态路由，而非写死规则分类器
- 免 API Key 搜索与抽取路径，支持成本感知的优雅降级
- 自定义 Provider 适配器即插即用：放入 `<agent-dir>/extensions/pi-search/providers/` 即可生效
- 覆盖通用搜索、垂直搜索，以及网页与 PDF 抽取
- 具备服务端请求伪造（SSRF）防护、有界响应、请求取消与超时机制
- 结果去重并严格限制在 Pi 的 2,000 行或 50 KiB 工具输出限额内，完整结果保存在临时文件中

## 安装

需要 Node.js 22.19.0 或更高版本以及 Pi。

```sh
pi install npm:@hyav/pi-search
```

向 Pi 询问需要实时联网搜索的信息。安装成功后会暴露 `web_search` 和 `web_fetch` 工具，并由选中的内置 Provider 返回结构化结果。

## 配置

内置的 Tavily、AnySearch 搜索和 Jina 抽取无需 API Key 即可工作。配置可选凭据可解锁 Provider 专有能力：

| 提供商 | 环境变量 | 作用 |
|---|---|---|
| Tavily | `TAVILY_API_KEY` | 启用需鉴权的抓取、站点地图和深度研究能力 |
| AnySearch | `ANYSEARCH_API_KEY` | 鉴权通用搜索、垂直搜索和内容抽取请求 |
| Jina | `JINA_API_KEY` | 鉴权网页与 PDF 抽取请求 |

环境变量优先于 `<agent-dir>/extensions/pi-search/config.json`，其中 `<agent-dir>` 为 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`（`$XDG_CONFIG_HOME/pi/agent` 等 XDG 布局通过 `PI_CODING_AGENT_DIR` 生效）。凭据文件应限制为仅当前用户可读。

## 使用

模型直接调用 `web_search` 和 `web_fetch`。未显式指定 Provider 时，降级顺序为：

- 搜索：Tavily → AnySearch
- 提取：Tavily → Jina → AnySearch

显式选择 Provider 后不会静默降级；失败会直接返回。若当前无匹配能力的已配置或免 Key Provider，工具会抛出明确的错误提示。

## 自定义 Provider

自定义 Provider 适配器是普通的 TypeScript 文件，启动时从你的 Pi 代理目录自动发现（`/reload` 后重新发现）：

```text
<agent-dir>/extensions/pi-search/providers/
  my-provider.ts
```

放入文件即自动注册（每个文件一个 Provider）；声明了与内置 Provider 相同 `name` 的文件会覆盖内置实现。适配器文件从本包导入 `defineProvider` 并默认导出适配器：

```ts
import { defineProvider, type Provider } from "@hyav/pi-search";

class MyProvider implements Provider {
  // 按声明的 ProviderCapabilities 实现 search()、fetch() 等
}

export default defineProvider({
  name: "my-provider",
  label: "My Provider",
  envVar: "MY_PROVIDER_API_KEY",
  capabilities: {
    generalSearch: true,
    verticalSearch: false,
    contentExtraction: true,
    crawl: false,
    siteMap: false,
    deepResearch: false,
    batchSearch: false,
    hasMetadata: false,
  },
  searchHint: "...",
  fetchHint: "...",
  searchFallbackPriority: 20,
  fetchFallbackPriority: 20,
  apiKeyRequired: false,
  create: ({ apiKey }) => new MyProvider(apiKey),
});
```

完整的文件形态、校验规则、冲突与重载行为见[适配器契约文档](https://github.com/hyav/pi-search/blob/main/docs/adapter-extensions.md)。包内 `src/providers/` 下的内置 Provider 即此形态的参考模板——复制一份按需修改即可。仓库内 [`examples/search-providers`](examples/search-providers/) 还提供不会默认启用的 DeepSeek、豆包搜索、Exa、Firecrawl、Gemini、iFlow 与 Serper 适配器参考实现。适配器文件不得在运行时导入 Pi 捆绑包（`@earendil-works/*`），仅类型导入不受限。增删改文件后执行 `/reload` 即可重新发现，无需改动包本身。

适配器文件以你的完整系统权限运行，可执行任意代码——只安装你信任来源的适配器。

## 使用须知

搜索词、请求的 URL 和提取内容会发送给选定的外部 Provider，并受其价格与数据政策约束。超大结果会保留在操作系统临时目录中，直到用户删除或由系统清理。

## 许可证

[MIT](LICENSE)
