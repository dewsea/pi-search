# pi-search 适配器扩展契约

自定义 Provider 适配器为 pi-search 提供文件级即插即用能力：把 TypeScript 或 JavaScript 文件放入用户适配器目录，重载后 Provider 即完成注册——无需改动包、无需修改注册表。

## 目录布局

用户适配器从 Pi 解析后的代理目录中发现：

```text
<agent-dir>/extensions/pi-search/
  config.json        # 可选：apiKeys / defaults（见 README）
  providers/         # 自定义 Provider 适配器文件
```

`<agent-dir>` 为 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent`（XDG 布局通过 `PI_CODING_AGENT_DIR` 生效）。适配器文件可为 `.ts` 或 `.js`；名为 `index.*`、`types.*`、`*.test.*`、`*.spec.*` 及 `*.d.ts` 的文件会被忽略，子目录不扫描。

## 适配器文件形态

每个文件默认导出一个由 `defineProvider` 产生的 `Provider` 对象：

```ts
import { defineProvider, type ProviderContext, type SearchResponse, type FetchResponse } from "@hyav/pi-search";

export default defineProvider({
  name: "my-provider",            // 唯一 ID；同名时覆盖内置
  label: "My Provider",           // 展示名
  envVar: "MY_PROVIDER_API_KEY",  // API Key 对应的环境变量
  keyless: false,                 // 可选：免 Key 即可使用时设为 true

  searchHint: "何时在 search 中优先使用该 Provider。",
  fetchHint: "何时在 fetch 中优先使用该 Provider。",

  async search(query: string, maxResults: number, ctx: ProviderContext): Promise<SearchResponse> {
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

  async fetch(url: string, ctx: ProviderContext): Promise<FetchResponse> {
    const res = await ctx.request(`https://api.myprovider.com/extract?url=${encodeURIComponent(url)}`);
    const data = await res.json();
    return {
      title: data.title,
      text: data.content,
    };
  },
});
```

`defineProvider` 是纯校验函数：在加载时校验声明，并原样返回 Provider 对象。

## 校验规则

声明非法时加载失败，该文件被跳过并输出警告，其余文件继续加载。

- `name`、`label`、`envVar` 必填且为非空字符串。
- 必须至少实现 `search` 或 `fetch` 中的一个方法。
- 实现 `search` 时必须提供 `searchHint`。
- 实现 `fetch` 时必须提供 `fetchHint`。
- `keyless`（存在时）必须是布尔值。
- 旧版 v0.1 字段（`create`、`capabilities`、`searchFallbackPriority`、`fetchFallbackPriority`）会被拦截并抛出明确的迁移指引错误。

## ProviderContext

方法入参包含 `ProviderContext` 对象，提供以下上下文能力：

- `apiKey`：已解析的有效 API Key（优先读取存储配置，其次读取环境变量），免 Key 时为 `undefined`。
- `signal`：用于取消操作传播的 `AbortSignal`。
- `request(url, init)`：封装了 `fetch` 的 HTTP 请求助手方法，自动内置 30 秒超时、10 MiB 缓冲区限制与中断信号处理。

## 冲突与覆盖语义

内置 Provider 在模块加载时先注册；用户适配器后加载，因此同名用户适配器会覆盖内置注册，元数据在原位替换。删除覆盖内置的用户适配器并执行 `/reload` 后，会自动恢复内置 Provider。

## 加载与 `/reload`

适配器在扩展启动时加载。执行 `/reload` 后扩展重新发现：适配器根目录下的缓存模块会被丢弃，已有文件的修改会重新读盘；删除的文件移出注册表；损坏的文件跳过并警告。

## 适配器文件的导入规则

- 适配器文件从 `@hyav/pi-search` 导入 `defineProvider`、`registerProvider` 及共享类型（`Provider`、`ProviderContext`、`SearchResponse`、`FetchResponse`）。加载器将该包名别名指向包内适配器 API，不依赖本地物理安装。
- 适配器文件不得在运行时导入 Pi 捆绑包（`@earendil-works/*`）；仅类型导入不受限。
- 适配器代码以用户完整系统权限运行，可执行任意代码。只安装你信任来源的适配器。

## 参考模板

包内 `src/providers/` 下的内置 Provider（`tavily.ts`、`anysearch.ts`、`jina.ts`、`exa.ts`、`serper.ts`、`firecrawl.ts`、`brave.ts`、`tinyfish.ts`、`serpapi.ts`）即此形态的标准参考模板。仓库内 [`examples/search-providers`](../examples/search-providers/) 还提供额外的 DeepSeek、豆包搜索、Gemini、iFlow 参考实现。
