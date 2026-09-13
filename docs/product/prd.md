# pi-profile 产品需求

## 定位

`pi-profile` 是一个 Pi package。它把 profile 作为 Pi runtime 的资源选择机制：一个 profile 引用已存在的 skills、extensions、已配置的 MCP server 和 tools，并在同一 Pi 实例内切换这些引用。

profile 不复制资源。一个 `SKILL.md`、extension 或 MCP server 只有一份实现；多个 profile 只引用它。修改实现后，所有引用它的 profile 会在下一次启动或 reload 时获得新内容。

```text
SkillRegistry
  git-commit ──► ~/.pi/agent/skills/git-commit/SKILL.md
       ▲                 ▲
       │                 │
  review profile     implement profile
```

## 设计哲学

Pi 是一个极简 agent；`pi-profile` 只完成 profile 选择这一必要需求，不添加额外约束。

- 用户直接拥有并维护自己的 profile。
- profile 中的 `skills`、`extensions`、`tools` 和 `mcp` 默认都可自由调整。
- 不增加白名单、审批层或额外定制开关。
- 只有影响 Pi 正常运行或安全边界的行为才受限制，例如 `alwaysOn` extension。
- 配置语义保持直接：临时调整走 runtime overlay；持久调整写当前 profile 所属文件。

## 产品目标

- 用命名 profile 组织 Pi 的工作方式，例如 `review`、`implement`、`research` 与 `restricted`。
- 让 profile 引用 Pi 已发现的 skills、resource registry 中声明的 extension，以及 `pi-mcp-adapter` 已配置的 MCP server。
- 在不重启 Pi 进程的情况下切换 profile。资源图变化时执行 reload。
- 保持 Pi 的默认行为：profile 未显式控制的行为仍由 Pi 原有 settings、discovery 和会话状态决定。
- 提供 TUI 中的 profile 与 resource registry CRUD。
- 支持全局与可信项目两种 catalog；项目定义可覆盖同名全局定义。
- 让 `pi-profile` 启动器在第一个 agent turn 前加载目标 profile，而不是先向模型暴露全量资源。

## 使用方式

```bash
# 原生 Pi：总是使用内建 default profile
pi

# pi-profile host：使用上次保存的 profile；不存在时使用 default
pi-profile

# 本次启动使用指定 profile；之后可用 /profile use 保存选择
pi-profile review

# 继续传递 Pi 参数；第一个 -- 后面的参数原样传给 pi
pi-profile review -- --model openai/gpt-5.4
pi-profile research -- --mode rpc
```

`pi` 保持原生入口，并总是从内建 `default` profile 启动。`default` 加载 Pi 可发现的全部 skills、tools、MCP server 与 extensions。

`pi-profile review` 的位置参数只选择本次启动的 profile，不把 `review` 保存为活动 profile。之后在对话中执行 `/profile use implement` 是显式运行时操作，按 profile 来源保存选择。

初始 profile 选择由 `pi-profile` 启动器在 spawn Pi 前完成：启动器把 profile 的资源选择编码为生成的 settings，Pi 的原生 settings 机制在第一个 agent turn 前完成过滤，不向模型暴露全量资源（决策动机与验证见 `docs/adr/0005-subprocess-host-with-generated-settings.md`）。

## 运行语义

一个 Pi runtime 同时只有：

- 一个命名 profile；
- 一个可选的 runtime overlay。

overlay 是临时调整。它不修改 profile 定义；`/profile reset` 删除 overlay 并恢复定义内容。

切换 profile 保留当前 session。下一次 agent turn 会得到一条 profile 变更摘要。历史中的旧 tools、skills 和指令不被改写；需要强隔离时，用户在切换后新建 session。

## 核心对象

| 对象                | 含义                                                               | 所有权             |
| ------------------- | ------------------------------------------------------------------ | ------------------ |
| `Profile`           | 命名工作流定义，引用资源并声明可选 model、thinking 和 instructions | 全局或项目 catalog |
| `default`           | 内建、不可删除的全量 profile；overlay 可临时限制其范围             | `pi-profile`       |
| `RuntimeOverlay`    | 当前 profile 的临时资源与 tool 覆盖                                | runtime state      |
| `SkillRegistry`     | Pi 当前完整 discovery 结果中的 skill 名到最终 `SKILL.md` 的映射    | resolver           |
| `ResourceRegistry`  | extension 的可引用视图：隐式发现（已安装包、散装文件）+ 显式 ID、依赖和常驻标记         | 全局或项目 catalog（显式层） |
| `McpServerRegistry` | `pi-mcp-adapter` 发现的 MCP server 名称与状态                      | `pi-mcp-adapter`   |
| `ActivationPlan`    | 解析后的技能、extension、MCP server、tools 与指令集合              | resolver           |

## 配置范围

| 文件                                | 用途                             | 覆盖规则                                  |
| ----------------------------------- | -------------------------------- | ----------------------------------------- |
| `~/.pi/agent/profiles.json`         | 全局 profile catalog             | 全局基础定义                              |
| `.pi/profiles.json`                 | 项目 profile catalog             | 同名完整替换全局 profile；可新增名称      |
| `~/.pi/agent/resources.json`        | 全局 extension registry（可选，override 层） | 同名 ID 覆盖隐式发现条目                  |
| `.pi/resources.json`                | 项目 extension registry（可选，override 层） | 同名 ID 覆盖全局与隐式条目                |
| `~/.pi/agent/pi-profile-state.json` | 全局 runtime state               | 保存全局来源 profile 的活动选择与 overlay |
| `.pi/pi-profile-state.json`         | 项目 runtime state               | 保存项目来源 profile 的活动选择与 overlay |

项目目录只在 Pi 已信任项目后读取和写入。

profile 的来源决定 state 写入范围：项目定义写项目 state；全局定义写全局 state；内建 `default` 视为全局定义。若项目 catalog 删除覆盖全局的同名 profile，全局 profile 立即重新出现在列表中。

profile 不支持继承。项目同名 profile 是完整替换，不深度合并、不追加数组，也不提供 `extends`。需要基于一个 profile 创建变体时，CRUD 向导复制完整定义后创建新名称。

`model`、`thinkingLevel` 和 `instructions` 都是可选字段。未声明时不修改 Pi 当前的模型、thinking 或 system prompt。显式声明的模型缺失或未认证时，profile 激活失败并回滚。

各文件的 JSON schema 见 `docs/architecture/overview.md` 的数据契约。

## 资源引用

skills、resource ID、MCP server name 和 tool name 都支持 glob。glob 在每次启动或 reload 时重新展开；新匹配项自动进入 profile，`/profile status` 显示本次解析相对上次的增减。零匹配的 glob 不阻塞激活，但作为 unmatched 警告出现在启动输出与 `/profile status` 中（tool glob 除外：扩展贡献的 tool 在启动前不可知）。

### Skills

skill 使用 Pi 的 skill name 作为逻辑身份：

```json
{
  "skills": ["git-commit", "code-review", "research-*"]
}
```

`SkillRegistry` 镜像 Pi 当前完整 discovery 结果：常规用户与项目目录、ancestor `.agents/skills`、settings 路径和已安装 package resources 都进入 registry。

同名 skill 按 Pi 原有发现优先级解析。profile 不固定绝对路径；它在每次启动或 reload 时重新解析。因此同一 profile 在项目中可以使用项目优先的 skill，在其他目录中使用全局 skill。`/profile status` 显示最终 `SKILL.md` 路径。

### Extensions

extension 引用遵循发现优先（ADR-0006）：已安装包与标准目录散装文件**无需注册**即可引用，`resources.json` 只用于覆盖与标准位置外的 extension。

一个引用按以下顺序解析：

1. **registry ID**：`resources.json` 显式条目（覆盖一切同名的隐式条目）。
2. **包名或源别名**：已配置 user 包的 `package.json#pi.extensions` 声明入口；`"pi-mcp-adapter"` 或 `"npm:pi-mcp-adapter"` 均可。多入口包以包名选中全部入口，单入口可按 `<包名>:<相对路径>` 选中。
3. **散装文件 stem**：`~/.pi/agent/extensions/conventions.ts` 引用为 `"conventions"`；已信任项目的 `.pi/extensions` 同理，同名覆盖全局。
4. **磁盘路径**：绝对路径或 `~/` 路径直接引用一次性 extension，无需任何注册。

```json
{
  "extensions": ["pi-mcp-adapter", "conventions", "github-*"]
}
```

未匹配的字面量引用激活失败，错误列出已发现候选、相近名提示与最小注册示例。glob 零匹配不阻塞激活，但会在启动警告与 `/profile status` 中可见。

显式注册保留完整表达力：稳定 ID、`alwaysOn`、`dependsOn`、对隐式条目的覆盖（`entry` 可省略以继承发现到的入口）：

```json
{
  "resources": {
    "pi-web-access": { "kind": "extension", "alwaysOn": true },
    "team-conventions": { "kind": "extension", "entry": "/home/you/team/extensions/conventions.ts" }
  }
}
```

### MCP

MCP 集成锁定为 `pi-mcp-adapter`。它是可选依赖：未安装 adapter 且 profile 未声明 `mcp` 时，skills、extensions、tools 和 profile 切换不受影响；未安装 adapter 且 profile 声明了 `mcp` 时，该 profile 激活失败并提示缺少 `pi-mcp-adapter`。

profile 只引用 adapter 已配置的 MCP server 名称：

```json
{
  "mcp": ["github-ro", "atlassian"]
}
```

server 的命令、地址、OAuth、token 和 timeout 保留在 `pi-mcp-adapter` 管理的 MCP 配置中。`profiles.json` 不保存 MCP 连接参数或凭证。

用户执行 `/mcp enable <server>` 或 `/mcp disable <server>` 时，修改当前 profile 的 `mcp` 数组并保存到该 profile 所属 catalog。锁定版本的 adapter 通过其 profile-scoped state store 执行该修改，不写入 adapter 默认的 `.pi/mcp.json` 覆盖状态。

`/profile use` 切换 profile 时，`pi-profile` 向 adapter 应用新 profile 的 runtime server allowlist；不调用 adapter 的持久化 enable/disable 实现。

`/profile status` 显示已启用 server、adapter 发现但当前未启用的 server，以及 profile 引用了但 adapter 未发现的缺失名称。

### Tools

profile 使用 Pi 的全局 tool name：

```json
{
  "tools": ["read", "grep", "find", "ls", "search_issues"]
}
```

选择 custom tool 时，profile 同时引用提供该 tool 的 extension resource。初始启动由生成的 `--tools` flag 生效；切换或 reload 后，pi-profile extension 依据 Pi 实际注册的 tools 重新设置活动集合。

## 常驻与选择

- `default` 包含所有 Pi 可发现资源。
- `ResourceRegistry` 中 `alwaysOn: true` 的 extension 在所有 profile 中加载，例如安全 gate 或审计 extension。
- 非 `default` profile 不加载未被 profile 或依赖闭包选中的 extension（发现到的未选中项同样不加载）。
- profile 声明的 resource 的 `dependsOn` 由 resolver 递归加入 ActivationPlan。
- profile 不人为排序 extension。Pi 的隐式加载顺序决定 handlers、同名 tool override 和 command 后缀。
- 同名 tool 或 command 不阻止激活。`/profile status` 显示冲突、实际加载顺序和最终胜出结果。

## 命令与交互

| 命令                            | 行为                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `/profile`                      | 打开 profile 选择器                                                             |
| `/profile list`                 | 列出内建、全局和项目 profile，以及最终来源                                      |
| `/profile use <name>`           | 校验、保存选择、创建 ActivationPlan 并切换                                      |
| `/profile status`               | 显示 profile、overlay、解析后的资源路径、glob 差异与冲突                        |
| `/profile customize`            | 编辑当前 profile 的 runtime overlay                                             |
| `/profile reset`                | 删除当前 overlay 并重新激活 profile                                             |
| `/profile create`               | 选择 global 或 project catalog 后创建 profile                                   |
| `/profile edit <name>`          | 编辑 profile；编辑活动 profile 时保存后立即重新激活                             |
| `/profile delete <name>`        | 删除 profile；删除活动 profile 前必须先选择替代 profile                         |
| `/profile resource list`        | 列出 resource registry 条目                                                     |
| `/profile resource create`      | 创建 extension resource 条目                                                    |
| `/profile resource edit <id>`   | 编辑 resource registry 条目                                                     |
| `/profile resource delete <id>` | 删除未被 profile 或 resource 依赖引用的条目                                     |
| `/profile reload`               | 重新扫描 registry、catalog、adapter MCP server 和所有引用资源后激活当前 profile |

CRUD 只在 TUI mode 提供。RPC、print 和 JSON mode 可以通过 `pi-profile <profile> -- <Pi 参数>` 启动目标 profile，但不提供交互式 catalog 编辑。

创建 profile 时，TUI 必须明确询问写入 global 还是 project catalog。编辑现有 profile 与持久 active selection 时，写入最终解析 profile 的来源 scope。

`/profile customize` 修改 runtime overlay；不写 profile catalog。`/mcp enable` 与 `/mcp disable` 直接修改当前 profile 所属 catalog 的 `mcp` 数组；保存后执行 MCP runtime reload。

CRUD 向导打开后，外部编辑器或另一 Pi 实例对 catalog 的修改不会阻止保存。当前向导内容直接覆盖文件。

### System prompt

profile 的 `instructions` 追加到 Pi 已构建的 system prompt 末尾。Pi 的默认 system prompt、AGENTS.md、项目 context 和其他 extension 指令继续生效。

非 `default` profile 选择 skills 时，模型与 `/skill:` 命令只看到该 profile 解析出的 skills。SkillRegistry 仍扫描并维护全量可引用 skill 集。

## 通用规则

### 默认行为优先

`pi-profile` 只改变 profile 明确要求改变的行为：

- `default` 加载 Pi 的全量可发现资源。
- profile 未声明 `model` 时，保持当前 Pi model。
- profile 未声明 `thinkingLevel` 时，保持当前 Pi thinking level。
- profile 未声明 `instructions` 时，不追加 profile 指令。
- 所有未被 profile 选择逻辑覆盖的 Pi 设置继续按 Pi 默认规则工作。

### Profile 与资源维护

- skills 是共享实现，不复制到 profile 目录。
- extension 的发现优先于注册：已安装包与标准目录散装文件直接可引用；resource registry 只承担覆盖与标准位置外 extension 的 ID 注册。
- profile 使用包名、散装文件名、路径、resource ID、MCP server name、tool name 和 skill name 引用能力，不引用实现副本。
- profile 不保存 MCP server 地址、启动命令、OAuth 配置或凭证；这些配置由 `pi-mcp-adapter` 管理。
- glob 是动态引用；每次 reload 都可能扩展或缩小实际能力集。
- profile 不支持多 profile 叠加；临时差异使用 runtime overlay。

### 运行模式

| 模式                      | 初始 profile                | CRUD          | 状态详情                                                          |
| ------------------------- | --------------------------- | ------------- | ----------------------------------------------------------------- |
| `pi`                      | `default`                   | Pi 原生行为   | Pi 原生行为                                                       |
| `pi-profile` TUI          | 保存的 profile 或 `default` | 完整 TUI CRUD | 显示 profile、overlay、resource 路径、glob 差异与 MCP server 状态 |
| `pi-profile` RPC          | 位置参数或保存的 profile    | 不提供        | 结构化非交互状态                                                  |
| `pi-profile` print / JSON | 位置参数或保存的 profile    | 不提供        | 普通 Pi 输出与诊断                                                |

## 验收标准

### Unit tests

- Pi discovery 结果到 `SkillRegistry` 的同名优先级解析。
- project profile、resource registry 覆盖和删除后的全局回退。
- skills、resource ID、MCP server name 和 tool name 的 glob 展开与 reload 差异。
- extension 的发现优先引用：包名/别名、散装文件 stem、绝对路径均无需注册；多入口包的包级与入口级选择。
- 显式 registry 条目省略 `entry` 时继承隐式入口；无隐式匹配时大声失败。
- 散装文件与包名 ID 碰撞：散装胜出、记录 warning、包经别名可选。
- 未知 extension 字面量的错误含候选列表、did-you-mean 与注册示例；零匹配 glob 进入 `unmatched` 警告面。
- overlay 可以调整当前 profile 声明的资源引用，但不能关闭 `alwaysOn` extension 或其直接依赖。
- resource dependency 闭包与循环检测。
- `default` 的全量资源 plan。
- profile 未声明 model、thinking 和 instructions 时保持 Pi 当前状态。
- profile 引用了 adapter 未发现的 MCP server 名称时激活失败。
- profile 声明 `mcp` 但未安装 adapter 时激活失败；未声明 `mcp` 时正常激活。

### Integration tests

- `pi-profile review` 在第一个 agent turn 前只向模型暴露 `review` skills 与 resources。
- `/profile use implement` 不重启 Pi 进程，并在 reload 后替换 resources。
- skill 内容修改后，所有引用该 skill 的 profile 在 reload 后得到新内容。
- 项目 profile 覆盖全局 profile，删除项目条目后回退全局定义。
- `/mcp disable <server>` 写入当前 profile 的 `mcp` 数组，并在 reload 后移除该 server 的 tools。
- `/mcp enable <server>` 写入当前 profile 的 `mcp` 数组，并在 reload 后恢复该 server 的 tools。
- profile 切换只应用 runtime server allowlist，不修改 `.pi/mcp.json`。
- 未安装 `pi-mcp-adapter` 时，未声明 `mcp` 的 profile 正常激活。
- 同名 tool/command 冲突的最终结果与 Pi 的加载顺序一致。
- CLI 初始 profile 不写 runtime state；后续 `/profile use` 会写入正确来源 scope。

### TUI 验收

1. 在全局 skill 目录创建 `git-commit`。
2. 创建 `review` 与 `implement`，两者都引用 `git-commit`。
3. 用 `pi-profile review` 启动，确认模型只看到 `review` 引用的 skills。
4. 修改 `git-commit/SKILL.md` 并执行 `/profile reload`，确认两个 profile 都使用修改后的内容。
5. 执行 `/profile customize`，临时禁用当前 profile 声明的 skill 或 tool，再执行 `/profile reset` 恢复定义。
6. 在 `review` 中执行 `/mcp disable atlassian`，确认当前 profile 的 `mcp` 数组移除该名称，并在 reload 后该 server 的 tools 不可用。
7. 切换到 `implement`，确认其独立 `mcp` 数组不受 `review` 的禁用操作影响。
8. 退出后直接运行 `pi`，确认 `.pi/mcp.json` 中 adapter 原有启用状态未被 profile 切换修改。
