# opencode-quota-sidebar

[English](./README.md)

OpenCode 插件：在 TUI sidebar 中显示 token 用量和 provider quota，同时让共享的 session title 在 Desktop、Web 和 TUI 中都保持紧凑可读。

![示例截图](./assets/OpenCode-Quota-Sidebar.png)

上面的截图来自 [`./assets/OpenCode-Quota-Sidebar.png`](./assets/OpenCode-Quota-Sidebar.png)，展示的是这个插件实际渲染出来的 TUI 侧边栏布局。

## 核心能力

- 在 TUI sidebar 中渲染结构化的 `TITLE`、`USAGE`、`QUOTA` 三个区块
- 让共享 `session.title` 保持紧凑单行，而不是把多行遥测数据写进所有客户端都共用的标题
- 统计 `session`、`day`、`week`、`month` 四种范围的 usage
- 内置支持 OpenAI、Copilot、Anthropic、Kimi、Zhipu、MiniMax、RightCode、XYAI 的 quota / balance 获取
- session 级统计可选聚合 descendant subagent sessions
- 提供 `quota_summary` 和 `quota_show` 两个工具

## 架构概览

这个仓库是纯插件实现，不修改 OpenCode 核心代码。

- Server 层：负责 usage 聚合、quota 拉取、状态持久化、title 刷新和工具注册
- TUI 层：负责侧边栏面板渲染，并读取持久化的 sidebar-panel 数据
- Persistence 层：负责全局状态和按日期分片的 session chunk 存储
- Provider Adapter 层：通过统一的 `QuotaSnapshot` 结构屏蔽不同 provider 的 quota/balance 接口差异

依赖 `@opencode-ai/plugin` 和 `@opencode-ai/sdk`。

## 工作方式

这个插件有两条展示路径：

- TUI sidebar panel：渲染结构化的 `TITLE / USAGE / QUOTA`
- Shared session title：保持紧凑单行，供 Desktop、Web、TUI 共同使用

在 `sidebar.titleMode="auto"` 下，共享 title 会保持 compact 单行。更丰富的多段布局由专门的 TUI 插件渲染，而不是直接写进 `session.title`。

当 `sidebar.includeChildren=true` 时，`period=session` 的统计可以聚合子代 subagent sessions。`day/week/month` 范围统计不会合并 descendants。

## 支持的 Provider

内置 quota adapter 如下：

| Provider            | Endpoint family                                            | 鉴权方式            | 展示形态        | 说明                                               |
| ------------------- | ---------------------------------------------------------- | ------------------- | --------------- | -------------------------------------------------- |
| OpenAI Codex        | `chatgpt.com/backend-api/wham/usage`                       | OAuth               | 多窗口订阅额度  | 读取 ChatGPT usage 窗口，例如短窗口 + 周窗口       |
| GitHub Copilot      | `api.github.com/copilot_internal/user`                     | OAuth               | 月度额度        | 使用 Copilot internal user 接口                    |
| Anthropic           | `api.anthropic.com/api/oauth/usage`                        | OAuth               | 多窗口订阅额度  | 支持 plan-based usage windows                      |
| Kimi For Coding     | `api.kimi.com/coding/v1/usages`                            | API key             | 多窗口订阅额度  | 通常为 `5h` + weekly                               |
| Zhipu Coding Plan   | `bigmodel.cn/api/monitor/usage/quota/limit`                | API key             | token quota     | coding plan 风格额度                               |
| MiniMax Coding Plan | `www.minimaxi.com/v1/api/openplatform/coding_plan/remains` | API key             | 多窗口订阅额度  | 通常为 `5h` + weekly                               |
| RightCode           | `www.right.codes/account/summary`                          | API key             | 日额度和/或余额 | 按 prefix 匹配订阅，失败时回退为 balance           |
| XYAI                | `new.xychatai.com/frontend-api/*`                          | 登录态 session auth | 日额度 / 日余额 | 默认关闭，需要在 `quota.providers.xyai` 中显式开启 |

补充说明：

- 没有内置 quota adapter 的 generic provider 仍然可以参与 usage 聚合，但不会显示 quota/balance
- OpenAI、Copilot、Anthropic 的 quota 支持依赖 OAuth / session auth，而不是通用 API key 账单接口
- RightCode 可能同时显示 daily allowance 和 balance 两行
- XYAI 需在配置中提供登录信息，插件会自行获取并缓存 session auth
- Copilot 支持 quota 展示，但当前不会显示 API-equivalent cost，因为 pricing metadata 不够稳定

## 展示规则

- Sidebar quota 区块只展示当前 session 中实际使用过、且能被 adapter 识别的 provider
- `quota_summary` 会主动抓取默认 quota providers，即使当前 session 没用到
- TUI sidebar 优先读取持久化的 `sidebarPanel` / usage 数据，所以历史 session 打开时也能快速渲染
- compact title 中的 quota 解析只是兜底路径，TUI panel 优先消费结构化持久化数据
- `quota_show` 控制的是共享 title 的装饰开关，TUI panel 仍然是主要的富文本展示入口

title 相关补充：

- `sidebar.titleMode="auto"`：共享 title 保持 compact
- `sidebar.titleMode="compact"`：强制所有客户端都使用 compact title
- `sidebar.titleMode="multiline"`：使用旧的 multiline title 装饰路径
- 共享 title 本质上仍然只有一个 `session.title`，所以复杂布局更适合放在 TUI panel 中

## Sidebar 示例

典型的 TUI sidebar 布局：

```text
TITLE
  Fix quota adapter matching
USAGE
  R184 I189k O53.2k
  CR31.4k CW3.2k Cd66%
  Est $12.8
QUOTA
  OAI 5h80 R3h20m
      W70 R2D04h
  Cop M78 R12D00h
  RC D$88.9/$60 E6D00h
     B260
```

compact shared title 示例：

```text
Fix quota adapter matching | OAI 5h80 R3h20m W70 R2D04h | RC D$88.9/$60 B260 | Cd66% | Est$12.8
```

另一个多 provider 示例：

```text
Add XYAI quota adapter | Ant 5h100 W77 O7d60 | Cop M78 R04-01 | Cd52% | Est$2.34
```

## Tool Report 示例

`quota_summary` 返回的 markdown 大致会是这样的结构：

```md
## Session Usage

- Requests: 184
- Input: 189k
- Output: 53.2k
- Cache Read: 31.4k
- Cache Write: 3.2k
- Cost as API: $12.8

## Quota

- OpenAI: 5h 80% (reset 3h20m), Weekly 70% (reset 2D04h)
- Copilot: Monthly 78% (reset 12D00h)
- RightCode: Daily $88.9/$60 (exp 6D00h), Balance $260
```

这个工具本身就返回完整 markdown，调用方应该直接展示，而不是再压缩成一句话摘要。

补充说明：

- Sidebar 里用的是 compact token
- Toast 和 markdown report 使用更完整的人类可读文案
- `quota_summary` 可以展示默认 quota providers，即使当前 session 没有使用它们

## 为什么需要 TUI Panel

OpenCode 对 sidebar title 的渲染本质上是一个单一的文本字段。它适合放紧凑的 telemetry，但不适合承载结构化的多段布局。

所以这个插件采用了两层设计：

- shared compact title：保证跨客户端兼容
- dedicated TUI sidebar panel：提供更清晰的区块化展示

这样既不会污染 Desktop/Web 的标题，又能让 TUI 用户看到清晰的 quota dashboard。

## 缩写说明

Usage token：

- `R`：requests
- `I`：input tokens
- `O`：output tokens，已包含 reasoning tokens
- `CR`：cache read tokens
- `CW`：cache write tokens
- `Cd`：cached ratio / cache coverage
- `Est`：API-equivalent cost estimate

Quota token：

- `OAI`：OpenAI
- `Cop`：GitHub Copilot
- `Ant`：Anthropic
- `RC`：RightCode
- `B`：balance
- `D`：daily window
- `W`：weekly window
- `M`：monthly window
- `R3h20m`：还剩 `3h20m` 重置
- `R2D04h`：还剩 `2D04h` 重置
- `E6D00h`：还剩 `6D00h` 到期

compact quota 片段示例：

- `OAI 5h80 R3h20m`：OpenAI 短窗口剩余 80%，还剩 `3h20m` 重置
- `Cop M78 R12D00h`：Copilot 月额度剩余 78%，还剩 `12D00h` 重置
- `RC D$88.9/$60 E6D00h B260`：RightCode 日额度 + 余额

## 安装

OpenCode 会分别从 `opencode.json` 和 `tui.json` 加载 server / TUI 插件。

`opencode.json`

```json
{
  "plugin": ["@leo000001/opencode-quota-sidebar@latest"]
}
```

`tui.json`

```json
{
  "plugin": ["@leo000001/opencode-quota-sidebar@latest"]
}
```

OpenCode `>=1.2.15` 时，server 插件放在 `opencode.json`，TUI 插件放在 `tui.json`。

## 配置

常见配置路径：

- `~/.config/opencode/quota-sidebar.config.json`
- `<worktree>/quota-sidebar.config.json`
- `<worktree>/.opencode/quota-sidebar.config.json`
- `OPENCODE_QUOTA_CONFIG=/absolute/path/to/config.json`

最小示例：

```json
{
  "sidebar": {
    "enabled": true,
    "titleMode": "auto",
    "showCost": true,
    "showQuota": true,
    "includeChildren": true
  }
}
```

完整配置示例见 [`quota-sidebar.config.example.json`](./quota-sidebar.config.example.json)。

重要配置项：

- `sidebar.titleMode`：`auto`、`compact`、`multiline`
- `sidebar.showCost`：控制 sidebar、title、markdown report、toast 中的 API-equivalent cost 可见性
- `sidebar.wrapQuotaLines`：长 quota 行是否自动续行并缩进
- `sidebar.includeChildren`：`period=session` 时是否聚合 descendant subagent sessions
- `quota.providers.xyai.enabled`：是否启用 XYAI quota
- `quota.providers.xyai.login.username/password`：XYAI 登录信息，用于换取和刷新 session auth

配置采用分层覆盖，后层配置覆盖前层配置：

1. 全局配置
2. worktree 配置
3. directory 配置
4. worktree `.opencode` 配置
5. directory `.opencode` 配置
6. `OPENCODE_QUOTA_CONFIG`

## 持久化与聚合

插件会把数据写入：

- 全局状态：`<opencode-data>/quota-sidebar.state.json`
- session 分片：`<opencode-data>/quota-sidebar-sessions/YYYY/MM/DD.json`

这些持久化 chunk 会保存 title 状态、cached usage、sidebar-panel payload 和 quota cache，从而让 TUI sidebar 在 session open/resume 时可以直接从结构化状态恢复，而不必完全依赖实时 message 扫描。

usage 聚合采用增量模式。插件会为每个 session 维护 cursor，优先只处理新消息；如果消息历史变化导致增量视图失效，再回退到重扫并刷新持久化 usage。

## 工具

- `quota_summary`：查看 `session`、`day`、`week`、`month` 的用量和 quota
- `quota_show`：切换 title 装饰开关

行为说明：

- `quota_summary` 返回完整 markdown report
- `quota_summary` 可以同时触发 toast 展示
- `quota_summary(includeChildren=true)` 只影响 `period=session`
- `quota_show(enabled=true|false)` 可以显式指定目标状态，而不是只做 toggle

命令别名示例：

```json
{
  "command": {
    "qday": {
      "description": "Show today's usage and quota",
      "template": "Call tool quota_summary with period=day and toast=true."
    },
    "qweek": {
      "description": "Show this week's usage and quota",
      "template": "Call tool quota_summary with period=week and toast=true."
    },
    "qmonth": {
      "description": "Show this month's usage and quota",
      "template": "Call tool quota_summary with period=month and toast=true."
    },
    "qtoggle": {
      "description": "Toggle sidebar usage display on/off",
      "template": "Call tool quota_show (no arguments, it toggles)."
    }
  }
}
```

## 开发

```bash
npm install
npm run build
npm test
```

如果改动涉及 TypeScript 类型、配置加载或公共行为，建议额外执行：

```bash
npm run typecheck
```

本地调试时：

- 在 `opencode.json` 里加载 `file:///ABSOLUTE/PATH/opencode-quota-sidebar/dist/index.js`
- 在 `tui.json` 里加载 `file:///ABSOLUTE/PATH/opencode-quota-sidebar/dist/tui.tsx`

Windows 下请使用正斜杠形式的 `file:///` 路径。

## 兼容性与注意事项

- Node.js `>=18`
- OpenCode plugin SDK `@opencode-ai/plugin` / `@opencode-ai/sdk` `^1.3.5`
- OpenCode `>=1.2.15` 时，TUI 配置应放在 `tui.json`
- 共享 title 仍然只有一个 `session.title`，所有客户端共用
- 为了避免 resize 场景的渲染污染，sidebar title 默认避免使用 ANSI 样式码
- 有些 provider 提供真正的 quota window，有些 provider 只提供 balance 数据

## 文档导航

- English README：[`README.md`](./README.md)
- 变更记录：[`CHANGELOG.md`](./CHANGELOG.md)
- 贡献指南：[`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 安全策略：[`SECURITY.md`](./SECURITY.md)

## 贡献

- 变更记录：[`CHANGELOG.md`](./CHANGELOG.md)
- 适配器与架构说明：[`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 安全策略：[`SECURITY.md`](./SECURITY.md)
