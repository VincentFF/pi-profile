# pi-profile-switch

[English](README.md) | [中文](README.zh-CN.md)

[Pi](https://github.com/badlogic/pi-mono) 的命名 profile 扩展。一个 profile 选择模型看到什么、会话使用哪些能力——skills、MCP server、tools、预制模型和附加指令——并在同一 Pi 进程内即时切换。

随包提供一个 `read-only` 预设覆盖「读代码 + 报告」的工作流；其余工作流由你自己定义——profile 可以收窄工具集、隐藏 skill、固定模型或附加指令。

`pi-profile-switch` 是普通 Pi package（ADR-0007）：像其他扩展一样安装，不改动 Pi 的配置目录，session、packages、项目信任和其他扩展全部保持原生。

## 安装

```bash
pi install npm:pi-profile-switch
```

依赖 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（作为 peer dependency 自动安装）。

## 快速上手

```bash
# 使用已保存的 profile（不存在时用内建 default）
pi

# 仅本次启动使用指定 profile（不保存）
pi --profile read-only

# 显式的原生基线
pi --profile default
```

用 `/profile create` 创建 profile，写入 `~/.pi/agent/profiles.json`（全局）或 `<项目>/.pi/profiles.json`（项目级，仅限已信任项目）。向导提供随包的 `read-only` 预设——只用 Pi 内建工具，不假设任何 skill、MCP server 或模型——也可以从空定义开始。

预设只被复制一次：它不被跟踪，包升级不会改动你已经创建的 profile。Profile 只**引用**资源，从不复制资源。[`examples/profiles.example.json`](examples/profiles.example.json) 是覆盖全部字段的完整 catalog，示例中的资源名请替换成你本机已有的名字。

`schemaVersion` 为 1，也是唯一接受的值。Profile 不选择 extension：extensions 在所有 profile 中原生加载，请用 `pi install` 管理。

## Profile 控制的范围

| 字段 | 效果 |
| --- | --- |
| `instructions` | 每个 turn 追加到 system prompt 末尾 |
| `model` | 会话启动的模型预设；显式 `--model`/`--thinking` 或 session 历史中记录的模型优先 |
| `skills` | 模型在 prompt skills 列表中看到的内容；所有已安装 skill 仍保持加载，用户可用 `/skill:name` 手动调用 |
| `mcp` | 发布给 `pi-mcp-adapter` 的运行时 server allowlist；连接参数仍由 adapter 自己管理 |
| `tools` | 活动工具集：声明的名字/glob 成为活动集合；之后才注册的工具（MCP、扩展）在出现时补上 |

未声明的字段保持 Pi 原生行为，`default` 什么都不声明。

## 命令

在 TUI 中，`/profile` 命令族完成所有会话内操作：

| 命令 | 作用 |
| --- | --- |
| `/profile` | 交互式选择 profile |
| `/profile list` / `/profile status` | 列出 profile / 查看活动 profile 详情 |
| `/profile use <name>` | 即时切换——同一 session，无 reload |
| `/profile create\|edit\|delete\|duplicate` | 向导式 profile 增删改（仅 TUI） |
| `/profile customize` / `/profile reset` | 仅本次会话收窄活动 profile |
| `/mcp enable\|disable <server>` | 在活动 profile 中开关 MCP server |

活动 profile 不是 `default` 时，footer 显示 `profile: <name>`；本次会话的 overlay 生效时追加 `*`。`default` 不显示 badge，未使用 profile 的会话保持 Pi 原生 footer。

非交互模式（`--mode rpc|print|json`）下命令同样生效；CRUD 向导仅 TUI 可用。

## 保证

- **引用而非复制**——profile 指向你自己拥有和维护的资源。
- **Pi 原生**——配置目录就是 Pi 自己的目录，session、扩展配置、packages、context 文件和信任行为与原生 Pi 完全一致。
- **失败安全**——未信任的项目目录从不读取；激活失败时不应用任何设置并报出原因。
- **无 reload**——切换在原位重新应用运行时状态；下一个 turn 的 prompt 直接带上新选择。

## 文档

- [架构设计](docs/architecture/overview.md) · [ADR](docs/adr/) · [术语表](CONTEXT.md)

## 许可证

MIT
