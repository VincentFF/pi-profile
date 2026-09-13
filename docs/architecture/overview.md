# pi-profile-switch 架构设计

## 范围

本文定义 `pi-profile-switch` 的内部设计：总体结构、模块接口、数据契约、激活与切换流程、包结构。产品目标与用户可见语义见 `docs/product/prd.md`；关键决策的动机见 `docs/adr/`。

宿主架构：纯 Pi extension（ADR-0007，取代 ADR-0001/ADR-0005 的 launcher + 生成式 settings）。

## 总体架构

```text
┌────────────────────────────────────────────────────────────────────┐
│                          普通 pi 进程                               │
│                                                                    │
│  已安装的 extensions（全部原生加载，不做隔离）                        │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  pi-profile-switch extension                                        │  │
│  │  session_start   → 解析 profile，应用 model/tools/MCP          │  │
│  │  before_agent_start → 重建 skills 段落 + 追加 instructions     │  │
│  │  /profile 命令族、/mcp enable|disable                         │  │
│  │  pi.events ↔ pi-mcp-adapter（内存 allowlist）                 │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  Pi 原生：agentDir、sessions、packages、trust、context files        │
└────────────────────────────────────────────────────────────────────┘
```

`pi-profile-switch` 的外部 interface 是 `/profile` 命令族、`--profile` CLI flag、catalog schema 与 state 文件。解析、glob 展开、引用校验、可见性过滤、MCP 协调与状态持久化都在内部完成。`PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`、生成文件与 symlink 全部不再使用。

## 受控与不受控

| 资源 | 机制 |
| --- | --- |
| skills | prompt 可见性过滤：`before_agent_start` 用 Pi 导出的 `formatSkillsForPrompt` 重建段落并替换 |
| mcp | `pi.events` 向 `pi-mcp-adapter` 发布运行时 allowlist（内存，不写配置文件） |
| tools | `pi.setActiveTools` 对 live registry 展开后的活动集合；未注册字面量 pending 重试 |
| model / thinkingLevel | `pi.setModel` / `pi.setThinkingLevel`，遵循显式选择优先 |
| instructions | 与 skills 过滤合并到同一个 `before_agent_start` 返回值 |
| extensions | 不控制：所有已安装 extension 在每个 profile 中原生加载 |
| sessions / agentDir 文件 / packages / trust / prompts / themes | 原生行为，pi-profile-switch 不触碰 |

## 运行时接缝（Pi 0.85.1 验证）

| 能力 | API |
| --- | --- |
| 全量已加载 skills | 命令上下文：`ctx.getSystemPromptOptions().skills`；每轮：`before_agent_start` 事件的 `systemPromptOptions.skills`（与 Pi 传给 `buildSystemPrompt` 的数组同源）。**事件上下文（`session_start`）没有这个访问器** |
| skills 段落格式化 | 公开导出 `formatSkillsForPrompt(skills, fileReadTool)`；Pi 在默认与自定义 prompt 两个分支都逐字追加其返回值 |
| prompt 替换 | `before_agent_start` 返回 `{ systemPrompt }`，只作用于当前 turn，多个扩展按加载顺序链式处理 |
| `/skill:` 命令来源 | `resourceLoader.getSkills().skills`，与 prompt 无关；可见性过滤不影响用户手动调用 |
| 段落存在判据 | `["read","bash"].find(tool => options.selectedTools.includes(tool))`；两者都不在时 Pi 不产出段落 |
| 工具注册表 | `pi.getAllTools()`（内置 + 扩展 + MCP）与 `pi.setActiveTools(names)` |
| 模型 | `ctx.modelRegistry.find()` / `hasConfiguredAuth()` / `pi.setModel()` / `pi.setThinkingLevel()` |
| 启动 profile 选择 | `pi.registerFlag("profile", { type: "string" })` + `pi.getFlag`；Pi 无同名 flag，未知 flag 由 `parseArgs` 收进 `unknownFlags` 再匹配已注册扩展 flag |
| 显式 CLI 声明检测 | 包公开导出 `parseArgs`；扩展对 `process.argv.slice(2)` 重新解析 |
| 项目信任 | `ctx.isProjectTrusted()` |
| MCP 协调 | `pi-profile:mcp-allowlist:v1` 发布通道 + `pi-mcp-adapter:runtime-snapshot:v1` 存在性探测（ADR-0002） |

Pi 的 package `exports` 不暴露 `buildSystemPrompt`，扩展无法自行重建整个 prompt，因此 skills 过滤走"同源格式化 + 段落替换"。

## skills 可见性过滤

```
selected   = 解析 profile.skills 与 overlay.disabledSkills 得到的可见集合
all        = event.systemPromptOptions.skills   // 随 before_agent_start 提供；session_start 读不到
fileReadTool = ["read","bash"].find(tool => options.selectedTools.includes(tool))
original   = formatSkillsForPrompt(all, fileReadTool)          // 与 Pi 的输出逐字一致
filtered   = formatSkillsForPrompt(visibleSkills(all, filter), fileReadTool)

若 fileReadTool 不存在、original 为空、或 systemPrompt 不含 original：
    不替换；一次性 warning
否则：
    systemPrompt = systemPrompt.replace(original, filtered)
```

性质：

- prompt 每轮从 Pi 的基础 prompt 重建，不累积历史；profile 切换后下一轮自动生效。
- `default` profile 不做过滤；overlay 仍可收窄。
- `SkillsFilter.refs` 为 `"all"` 表示"声明为空、仅 overlay 收窄"；`[]` 表示"什么都不显示"。
- 未选中的 skill 仍加载、仍在 `/skill:` 菜单、仍可被用户调用；模型看不到它的 name、description、location。
- `disableModelInvocation` 的 skill 由 `formatSkillsForPrompt` 自身过滤，与 Pi 行为一致。
- 段落替换失败时本轮退化为原生 prompt 并报告 warning，不阻塞对话。
- 启动（`session_start`）读不到 skill 列表，因此 profile 的 skill 引用在启动时**不做存在性判断**（否则每个引用都会被误报为"未加载"）；第一轮 `before_agent_start` 用真实列表检查一次，只警告一次，并写回 selection 供 `/profile status` 读取。

## profile 语义

```json
{
  "schemaVersion": 1,
  "profiles": {
    "review": {
      "label": "Code review",
      "description": "Read-only review workflow",
      "instructions": "Review only; never edit tracked files.",
      "model": { "provider": "anthropic", "id": "claude-sonnet-4-5", "thinkingLevel": "high" },
      "skills": ["git-commit", "matt/*"],
      "mcp": ["github-ro"],
      "tools": ["read", "grep", "find", "ls"]
    }
  }
}
```

| 字段 | 解析方式 |
| --- | --- |
| `instructions` | 每个 turn 追加；未声明时不追加 |
| `model` | 对 `ctx.modelRegistry` 解析；`thinkingLevel` 由 `setThinkingLevel` 自动 clamp |
| `skills` | 每个 turn 对 live skill 名称解析（支持 glob） |
| `mcp` | 激活时对 adapter 探测结果解析 |
| `tools` | 对 `pi.getAllTools()` 名称解析；未注册字面量 pending |

`RuntimeOverlay` 字段：`disabledSkills`、`disabledMcp`、`tools`（替换 profile 的 tools）。

`default` profile 不声明任何字段：不过滤、不改 tools、不改 model、不注入 instructions、不发布 MCP allowlist。

### 引用解析规则

| 引用 | 字面量未解析 | glob 零匹配 | 候选来源 |
| --- | --- | --- | --- |
| skill name | warning（候选 + did-you-mean），不阻塞激活 | `unmatched` 警告 | live skills |
| mcp server name | 激活失败（adapter 缺失或 server 未发现） | `unmatched` 警告 | adapter 探测 |
| tool name | 进入 pending，重试到全部解析或会话结束 | `unmatched` 警告 | `pi.getAllTools()` |

skill 字面量未解析不阻塞激活的两个理由：其他扩展经 `resources_discover` 在 `session_start` 之后才贡献 skill，启动时硬失败会产生假阴性；可见性缺失不会破坏 runtime。

### 显式声明优先（model / thinking / tools）

| 优先级 | 来源 |
| --- | --- |
| 1 | CLI `--model` / `--thinking` / `--tools` / `--exclude-tools`（`parseArgs` 检测 `process.argv`） |
| 2 | session 历史中记录的 model/thinking 变更 |
| 3 | profile 声明 |
| 4 | Pi settings 默认值 |

`/profile use` 是用户对 profile 的显式选择，应用 profile 声明并覆盖 1–2。

## 模块与接口

### `extensions/pi-profile-switch/index.ts`

**Interface**：注册 `--profile` flag、`/profile` 命令族、`/mcp enable|disable`、`session_start` 与 `before_agent_start` handler。

**Rules**：

- `session_start`：解析启动 profile（flag → 项目 state（已信任）→ 全局 state → `default`）→ 构建 live view → 解析 + 校验 + 应用；失败时不应用任何设置并报出可行动错误。
- `before_agent_start`：重试 pending tools；重建 skills 段落；追加 instructions；每轮刷新 footer badge（主题变更无事件，只能靠这一轮刷新自愈）；无可变更时返回 undefined。
- footer badge（`src/profile-badge.ts`）：`profile: <name>`，overlay 生效时追加 `*`；`default` 与未应用的 profile 不写 badge。`setCurrent` 是 profile 身份（`selection.name` 与 `overlay`）与 badge 的唯一写入点，只反映已成功应用的激活；`pendingTools`/`skillsOutcome` 的原地更新不改身份，也不触碰 badge。
- 启动选择（`--profile`）不写 state；stored overlay 不在启动时应用。
- CRUD 向导仅 TUI（`ctx.mode === "tui"`）；list/status 经 `pi.sendMessage` 发送 `customType: "pi-profile-switch"` 的结构化 `details`。

### `ProfileCatalog` / `ProfileCatalogStore`

**Interface**：只读列出/解析 winning 定义；写入侧提供 create/edit/delete/duplicate。

**Rules**：`default` 不存在于文件中且不可删除；项目同名完整替换全局；`schemaVersion` 1 为当前值、2 作兼容读，保存一律写 1；`extensions` 与未知字段静默忽略、不进入解析结果（无继承）。

### `ProfilePresets`

**Interface**：`PROFILE_PRESETS`——随包发布的起点数组 `{ name, definition }`；create 向导以 `start from which preset?` 呈现，`blank` 为第一项，预设按选项下标识别（不解析名字，避免命名冲突）。

**Rules**：预设是数据，不是 profile——不进入 `/profile list`，只有被 `/profile create` 复制进用户 catalog 后才存在，`default` 仍是唯一内建 profile，复制后预设不被跟踪（包升级不会改动用户已创建的 profile）。每个预设必须零资源假设：不得声明 `mcp`（adapter 缺失即激活失败）、`model`（未认证即激活失败）、`skills`（字面量缺失告警、`[]` 屏蔽全部、省略即不过滤）；`tools` 只列 Pi 内建工具且必含 `read`（否则 Pi 不产出 skills 段落）；`instructions` 只描述行为、不引用具体 skill 或 MCP server 名，并有行数上限（每轮追加，长度直接摊销成本）。`test/profile-presets.test.ts` 强制以上规则，并断言 `examples/profiles.json` 与该 catalog 完全一致。

### `ProfileResolver`

**Interface**：纯函数——输入 profile、可选 overlay、`LiveResources`，输出 `ResolvedSelection`；声明 MCP 无法满足时抛 `ActivationError`。

**Rules**：`LiveResources.skills` 可为 `undefined`（调用方此刻读不到 skill 列表）——此时照常产出过滤条件，但不产出存在性警告；`skillWarnings(refs, live)` 与 `formatSkillWarnings` 供首轮重查复用。

### `SkillSelection`

**Interface**：`visibleSkills` / `visibleSkillNames` / `applySkillsFilter` / `formatInstructionsBlock`。

### `ModelSelection`

**Interface**：`readSessionChoices` / `decidePreset`。

### `StartupSelection`

**Interface**：`registerProfileFlag` / `readProfileFlag` / `detectExplicitDeclarations` / `resolveStartupProfile`。

### `switching/apply-profile.ts`

**Interface**：`validateSelection` / `applySelection` / `retryPendingTools`，依赖注入到窄 interface `ApplySurface`。

### `ProfileBadge`

**Interface**：`buildProfileBadge`（`default` 返回 undefined）、`renderProfileBadge`、`PROFILE_STATUS_KEY`、`truncateToColumns` / `displayWidth`。

**Rules**：纯展示，无状态无 I/O；名字截到 16 列（按显示宽度，CJK 记 2 列）；颜色在渲染时向 theme 索取。

### `switching/activate-profile.ts` / `customize.ts`

**Interface**：`activateProfile`（解析 → 校验 → 可选持久化 → 应用，返回 `{ selection, overlay? }`）；`customizeOverlay` / `resetOverlay`。

### `RuntimeStateStore` / `mcps`

**Interface**：按 scope 读写 `pi-profile-state.json`（`overlayNarrows` 判定 overlay 是否真有差异）；adapter 配置只读发现（`mcp-config.ts`）与事件契约（`mcp-coordination.ts`，ADR-0002 不变）。

## 数据契约

| 文件 | 用途 | 备注 |
| --- | --- | --- |
| `~/.pi/agent/profiles.json` | 全局 catalog | schemaVersion 1（v2 兼容读） |
| `.pi/profiles.json` | 项目 catalog | 仅 Pi 报告项目已信任时读取 |
| `~/.pi/agent/pi-profile-state.json` | 全局 runtime state | `activeProfile` + `overlay` |
| `.pi/pi-profile-state.json` | 项目 runtime state | 同上 |
| `~/.pi/agent/resources.json`、`.pi/resources.json` | —— | 不再读取（ADR-0006 被取代） |

## 激活流程

### 启动（`session_start`）

```text
pi [--profile review]
  │
  ├─ 解析启动 profile（flag → 项目 state → 全局 state → default）
  ├─ 构建 live view：pi.getAllTools() + adapter 探测（skills 此时不可读，首轮再检查）
  ├─ resolve（glob 展开、overlay、warnings）
  ├─ validate（model 存在且已认证；MCP intent 可满足）
  ├─ apply（setModel/setThinkingLevel → setActiveTools → 发布 MCP allowlist）
  └─ 失败：不应用任何设置，notify 可行动错误
```

### 会话内切换（`/profile use`）

```text
/profile use implement
  │
  ├─ 重新读取 catalog/adapter/live view
  ├─ resolve + validate（失败时不改变任何状态）
  ├─ 持久化选择到目标 profile 的 source scope（清除 overlay）
  ├─ apply（model/tools/MCP 立即生效）
  └─ skills/instructions：下一个 turn 的 prompt 直接带上
```

不等待 idle、不 reload、不重启进程、不写任何生成文件；session file 与 session id 不变。

## Package 结构

```text
pi-profile-switch/
├── package.json                 # pi.extensions 入口；无 bin
├── extensions/
│   └── pi-profile-switch/index.ts      # 命令、flag、session_start、before_agent_start、MCP 协调
├── src/
│   ├── profile-catalog.ts       # v2 读取 + v1 兼容
│   ├── profile-catalog-store.ts # 写入侧
│   ├── profile-presets.ts       # 随包预设（create 起点，零资源假设）
│   ├── runtime-state-store.ts
│   ├── profile-resolver.ts      # 纯函数选择解析
│   ├── profile-badge.ts         # footer badge 构造与列宽截断
│   ├── name-matching.ts         # 名字/glob 匹配与 did-you-mean
│   ├── skill-selection.ts       # 可见性过滤与 instructions 块
│   ├── model-selection.ts       # 预设优先级
│   ├── startup-selection.ts     # --profile flag 与启动选择
│   ├── mcp-config.ts            # adapter server 名只读发现
│   ├── mcp-coordination.ts      # pi.events 契约
│   ├── json-file.ts
│   └── switching/
│       ├── apply-profile.ts     # 窄 surface 上的运行时应用
│       ├── activate-profile.ts  # 激活编排
│       ├── customize.ts         # overlay
│       ├── profile-crud.ts      # catalog CRUD
│       ├── profile-wizard.ts    # TUI 向导
│       ├── list-profiles.ts
│       ├── status.ts
│       └── mcp-toggle.ts
├── schemas/profiles.schema.json
├── examples/profiles.json
└── test/                        # 单测 + 真实 pi 子进程集成测试
```

## 兼容性保证

| 保证 | 验证方式 |
| --- | --- |
| 不设置 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` | 集成测试断言子进程环境中无 override |
| session 落在 `<agentDir>/sessions/--<cwd>--/` | 集成测试对比 `get_state` 的 sessionFile |
| 第三方扩展的 agentDir 配置可读 | probe 扩展读取 fixture 配置文件并断言内容 |
| 全局 `<agentDir>/AGENTS.md` 进入 system prompt | probe 扩展断言 prompt 含 fixture 内容 |
| 所有已安装 extension 在任意 profile 下加载 | 扩展不控制 extension 集合 |
| `default` profile 逐字原生 | 不过滤、不 setActiveTools、不发布 allowlist |
