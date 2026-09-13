# pi-profile 纯 extension 重构方案

Status: ready-for-agent

## Problem Statement

现架构（ADR-0005：子进程宿主 + 生成式 settings）用 `PI_CODING_AGENT_DIR` 把 Pi 指向 per-launch 生成目录，其中只放固定白名单 symlink。agentDir 是 Pi 核心与所有第三方扩展共享的命名空间，两个已证实的兼容性破坏由此产生：

- **Session 隔离**：`PI_CODING_AGENT_SESSION_DIR=<真实>/sessions` 把 session 目录钉在扁平根目录。Pi 只在未显式指定 session 目录时才按项目派生 `<sessionDir>/--<cwd>--/`，因此 pi-profile 的 session 全部平铺在 `sessions/` 根，与原生 pi 的 per-project 目录互相不可见（`pi -r`、`pi -c`、`/resume` 都受影响）。该环境变量还越过用户的 `sessionDir` 设置。
- **扩展配置读不到**：白名单外的 agentDir 文件在子进程里不存在。`pi-plan-build.json`、`plans/`、`mcp-cache.json`、`web-push.json` 与全局 `AGENTS.md` 都被静默丢弃：第三方扩展回退默认值，Pi 丢失全局 context file。原子写（临时文件 + rename）的扩展还会把 symlink 替换成临时目录里的本地文件，写入在清理时丢失。

把白名单改成全量镜像仍保留宿主进程、保留与 Pi settings schema 耦合的生成式配置，并且缓存不住原子写；而 products 侧真正需要的隔离对象只有 skills、mcp、tools 三类。

## Solution

`pi-profile` 变成普通 Pi package：以 `pi.extensions` 入口安装，没有 launcher、没有环境变量改写、没有生成文件。一个 profile 控制五项：`instructions`、`model`/`thinkingLevel`、`skills`（prompt 可见性）、`mcp`、`tools`。extensions 不再是 profile 资源，全部原生加载。

三个运行时接缝承担全部行为：

| 接缝 | 触发点 | 作用 |
| --- | --- | --- |
| `session_start` | 进程启动、`/new`、`/resume`、`/fork` | 读取 state 与 catalog、激活 profile、应用 model/thinking/tools/mcp |
| `before_agent_start` | 每个 user turn | 重建 skills 段落（可见性过滤）并追加 `instructions` |
| `pi.events` | 激活与切换 | 向 `pi-mcp-adapter` 发布运行时 server allowlist |

产品语义随之变化：plain `pi` 应用已保存的活动 profile；`pi --profile default` 是显式原生基线；`pi --profile <name>` 为本次启动选择 profile 且不写 state。

## 目标架构

### 受控与不受控

| 资源 | 现架构机制 | 新架构机制 |
| --- | --- | --- |
| skills | 生成 settings 的白名单路径 + 排除模式 | prompt 可见性过滤（`formatSkillsForPrompt` + `systemPrompt` 替换） |
| mcp | `pi.events` allowlist（内存） | 不变 |
| tools | 生成 `--tools` flag + reload 后 `setActiveTools` | `session_start` 与切换时 `setActiveTools`，带 pending 重试 |
| model / thinkingLevel | 生成 `--model` flag | `setModel` / `setThinkingLevel`，遵循显式选择优先 |
| instructions | `before_agent_start` 追加 | 与 skills 过滤合并到同一个 `before_agent_start` 返回值 |
| extensions | 生成 settings 白名单 + 依赖闭包 + `alwaysOn` | 不控制，全部原生加载 |
| sessions / AGENTS.md / packages / trust / prompts / themes | 部分被 agentDir 改写破坏 | 全部原生，pi-profile 不触碰 |

### 运行时 API 依据（Pi 0.85.1 验证）

| 能力 | API |
| --- | --- |
| 全量已加载 skills | `ctx.getSystemPromptOptions().skills`，与 Pi 构建 prompt 时传给 `buildSystemPrompt` 的数组同源 |
| skills 段落格式化 | 公开导出 `formatSkillsForPrompt(skills, fileReadTool)`；Pi 在默认与自定义 prompt 两个分支都逐字追加其返回值 |
| prompt 替换 | `before_agent_start` 返回 `{ systemPrompt }`，只作用于当前 turn，多个扩展按加载顺序链式处理 |
| `/skill:` 命令来源 | `resourceLoader.getSkills().skills`，与 prompt 无关；prompt 过滤不影响用户手动调用 |
| skills 段落是否存在的判据 | `["read", "bash"].find(tool => options.selectedTools.includes(tool))`；两者都不在时不产出段落 |
| 工具注册表 | `pi.getAllTools()`（内置 + 扩展 + MCP）与 `pi.setActiveTools(names)` |
| 模型 | `ctx.modelRegistry`、`pi.setModel(model)`（未认证返回 `false`）、`pi.setThinkingLevel(level)` |
| 启动 profile 选择 | `pi.registerFlag("profile", { type: "string" })` + `pi.getFlag("profile")`；Pi 无同名 flag，未知 flag 由 `parseArgs` 收进 `unknownFlags` 再匹配已注册扩展 flag |
| 显式 CLI 声明检测 | 包公开导出 `parseArgs`；扩展对 `process.argv.slice(2)` 重新解析，读取 `model`、`thinking`、`tools`、`excludeTools` |
| MCP 协调 | `pi-profile:mcp-allowlist:v1` 发布通道 + `pi-mcp-adapter:runtime-snapshot:v1` 存在性探测（ADR-0002） |

Pi 的 package `exports` 不暴露 `buildSystemPrompt`，扩展无法自行重建整个 prompt，因此 skills 过滤走"同源格式化 + 段落替换"。

### skills 可见性过滤算法

```
selected   = profile.skills ∪ overlay 的解析结果（skill name 集合）
all        = ctx.getSystemPromptOptions().skills
fileReadTool = ["read","bash"].find(tool => options.selectedTools.includes(tool))
original   = formatSkillsForPrompt(all, fileReadTool)          // 与 Pi 的输出逐字一致
filtered   = formatSkillsForPrompt(all.filter(s => selected.has(s.name)), fileReadTool)

若 fileReadTool 不存在、original 为空、或 systemPrompt 不含 original：
    不替换；一次性 warning
否则：
    systemPrompt = systemPrompt.replace(original, filtered)
systemPrompt = systemPrompt + instructionsBlock
```

性质：

- 过滤后的 prompt 每轮从 Pi 的基础 prompt 重建，不累积历史；profile 切换后下一轮自动生效，无需 reload。
- `default` profile 不做 skills 过滤（`selected` 不存在时直接跳过）。
- 未选中的 skill 仍加载、仍在用户的 `/skill:` 菜单里、仍可被用户手动调用；模型看不到它的 name、description 和 location。
- `disableModelInvocation` 的 skill 由 `formatSkillsForPrompt` 自身过滤，与 Pi 行为一致。
- 段落替换失败时本轮退化为原生 prompt 并报告 warning，不阻塞对话。

### profile 语义

```json
{
  "schemaVersion": 2,
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

| 字段 | 语义 | 解析 |
| --- | --- | --- |
| `instructions` | 追加到 system prompt 末尾的文本 | 每个 turn 追加；未声明时不追加 |
| `model` | 会话启动预设 | `provider`/`id` 对 `ctx.modelRegistry` 解析；`thinkingLevel` 由 `setThinkingLevel` 自动 clamp |
| `skills` | skill name 引用（支持 glob） | 每个 turn 对 `options.skills` 的名称解析 |
| `mcp` | MCP server name 引用（支持 glob） | 激活时对 adapter 探测结果解析 |
| `tools` | 活动工具集（支持 glob） | 对 `pi.getAllTools()` 的名称解析；`read`/`bash` 缺失只影响 skills 段落存在性 |

`RuntimeOverlay` 保留三个字段：`disabledSkills`、`disabledMcp`、`tools`（替换 profile 的 tools）。`disabledExtensions` 随 extensions 一并删除。

`default` profile 不声明任何字段：不过滤 skills、不改 tools、不改 model、不注入 instructions、不发布 MCP allowlist。overlay 仍可作用于 `default`。

### 引用解析规则

| 引用 | 字面量未解析 | glob 零匹配 | 全量候选来源 |
| --- | --- | --- | --- |
| skill name | warning（列出候选与 did-you-mean），不阻塞激活 | `unmatched` 警告 | `options.skills` |
| mcp server name | 激活失败（adapter 缺失或 server 未发现） | `unmatched` 警告 | adapter 探测 |
| tool name | 进入 pending，重试到全部解析或会话结束；status 显示 | `unmatched` 警告 | `pi.getAllTools()` |

skill 字面量未解析不阻塞激活的两个理由：其他扩展经 `resources_discover` 在 `session_start` 之后才贡献 skill，启动时硬失败会产生假阴性；可见性缺失不会破坏 runtime。

### 启动、切换与显式声明

**启动（`session_start`，reason 为 `startup`/`new`/`resume`/`fork`）**

1. 读 runtime state 与 catalogs；项目文件仅当 `ctx.isProjectTrusted()` 时读取。
2. 解析 profile（`--profile` flag 优先于保存的 state，`--profile` 不写 state）。
3. 校验：model 可解析且已认证；声明 `mcp` 时 adapter 存在且 server 已发现。
4. 校验失败：不应用该 profile 的任何设置，保持原生状态，输出可行动错误（候选列表 + did-you-mean）。
5. 校验通过：应用 model/thinking、tools、MCP allowlist；skills 与 instructions 从下一个 turn 起生效。

**`/profile use <name>`**

1. 重新读取 catalog、adapter 状态与 `options.skills`。
2. 校验同上；失败时不改变当前状态。
3. 通过：写 runtime state（按 profile 的 source scope）→ 应用 model/thinking/tools/mcp → skills/instructions 下一轮生效。
4. 不需要 `waitForIdle`、`ctx.reload()`、settings 快照或回滚；session file 与 session id 不变。
5. 不向对话注入变更摘要消息：模型在下一轮 prompt 中直接看到新的 tools 与 skills 段落。

**显式声明优先（model / thinking / tools）**

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | CLI `--model` / `--thinking` / `--tools` / `--exclude-tools` | 用 `parseArgs` 检测 `process.argv`；存在时 profile 对应字段不生效 |
| 2 | session 历史中记录的 model/thinking 变更 | `startup` 时若 session 已有记录（`-c`/`-r` 恢复），保持用户选择 |
| 3 | profile 声明 | 无更高优先级来源时应用 |
| 4 | Pi settings 默认值 | 以上都未定义时的原生行为 |

`/profile use` 是用户对 profile 的显式选择，应用 profile 声明并覆盖 1–2。

**tools 的 pending 机制**

`session_start` 时 MCP 与扩展工具可能尚未注册。未解析的字面量进入 pending 集合，在每次 `before_agent_start` 重试 `setActiveTools`；全部解析后停止重试，用户之后的原生手动切换不再被覆盖。profile 未声明 `tools` 且无 overlay 时不调用 `setActiveTools`。

### MCP 协调

- profile 声明 `mcp` 时发布精确 allowlist；仅 overlay 限制时发布"已发现 server 减去 disabled"；两者都无时不发布，adapter 保持自身状态。
- `/mcp enable|disable` 写当前 profile 所属 catalog 的 `mcp` 数组并重新发布 allowlist，不调用 adapter 的持久化实现，不触碰 `.pi/mcp.json`。
- 声明 `mcp` 但 adapter 缺失：激活失败并提示安装；profile 未声明 `mcp` 时 MCP 完全可选。

### 错误语义

| 情形 | 行为 |
| --- | --- |
| 未知 `--profile` 值 | 列出可用 profile（含项目 catalog）后不应用任何 profile |
| 未注册 `--profile`（未安装本扩展） | Pi 原生 unknown option 错误 |
| model 未知或未认证 | 激活失败，不应用任何 profile 设置 |
| 声明 `mcp` 而 adapter 缺失或 server 未发现 | 激活失败，不应用任何 profile 设置 |
| skill 字面量未解析 | 激活继续，warning 含候选与 did-you-mean，`/profile status` 可见 |
| prompt 段落未找到 | 本轮不过滤，warning，`/profile status` 可见 |
| catalog 文件损坏 | 读取失败以文件路径与解析错误报错，不应用该 catalog |

## 模块处置

| 模块 | 处置 | 说明 |
| --- | --- | --- |
| `bin/pi-profile.ts`、发布用 `.js` 包装 | 删除 | 无 launcher；`package.json` 移除 `bin` 与 `jiti` 依赖 |
| `src/launcher/args.ts`、`spawn.ts`、`runtime-cleanup.ts`、`discovery.ts`、`initial-profile.ts`、`model-check.ts` | 删除 | 宿主进程整体移除；model 校验改由 `ctx.modelRegistry` + `setModel` 返回值承担 |
| `src/settings-generator.ts` | 删除 | 无生成式 settings |
| `src/project-trust.ts` | 删除 | 项目读取改用 `ctx.isProjectTrusted()` |
| `src/extension-discovery.ts`、`src/resource-registry.ts`、`src/resource-registry-store.ts` | 删除 | extensions 不再是 profile 资源（ADR-0006 被取代） |
| `src/skill-registry.ts` | 删除 | 全量 skill 集来自 `ctx.getSystemPromptOptions().skills` |
| `src/profile-resolver.ts` | 重写 | 输出 selection（skills/mcp/tools/model/instructions），无 extension 闭包、无 trust 守门、无 filter 分支 |
| `src/profile-catalog.ts`、`src/profile-catalog-store.ts` | 保留 | schema v2；读取 v1 时忽略 `extensions` 并警告一次 |
| `src/runtime-state-store.ts` | 保留 | 去 `lastVerifiedProfile`；overlay 去 `disabledExtensions` |
| `src/mcp-config.ts`、`src/mcp-coordination.ts` | 保留 | adapter server 名只读发现与事件契约（ADR-0002）不变 |
| `src/json-file.ts` | 保留 | 无改动 |
| `src/switching/apply-plan.ts` | 重写为 `apply-profile.ts` | 运行时应用；删除 `LaunchPlanFile` 与 launch plan 文件读写 |
| `src/switching/switch-profile.ts` | 重写 | 校验 → 持久化 → 应用；无快照、无 reload、无回滚 |
| `src/switching/customize.ts` | 保留 | overlay 去 `disabledExtensions` |
| `src/switching/list-profiles.ts`、`status.ts`、`profile-crud.ts`、`profile-wizard.ts`、`mcp-toggle.ts` | 保留 | status 去 extension/trust/filter 字段，增 unresolved/pending 报告 |
| `src/switching/resource-crud.ts`、`resource-wizard.ts` | 删除 | `/profile resource` 命令族移除 |
| `src/switching/tool-references.ts` | 保留 | 作为 tool 解析核心，增加 pending 语义 |
| `src/tui/profile-selector.ts`、`profile-editor.ts` | 保留 | 字段更新为 skills/mcp/tools/model/instructions |
| `src/tui/resource-editor.ts` | 删除 | 无 resource registry |
| `src/skill-selection.ts` | 新增 | 段落重建与替换、失败守卫、一次性 warning |
| `src/model-selection.ts` | 新增 | 显式选择检测与预设应用 |
| `src/startup-selection.ts` | 新增 | `--profile` flag 注册与读取、`parseArgs` 显式声明检测 |
| `extensions/pi-profile/index.ts` | 重写 | 注册 `/profile` 命令族与 `--profile` flag、`session_start` 应用、`before_agent_start` 过滤与 instructions、MCP 发布 |
| `schemas/profiles.schema.json` | 更新 | v2；`schemas/resources.schema.json` 删除 |
| `examples/profiles.json` | 更新 | 去 `extensions`；`examples/resources.json` 删除 |

## 数据契约

| 文件 | 用途 | 变化 |
| --- | --- | --- |
| `~/.pi/agent/profiles.json` | 全局 catalog | schemaVersion 2；去 `extensions` |
| `.pi/profiles.json` | 项目 catalog（仅信任后读取） | 同上 |
| `~/.pi/agent/pi-profile-state.json` | 全局 runtime state | 去 `lastVerifiedProfile`、`overlay.disabledExtensions` |
| `.pi/pi-profile-state.json` | 项目 runtime state | 同上 |
| `~/.pi/agent/resources.json`、`.pi/resources.json` | —— | 不再读取；存在时启动警告一次 |

`pi-profile-state.json` 的 `activeProfile` 决定 plain `pi` 启动时应用的 profile；`--profile <name>` 只作用于本次启动。

## 通用规则

### 兼容性保证

| 保证 | 验证方式 |
| --- | --- |
| pi-profile 不设置 `PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR` | 集成测试断言扩展运行环境中两者未定义 |
| session 落在 `~/.pi/agent/sessions/--<cwd>--/`，与原生 pi 完全一致 | 集成测试对比原生与带扩展进程的 session 路径 |
| 第三方扩展在 agentDir 的配置文件可读写 | fixture 中放探针配置文件，探针扩展读取并断言 |
| 全局 `<agentDir>/AGENTS.md` 进入 system prompt | 集成测试断言 prompt 含 fixture 内容 |
| 所有已安装 extension 在任意 profile 下加载 | 集成测试断言扩展 count 与原生一致 |
| `default` profile 下 Pi 行为逐字原生 | 集成测试对比 prompt（除扩展自身注册内容外）与原生一致 |
| 无 pi-profile 时的 `pi` 行为不变 | 安装状态无 state 文件时扩展不产生任何应用动作 |

### 接受的退化

- extensions 不再按 profile 隔离：未选中的扩展代码照常运行，profile 不表达扩展层的能力限制。
- skills 隔离是模型可见性，不是访问控制：未选中 skill 仍在进程内、仍在 `/skill:` 菜单、仍可被用户调用；其他扩展经 `getSystemPromptOptions()` 仍能看到全量。
- 项目级 skill 的信任由 Pi 原生承担，pi-profile 不再做 trust 守门。

### 迁移

| 旧用法 | 新用法 |
| --- | --- |
| `pi-profile review` | `pi --profile review` |
| `pi-profile review -- --mode rpc` | `pi --profile review --mode rpc` |
| `/profile reload` | `/profile use <当前 profile>`（skills 内容本就按需读取，无缓存） |
| `/profile resource list/create/edit/delete` | 无对应命令；直接安装 Pi package |
| profile 的 `extensions` 字段 | 忽略并警告一次；扩展用 `pi install` 管理 |
| `~/.pi/agent/pi-profile/runtime/` 残留目录 | 迁移时删除；新版本不再创建 |

## Testing Decisions

好测试的标准：只在模块公开接口的边界上断言外部可观测行为，不断言内部 helper 或解析顺序；文件型模块用磁盘 fixture 驱动；`pi-mcp-adapter` 用 fake event bus 驱动。

| Seam | 类型 | 覆盖 |
| --- | --- | --- |
| ProfileCatalog | unit | v1 → v2 读取兼容、`extensions` 忽略警告、global/project 覆盖与回退、CRUD scope |
| ProfileResolver | unit | skills/mcp/tools glob 展开、overlay 应用、未解析字面量的分级处理 |
| SkillSelection | unit | 段落替换逐字一致、空选择删除段落、`disableModelInvocation` 一致、段落缺失守卫、每轮不累积 |
| ModelSelection | unit | 显式声明优先级、未认证失败、resume 记录优先、`/profile use` 覆盖 |
| ToolSelection | unit | 活动集合应用、pending 重试与停止、literal/glob 报告 |
| RuntimeStateStore | unit | 按 source scope 读写、旧字段容忍 |
| McpCoordination | unit（fake event bus） | allowlist 三态发布、探测、enable 拒绝未知名称 |
| Extension runtime | integration（真实 pi 子进程） | 三个兼容性回归、首轮 skills 可见性、`/skill:` 仍可调用、切换不重建 runtime、显式声明优先、MCP 协调、错误语义 |

集成测试继续使用 fixture HOME/agentDir/cwd 与真实 `pi --mode rpc` 子进程内省；测试可以设置 `PI_CODING_AGENT_DIR` 隔离 fixture，产品代码不得设置。

## 工作分解

| 阶段 | 交付 | 退出条件 |
| --- | --- | --- |
| P0 文档 | 本方案、ADR-0007、既有 ADR 标注 | 文档评审通过 |
| P1 文档重写 | `docs/architecture/overview.md`、`docs/product/prd.md`、`CONTEXT.md`、`docs/acceptance.md` 重写为目标设计 | 目标架构成为仓库唯一描述；Generated settings、Runtime reload、ResourceRegistry、alwaysOn 等术语删除；无文档与新 ADR 冲突 |
| P2 删除宿主 | 删除 launcher、settings-generator、resource registry、extension discovery、project-trust、skill-registry 及对应测试；`package.json` 去 `bin` 与 `jiti` | `npm run check` 与剩余测试通过 |
| P3 数据层 | profiles v2 schema、catalog v1 兼容读、state 精简、`resources.json` 停用警告 | catalog/state 单测通过 |
| P4 运行时应用 | `profile-resolver` 重写、`skill-selection`、`model-selection`、`startup-selection`、`apply-profile`、`switch-profile` 重写、extension 入口重写 | 单测通过；`/profile use` 无 reload 生效 |
| P5 命令与 TUI | 命令族收敛（去 resource 与 reload）、status 报告 unresolved/pending、wizard 字段更新 | TUI 手动验收清单通过 |
| P6 兼容性回归与迁移 | 集成测试（session 布局、扩展配置、AGENTS.md、首轮 skills、切换语义）；README 迁移表；删除旧 runtime 目录说明 | 全部验收标准通过 |

## 验收标准

### Unit

- profiles.json v1 读取时 `extensions` 被忽略并产生一次警告；写回为 v2。
- skills 段落替换与 Pi 输出逐字一致；选择为空时段落被删除；`fileReadTool` 不存在或段落缺失时不替换、发警告。
- 未选中的 skill 不影响选择集；`disableModelInvocation` 的 skill 在选中与未选中两种情况下行为与 Pi 一致。
- model 优先级：CLI > session 记录 > profile；`/profile use` 覆盖前两者；未认证模型使激活失败。
- tool pending 在一次解析成功后停止重试。
- overlay 只包含 `disabledSkills`、`disabledMcp`、`tools`。

### Integration

- 进程环境中不存在 `PI_CODING_AGENT_DIR` 与 `PI_CODING_AGENT_SESSION_DIR`；session 文件路径与原生 pi 在同一 `--<cwd>--` 目录。
- 探针扩展读到 fixture agentDir 中的配置文件；system prompt 含全局 `AGENTS.md` 内容。
- `pi --profile review` 首轮 system prompt 只含选中 skill 的条目；`/skill:<未选中>` 仍可调用并注入内容。
- `/profile use` 后 session id 与 session file 不变，扩展实例不重建，下一轮 skills 生效，model/tools 立即生效。
- `--model`、`--thinking`、`--tools`、`--exclude-tools` 存在时 profile 对应字段不生效；`-r` 恢复的 session 保持记录的 model。
- 声明 `mcp` 的 profile 在 adapter 缺失时激活失败且不应用任何设置；`/mcp disable` 写 catalog、不触碰 `.pi/mcp.json`。
- 未知 `--profile` 值列出候选；未安装本扩展时 `--profile` 由 Pi 报 unknown option。

### TUI 手动验收

1. 无 state 时启动 `pi`：行为与原生一致。
2. `pi --profile review`：skills 段落只含 review 选择；用户执行 `/skill:<未选中>` 仍可用。
3. 修改选中 `SKILL.md` 内容，下一次模型读取或 `/skill:` 调用即得到新内容。
4. `/profile use implement`：无 reload 提示，session 延续，model/tools 立即变化，下一轮 skills 变化。
5. `/profile customize disable skill <name>` 后 `/profile status` 显示 overlay；`/profile reset` 恢复。
6. `/mcp enable|disable` 写 catalog，`pi` 原生启动时 adapter 的 `.pi/mcp.json` 未被改动。

## 文档影响

| 文件 | 变化 |
| --- | --- |
| `docs/adr/0007-pure-extension-runtime.md` | 新增（已完成） |
| `docs/adr/0001`、`0005`、`0006` | 标注被 ADR-0007 取代（已完成） |
| `docs/adr/0002` | 标注 launch-time 预检移除（已完成） |
| `docs/product/prd.md` | 重写定位、使用方式、运行语义、资源引用、命令表、验收标准；删除 launcher、extensions、resource registry、reload 语义 |
| `docs/architecture/overview.md` | 重写为目标架构、模块接口、数据契约、激活与切换流程 |
| `CONTEXT.md` | 删除 Generated settings、Runtime reload、ResourceRegistry、alwaysOn、SkillRegistry 的旧定义；重定义 ActivationPlan；新增 skills 可见性过滤 |
| `docs/acceptance.md` | 按新 TUI 验收清单重写 |
| `docs/specs/discovery-first-extensions/spec.md` | 顶部标注随 ADR-0006 被取代 |
| `README.md`、`README.zh-CN.md` | 安装与用法更新；迁移表 |

## Out of Scope

- extensions 的按 profile 隔离与 `alwaysOn`/`dependsOn` 语义。
- skills 的硬隔离（未选中不加载）：扩展 API 无运行时移除接缝，硬隔离需要进程级 `--no-skills`。
- skills 真正不可达的访问控制；`/skill:` 对未选中 skill 的手动入口保留。
- system prompt 的整段替换：profile 只追加 `instructions`。
- MCP 连接参数、OAuth、凭证管理（归 `pi-mcp-adapter`）。
- profile 继承与多 profile 叠加（ADR-0003）；per-profile 资源副本（ADR-0004）。
- 非 TUI 模式的交互式 CRUD。
- TUI 自动化测试。

## Further Notes

- Pi 版本基线为 0.85.1；上述 API 依据均在该版本验证。
- skills 过滤依赖 Pi 的 prompt 段落格式。Pi 升级改变格式时，过滤退化为不过滤并报告 warning，集成测试同时失败以暴露漂移。
- 本方案使 `pi` 与 `pi-profile` 不再有入口差异：安装一次，所有 Pi 启动都受活动 profile 影响，`pi --profile default` 提供原生基线。
