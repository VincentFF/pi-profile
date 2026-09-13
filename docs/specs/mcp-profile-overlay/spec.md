# MCP profile 过滤（生成式 overlay） spec

Status: done

## Problem Statement

profile 的 `mcp` 白名单目前不产生任何运行时效果：

- `pi-mcp-adapter`（本机与 npm 最新均为 2.33.0）**不订阅** `pi-profile:mcp-allowlist:v1`。它只订阅 `pi-mcp-adapter:runtime-register:v1` 与 `pi-mcp-adapter:runtime-snapshot:v1`；ADR-0002 的修订里已经记录了这一点（"no allowlist, no profile-state API, no enable/disable/reload event"）。仓库当前只做到：激活时校验 server 名、`/profile status` 展示、发布一个无人监听的事件。
- 后果对用户可见：切到 `mcp: ["github"]` 的 profile 后，前一个 profile / 其他 server 的 MCP 工具**依旧可以被模型调用**；`mcp: []` 同理无效。
- 今天唯一能真正控制「模型能调用哪些 MCP 工具」的字段是 `tools`（活动工具集，支持 glob）。但 MCP 工具数量大、名字长（`<server前缀>_<工具名>`），让用户手工枚举/排除不可接受；用户期望用 `mcp` 这一层按 **server** 粒度过滤。
- reload 不能解决：adapter 重新读的是它自己的配置文件，与 `mcp` 白名单无关。

## Solution

每次**启动**与**切换**时，pi-profile-switch 依据当前 profile 的 `mcp` 白名单生成一份 **disable overlay** 配置，写入固定路径，并让 adapter 读取该文件：

```json
{ "mcpServers": { "atlassian": { "disabled": true }, "context-mode": { "disabled": true } } }
```

- overlay 只包含 `{ "<server>": { "disabled": true } }` 这样的禁用条目，**不复制连接参数、不复制凭据**——这正是 adapter 自己 `/mcp disable` 的惯用法（其源码注释：*"Persist only the disabled field… this writer never copies a server definition or its credentials into the file."*）。
- 被禁 server 由 adapter 彻底禁用：不连接、不注册直连/namespace 工具，且网关工具（`mcp`/`mcpScript`）调用该 server 会被拒绝（`MCP server "X" is disabled`）。
- 生成文件就是 adapter 默认读取的 Pi-global 槽位 `<agentDir>/mcp.json`（不需要任何启动参数）；用户自己的 Pi-global server 由 sidecar `<agentDir>/mcp.user.json` 承载，首次运行时从手写槽位采用。用户显式传 `--mcp-config <自己的文件>` 时以用户为准，本包不写任何文件并提示。
- 未安装 `pi-mcp-adapter` 时整段逻辑不执行：不注册 flag、不写文件、不报错、不阻塞启动。

语义（三种声明形态）：

| profile 的 `mcp` | 生成的 overlay | 模型可见的 MCP |
| --- | --- | --- |
| 未声明 | 透传（不禁任何 server；等价于覆盖层为空） | 与原生一致（全部） |
| `[]` | 禁用所有已发现的 server | 无 |
| `["github"]` / glob | 除解析结果外全部禁用 | 仅允许的 server |

切换路径：重写 overlay（仅在内容变化时）→ `ctx.waitForIdle()` → `ctx.reload()`，使 adapter 重新初始化并读到新配置。session id / session file 不变，无需新进程、无需用户手动操作。

## User Stories

1. 作为 Pi 用户，我切换到一个声明 `mcp: ["github"]` 的 profile 后，只有 github 的工具对模型可见，这样我不用再手工枚举 MCP 工具。
2. 作为 Pi 用户，我切换到一个声明 `mcp: []` 的 profile 后，任何 MCP 工具都不可见也不可调用，这样我可以确认「没有外部系统被触达」。
3. 作为 Pi 用户，我切换到一个**未声明** `mcp` 的 profile 后，MCP 行为与原生 Pi 完全一致，这样我不会因为装了本包而失去既有 server。
4. 作为 Pi 用户，我不需要修改 profile 的 `tools` 字段就能按 server 过滤 MCP，这样我不用维护一长串工具名。
5. 作为 Pi 用户，我不需要为这个功能添加任何启动参数或配置文件，这样交互成本为零。
6. 作为 Pi 用户，如果我出于调试显式传了 `--mcp-config <自己的文件>`，它仍然生效并覆盖默认行为，这样我不会被扩展"劫持"。
7. 作为未安装 `pi-mcp-adapter` 的 Pi 用户，本包不产生任何副作用（不写额外文件、不注册多余 flag、启动不报错），这样我可以只把它当作 skills/tools/model 的 profile 工具。
8. 作为 Pi 用户，我在 `pi --profile review` 启动时功能立即生效，不需要先手动 `/reload`。
9. 作为 Pi 用户，我在会话内执行 `/profile use xxx` 后，MCP 工具面在切换完成后立即变化，且 session 延续（同一 session id / 文件）。
10. 作为 Pi 用户，我用 `/mcp enable|disable <server>` 后，运行时状态与 catalog 中的 `mcp` 数组保持一致，且新状态即时生效。
11. 作为 Pi 用户，我使用 bare `/profile` picker 选择 profile 时，行为与 `/profile use` 一致（含 MCP 过滤与 reload）。
12. 作为 Pi 用户，我用 `/profile edit` / `/profile delete` 修改或删除当前生效的 profile 后，运行时 MCP 状态与新的定义一致。
13. 作为项目级 profile 的用户，我在**已信任**的项目里使用项目 profile 时，`mcp` 过滤同样生效，并且项目 `.pi/mcp.json` / `.mcp.json` 中的 server 也能被正确禁用。
14. 作为用户，我进入**未信任**的项目时，本包不读取该项目的 MCP 配置与 profile，也不会因此放大权限。
15. 作为用户，我首次进入一个需要交互确认信任的目录时，如果启动瞬间无法确定信任状态，切换/重启后状态会被纠正，并得到一条可行动的提示。
16. 作为安全敏感的用户，我确认生成的 overlay 文件里**没有**任何 URL、命令、header、token 或凭据，只有 `disabled` 标记（除非用户自己的 Pi global 槽位文件需要被原样透传）。
17. 作为安全敏感的用户，我确认本包从不修改我的 `~/.pi/agent/mcp.json`、`.pi/mcp.json`、`~/.agents/mcp.json`、`~/.config/mcp/mcp.json`、`mcp-cache.json` 或 adapter 的认证数据。
18. 作为 Pi 用户，我通过 MCP 网关（`mcp` / `mcpScript`）调用被禁 server 时会被拒绝，这样过滤不是"仅提示词层面"的假隔离。
19. 作为 Pi 用户，我使用的 server 定义在 `~/.agents/mcp.json` 或 `~/.config/mcp/mcp.json` 时也能被 `mcp` 白名单引用与过滤，这样我不必为了本功能迁移配置。
20. 作为 Pi 用户，我在 profile 里写了不存在的 server 名时，激活仍然像今天一样"响亮失败并给出候选"，而不是静默放行。
21. 作为 Pi 用户，overlay 生成失败（磁盘只读、JSON 损坏等）时，我的会话仍能启动，问题以 warning 呈现，并明确指出文件与原因。
22. 作为 Pi 用户，反复启动/切换时不会产生无意义的 reload：overlay 内容未变化就什么都不做。
23. 作为其他扩展的作者，我观察到本包不占用 Pi 的核心行为：只在自身需要时写入一个生成文件，并且 flag 默认值可被 CLI 覆盖。
24. 作为维护者，我能在一处（ADR + 架构文档）读到"为什么需要生成式 overlay、为什么用 flag 默认值、与 ADR-0002 的边界"，这样后续升级 adapter 时知道哪些判断需要复核。
25. 作为维护者，当 adapter 未来实现 allowlist 通道时，我可以移除 overlay 机制而不破坏 profile 语义。

## Implementation Decisions

### 模块

- **扩展发现（既有模块扩展）**：`src/mcp-config.ts` 从"只读 server 名"升级为"读 adapter 的全部**文件来源**，返回 `name → 定义 + 来源`"。来源与顺序（后者优先）：`~/.config/mcp/mcp.json`、`~/.agents/mcp.json`、`~/.agents/mcp/mcp.json`、Pi global 槽位（默认 `<agentDir>/mcp.json`，或用户 `--mcp-config` 指定路径）、项目 `./.mcp.json`、项目 `./.pi/mcp.json`（仅在信任时读取）。
- **overlay 生成（新模块，纯函数）**：输入 = ①Pi global 槽位文件的原始文档（若存在）②其他来源的 server 名与定义 ③允许的 server 集合（由 resolver 产出，支持 glob）。输出 = 可直接写盘的 overlay 文档：
  - 槽位文件中存在的 server：原样保留其定义；不在允许集合内则加 `disabled: true`。
  - 其他来源中的 server：不在允许集合内则写 `{ "<name>": { "disabled": true } }`（不复制定义）。
  - 槽位文件中的 `settings` / `imports` / `claudePlugins` 等非 `mcpServers` 键原样透传（因为该槽位被 overlay 文件替换）。
- **接线（既有 extension 入口）**：
  - 扩展加载阶段（同步，必须先于 adapter 的 `session_start` 读配置）：存在性门禁 → 采用手写槽位（如有）→ 生成并写 overlay。
  - `session_start`：用 `ctx.isProjectTrusted()` 复核；与加载阶段结果不一致时重写 overlay 并提示一次 `/reload`（无法在事件上下文里 reload）。
  - 切换路径（`/profile use`、picker、`/mcp enable|disable`、CRUD 重激活）：重写 overlay → `ctx.waitForIdle()` → `ctx.reload()`（必须为最后一步，`await` 之后不得再使用旧 `ctx`/`pi`）。
- **activation 校验与 `pi.events` 发布保持不变**：`mcp` 引用的合法性与 `pi-profile:mcp-allowlist:v1` 事件保留（作为上游实现后的兼容路径）。

### 契约与机制依据

- **disable-only 条目合法**：adapter 的条目校验只要求"是一个对象"。
- **合并是逐字段的**：`merged[name] = { ...baseEntry, ...definition }`，所以高优先级来源只写 `disabled` 即可禁用低优先级来源里的完整定义；项目来源后合并也不会清掉该字段。
- **adapter 读取路径可被 flag 替换**：`--mcp-config` 替换的是 "Pi global override" 这一个槽位（`getPiGlobalConfigPath`），因此 overlay 文件**必须**承担该槽位原有的 server 定义。
- **flag 注入不可行（实测）**：Pi 的 `detectExtensionConflicts` 把「两个扩展注册同名 flag」判为致命冲突（后加载的扩展整体加载失败，报 `Flag "--mcp-config" conflicts with …`），因此本包不能替 adapter 注册 `mcp-config`。改为写 adapter 默认读取的槽位，用户显式传的 `--mcp-config` 仍然优先（此时本包关闭管理）。
- **没有文件监听**：adapter 只在扩展加载时（eager/keep-alive 场景）与 `session_start` 读取配置，所以必须"先写文件、后 reload"；加载阶段写入是唯一能赶在 adapter session 初始化之前的时机。
- **加载阶段读不到 `--profile` 的 flag 值**（CLI 值在加载后才应用）：加载阶段改为解析 `process.argv`；`session_start` 起使用正式的 `readProfileFlag`。
- **信任镜像**（加载阶段）：`hasTrustRequiringProjectResources(cwd)` 为假 → 视为信任；否则 `ProjectTrustStore.get(cwd)`；再否则 Pi settings 的 `defaultProjectTrust`（`always`/`never`/`ask`，`ask` 在加载阶段按"未信任"处理），与 Pi 的 `resolveProjectTrusted` 顺序一致（不含交互询问与扩展投票）。
- **存在性门禁**（任一命中即视为已安装）：`<agentDir>/npm/node_modules/pi-mcp-adapter/package.json`、`process.argv` 的 `-e <path>` 含 `pi-mcp-adapter`、Pi settings `packages` 含 `pi-mcp-adapter`、`pi.events` 的 snapshot 探测有回应。未命中 → 不注册 flag、不写文件。
- **文件与写入**：生成物 = `<agentDir>/mcp.json`（adapter 的 Pi-global 槽位），带 `piProfileSwitch` 标记；sidecar = `<agentDir>/mcp.user.json`。原子写（临时文件 + rename）、仅内容变化时写、权限 `0600`（透传的用户定义可能含凭据）。
- **失败处理**：加载阶段任何异常都不得抛出（catch → 静默/一条 warning）；切换阶段的生成失败按普通激活错误报告，且不得留下半成品文件。
- **无 schema 变更**：不新增 profile 字段，复用现有 `mcp` 数组（含 glob）。

### ADR

新增 ADR（生成式 overlay + 内置 flag 默认值 + 与 ADR-0002「不管理 MCP 配置」的边界），并在 ADR-0002/0007 中标注需要复核的条款。

## Testing Decisions

好测试的标准：只断言**外部行为**——生成的配置文档内容、adapter 实际暴露给模型的工具集合、以及包在特定文件布局下是否产生副作用；不断言内部函数调用顺序或私有实现。

采用**两个接缝**（其余复用已有接缝）：

1. **纯生成接缝（新增，最高点）**：`buildMcpOverlay` 纯函数。单元测试覆盖语义表（未声明 / `[]` / 白名单 / glob）、槽位定义透传、非槽位来源只写禁用条目、`settings`/`imports` 透传。先例：`test/profile-resolver.test.ts`、`test/profile-presets.test.ts` 的纯函数测试风格。
2. **真实 adapter 集成接缝（复用现有 RPC harness）**：fixture HOME/agentDir + `-e` 加载真实 `pi-mcp-adapter` 与 fake stdio MCP server，断言：启动后非允许 server 的工具不在活动集合、被禁 server 的网关调用被拒绝、`/profile use` 后（reload 结束）工具面改变、session id/file 不变。先例：`test/extension.integration.test.ts` 的 adapter 探针与 "switches profiles in place" 用例。

复用/补充的既有接缝：

3. **发现范围**：`test/mcp-config.test.ts` 扩展为 fixture 文件树（含 `.agents/mcp.json`、`~/.config/mcp/mcp.json`、项目两处、未信任不读）。
4. **门禁与 flag 默认值**：fixture 无 adapter 时断言不写 overlay、不注册 `mcp-config`；有 adapter 时断言 CLI 显式值优先于默认值。先例：`test/startup-selection.test.ts`。

不做的事：不 mock adapter 内部实现；不对 TUI 呈现做自动化；不为"上游 allowlist 通道"写测试。

## Out of Scope

- 上游 `pi-mcp-adapter` 实现 allowlist 通道（本 spec 提供的是不依赖上游的路径）。
- 复制完整 MCP 配置或使用 `PI_MCP_CONFIG_MODE=exclusive`。
- host discovery 来源（`~/.claude.json`、`~/.cursor/mcp.json`、Codex 等 opt-in 文件）的 allowlist 支持与禁用。
- package manifest（`pi.mcp`）与 agent plugin / Claude plugin 来源的 server 名发现：这些名字是命名空间化的，且不在"文件来源"集合内；命中 `disabled` 时仍会被禁用，但不在发现范围内。
- 连接级隔离保证（被禁 server 不会被连接）：`disabled` 已在 adapter 内产生"不连接、不注册、网关拒绝"的效果，但本包不额外保证进程级无接触。
- 交互式首信任目录的精确一致性（用"纠偏 + 提示 reload"兜底）。
- 为 MCP 过滤新增配置开关或 profile 字段。

## Comments

2026-09-13 — 实现期修正（`feat` 分支，未发布）：

- 原设计的「代码内置 `--mcp-config` flag 默认值」被实测否定：真实 `pi` 加载第二个注册同名 flag 的扩展直接失败（`Flag "--mcp-config" conflicts with …`，`resource-loader.js` 的 `detectExtensionConflicts` 无条件判定）。改为写 adapter 默认读取的 Pi-global 槽位 `<agentDir>/mcp.json` + sidecar `<agentDir>/mcp.user.json` + 生成标记；用户显式 `--mcp-config` 时关闭管理。
- 已实现并通过：`src/mcp-overlay.ts`（纯生成，11 例）、`src/mcp-config.ts`（发现范围扩到 `.agents`/`~/.config/mcp`/项目两处，10 例）、`src/mcp-overlay-file.ts`、`src/adapter-presence.ts`（6 例）、`src/startup-mcp-scope.ts`（20 例）、`test/mcp-overlay.integration.test.ts`（4 例：假 adapter 端到端 3 例 + 真 adapter 状态事件 1 例，后者在未安装时自动跳过）。
- 真机验证（pi-mcp-adapter 2.33.0）：`review`（`mcp: ["alpha"]`）下 adapter 自身状态事件报告 `alpha: failed（已尝试连接）`、`beta: disabled`。
- 收尾：`npm run check` 干净，`npm test` 25 个文件 276/276 通过；`docs/adr/0008`、架构文档、README（中英）、PRD、acceptance 已同步。仍未自动化的只有 `docs/acceptance.md` 的 11/12 两步人工检查（等价断言已由集成测试覆盖）。

## Further Notes

- 关键源码依据（供实现者复核，adapter 2.33.0 / Pi 0.85.1）：逐字段合并 `mergeServerMaps`；条目校验 `isServerEntry`（仅要求对象）；禁用判定 `isServerDisabled` 与各处拒绝（初始化过滤、直连工具、namespace 工具、`server-manager` 的连接与调用）；adapter 自身 `/mcp disable` 写 disabled-only override 的实现与注释；`getConfigSources` 的来源顺序与 `getPiGlobalConfigPath` 的槽位替换；配置读取点（扩展加载、`session_start`）与"无文件监听"；Pi 的 `registerFlag` 默认值、共享 `flagValues`、CLI 值在加载后无条件覆盖；`resolveProjectTrusted` 的信任顺序。
- 已知边界：`<agentDir>/mcp.json` 槽位被 overlay 文件替换，所以该文件的 server 定义必须被 overlay 透传；若其中含硬编码凭据，会出现在 overlay 文件里（写入权限 0600，并在文档中建议改用 env 引用）。
- 文档影响：`README.md` / `README.zh-CN.md`（`mcp` 字段语义与零配置说明）、`docs/architecture/overview.md`（新模块、生成文件、触发点与 reload 语义）、`docs/product/prd.md`（`mcp` 的实际生效机制）、`docs/acceptance.md`（手工验收：切换后工具面变化、网关拒绝、无 adapter 无副作用）、新增 ADR。
- 未来清理：一旦上游实现 allowlist 通道，可删除 overlay 生成与 flag 默认值，profile 语义与测试断言不变（只换实现路径）。
