# pi-search 适配器扩展契约

自定义 Provider 适配器为 pi-search 提供文件级即插即用：把 TypeScript 文件放入用户适配器目录，重载后 Provider 即完成注册——无需改动包、无需修改注册表。

## 目录布局

用户适配器从 Pi 解析后的代理目录中发现：

```text
<agent-dir>/extensions/pi-search/
  config.json        # 可选：apiKeys / defaults（见 README）
  providers/         # 自定义 Provider 适配器文件
```

`<agent-dir>` 为 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`（XDG 布局通过 `PI_CODING_AGENT_DIR` 生效）。适配器文件可为 `.ts` 或 `.js`；名为 `index.*`、`types.*`、`*.test.*`、`*.spec.*` 及 `*.d.ts` 的文件会被忽略，子目录不扫描。

## 适配器文件形态

每个文件默认导出一个由 `defineProvider` 产生的 `ProviderAdapter`：

```ts
import { defineProvider, type Provider } from "@hyav/pi-search";

class MyProvider implements Provider {
  // 按 capabilities 声明实现对应方法：
  //   search(query, maxResults, signal?)
  //   fetch(url, signal?)
  //   verticalSearch(domain, subDomain, query, maxResults, signal?)
  //   batchSearch(queries, maxResults, signal?)
  //   crawl(url, maxPages, signal?)
  //   map(url, signal?)
  //   research(query, signal?)
}

export default defineProvider({
  name: "my-provider",            // 唯一 ID；同名时覆盖内置
  label: "My Provider",           // 展示名
  envVar: "MY_PROVIDER_API_KEY",  // API Key 对应的环境变量
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
  searchHint: "何时在 web_search 中优先使用该 Provider。",
  fetchHint: "何时在 web_fetch 中优先使用该 Provider。",
  searchFallbackPriority: 20,     // 越小越先尝试（搜索降级链）
  fetchFallbackPriority: 20,      // 越小越先尝试（提取降级链）
  apiKeyRequired: false,          // 默认 true：无 Key 时不实例化
  create: ({ apiKey }) => new MyProvider(apiKey),
});
```

`defineProvider` 是纯函数：校验声明并原样返回适配器。加载器在成功导入默认导出后执行注册。

## 校验规则

声明非法时加载失败，该文件被跳过并输出警告，其余文件继续加载。规则：

- `name`、`label`、`envVar` 必填且为非空字符串。
- `capabilities` 与 `create()` 必填。每个能力标志必须是布尔值，`apiKeyRequired`（存在时）必须是布尔值，降级优先级（存在时）必须是有限数值。
- `verticals`（存在时）必须是非空字符串数组。
- `generalSearch: true` 时必须声明 `searchHint` 与 `searchFallbackPriority`。
- `contentExtraction: true` 时必须声明 `fetchHint` 与 `fetchFallbackPriority`。
- `generalSearch: false` 时声明 `searchHint` 或 `searchFallbackPriority` 会被拒绝。
- `verticalSearch: false` 时声明 `verticals` 会被拒绝。

## 冲突与覆盖语义

内置 Provider 在模块加载时先注册；用户适配器后加载，因此同名用户适配器会覆盖内置注册。被覆盖的元数据与工厂在原位替换，路由、降级链与工具 schema 自动生效；重复注册会输出包含 Provider 名的警告。

## 加载与 /reload

适配器在扩展启动时加载，先于 `web_search`、`web_fetch` 工具 schema 的注册，因此新 Provider 立即出现在 Provider 枚举中。执行 `/reload` 后扩展重新发现：适配器根目录下的缓存模块会被丢弃，已有文件的修改会重新读盘；删除的文件消失；损坏的文件跳过并警告。

## 适配器文件的导入规则

- 适配器文件从 `@hyav/pi-search` 导入 `defineProvider`、`registerProvider` 及共享类型（`Provider`、`ProviderCapabilities` 等）。加载器将该包名别名指向包内适配器 API，不依赖本地安装情况。
- 适配器文件不得在运行时导入 Pi 捆绑包（`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui`、`@earendil-works/pi-ai`）；仅类型导入不受限。代理目录、配置等运行时值由宿主解析，适配器文件不自行解析。
- API Key：宿主先读适配器 `envVar` 对应的环境变量，再读 `<agent-dir>/extensions/pi-search/config.json` 中 `config.apiKeys[name]`。
- 适配器代码以用户完整系统权限运行，可执行任意代码。只安装你信任来源的适配器。

## 参考模板

包内 `src/providers/` 下的内置 Provider（`tavily.ts`、`anysearch.ts`、`jina.ts`）即此形态的参考模板——复制一份按需修改即可。仓库内 [`examples/search-providers`](../examples/search-providers/) 还提供不会默认启用的 DeepSeek、豆包搜索、Exa、Firecrawl、Gemini、iFlow 与 Serper 完整参考实现。`src/adapter-loader.ts` 是发现机制的实现参考。
