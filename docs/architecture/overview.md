# pi-profile 架构设计

## 范围

本文定义 `pi-profile` 的内部设计：总体结构、模块接口、数据契约、激活流程与包结构。产品目标、用户可见语义与验收标准见 `docs/product/prd.md`；关键决策的动机见 `docs/adr/`。

宿主架构：子进程 + 生成式 settings（ADR-0005，取代 ADR-0001 的 SDK 宿主方案）。

## 总体架构

```text
                         ┌─────────────────────────────┐
                         │       pi-profile CLI         │
                         │  positional profile + 全量   │
                         │  Pi 参数透传（拦截 --approve）│
                         └──────────────┬──────────────┘
                                        │
        ┌───────────────────────────────┼───────────────────────────────┐
        │ ProfileCatalog │ ResourceRegistry │ SkillRegistry │ RuntimeStateStore
        │ ProfileResolver（含 trust 守门） │ SettingsGenerator            │
        └───────────────────────────────┼───────────────────────────────┘
                                        │ 生成 per-launch agentDir
                                        │ settings.json + symlinks + env + flags
                                        ▼
                         ┌─────────────────────────────┐
                         │   spawn 真实 pi 子进程        │
                         │   PI_CODING_AGENT_DIR=<生成>  │
                         │   -e <pi-profile extension>  │
                         └──────────────┬──────────────┘
                                        │
┌───────────────────────────────────────▼───────────────────────────────────────┐
│                              pi-profile extension（在 pi 内）                  │
│ /profile 命令族 · CRUD 向导 · 状态 · instructions 注入 · tools/model 切换      │
│ 切换 = 重新 resolve → 重写生成的 settings.json → ctx.reload()（pi 原生）       │
│ MCP 协调：经 pi.events 与 pi-mcp-adapter 通信                                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

`pi-profile` 的外部 interface 是 CLI、`/profile` 命令、catalog schema 与 resource registry schema。profile 解析、glob 展开、依赖闭包、trust 守门、settings 生成、MCP 协调和状态持久化都在内部完成；资源过滤本身由 Pi 原生的 settings 机制执行（见 ADR-0005 的验证证据）。

## 过滤模型

profile 只管理四类资源（skills、extensions、MCP servers、tools）；其余资源类别（prompt templates、themes、context files、Pi settings 本体）原样穿过，保持 Pi 原生行为。

| 作用域 | 机制 | 形态 |
| --- | --- | --- |
| agentDir 级（`~/.pi/agent/skills`、`extensions`） | 发现根随 `PI_CODING_AGENT_DIR` 移走，天然不发现；settings 数组写入选中项绝对路径 | 白名单（附加路径） |
| `~/.agents/skills`（HOME 级，无法抑制） | settings `skills` 数组写 `-绝对路径` / `!glob` 排除未选中项 | 补集排除 |
| 项目级（`.pi/*`、项目 ancestor `.agents/skills`） | 生成 settings 置 `defaultProjectTrust: "never"` 且不链接 `trust.json`（stored trust 优先于 never）；launcher 自读真实 `trust.json`，仅已信任时把选中项绝对路径写入 settings 数组（附加用户级路径不经 Pi trust 检查）；项目 `packages` 被剥除（会装进全局 npm 根） | 白名单（附加路径）+ trust 守门 |
| packages（全局与项目） | settings `packages` 数组对象形式按类别写 allowlist glob | 白名单 |
| tools | 生成 `--tools` flag（全量 tool 严格 allowlist，含 extension tools） | 白名单 |
| MCP servers | extension 经 `pi.events` 向 adapter 发布运行时 allowlist | 白名单（内存） |

`default` profile 不生成任何过滤：settings 为用户全局 settings 的逐字拷贝，不置 `defaultProjectTrust`，项目信任行为与原生 Pi 完全一致。

## 模块与接口

### `pi-profile CLI`（`bin/pi-profile.ts` + `src/launcher/`）

**Interface**：解析 `pi-profile [profile] [-- <pi args>...]`；其余一切原样透传给 spawn 的 pi。

**Rules**：

- 仅消费两段输入：首个不以 `-` 开头的位置参数（profile 名）与其后的第一个 `--` 分隔符本身。`--` 之后的内容原样成为 pi 的 argv。
- `--approve` / `--no-approve` 对命名 profile 不透传：改写为 launcher 的 trust 输入，防止 Pi 侧自动发现未过滤的项目资源。`default` profile 无过滤，按原生语义原样透传（ticket 01）。
- 位置参数只作用于本次启动（不写 runtime state）；无位置参数时读取保存的活动 profile，不存在则用 `default`。
- 未知 profile 在 spawn 前失败退出。

### `ProfileCatalog`

**Interface**：读取、列出、创建、编辑、删除 global 与 project `Profile`。

**Rules**（不变）：

- `default` 不存在于文件中，不能删除。
- 项目同名 profile 完整替换全局 profile；删除项目覆盖后立即暴露全局同名。
- 删除活动 profile 前必须先完成替代 profile 选择。
- `/mcp enable` 与 `/mcp disable` 修改当前 profile 的 `mcp` 数组，不修改 MCP 连接配置。

### `ResourceRegistry`

**Interface**：用逻辑 ID 解析 extension 入口，返回依赖闭包。

**Rules**（不变）：ID 稳定唯一；环形依赖、缺失入口、缺失依赖使 profile 无法激活；`alwaysOn` 总是进入 ActivationPlan；不负责排序。

### `SkillRegistry`

**Interface**：输出当前全量可引用 skill 集：skill name、最终 `SKILL.md`、source 与 source scope。

**Implementation**：以只读方式调用 Pi SDK 的 `DefaultResourceLoader`（指向真实 agentDir 与 cwd）获得 Pi 原生发现结果与优先级，不自行重实现目录扫描。每次启动或 reload 重新解析。

### `ProfileResolver`

**Interface**：输入 profile、registry、skills、可选 MCP server registry、overlay 和 trust 状态，输出不可变 `ActivationPlan`。

**Rules**：

- 一个 plan 对应一个 profile 和一个 overlay；展开四类 glob，应用 overlay，合并 `alwaysOn` 与依赖闭包。
- overlay 可以调整当前 profile 声明的资源引用，但不能关闭 `alwaysOn` extension 或其依赖链（传递闭包）。
- 未声明的 model、thinking 或 instructions 不进入 plan（保持 Pi 当前状态）。
- **Trust 守门**：launcher（`project-trust.ts`）按 Pi 的判定序镜像 trust 布尔量：一次性 `--approve` 输入 → 无任何 trust-requiring 项目资源则信任（含 pi-profile 自己的 catalog/state 文件，Pi 的原生清单不认识它们）→ 真实 `trust.json` 最近祖先条目 → `defaultProjectTrust: always`；项目 catalog、registry、资源仅在已信任时进入 plan。pi-profile 因此成为项目资源的唯一信任守门人——命名 profile 的生成 settings 置 `defaultProjectTrust: "never"` 且不链接 `trust.json`（已存储的 trust 决定在 Pi 侧优先于 never），保证 Pi 侧永不自动发现项目资源。已知偏离：不咨询 extension 的 `project_trust` 事件（那需要在 launcher 里执行扩展代码）。

### `SettingsGenerator`

**Interface**：输入 ActivationPlan、全量发现结果与用户全局 settings，输出一个 per-launch 运行目录：生成的 `settings.json`、symlink 组、环境变量与生成 flags。

**Implementation**：

- 运行目录位于 pi-profile 私有位置（如 `~/.pi/agent/pi-profile/runtime/<launch-id>/`），每次启动新建；进程退出后残留目录无害，可定期清理。
- 生成 `settings.json`：用户全局 settings 内容 + 过滤模型的数组改写（见上表）；非 `default` profile 追加 `defaultProjectTrust: "never"`；已信任项目的 `.pi/settings.json` 内容按 Pi 的合并规则（项目覆盖全局、嵌套按键合并）合并进来，以保持非受管行为原生。
- symlinks：`auth.json`、`models.json`、`models-store.json`、`mcp.json`、`npm/`、`git/`、`bin/` 指向真实 agentDir 的对应项（git/bin 分别是包安装根与 Pi 托管二进制，避免在运行目录里重复安装；`mcp.json` 是 pi-mcp-adapter 的全局配置，其路径派生自 `PI_CODING_AGENT_DIR`，pi-profile 只链接从不改写）。`trust.json` 只在 `default` profile 下链接：Pi 侧已存储的 trust 决定优先于生成 settings 的 `defaultProjectTrust: "never"`，若链接会使命名 profile 的项目自动发现复活——launcher 自读真实 trust.json，是项目资源的唯一信任守门人。
- 环境变量：`PI_CODING_AGENT_DIR=<运行目录>`、`PI_CODING_AGENT_SESSION_DIR=<真实 sessions 目录>`。
- 生成 flags：`--tools <选中清单>`（非 `default` 且声明 tools 时）、`--model <provider/id[:thinking]>`（声明 model 时）。
- 已知限制：`pi install` / `pi config` 在会话内写生成的 settings，退出后丢失（持久改动走 `/profile edit` 或原生 `pi`）。

### `RuntimeStateStore`

**Interface**：按 source scope 读写 `pi-profile-state.json`（activeProfile、overlay、lastVerifiedProfile）。项目定义写项目 state；全局定义与 `default` 写全局 state。（不变）

### `pi-profile extension`（`extensions/pi-profile/index.ts`，经 `-e` 加载）

**Interface**：注册 `/profile` 命令族（list/use/status/customize/reset/create/edit/delete/resource/reload）、profile selector、CRUD 向导与状态展示。

**Rules**：

- **切换**：`/profile use <name>` 校验 → 等待 agent idle（`ctx.waitForIdle()`）→ 内存快照当前 runtime 文件 → 重新 resolve → 重写生成的 `settings.json` 与 launch plan（标记 `persistSelection` 与 `switchedFrom`）→ `ctx.reload()`（Pi 原生 reload 重读磁盘并重建 runtime，保留 session）→ 验证 reload 真的执行（旧 ctx 失效探针；interactive 模式的 reload 拒绝不会 reject）→ 失败时恢复快照并再次 reload，runtime 绝不半切换。state（`activeProfile` + `lastVerifiedProfile` 回滚锚）由 reload 后的新 extension 实例在 `session_start` 里按来源 scope 写入——只有验证成功的激活才落锚。下一个 agent turn 收到一次性变更摘要。
- **reload**：`/profile reload` 重新发现与 resolve 后走同一路径，共享 skill 的修改随之传播。
- **失败回滚**：reload 前保留上一份已验证 settings 快照；reload 失败时写回快照并再次 reload。
- **instructions**：在 `before_agent_start` 中把 profile instructions 追加到 Pi 已构建的 system prompt 末尾（初始与切换路径统一走 extension，不用 flag）。
- **tools/model/thinking**：初始由生成 flags 生效；session_start（含 reload）后由 extension 把原始 tool 引用对 Pi 实际注册表（含扩展工具）重新展开并 `pi.setActiveTools`、可选 `pi.setModel` 与 thinking。
- **MCP 协调**：经 `pi.events` 与 `pi-mcp-adapter` 通信：激活时发布当前 profile 的运行时 server allowlist（仅内存，不触碰 adapter 的 `.pi/mcp.json`）；`/mcp enable|disable` 经 adapter 的 profile-scoped state store 写当前 profile 的 `mcp` 数组并触发 MCP 级 reload。adapter 未安装且 profile 声明 `mcp` 时激活失败；未声明 `mcp` 时不注册协调。
- CRUD 只在 TUI mode 提供；extension 可获知当前运行 mode，非交互模式下命令族退化为只读状态输出。

### `McpServerRegistry`

（不变）adapter 发现的 server 名称与状态；pi-profile 只引用名称。

## 数据契约

### `profiles.json` / `resources.json` / `pi-profile-state.json`

与前一版完全一致（schemaVersion 1），见 PRD 配置范围与本文件历史版本；核心字段不变：profile 的 `skills`/`extensions`/`mcp`/`tools`（glob）、可选 `model`（`provider`/`id`/`thinkingLevel`）与 `instructions`；resource 的 `kind`/`entry`/`dependsOn`/`alwaysOn`；state 的 `activeProfile`/`overlay`/`lastVerifiedProfile`。

### 生成的 `settings.json`（pi-profile 私有运行时产物，非用户配置）

```json
{
  "defaultProjectTrust": "never",
  "skills": [
    "/home/user/.pi/agent/skills/git-commit",
    "-/home/user/.agents/skills/secret-*"
  ],
  "extensions": [
    "/opt/pi-resources/review-guard/index.ts"
  ],
  "packages": [
    { "source": "npm:pi-skills", "skills": ["code-review"], "extensions": [] }
  ]
}
```

由 SettingsGenerator 每次启动/切换/reload 重新生成；用户全局 settings 中未被 profile 接管的键原样保留。它不是 interface 的稳定面：schema 随 Pi 版本演进，集成测试负责发现漂移。

## 激活流程

### 启动（CLI）

```text
pi-profile review -- --mode rpc
  │
  ├─ 解析位置参数与透传段（拦截 --approve）
  ├─ ProfileCatalog 解析 review 的最终来源（unknown → 退出）
  ├─ resolver 读 trust.json，判定项目 trust
  ├─ SkillRegistry（只读 SDK discovery）+ ResourceRegistry + adapter server 名
  ├─ ProfileResolver 生成 ActivationPlan（glob、闭包、alwaysOn、overlay）
  ├─ 校验：模型认证、入口存在、依赖闭包、MCP server 存在
  ├─ SettingsGenerator 写出运行目录（settings.json + symlinks + env + flags）
  ├─ spawn pi：-e <extension>、生成 flags、用户参数原样透传
  └─ extension 在 session_start 时经 pi.events 发布 MCP allowlist
```

### 会话内切换（extension）

```text
/profile use implement
  │
  ├─ 校验与 resolve（同启动路径）
  ├─ 按来源 scope 保存 runtime state
  ├─ 等待 agent idle
  ├─ 快照当前生成的 settings.json
  ├─ 重写 settings.json → ctx.reload()
  │    ├─ Pi 重读 settings，重建 resources（旧 extensions shutdown，新的加载）
  │    ├─ extension 重新执行：发布 MCP allowlist、设置 tools/model/thinking
  │    └─ session 保留（sessionId 与历史不变）
  ├─ 成功：记录 lastVerifiedProfile，下一 turn 发送变更摘要
  └─ 失败：写回快照并再次 reload，报告错误
```

## Package 结构

```text
pi-profile/
├── package.json
├── README.md
├── bin/
│   └── pi-profile.ts             # 位置参数解析、profile 解析、spawn
├── extensions/
│   └── pi-profile/
│       └── index.ts              # /profile 命令族、TUI、instructions、MCP 协调
├── src/
│   ├── launcher/
│   │   ├── args.ts               # 位置参数 + 透传段解析（含 --approve 拦截）
│   │   └── spawn.ts              # 子进程 spawn、信号与退出码转发
│   ├── profile-catalog.ts
│   ├── resource-registry.ts
│   ├── skill-registry.ts         # 只读 SDK discovery
│   ├── profile-resolver.ts
│   ├── settings-generator.ts     # plan → settings.json + symlinks + env + flags
│   ├── runtime-state-store.ts
│   ├── mcp-config.ts             # adapter pi-native 配置的 server 名只读发现
│   └── mcp-coordination.ts       # pi.events 协调契约（allowlist 频道 + 探测）
│   └── tui/
│       ├── profile-selector.ts
│       ├── profile-editor.ts
│       └── resource-editor.ts
├── schemas/
│   ├── profiles.schema.json
│   └── resources.schema.json
├── test/
│   ├── helpers/pi-fixture.ts     # fixture 布局约定（ticket 01 建立）
│   ├── profile-resolver.test.ts
│   ├── settings-generator.test.ts
│   ├── skill-registry.test.ts
│   └── launcher.integration.test.ts  # 真实 pi 子进程 + RPC 内省
└── examples/
    ├── profiles.json
    └── resources.json
```

`package.json` 同时声明 Pi extension 和 `pi-profile` binary。extension 提供对话内 runtime 交互；binary 负责初始 profile 解析、生成运行目录并 spawn Pi。
