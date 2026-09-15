# pi-profile-switch

[English](README.md) | [中文](README.zh-CN.md)

[Pi](https://github.com/badlogic/pi-mono) 的命名 profile 扩展。一个 profile 引用一组已存在的 skills、extensions、MCP server 和 tools，并在同一 Pi 进程内切换，无需重启。

代码评审用精简的只读 profile，实现需求用全量 profile，临时提问用最小 profile——全部基于同一套已安装的资源。

## 安装

```bash
npm install -g pi-profile-switch
```

依赖 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)（作为 peer dependency 自动安装）。

## 快速上手

```bash
# 使用内建 default profile 启动（全量资源，等同原生 Pi）
pi-profile

# 使用指定 profile 启动
pi-profile review

# -- 后面的参数原样传给 pi
pi-profile review -- --model openai/gpt-5.4
```

在 `~/.pi-profile-switch/profiles.json`（全局，支持 `PI_PROFILE_SWITCH_DIR` 环境变量自定义，向下兼容 `~/.pi/agent/profiles.json`）或 `<项目>/.pi/profiles.json`（项目级，仅限已信任项目）中定义 profile：

```json
{
  "schemaVersion": 1,
  "profiles": {
    "review": {
      "label": "Code review",
      "skills": ["code-review"],
      "mcp": ["github"],
      "tools": ["read", "grep", "find", "bash"],
      "instructions": "Review only; do not modify files."
    }
  }
}
```

Profile 只**引用**资源，从不复制资源。已安装的包和标准目录下的文件会被自动发现，无需注册。完整示例见 [`examples/profiles.json`](examples/profiles.json)。

安装时，pi-profile-switch 会向 `~/.pi-profile-switch/profiles.json` 写入一个初始 **`ask`** profile——只读的问答与代码走读模式（仅 `read`/`grep`/`find`/`ls`，无 skill、extension 和 MCP）。它不假设你安装过任何插件，可随意修改或删除。

## 命令

在 TUI 中，`/profile` 命令族完成所有会话内操作：

| 命令 | 作用 |
| --- | --- |
| `/profile` | 交互式选择 profile |
| `/profile list` / `/profile status` | 列出 profile / 查看活动 profile 详情 |
| `/profile use <name>` / `/profile reload` | 会话内切换 / 重载（失败自动回滚） |
| `/profile create\|edit\|delete\|duplicate` | 向导式 profile 增删改（仅 TUI） |
| `/profile resource create\|edit\|delete` | 向导式资源覆盖管理 |
| `/profile customize` / `/profile reset` | 仅本次会话收窄活动 profile |
| `/mcp enable\|disable <server>` | 在活动 profile 中开关 MCP server |

非交互模式（`--mode rpc|print|json`）下命令同样生效；CRUD 向导仅 TUI 可用。

## 保证

- **引用而非复制**——profile 指向你自己拥有和维护的资源。
- **Pi 原生**——profile 未显式控制的一切保持原生 Pi 行为。
- **失败安全**——未信任的项目目录从不读取；切换失败回滚到上一份可用配置。

## 文档

- [架构设计](docs/architecture/overview.md) · [ADR](docs/adr/) · [术语表](CONTEXT.md)
- JSON Schema：[`schemas/`](schemas/)

## 许可证

MIT
