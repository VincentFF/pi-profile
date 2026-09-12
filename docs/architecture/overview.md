# pi-profile 架构设计

## 范围

本文定义 `pi-profile` 的内部设计：总体结构、模块接口、数据契约、激活流程与包结构。产品目标、用户可见语义与验收标准见 `docs/product/prd.md`；关键决策的动机见 `docs/adr/`。

## 总体架构

```text
                         ┌─────────────────────────────┐
                         │       pi-profile CLI         │
                         │  initial profile + Pi args   │
                         └──────────────┬──────────────┘
                                        │
                         ┌──────────────▼──────────────┐
                         │        ProfileHost           │
                         │ Pi SDK runtime + TUI/RPC/CLI │
                         └──────────────┬──────────────┘
                                        │
┌───────────────────────────────────────▼───────────────────────────────────────┐
│                              pi-profile extension                              │
│ commands · selector · CRUD · profile instructions · runtime switch status      │
├────────────────────────────────────────────────────────────────────────────────┤
│ ProfileCatalog │ ResourceRegistry │ SkillRegistry │ RuntimeStateStore          │
│ ProfileResolver│ ResourceFilterAdapter │ McpIntegration │ RuntimeApplier       │
└─────────┬──────────────┬──────────────────┬──────────────────┬─────────────────┘
          │              │                  │                  │
          ▼              ▼                  ▼                  ▼
   catalog files   Pi discovery result   ResourceLoader    pi-mcp-adapter runtime
```

Pi 的公开 Extension API 没有启动前的 resource-filter seam，因此初始 profile 选择由 `pi-profile` 启动器在 Pi runtime 创建前完成，而不是 `pi --profile` 参数（见 `docs/adr/0001-launcher-based-initial-profile-selection.md`）。

`pi-profile` 的外部 interface 是 CLI、`/profile` 命令、catalog schema 与 resource registry schema。资源扫描、scope 解析、glob 展开、依赖闭包、资源过滤、Pi SDK runtime 重建、MCP runtime 过滤、回滚和状态展示都在内部完成。

## 模块与接口

### `ProfileCatalog`

**Interface**：读取、列出、创建、编辑、删除 global 与 project `Profile`。

**Implementation**：解析 JSON、按项目优先级选择同名 profile、为 CRUD 向导提供可编辑模型。

**Rules**：

- `default` 不存在于文件中，不能删除。
- 项目同名 profile 完整替换全局 profile。
- 删除项目覆盖 profile 后，立即暴露全局同名 profile。
- 删除活动 profile 前必须先完成替代 profile 选择。
- `/mcp enable` 与 `/mcp disable` 修改当前 profile 的 `mcp` 数组，不修改 MCP 连接配置。

### `ResourceRegistry`

**Interface**：用逻辑 ID 解析 extension 入口，返回依赖闭包。

**Implementation**：合并 global 与 project `resources.json`，项目同名 ID 覆盖全局 ID，递归解析 `dependsOn`。

**Rules**：

- ID 必须稳定且唯一。
- 环形依赖、缺失入口和缺失依赖使 profile 无法激活。
- `alwaysOn` resource 总是进入 ActivationPlan。
- 依赖闭包不排序 extension；最终顺序由 Pi 的资源加载流程决定。

### `McpIntegration`

**Interface**：发现 `pi-mcp-adapter` 是否安装，读取 adapter 的 server registry，应用 runtime server allowlist，并接收 `/mcp enable` 与 `/mcp disable` 的启用集合变更。

**Implementation**：锁定支持 profile-scoped state store 的 `pi-mcp-adapter` 约定版本。adapter 的 `/mcp` 命令与面板通过该 store 写入当前 profile，而不是默认的 `.pi/mcp.json` 覆盖层。

**Rules**：

- adapter 未安装且当前 profile 未声明 `mcp` 时，不注册 MCP 集成。
- adapter 未安装且当前 profile 声明 `mcp` 时，profile 激活失败并提示缺少 `pi-mcp-adapter`。
- `default` profile 在未声明 `mcp` 时使用 adapter 当前发现与启用的全量 server。
- profile 切换只应用内存中的 server allowlist，不调用 adapter 的持久化 enable/disable 实现。
- `/mcp enable` 只接受 adapter 已发现的 server 名称。
- `/mcp disable` 可以移除 profile 引用的缺失 server 名称。
- 缺失 server 名称阻止 profile 激活。
- server 连接、OAuth、token、重连与工具注册由 `pi-mcp-adapter` 负责。

### `SkillRegistry`

**Interface**：输入 Pi 当前完整 discovery 结果，输出 skill name、最终 `SKILL.md`、source 与 source scope。

**Implementation**：使用与 Pi 一致的 discovery 与优先级，不重新定义同名 skill 的胜出规则。

**Rules**：

- profile 引用每次启动或 reload 都重新解析。
- glob 重新展开，新增匹配项自动进入 ActivationPlan。
- status 必须显示解析后的绝对路径和与上次 plan 的差异。

### `ProfileResolver`

**Interface**：输入 profile、registry、skills、可选 MCP server registry、overlay 和项目 trust，输出不可变 `ActivationPlan`。

**Implementation**：展开 skill/resource/MCP/tool glob，应用 overlay，合并 `alwaysOn` 与依赖闭包，解析 profile source scope。

**Rules**：

- 一个 plan 对应一个 profile 和一个 overlay。
- overlay 可以调整当前 profile 声明的资源引用，但不能关闭 `alwaysOn` extension 或其直接依赖。
- 未声明的模型、thinking 或 instructions 不修改 Pi 默认行为。
- 不可信项目不读取项目 catalog、registry 或 state。

### `ResourceFilterAdapter`

**Interface**：把 `ActivationPlan` 转换为 Pi SDK `DefaultResourceLoader` 的 extensions 与 skills 过滤结果。

**Implementation**：ProfileHost 创建 Pi runtime 前扫描 Pi 全量资源，再通过 ResourceLoader override 保留 selected skills、selected extensions、`alwaysOn` resources 和 Pi 基础资源。

**Rules**：

- `default` 不过滤 Pi 可发现资源。
- 非 `default` profile 中未注册且未选中的 extension 不加载。
- profile 选择的 skills 是模型和 `/skill:` 命令唯一可见的 skills。
- Host 使用受控 loader，不改写用户原始 Pi settings。

### `RuntimeApplier`

**Interface**：`activate(plan)`、`reload(plan)`、`rollback(previousPlan)`。

**Implementation**：等待 agent idle，重建 ResourceLoader runtime，向 `McpIntegration` 应用 server allowlist，设置活动 tools、可选模型与 thinking，并更新 TUI 状态。profile 的 `instructions` 在 `before_agent_start` 中追加到 Pi 已构建的 system prompt 末尾。

**Rules**：

- tools 由 Pi 全局 tool name 选择。
- tool/command 名称冲突沿用 Pi 行为；status 展示结果。
- profile 资源变化必须 reload；只变更已激活 tools、模型、thinking 或 instructions 时可直接生效。
- `/mcp enable` 与 `/mcp disable` 写入当前 profile 后执行 MCP runtime reload，使被禁用 server 的 tools 从活动集合中移除。
- 激活失败时恢复上一个已验证的 ActivationPlan。
- reload 后不使用旧 extension context 或旧 command context。

## 数据契约

### `profiles.json`

```json
{
  "schemaVersion": 1,
  "profiles": {
    "review": {
      "label": "Code review",
      "description": "Review code and issue context without changing files.",
      "skills": ["code-review", "git-commit"],
      "extensions": ["review-guard", "github-*"],
      "mcp": ["github-ro", "atlassian"],
      "tools": ["read", "grep", "find", "ls", "search_issues"],
      "model": {
        "provider": "openai-codex",
        "id": "gpt-5.4",
        "thinkingLevel": "high"
      },
      "instructions": "Review the requested change. Do not edit files unless the user explicitly asks for a patch."
    },
    "implement": {
      "label": "Implementation",
      "skills": ["git-commit"],
      "extensions": ["review-guard", "github-tools"],
      "tools": ["read", "bash", "edit", "write", "search_issues"],
      "instructions": "Implement the requested change, then run the relevant verification."
    }
  }
}
```

覆盖、继承与可选字段语义见 `docs/product/prd.md` 的配置范围。

### `resources.json`

```json
{
  "schemaVersion": 1,
  "resources": {
    "review-guard": {
      "kind": "extension",
      "entry": "/opt/pi-resources/review-guard/index.ts",
      "alwaysOn": true
    },
    "github-tools": {
      "kind": "extension",
      "entry": "/opt/pi-resources/github-tools/index.ts",
      "dependsOn": ["review-guard"]
    }
  }
}
```

`entry` 指向已安装的 extension 入口。`kind` 固定为 `extension`；MCP 能力不通过 `resources.json` 声明。`dependsOn` 只决定依赖闭包，不改变 Pi 的最终 extension 加载顺序。

### `pi-profile-state.json`

```json
{
  "schemaVersion": 1,
  "activeProfile": "review",
  "overlay": {
    "disabledSkills": ["git-commit"],
    "disabledExtensions": [],
    "disabledMcp": ["atlassian"],
    "tools": ["read", "grep", "find", "ls", "search_issues"]
  },
  "lastVerifiedProfile": "review"
}
```

runtime overlay 可以临时修改当前 profile 声明的 `skills`、`extensions`、`mcp` 和 `tools`。它不能关闭 `alwaysOn: true` 的 extension，也不能移除其直接依赖的 resource。

## 激活流程

```text
/profile use review
  │
  ├─ ProfileCatalog 解析 review 的最终来源
  ├─ SkillRegistry 镜像当前 Pi discovery
  ├─ ResourceRegistry 解析 resource ID、glob 与 dependsOn
  ├─ McpIntegration 读取 adapter 发现的 server 名称
  ├─ ProfileResolver 生成 ActivationPlan
  ├─ 校验模型认证、入口、依赖、overlay、MCP server 与 project trust
  ├─ 保存来源 scope 的 runtime state
  ├─ 等待 agent idle
  ├─ ProfileHost 重建受过滤的 ResourceLoader runtime
  │    ├─ 旧 extensions: session_shutdown
  │    ├─ 新 extensions 与 skills 加载
  │    ├─ McpIntegration 应用本次 runtime 的 server allowlist
  │    └─ RuntimeApplier 设置 tools、model、thinking
  ├─ 成功：记录 lastVerifiedProfile，更新 TUI status
  └─ 失败或 Escape：回滚上一个已验证 ActivationPlan
```

当 `pi-profile review` 启动时，ProfileHost 在创建 Pi runtime 前执行相同流程。初始 profile 选择只作用于该进程；它不把 `review` 保存为活动 profile。对话中的 `/profile use` 会保存活动 profile；`/mcp enable|disable` 会持久修改当前 profile 的 `mcp` 数组。

## Package 结构

```text
pi-profile/
├── package.json
├── README.md
├── bin/
│   └── pi-profile.ts             # 位置参数解析与 ProfileHost 启动
├── extensions/
│   └── pi-profile/
│       └── index.ts              # /profile、TUI、instructions、状态
├── src/
│   ├── profile-host.ts
│   ├── profile-catalog.ts
│   ├── resource-registry.ts
│   ├── mcp-integration.ts
│   ├── skill-registry.ts
│   ├── profile-resolver.ts
│   ├── resource-filter-adapter.ts
│   ├── runtime-applier.ts
│   ├── runtime-state-store.ts
│   └── tui/
│       ├── profile-selector.ts
│       ├── profile-editor.ts
│       └── resource-editor.ts
├── schemas/
│   ├── profiles.schema.json
│   └── resources.schema.json
├── test/
│   ├── profile-resolver.test.ts
│   ├── mcp-integration.test.ts
│   ├── skill-registry.test.ts
│   ├── resource-filter-adapter.test.ts
│   └── profile-host.integration.test.ts
└── examples/
    ├── profiles.json
    └── resources.json
```

`package.json` 同时声明 Pi extension 和 `pi-profile` binary。extension 提供对话内 runtime 交互；binary 在 Pi runtime 创建前提供初始 profile 选择与严格资源过滤。
