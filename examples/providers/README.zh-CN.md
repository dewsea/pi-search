# 搜索 Provider 适配器参考实现

本目录包含一组完整但非内置的 `@hyav/pi-search` Provider 适配器参考实现。

它们刻意放在 `src/providers/` 之外，因此安装包不会默认加载或启用这些 Provider；npm 发布包也会排除这个仅供仓库维护的 `examples/` 目录。

## 包含的适配器

| Provider | 能力 | 必需环境变量 | 可选环境变量 |
|---|---|---|---|
| DeepSeek | 搜索 | `DEEPSEEK_API_KEY` | `DEEPSEEK_SEARCH_MODEL` |
| 豆包搜索 | 搜索 | `DOUBAO_SEARCH_API_KEY` | — |
| Gemini | 搜索 | `GEMINI_API_KEY` | `GEMINI_SEARCH_MODEL` |
| iFlow | 搜索、内容提取 | `IFLOW_API_KEY` | — |

## 安装为用户适配器

将需要的适配器复制到 Pi 解析后的代理目录：

```text
<agent-dir>/extensions/pi-search/
  config.json             # 可选
  providers/
    deepseek.ts
    doubao.ts
    gemini.ts
    iflow.ts
```

例如：

```sh
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extensions/pi-search/providers"
cp examples/providers/deepseek.ts \
  "$agent_dir/extensions/pi-search/providers/deepseek.ts"
```

如果未设置 `PI_CODING_AGENT_DIR`，Pi 通常将代理目录解析为 `~/.pi/agent`。

凭据可以通过上表中的环境变量提供，也可以写入 `<agent-dir>/extensions/pi-search/config.json`，其中键名使用适配器的 `name`：

```json
{
  "apiKeys": {
    "deepseek": "...",
    "doubao": "..."
  }
}
```

凭据解析优先级遵循统一的 `stored > env > keyless`，`config.json` 中的存储配置优先于环境变量。凭据文件应仅允许当前用户读取，且绝不能提交密钥。修改由进程继承的环境变量后需重启 Pi；也可更新 `config.json`，随后执行 `/reload`，重新发现适配器文件及工具 schema。

在 `search` 或 `fetch` 中使用的 Provider 名称分别为 `deepseek`、`doubao`、`gemini` 和 `iflow`。

## 范围与安全

这些是参考集成，不是内置 Provider。其上游 API、模型、字段、价格、额度及可用性可能独立于 pi-search 发生变化。仓库默认测试仅使用模拟响应，不会消耗 Provider 额度。

适配器文件以用户的完整系统权限运行。安装前请审查代码，只使用可信凭据，并确认各 Provider 当前的价格及数据政策。
