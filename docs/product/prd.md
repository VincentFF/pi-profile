# pi-profile-switch 产品需求

## 定位

`pi-profile-switch` 是一个 Pi package。它把 profile 作为 Pi 会话的选择机制：一个 profile 选择模型看到什么（prompt 与 skills 可见性）、会话使用哪些 MCP server 和 tools，并可选提供 model 预设与附加指令；这些选择在同一 Pi 进程内即时切换。

profile 不复制资源。一个 `SKILL.md`、MCP server 或 tool 只有一份实现；多个 profile 只引用它。修改实现后，所有引用它的 profile 立即获得新内容。

extensions 不是 profile 资源：所有已安装 extension 在每个 profile 中原生加载（ADR-0007）。

## 设计哲学

Pi 是一个极简 agent；`pi-profile-switch` 只完成会话选择这一必要需求。

- 用户直接拥有并维护自己的 profile。
- profile 中的 `skills`、`mcps` 和 `tools` 默认都可自由调整。
- 不增加白名单、审批层或额外定制开关。
- 配置语义保持直接：临时调整走 runtime overlay；持久调整写当前 profile 所属文件。
- Pi 的配置目录、session 布局、package 管理与信任机制保持原生。

## 产品目标

- 用命名 profile 组织 Pi 的工作方式，例如 `review`、`implement`、`research` 与 `restricted`。
- 让 profile 控制 prompt（instructions）、skills 可见性、`pi-mcp-adapter` 已配置的 MCP server、Pi 全局 tool name，以及可选 model/thinkingLevel。
- 在 session 内即时切换，不重启进程、不 reload、不改写 session。
- 支持全局与可信项目两种 catalog；项目定义可覆盖同名全局定义。
- 提供 TUI 中的 profile CRUD 与 observability。
- 作为普通 Pi package 安装：`pi` 与 profile 化会话是同一个入口，`--profile default` 提供原生基线。

## 使用方式

```bash
# 使用已保存的 profile；不存在时使用内建 default
pi

# 仅本次启动使用指定 profile（不保存）
pi --profile review

# 显式的原生基线
pi --profile default

# 任意原生 Pi 参数照常使用
pi --profile research --model openai/gpt-5.4
pi --profile review --mode rpc
```

`--profile` 由 pi-profile-switch 注册并读取；未安装本扩展时 Pi 按原生 unknown option 报错。`default` 不声明任何字段，行为逐字原生。`--profile` 只在进程启动时生效：同进程内的后续 session start（reload / new / resume / fork）沿用当前选择，MCP overlay 变化触发的 reload 不会复活启动 profile。

## 运行语义

一个 Pi runtime 同时只有：

- 一个命名 profile；
- 一个可选的 runtime overlay。

切换 profile 保留当前 session 与其历史。model/tools/MCP 立即生效；skills 与 instructions 从下一个 agent turn 起生效（system prompt 每轮从 Pi 的基础 prompt 重建，不累积历史）。

overlay 是临时调整：`/profile customize` 收窄当前 profile，`/profile reset` 删除 overlay；两者都不写 catalog。overlay 持久化在 state 文件里，但启动时不应用——它不跨进程存活。切换 profile 会丢弃上一个 profile 的 overlay。

## 核心对象

| 对象 | 含义 | 所有权 |
| --- | --- | --- |
| `Profile` | 命名工作流定义，选择 prompt/skills/mcps/tools 并声明可选 model | 全局或项目 catalog |
| `default` | 内建、不可删除的"什么都不声明"profile；overlay 可临时收窄 | `pi-profile-switch` |
| `Preset` | 随包发布的零假设起点；只在 `/profile create` 时被复制一次，之后即为用户定义，不参与解析 | `pi-profile-switch` |
| `RuntimeOverlay` | 当前 profile 的临时收窄（skills/mcp/tools） | runtime state |
| `Selection` | 解析后的选择：可见 skill、MCP allowlist、活动 tools、instructions、model 预设与 warnings | resolver |
| `pi-mcp-adapter` | MCP server 配置、连接与凭证的所有者；profile 只引用 server 名 | 外部 package |

## 配置范围

| 文件 | 用途 | 覆盖规则 |
| --- | --- | --- |
| `~/.pi/agent/profiles.json` | 全局 profile catalog | 全局基础定义 |
| `.pi/profiles.json` | 项目 profile catalog | 同名完整替换全局 profile；可新增名称 |
| `~/.pi/agent/pi-profile-state.json` | 全局 runtime state | 保存全局来源 profile 的活动选择与 overlay |
| `.pi/pi-profile-state.json` | 项目 runtime state | 保存项目来源 profile 的活动选择与 overlay |

项目目录只在 Pi 报告项目已信任（`ctx.isProjectTrusted()`）后读取和写入。项目 scoped resources（项目 skills、项目 MCP 配置）的信任同样由 Pi 原生承担。

profile 的来源决定 state 写入范围：项目定义写项目 state；全局定义写全局 state；内建 `default` 视为全局定义。若项目 catalog 删除覆盖全局的同名 profile，全局 profile 立即重新出现。

保存的选择只存在于一个 scope。项目 state 的优先级高于全局 state，因此切换到全局或内建 `default` 时必须清掉项目 state 里的旧 `activeProfile`，否则下次启动仍会恢复上一个项目 profile，`default` 看起来"切不回去"。每个 scope 的 `overlay` 不参与这套清理：它属于创建它的那个 profile。

profile 不支持继承。项目同名 profile 是完整替换，不深度合并、不追加数组，也不提供 `extends`。需要变体时用 CRUD 向导复制完整定义后创建新名称。

`model` 与 `instructions` 可选。未声明时不修改 Pi 当前的模型与 system prompt。

`schemaVersion` 只接受 1；catalog 中的未知字段（如 v0.1.0 的 `extensions`）静默忽略、不进入解析结果，写入时被丢弃。MCP server 键为 `mcps`（与 `skills`、`tools` 一致的复数形式）；旧键 `mcp` 仍按别名读取，两个键同时存在时 `mcps` 生效，下一次写盘（CRUD 保存或 `/mcp enable|disable`）改写为 `mcps`。

## 资源选择

skills、MCP server name 和 tool name 都支持 glob，并在每次解析时重新展开。

### Skills

skill 使用 Pi 的 skill name 作为逻辑身份：

```json
{
  "skills": ["git-commit", "code-review", "research-*"]
}
```

`skills` 控制的是**模型可见性**：解析出的 skill 出现在 system prompt 的 `<available_skills>` 段落中，未选中的 skill 不出现在 prompt 里。所有已加载的 skill 仍注册 `/skill:name` 命令，用户可随时手动调用任意 skill；`default` profile 不做过滤。

`skills: []` 表示模型看不到任何 skill（用户仍可手动调用）。未声明的 skill 引用不阻塞激活；字面量未解析时给出候选与 did-you-mean，零匹配 glob 进入 `unmatched` 警告面。

### Model

```json
{
  "model": { "provider": "anthropic", "id": "claude-sonnet-4-5", "thinkingLevel": "high" }
}
```

model 是会话启动预设，不是覆盖：显式 `--model`/`--thinking` 与 session 历史中记录的模型选择优先。`/profile use` 是用户的显式选择，会应用预设。声明的 model 未找到或未认证时，激活失败且不应用任何设置。

### 全新安装的默认 catalog

Pi package 没有安装钩子，默认 catalog 因此在扩展首次加载时写入（任何运行模式都会执行）：`<agentDir>/profiles.json` 不存在时，写入随包的 `read-only` profile；文件已存在时绝不读取、改写或备份。写入失败不阻塞加载，而是在 `session_start` 报告一次。

`read-only` 只用 Pi 内建工具并附加只读行为约定，不声明 `skills`、`mcps`、`model`，因此在没有额外 skill、未装 adapter、未配置凭据的机器上也能激活。默认 catalog 只提供可选起点，不改变启动默认值：没有保存的选择时启动仍停在内建 `default`。

### MCP

MCP 集成锁定为 `pi-mcp-adapter`。它是可选依赖：未安装 adapter 且 profile 未声明 `mcps` 时，其余能力不受影响；未安装 adapter 且 profile 声明了 `mcps` 时，该 profile 激活失败并提示缺失 `pi-mcp-adapter`。

```json
{
  "mcps": ["github-ro", "atlassian"]
}
```

profile 只引用 adapter 已配置的 server 名称；命令、地址、OAuth、token 和 timeout 保留在 adapter 自己的配置里，profile 从不保存它们。adapter 尚未实现 `pi-profile:mcp-allowlist:v1`，因此运行时过滤由**生成式 disable overlay** 完成（ADR-0008）：本包按 profile 的 `mcps` 白名单生成 `<agentDir>/mcp.json`（adapter 的 Pi-global 槽位），未授权 server 标 `disabled`（不连接、不注册工具、网关调用被拒）；用户原本放在该文件的 server 由 sidecar `<agentDir>/mcp.user.json` 承载。`/mcp enable|disable` 修改当前 profile 的 `mcps` 数组并保存到所属 catalog，随后重写 overlay 并（内容变化时）reload。

### Tools

```json
{
  "tools": ["read", "grep", "find", "ls", "search_issues"]
}
```

声明的字面量与 glob 成为活动工具集。MCP 与扩展工具在 session start 之后才注册，未注册的字面量进入 pending 并每轮重试，全部解析后停止重试（用户之后的手动切换不被覆盖）。未声明 `tools` 时 Pi 的活动集合不受影响。

### Instructions

profile 的 `instructions` 追加到 Pi 已构建的 system prompt 末尾。Pi 的默认 prompt、AGENTS.md、项目 context 和其他 extension 指令继续生效。

## 命令与交互

| 命令 | 行为 |
| --- | --- |
| `/profile` | 打开 profile 选择器 |
| `/profile list` | 列出内建、全局和项目 profile，以及最终来源 |
| `/profile use <name>` | 校验、保存选择、即时应用 |
| `/profile status` | 显示 profile、overlay、可见 skills、tools（含 pending）、MCP 三态与未解析引用 |
| `/profile customize` | 编辑当前 profile 的 runtime overlay |
| `/profile reset` | 删除 overlay 并恢复声明内容 |
| `/profile create` | 选择 global 或 project catalog 后创建 profile；可从随包预设 `read-only` 开始，或从空定义开始 |
| `/profile edit <name>` | 编辑 profile；编辑活动 profile 时保存后立即重新应用 |
| `/profile delete <name>` | 删除 profile；删除活动 profile 前必须先选择替代 profile |
| `/profile duplicate` | 复制完整定义到新名称 |
| `/mcp enable\|disable <server>` | 修改当前 profile 所属 catalog 的 `mcps` 数组并重新应用 |

CRUD 只在 TUI mode 提供。RPC、print 和 JSON mode 可以用 `pi --profile <name>` 启动目标 profile，也可以执行 `/profile use|list|status|customize|reset` 与 `/mcp enable|disable`，但不提供交互式向导。

TUI 中 footer 常驻显示 `profile: <name>`；runtime overlay 生效时追加 `*`。`default` 不显示 badge：它什么都不声明，因此也不改变 footer（未使用 profile 的会话与原生 Pi 完全一致）。badge 只反映已成功应用的运行时状态。

`/profile list` 与 `/profile status` 经 `pi.sendMessage` 发出 `customType: "pi-profile-switch"` 的结构化消息，`details` 携带 `{kind, ...}` 载荷供 RPC 消费者使用。

## 通用规则

### 默认行为优先

- `default` profile 不改变任何 Pi 行为。
- profile 未声明 `model` 时，保持当前 Pi model 与 thinking level。
- profile 未声明 `instructions` 时，不追加 profile 指令。
- profile 未声明 `tools` 时，不调用 `setActiveTools`。
- 所有未被 profile 选择逻辑覆盖的 Pi 设置、资源与信任行为继续按 Pi 默认规则工作。

### 维护

- skills 是共享实现，不复制到 profile 目录。
- profile 使用 skill name、MCP server name、tool name 和路径引用能力，不引用实现副本。
- profile 不保存 MCP server 地址、启动命令、OAuth 配置或凭证。
- glob 是动态引用；每次解析都可能扩展或缩小实际能力集。
- profile 不支持多 profile 叠加；临时差异使用 runtime overlay。

### 运行模式

| 模式 | 初始 profile | CRUD | 状态详情 |
| --- | --- | --- | --- |
| `pi`（TUI） | `--profile` 或保存的选择，否则 `default` | 完整 TUI CRUD | `/profile status` 全量 |
| `pi --mode rpc` | 同上 | 不提供 | 结构化非交互状态 |
| `pi --mode print/json` | 同上 | 不提供 | 普通 Pi 输出与诊断 |

## 验收标准

### Unit tests

- v1 catalog 读取时 `extensions` 被忽略并警告一次；写入升级为 v2。
- skills 段落替换与 Pi 输出逐字一致；空选择删除段落；缺 read/bash 或段落缺失时不替换、发警告。
- skills 引用的字面量/glob 展开、未解析字面量的候选提示、`disabledSkills` overlay、`refs: "all"` 与 `refs: []` 的区别。
- model 优先级：CLI > session 记录 > profile；`/profile use` 覆盖前两者；未认证模型激活失败且不写 state。
- tools pending：未注册字面量重试，全部解析后停止。
- overlay 字段为 `disabledSkills`、`disabledMcp`、`tools`；`/profile reset` 删除 overlay。
- 项目 scope 读写仅在 `projectTrusted` 时发生。

### Integration tests

- 子进程环境中没有 `PI_CODING_AGENT_DIR`/`PI_CODING_AGENT_SESSION_DIR` 改写；session 文件落在 `<agentDir>/sessions/--<cwd>--/`。
- 第三方扩展在 agentDir 的配置文件可读；全局 `AGENTS.md` 进入 system prompt。
- `pi --profile review`：模型侧 prompt 只含选中 skill；`/skill:<未选中>` 仍可调用。
- `/profile use`：session id 与 session file 不变，扩展模块不重新加载，下一轮 skills 生效。
- `/profile status` 不触发模型调用即可报告选择。
- 声明 `mcps` 的 profile 在 adapter 缺失或 server 未发现时激活失败，且不应用任何设置。
- 未知 `--profile` 值列出候选。
