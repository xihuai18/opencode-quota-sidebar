# AGENTS.md — opencode-quota-sidebar

## 1. 项目目的

OpenCode 插件，通过 `@opencode-ai/plugin` API 在 TUI sidebar 的 session title 中显示 token 用量和订阅额度信息。不 fork OpenCode，纯插件实现。

目标：

1. 实时显示当前 session 的 token 消耗（Input/Output/Cache/Reasoning）
2. 显示订阅制 provider 的额度余量（OpenAI Codex、GitHub Copilot）
3. 提供 `quota_summary` / `quota_show` 工具，支持 session/day/week/month 维度的用量报告
4. 准备开源发布到 npm

---

## 2. 架构约束

### 2.1 纯插件，不 fork OpenCode

所有功能必须通过 `@opencode-ai/plugin` 和 `@opencode-ai/sdk` 实现。不得修改 OpenCode 源码。

### 2.2 peerDependencies

`@opencode-ai/plugin` 和 `@opencode-ai/sdk` 放在 `peerDependencies`，不打包进 dist。

### 2.3 独立 git 仓库

本插件在 `plugins/opencode-quota-sidebar/` 下有自己的 `.git`，独立于父仓库。

---

## 3. Sidebar 渲染约束（关键）

### 3.1 Title 渲染方式

OpenCode sidebar 渲染 session title 的 JSX：

```tsx
<text fg={theme.text}>
  <b>{session().title}</b>
</text>
```

- 整个 title 字符串都在 `<b>` 标签内，所有行都是粗体 + `theme.text` 颜色
- `\n` 会产生视觉换行，但所有行共享相同样式
- 无法通过字符串注入 `<span>` 或改变颜色/字重 — 渲染器是结构化 JSX（SolidJS + @opentui），不是 HTML 解析

### 3.2 宽度链路

```
Sidebar container: width=42
  paddingLeft=2, paddingRight=2  → 38
  inner paddingRight=1           → 37
  session title box paddingRight=1 → ~36 可用字符
```

`config.sidebar.width` 默认 36，与实际可用宽度匹配。

### 3.3 固定宽度行（防抖动）

每行必须通过 `fitLine()` 截断到不超过 `width` 字符：

- 长行截断，防止溢出
- 不使用 ANSI 样式码，避免 SolidJS terminal renderer 在 resize 时产生字符污染

### 3.4 ANSI 转义码

- Sidebar title 中默认**不使用 ANSI 样式码**。
- 历史问题：`\u001b[22m` 会触发字符损坏；`\u001b[2m` 在 resize 场景也可能引发渲染异常。
- 结论：当前实现使用纯文本，样式分层交由 OpenCode 原生 `<b>` title 行处理。

### 3.5 MCP 两种字体的对应关系

MCP 条目通过 JSX 结构实现两种字体：

1. 服务器名称 — `fg={theme.text}`，正常字重
2. 状态文字 — `fg={theme.textMuted}`，暗色

我们的 sidebar title 对应：

1. 第一行（session title）— 粗体 + 主色（`<b>` 标签自带）
2. 后续详情行 — 纯文本（不注入 ANSI，避免渲染损坏）

---

## 4. Token 显示规则

### 4.1 Sidebar 中的 token 统计

- 使用 `sidebarNumber()`（当前走 `shortNumber(..., 1)`），按数值自动显示 `k/m`
- 示例：`Input 18.9k  Output 53` 或 `Input 1.2m  Output 54.8k`
- toast 和 markdown report 同样使用 `shortNumber()`

### 4.2 Cache 显示

- 始终使用 `Cache Read` / `Cache Write`（不要简写为 `Cache`）
- OpenAI/Gemini 只有 read；Anthropic 有 read + write
- 仅在 > 0 时显示

### 4.3 Reasoning 显示

- 仅在 `reasoning > 0` 时显示（兼容非推理模型）

### 4.4 Cost 计算

- 使用 OpenCode 官方的 `AssistantMessage.cost` 字段，不自行估算
- 已删除 `estimateMessageCost()`、`buildPricingTable()`、`PricingTable`、`ModelPricing` 等所有 pricing 相关代码
- `sidebar.showCost` 仅影响 `quota_summary` markdown report，不影响 sidebar title

---

## 5. Quota 显示规则

### 5.1 Sidebar 中的 quota

- 仅显示当前 session 实际使用过的订阅制 provider
- `quota_summary` 工具则显示所有订阅制 provider

### 5.2 格式

- 单窗口：`OpenAI Remaining 5h 80%`
- 多窗口：`OpenAI 5h 80% - Weekly 70%`
- Copilot：`Copilot Remaining Monthly 70%`
- 使用 "Remaining"（不是 "Remain"）

### 5.3 多窗口 quota

OpenAI wham/usage 响应结构（三个社区插件一致确认）：

- `rate_limit.primary_window` — 短期窗口（如 3h/5h），有 `used_percent`、`limit_window_seconds`、`reset_after_seconds`、`reset_at`
- `rate_limit.secondary_window` — 长期窗口（**单数对象，不是数组**），结构同上
- 窗口标签从 `limit_window_seconds` 推导（10800→3h, 604800→Weekly），不从 `reset_at` 推导

### 5.4 Provider 支持状态

| Provider               | Quota 端点                             | 状态              |
| ---------------------- | -------------------------------------- | ----------------- |
| OpenAI Codex (OAuth)   | `chatgpt.com/backend-api/wham/usage`   | 支持，多窗口      |
| GitHub Copilot (OAuth) | `api.github.com/copilot_internal/user` | 支持，月度        |
| Anthropic              | 无公开端点                             | `unsupported`     |
| API Key providers      | 无 quota 概念                          | 仅显示 token 用量 |

### 5.5 Copilot 请求头

伪装 VS Code Copilot Chat 以稳定访问内部 API：

```
User-Agent: GitHubCopilotChat/0.35.0
Editor-Version: vscode/1.107.0
Editor-Plugin-Version: copilot-chat/0.35.0
Copilot-Integration-Id: vscode-chat
```

---

## 6. 数据架构

### 6.1 增量聚合

- 跟踪每个 session 最后处理的 message ID/timestamp（`IncrementalCursor`）
- 仅处理新消息，不重复扫描
- `message.removed` 事件触发全量重扫

### 6.2 Session 保留策略

- 默认 2 年（730 天）
- 超龄 session 从内存驱逐，chunk 文件保留在磁盘

### 6.3 存储布局（v2）

```
~/.local/share/opencode/
  quota-sidebar.state.json          # 全局状态
  quota-sidebar-sessions/           # 按日期分片
    2026/02/23.json
```

### 6.4 并发控制

- `applyTitle` 有 per-session 锁（`applyTitleLocks`），防止并发写入
- `persistState` 有 dirty key 捕获机制，写入期间新增的 dirty key 不会丢失
- 范围查询（day/week/month）使用 `mapConcurrent` 限制并发为 5

---

## 7. 文件清单

| 文件             | 职责                                                            |
| ---------------- | --------------------------------------------------------------- |
| `src/index.ts`   | 插件入口，事件处理，工具注册，并发锁，增量聚合编排              |
| `src/format.ts`  | Sidebar title 渲染，markdown report，toast 格式化               |
| `src/quota.ts`   | Quota API 连接器（OpenAI/Copilot/Anthropic），OAuth token 刷新  |
| `src/usage.ts`   | Token 聚合，增量 cursor，UsageSummary 类型                      |
| `src/storage.ts` | v2 状态持久化，日期分片，LRU chunk 缓存，原子写入，symlink 防护 |
| `src/types.ts`   | 共享类型定义                                                    |
| `src/helpers.ts` | 工具函数（isRecord, asNumber, debug, swallow, mapConcurrent）   |
| `src/__tests__/` | 单元测试（20 个）                                               |

---

## 8. 开发注意事项

### 8.1 修改闭环

改动任一文件时，检查以下是否需要同步：

- `format.ts` ↔ `types.ts`（QuotaSnapshot/QuotaWindow 字段变化）
- `usage.ts` ↔ `index.ts`（函数签名变化）
- `quota.ts` ↔ `types.ts`（QuotaSnapshot 字段变化）

### 8.2 ANSI 码安全

- Sidebar title 默认禁止 ANSI 样式码
- 若未来确需引入，必须先在 resize/宽度切换场景完成实测并补充回归测试
- SGR 22（normal intensity）明确禁止

### 8.3 宽度安全

- Sidebar 所有行必须通过 `fitLine()` 保证不超过 `config.sidebar.width`（默认 36）
- 不做 `padEnd`，避免 trailing space 标准化导致的回写抖动
- quota 行一律一 provider 一行，避免长行拼接造成 wrap 异常

### 8.4 构建与测试

```bash
npm run build    # tsc 编译
npm test         # node --test，当前 20/20 pass
```

修改后必须 build + test 通过才算完成。

### 8.5 迭代修改流程

内容修改任务采用 modify → review 循环，直到内容完整正确。不要一次性提交未验证的大量改动。

---

## 9. 已知限制与待办

### 9.1 Sidebar 渲染稳定性

resize 场景曾出现字符污染和断裂。当前规避策略：

1. 移除 ANSI 样式码
2. 行文本仅做截断不做填充
3. quota 改为逐行显示

### 9.2 Anthropic quota

Anthropic 没有公开的订阅额度查询端点（已通过 claude-code#13585 确认）。标记为 `unsupported`。

### 9.3 Copilot token exchange

当前直接使用 OpenCode 的 OAuth token 调用 `/copilot_internal/user`。如果 GitHub 收紧权限，可能需要实现 token exchange 流程（`/copilot_internal/v2/token`），参考 `opencode-mystatus` 的三级 auth cascade。

### 9.4 OpenAI wham/usage 稳定性

这是 ChatGPT 内部 API，未公开文档。响应结构可能随时变化。当前解析逻辑对缺失字段做了 graceful fallback。

---

## 10. 参考插件

开发过程中参考了以下社区插件的 quota 查询实现：

1. [vbgate/opencode-mystatus](https://github.com/vbgate/opencode-mystatus) — OpenAI JWT 解析、Copilot 三级 auth cascade、Antigravity 多账户
2. [slkiser/opencode-quota](https://github.com/slkiser/opencode-quota) — SQLite 直读 token 用量、bundled pricing、Copilot PAT + internal API 双策略
3. [PhilippPolterauer/opencode-quotas](https://github.com/PhilippPolterauer/opencode-quotas) — Antigravity endpoint failover、双窗口线性回归预测、pattern-based 聚合
