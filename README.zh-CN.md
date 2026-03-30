# opencode-quota-sidebar

[English](./README.md)

OpenCode 插件：在 TUI sidebar 中显示 token 用量和 provider quota，同时让共享的 session title 保持紧凑。

## 功能

- TUI sidebar 渲染 `TITLE`、`USAGE`、`QUOTA` 三个区块
- Desktop、Web、TUI 共用紧凑单行 title
- 通过 `quota_summary` 查看 session/day/week/month 报告
- 通过 `quota_show` 开关 title 装饰
- session 级统计可选聚合 descendant subagent sessions
- 内置支持 OpenAI、Copilot、Anthropic、Kimi、Zhipu、MiniMax、RightCode、Buzz、XYAI

## 安装

OpenCode 会分别从 `opencode.json` 和 `tui.json` 加载 server / TUI 插件。

`opencode.json`

```json
{
  "plugin": ["@leo000001/opencode-quota-sidebar@3.0.1"]
}
```

`tui.json`

```json
{
  "plugin": ["@leo000001/opencode-quota-sidebar@3.0.1"]
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

完整示例见 [`quota-sidebar.config.example.json`](./quota-sidebar.config.example.json)。

## 工具

- `quota_summary`：查看 `session`、`day`、`week`、`month` 的用量和 quota
- `quota_show`：切换 title 装饰开关

## 开发

```bash
npm install
npm run build
npm test
```

本地调试时：

- 在 `opencode.json` 里加载 `file:///ABSOLUTE/PATH/opencode-quota-sidebar/dist/index.js`
- 在 `tui.json` 里加载 `file:///ABSOLUTE/PATH/opencode-quota-sidebar/dist/tui.tsx`

Windows 下请使用正斜杠形式的 `file:///` 路径。

## 贡献

- 适配器与架构说明：[`CONTRIBUTING.md`](./CONTRIBUTING.md)
- 安全策略：[`SECURITY.md`](./SECURITY.md)
