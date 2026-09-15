# pi-profile 初始实现 spec

Status: done

历史说明：本 spec 的资源模型已被后续决策部分取代——宿主架构改为 ADR-0005（子进程 + 生成式 settings），extension 管理改为 ADR-0007（纯发现与过滤，无 resources.json），工作区与实例管理见 `docs/specs/profile-wrapper-refactor/`。保留为历史记录。

## Problem Statement

Pi 是极简 agent：它发现全部可用的 skills、extensions、MCP servers 和 tools，并全部暴露给模型。对于固定工作流（code review、实现、调研、受限环境），用户无法按场景裁剪资源集合——全量资源稀释 context、扩大权限面，且改变工作方式必须重启或手工调整配置。用户需要一种命名机制：引用已有资源（不复制），按场景选择子集，并在不重启 Pi 的情况下切换。

## Solution

`pi-profile` 是一个 Pi package，把 profile 作为 Pi runtime 的资源选择机制。一个 profile 按名称引用已存在的 skills、ResourceRegistry 中的 extension、`pi-mcp-adapter` 已配置的 MCP server 和 Pi 全局 tool name，可选声明 model、thinkingLevel 和 instructions。

`pi-profile` 启动器在首个 agent turn 前完成初始 profile 解析与资源过滤；对话中通过 `/profile` 命令族切换、查看、临时调整（runtime overlay）和维护 profile 与 resource registry。资源只有一份实现，profile 只持有引用；切换保留 session、不改写历史。原生 `pi` 入口不变，总是以内建 `default` profile（全量资源）启动。

## User Stories

1. 作为 Pi 用户，我希望 `pi` 保持原生入口并总是以内建 `default` profile 启动，以便未配置工作流时行为完全不变。
2. 作为 Pi 用户，我希望 `pi-profile` 无参数启动时恢复上次保存的活动 profile，以便不必每次重申工作方式。
3. 作为 Pi 用户，我希望 `pi-profile review` 的位置参数只作用于本次启动、不保存选择，以便一次性会话不覆盖我的持久偏好。
4. 作为 Pi 用户，我希望 `--` 之后的参数原样传给 Pi（如 `--model`、`--mode rpc`），以便保留全部原生参数能力。
5. 作为 Pi 用户，我希望启动器在首个 agent turn 前完成资源过滤，以便模型从不看到 profile 之外的 skills、extensions、MCP servers 和 tools。
6. 作为 Pi 用户，我希望内建 `default` profile 加载 Pi 全量可发现资源且不可删除，以便随时回到无限制基线。
7. 作为 Pi 用户，我希望在全局 catalog（`~/.pi/agent/profiles.json`）定义 profile，以便在所有项目中使用。
8. 作为 Pi 用户，我希望在项目 catalog（`.pi/profiles.json`）定义 profile，以便项目携带自己的工作流。
9. 作为 Pi 用户，我希望项目同名 profile 完整替换全局定义，以便覆盖行为可预测。
10. 作为 Pi 用户，我希望删除项目覆盖后全局同名 profile 立即重新出现，以便不静默丢失全局定义。
11. 作为 Pi 用户，我希望 profile 不支持继承、每个定义自包含，以便阅读任何 profile 时无需回溯父链。
12. 作为 Pi 用户，我希望仅在 Pi 信任项目目录后才读写项目 catalog、registry 和 state，以便未信任目录无法注入资源。
13. 作为 Pi 用户，我希望 `/profile use <name>` 不重启 Pi 进程即切换 profile 并保留当前 session，以便在对话中途更换工作流。
14. 作为 Pi 用户，我希望 `/profile use` 按 profile 的 source scope 持久化选择，以便下次启动恢复到正确的 profile。
15. 作为 Pi 用户，我希望切换后的下一个 agent turn 收到 profile 变更摘要，以便模型了解资源集合已变化。
16. 作为 Pi 用户，我希望切换不改写历史中的旧 tools、skills 和指令，以便 session 记录保持真实；需要强隔离时我可以新建 session。
17. 作为 Pi 用户，我希望激活等待 agent idle 后再重建 runtime，以便进行中的 turn 不被破坏。
18. 作为 Pi 用户，我希望 `/profile customize` 通过 runtime overlay 临时调整当前 profile 的 skills、extensions、mcp 和 tools，以便不写 catalog 即可试验。
19. 作为 Pi 用户，我希望 `/profile reset` 删除 overlay 并重新激活 profile 定义，以便一键回到声明状态。
20. 作为 Pi 用户，我希望 overlay 永不写入任何 catalog，以便临时调整不会静默变成永久定义。
21. 作为 Pi 用户，我希望 overlay 无法关闭 `alwaysOn` extension 或其直接依赖，以便安全 gate 不被临时移除。
22. 作为 Pi 用户，我希望一个 runtime 同时只有一个 profile 和一个可选 overlay、不支持多 profile 叠加，以便运行语义保持简单可推理。
23. 作为 Pi 用户，我希望 `/profile` 打开 profile selector，以便交互式浏览和选择。
24. 作为 Pi 用户，我希望 `/profile list` 列出内建、全局、项目 profile 及最终来源，以便确认哪个定义生效。
25. 作为 Pi 用户，我希望 `/profile status` 显示活动 profile、overlay、解析后的资源绝对路径、glob 差异与冲突结果，以便核对模型实际可见的能力集。
26. 作为 Pi 用户，我希望用 Pi skill name 引用 skill 而非绝对路径，以便 profile 跨目录可移植。
27. 作为 Pi 用户，我希望 SkillRegistry 镜像 Pi 完整 discovery 结果并沿用其同名优先级，以便项目优先的 skill 在项目内生效、全局 skill 在别处生效。
28. 作为 Pi 用户，我希望 skills、resource ID、MCP server name 和 tool name 支持 glob 并在每次启动或 reload 重新展开，以便新增匹配项自动进入 profile。
29. 作为 Pi 用户，我希望 `/profile status` 显示本次解析相对上次的增减与最终 `SKILL.md` 路径，以便察觉能力集变化。
30. 作为 Pi 用户，我希望非 `default` profile 中模型与 `/skill:` 命令只看到该 profile 解析出的 skills，以便 context 保持聚焦。
31. 作为 Pi 用户，我希望 SkillRegistry 始终维护全量可引用 skill 集，以便其他 profile 仍可引用未选中的 skill。
32. 作为 Pi 用户，我希望通过 ResourceRegistry 的稳定逻辑 ID 引用 extension，以便摆脱 Pi extension 缺少统一名称字段的问题。
33. 作为 Pi 用户，我希望项目 `resources.json` 的同名 ID 覆盖全局条目，以便项目级替换 extension 入口。
34. 作为 Pi 用户，我希望 profile 声明的 resource 的 `dependsOn` 被递归加入 ActivationPlan，以便 extension 与其依赖一起加载。
35. 作为 Pi 用户，我希望 `alwaysOn: true` 的 extension 在所有 profile 中加载，以便安全 gate 与审计能力常驻。
36. 作为 Pi 用户，我希望非 `default` profile 不加载未注册且未被选中的 extension，以便未选中的 extension 代码不运行。
37. 作为 Pi 用户，我希望环形依赖、缺失入口、缺失依赖导致激活失败，以便 registry 错误响亮地暴露。
38. 作为 Pi 用户，我希望 extension 加载顺序沿用 Pi 的隐式顺序、同名 tool/command 冲突不阻止激活，以便行为与原生 Pi 一致。
39. 作为 Pi 用户，我希望 `/profile status` 展示同名冲突、实际加载顺序和最终胜出者，以便冲突结果可观测。
40. 作为 Pi 用户，我希望 MCP 集成锁定到可选的 `pi-mcp-adapter`、profile 只引用 server 名称，以便连接参数与凭证永不进入 catalog。
41. 作为 Pi 用户，我希望未安装 adapter 且 profile 未声明 `mcp` 时正常激活，以便 MCP 保持真正可选。
42. 作为 Pi 用户，我希望未安装 adapter 而 profile 声明了 `mcp` 时激活失败并提示缺少 adapter，以便缺口显式可见。
43. 作为 Pi 用户，我希望 profile 引用了 adapter 未发现的 server 名称时激活失败，以便缺失的 MCP 能力响亮报错。
44. 作为 Pi 用户，我希望 `/mcp enable <server>` 与 `/mcp disable <server>` 直接修改当前 profile 所属 catalog 的 `mcp` 数组并触发 MCP runtime reload，以便 MCP 选择随 profile 持久化并立即生效。
45. 作为 Pi 用户，我希望 `/mcp enable` 只接受 adapter 已发现的 server 名称，以便拼写错误快速失败。
46. 作为 Pi 用户，我希望 `/mcp disable` 能移除 profile 引用的缺失 server 名称，以便清理过期引用。
47. 作为 Pi 用户，我希望 `/profile use` 切换时只应用内存中的 runtime server allowlist、不触碰 `.pi/mcp.json`，以便 adapter 的默认启用状态不受 profile 影响。
48. 作为 Pi 用户，我希望 `/profile status` 显示已启用 server、已发现但未启用的 server 和缺失名称，以便 MCP 状态透明。
49. 作为 Pi 用户，我希望用 Pi 全局 tool name 选择 tools，以便 profile 控制活动工具集。
50. 作为 Pi 用户，我希望选择 custom tool 时同时引用提供它的 extension resource，以便 provider extension 随工具加载。
51. 作为 Pi 用户，我希望 reload 后依据 Pi 实际注册的 tools 设置活动集合，以便 plan 与真实注册结果一致。
52. 作为 Pi 用户，我希望 profile 可选声明 model、thinkingLevel 和 instructions，以便工作流可以固定推理配置。
53. 作为 Pi 用户，我希望未声明这些字段时保持 Pi 当前 model、thinking 和 system prompt 不变，以便 profile 只改变它声明的行为。
54. 作为 Pi 用户，我希望声明的 model 缺失或未认证时激活失败并回滚，以便不会在非预期模型上运行。
55. 作为 Pi 用户，我希望 profile 的 instructions 追加到 Pi 已构建的 system prompt 末尾，以便默认 prompt、AGENTS.md 和其他 extension 指令继续生效。
56. 作为 Pi 用户，我希望 `/profile reload` 重新扫描 registry、catalog、adapter MCP server 和所有引用资源后重新激活当前 profile，以便资源变化无需重启即可传播。
57. 作为 Pi 用户，我希望修改共享的 `SKILL.md` 后所有引用它的 profile 在 reload 时获得新内容，以便一处修复惠及所有工作流。
58. 作为 Pi 用户，我希望激活失败或 Escape 时回滚到上一个已验证的 ActivationPlan，以便损坏的 profile 不会让 runtime 处于半切换状态。
59. 作为 Pi 用户，我希望 reload 后不使用旧 extension context 或旧 command context，以便新旧资源不混杂。
60. 作为 Pi 用户，我希望 `/profile create` 明确询问写入 global 还是 project catalog，以便新 profile 落在我预期的 scope。
61. 作为 Pi 用户，我希望 `/profile edit <name>` 在编辑活动 profile 保存后立即重新激活，以便修改即刻生效。
62. 作为 Pi 用户，我希望 `/profile delete <name>` 在删除活动 profile 前要求先选择替代 profile，以便 runtime 不会失去活动 profile。
63. 作为 Pi 用户，我希望 CRUD 向导保存时直接覆盖外部并发修改，以便进行中的编辑不被阻塞。
64. 作为 Pi 用户，我希望 `/profile resource list/create/edit/delete` 维护 resource registry，且删除只允许未被任何 profile 或 resource 依赖引用的条目，以便 registry 引用完整性受保护。
65. 作为 Pi 用户，我希望 runtime state（活动 profile 与 overlay）按 source scope 分别持久化，以便项目与全局偏好互不覆盖。
66. 作为 Pi 用户，我希望 CLI 初始 profile 选择不写 runtime state，以便一次性启动不覆盖保存的偏好。
67. 作为 Pi 用户，我希望 RPC、print 和 JSON mode 能以指定 profile 启动但不提供 CRUD，以便非交互运行保持只读。
68. 作为 Pi 用户，我希望 RPC mode 提供结构化非交互状态输出，以便脚本检查 profile 状态。

## Implementation Decisions

宿主架构：子进程 + 生成式 settings（ADR-0005，取代 ADR-0001 的 SDK 宿主方案）。launcher 把 profile 的资源选择编码为 pi-profile 私有的生成 settings，spawn 真实 `pi` 子进程并全量透传用户参数；会话内切换由 pi 内的 pi-profile extension 重写 settings 并调用 Pi 原生 `ctx.reload()` 完成。

### 模块（全部新建，greenfield）

- **CLI 启动器**（`bin/pi-profile.ts` + `src/launcher/`）：仅消费位置 profile 参数与第一个 `--` 分隔符；其余参数原样透传给 spawn 的 pi；`--approve`/`--no-approve` 不透传，改写为 resolver 的 trust 输入；初始选择不写 runtime state。
- **ProfileCatalog**：读取、列出、创建、编辑、删除 global 与 project profile；项目同名完整替换全局；删除项目覆盖后全局立即回退；`default` 不存在于文件中且不可删除；删除活动 profile 前必须先完成替代选择；`/mcp enable|disable` 通过它修改当前 profile 的 `mcp` 数组。
- **ResourceRegistry**：合并 global 与 project `resources.json`（项目同名 ID 覆盖）；按逻辑 ID 解析 extension 入口；递归解析 `dependsOn`；环形依赖、缺失入口、缺失依赖使激活失败；`alwaysOn` 总是进入 ActivationPlan；不负责排序。
- **SkillRegistry**：以只读方式调用 Pi SDK 的 `DefaultResourceLoader`（真实 agentDir + cwd）获得 Pi 原生发现结果，输出 skill name → 最终 `SKILL.md`（含 source 与 source scope）；沿用 Pi 同名优先级，不自定义胜出规则；每次启动或 reload 重新解析。
- **ProfileResolver**：纯函数——输入 profile、registry、skills、可选 MCP server registry、overlay 和 trust 状态，输出不可变 ActivationPlan；展开四类 glob，应用 overlay，合并 `alwaysOn` 与依赖闭包；overlay 不能关闭 `alwaysOn` extension 或其依赖链（传递闭包）；未声明的 model/thinking/instructions 不进入 plan；**trust 守门**：自读真实 `trust.json`（含 `--approve` 一次性输入），不可信项目的 catalog、registry、资源不进入 plan。
- **SettingsGenerator**：把 ActivationPlan 编码为 per-launch 运行目录——生成的 `settings.json`（agentDir 级与项目级白名单附加路径、`~/.agents` 排除、packages 对象形式 allowlist、非 `default` 时 `defaultProjectTrust: "never"`、已信任项目 settings 按 Pi 合并规则并入）、symlink 组（trust/auth/models/models-store/npm/sessions → 真实 agentDir）、环境变量（`PI_CODING_AGENT_DIR`）与生成 flags（`--tools`、`--model`）。用户配置永不修改。
- **pi-profile extension**（在 pi 内，经 `-e` 加载）：注册 `/profile` 命令族、selector 与 CRUD 向导；`/profile use` 保存 state、等待 agent idle、重写生成的 settings 并 `ctx.reload()`（session 保留）；失败时写回上一份已验证 settings 快照并再次 reload；`before_agent_start` 注入 profile instructions；reload 后依据 Pi 实际注册结果设置活动 tools、可选 model 与 thinking；经 `pi.events` 与 adapter 协调 MCP runtime allowlist；CRUD 只在 TUI mode 提供。
- **McpCoordination**（extension 侧）：发现 adapter 是否安装；经 `pi.events` 发布/读取 server 状态；`/mcp enable|disable` 经 adapter 的 profile-scoped state store 写当前 profile 的 `mcp` 数组（锁定支持该约定的 adapter 版本，ADR-0002）；adapter 未安装且 profile 声明 `mcp` 时激活失败；profile 引用 adapter 未发现的 server 时激活失败。
- **RuntimeStateStore**：按 source scope 读写 `pi-profile-state.json`（activeProfile、overlay、lastVerifiedProfile）；项目定义的写项目 state，全局定义与 `default` 写全局 state。

### 数据契约（schemaVersion 1）

- **`profiles.json`**（global + project）：`profiles` map；每个 profile 含可选 `label`、`description`、`skills`、`extensions`、`mcp`、`tools`（均支持 glob）、`model`（`provider`/`id`/`thinkingLevel`）、`instructions`；无继承字段。
- **`resources.json`**（global + project）：`resources` map；条目含 `kind`（固定 `extension`）、`entry`（绝对入口路径）、可选 `dependsOn`、可选 `alwaysOn`；MCP 能力不通过此文件声明。
- **`pi-profile-state.json`**（global + project）：`activeProfile`、`overlay`（`disabledSkills`/`disabledExtensions`/`disabledMcp`/`tools`）、`lastVerifiedProfile`。
- **生成的 `settings.json`**（pi-profile 私有运行时产物）：非稳定 interface 面，schema 随 Pi 版本演进，由集成测试守护漂移。
- 两份 JSON schema 随包发布（`schemas/`），examples 提供样例。

### 关键交互

- 启动激活：catalog 解析来源 → trust 判定 → 只读 discovery → resource 闭包与 adapter server 校验 → 生成 ActivationPlan → 生成运行目录（settings + symlinks + env + flags）→ spawn pi（参数透传 + `-e` extension）→ extension 在 session_start 发布 MCP allowlist。
- 会话内切换：`/profile use` 持久化选择（CLI 初始选择不持久化）→ 等待 idle → 快照当前 settings → 重写 settings → `ctx.reload()` → 成功记录 `lastVerifiedProfile` / 失败写回快照再次 reload。
- `/mcp enable|disable` 持久化到当前 profile 所属 catalog 并执行 MCP 级 reload；`/profile customize` 只写 overlay；`/profile reset` 删 overlay 并重新激活。
- 同名 tool/command 冲突不阻止激活；status 展示冲突、加载顺序与胜出者。

## Testing Decisions

**好测试的标准**：只在模块公开接口的边界上断言外部可观测行为（输入 → 输出 / 文件效果 / 失败模式），不断言内部 helper 或解析顺序等实现细节。文件型模块用磁盘 fixture 驱动；外部边界（`pi-mcp-adapter`）用 fake。

**Seam 布局**（按模块细粒度 unit seam + 一个集成 seam，经与维护者确认）：

- **ProfileCatalog（unit）**：global/project 合并列表、同名替换、删除后全局回退、CRUD 写入正确 scope、`default` 不可删除。
- **ResourceRegistry（unit）**：global/project 合并与 ID 覆盖、依赖闭包、环形依赖检测、`alwaysOn` 注入、缺失入口/依赖报错。
- **SkillRegistry（unit）**：Pi discovery 结果到 name → `SKILL.md` 的映射、同名优先级、每次解析重新展开 glob。
- **ProfileResolver（unit）**：四类 glob 展开与 reload 差异、overlay 应用与 `alwaysOn` 保护、project 覆盖与回退、`default` 全量 plan、未声明 model/thinking/instructions 时不修改 Pi 状态、缺失 MCP server / 未装 adapter 的失败、不可信项目不读项目文件、`--approve` 一次性 trust 输入。
- **SettingsGenerator（unit）**：plan → 生成 settings 的数组形态（白名单附加路径 / `~/.agents` 排除 / packages allowlist / `defaultProjectTrust` 置位）、symlink 组指向真实 agentDir、用户全局 settings 未受管键原样保留、flags 与环境变量正确、`default` 逐字拷贝不过滤。
- **McpCoordination（unit，fake adapter/event bus）**：安装探测、allowlist 仅内存发布、`/mcp enable|disable` 写入 profile-scoped state store、enable 拒绝未知名称 / disable 允许缺失名称。
- **RuntimeStateStore（unit）**：按 source scope 读写、CLI 初始选择不落盘。
- **Launcher + extension（integration）**：fixture HOME/agentDir/project + **真实 pi 子进程**（`--mode rpc` + probe extension 内省，即 ADR-0005 spike 形态），覆盖 PRD 全部 integration 验收：首个 agent turn 前只暴露 profile 资源、`/profile use` 不重启切换且 session 保留、共享 skill 修改经 reload 传播、项目覆盖与回退、`/mcp enable|disable` 写 catalog 且不改 `.pi/mcp.json`、无 adapter 时未声明 `mcp` 的 profile 正常激活、tool/command 冲突结果与 Pi 加载顺序一致、用户 settings 文件零改写。
- **TUI**：不做自动化测试；按 PRD 的 TUI 验收清单（8 步）人工验收。

**Prior art**：无——greenfield 仓库，尚无任何测试。本批测试同时建立 test runner 与 fixture 布局约定：unit 测试不依赖真实 Pi 进程，integration 测试用 fixture 目录拉起真实 pi 子进程。

## Out of Scope

- MCP server 的连接配置、OAuth、凭证管理（归 `pi-mcp-adapter`）。
- profile 继承（`extends`、深合并、数组追加）与多 profile 叠加（ADR-0003）。
- per-profile 资源副本或 vendoring（ADR-0004，核心不变量）。
- RPC / print / JSON mode 下的交互式 CRUD。
- TUI 自动化测试。
- 人为控制 extension 加载顺序（沿用 Pi 隐式顺序）。
- 切换 profile 时改写 session 历史。
- 对未信任 project 目录的任何读写。
- 原生 `pi` 入口的行为变更。

## Further Notes

- 受约束于 ADR-0005（子进程 + 生成式 settings 宿主；取代 ADR-0001）、ADR-0002（MCP 锁定 `pi-mcp-adapter` 约定版本）、ADR-0003（无继承）、ADR-0004（引用而非复制）。
- `pi-mcp-adapter` 是可选依赖；其锁定版本必须提供 profile-scoped state store，使 `/mcp enable|disable` 写当前 profile 而非默认 `.pi/mcp.json` 覆盖层。
- 详细用户语义见 `docs/product/prd.md`；模块接口与激活流程见 `docs/architecture/overview.md`；术语以 `CONTEXT.md` 为准。
