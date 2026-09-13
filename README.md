# pi-profile

Pi 的命名 profile 扩展。一个 profile 引用一组已存在的 skills、extensions、MCP server 和 tools，并在同一 Pi 进程内切换这些引用，无需重启。

- 用户直接拥有并维护自己的 profile；profile 引用资源，从不复制资源。
- 不增加白名单、审批层或额外定制开关；只有影响 Pi 正常运行或安全边界的行为才受限制。
- 本仓库同时维护作者的 pi skills 集合（`.agents/skills/`，由 `skills-lock.json` 锁定来源）。

## 使用

```bash
# 原生 Pi：总是使用内建 default profile（全量资源）
pi

# pi-profile host：使用上次保存的 profile；不存在时使用 default
pi-profile

# 本次启动使用指定 profile；之后可用 /profile use 保存选择
pi-profile review

# 第一个 -- 后面的参数原样传给 pi
pi-profile review -- --model openai/gpt-5.4
```

## `/profile` 命令族（TUI）

- `/profile` — 交互选择器；`/profile list` — 内建 default / global / project 及同名胜出方。
- `/profile status` — 活动 profile、overlay、解析后的绝对资源路径、glob 差异、MCP 三态与同名冲突（冲突不阻塞激活，status 展示实际加载序与胜出者）。
- `/profile use <name>` / `/profile reload` — 会话内切换 / 重载（重写生成 settings + reload；失败回滚上一份已验证配置）。
- `/profile customize ...` / `/profile reset` — runtime overlay（仅收窄；不写入 catalog，不跨越 runtime 存活）。
- `/profile create|edit|delete|duplicate`、`/profile resource create|edit|delete` — 仅 TUI 的向导式 CRUD；编辑活动 profile 立即 reload；删除活动 profile 需先选替代。
- `/mcp enable|disable <server>` — 持久化到当前 profile 所属 catalog 的 `mcp` 数组并 reload；不修改 adapter 的连接配置（`.pi/mcp.json` 等）。

非交互模式（`-- --mode rpc|print|json`）完整生效；CRUD 向导仅 TUI 可用，其余命令在 RPC 下以结构化自定义消息（`customType: "pi-profile"`，`details` 携带对象）输出。

## 不变量

- **引用而非复制**：profile 只引用已存在的 skills/extensions/MCP servers/tools；pi-profile 从不复制资源内容。
- **发现优先于注册**：已安装包（`package.json#pi.extensions`）与标准目录散装文件直接可在 profile 中引用；`resources.json` 仅用于覆盖（`alwaysOn`/`dependsOn`）与标准位置外的 extension（ADR-0006）。
- **无继承**：profile 定义自包含，没有 `extends`/merge/数组追加；变体只能通过完整复制定义（`/profile duplicate`）产生。
- **信任守门**：未信任项目的 `.pi` 目录从不被读取或写入。
- **冲突不阻塞**：同名 tool/command 冲突按 Pi 加载序先到先得，结果在 `/profile status` 可见。

## Schemas 与示例

- `schemas/profiles.schema.json`、`schemas/resources.schema.json`（JSON Schema 2020-12）随包发布。
- `examples/` 含可通过 schema 校验的完整示例（测试保证）。

## 手动验收

PRD 的 8 步 TUI 验收流程见 [docs/acceptance.md](docs/acceptance.md)。

## 文档

- 产品需求：[docs/product/prd.md](docs/product/prd.md)
- 架构设计：[docs/architecture/overview.md](docs/architecture/overview.md)
- 术语表（英文，agent 用）：[CONTEXT.md](CONTEXT.md)
- 架构决策记录：[docs/adr/](docs/adr/)

## 状态

宿主架构已经 spike 验证并定为子进程 + 生成式 settings（`docs/adr/0005-subprocess-host-with-generated-settings.md`）；实现进行中（ticket 01，见 `docs/specs/initial-implementation/issues/`）。
