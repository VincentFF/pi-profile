# TUI profile badge spec

Status: done

## Problem Statement

profile 激活后，TUI 里没有任何常驻标识回答"这个会话现在跑的是哪个 profile"：

- `/profile status` 需要手动执行，返回的是详情（skills 计数、tools、MCP 三态、unresolved），不适合做身份确认。
- 切换在同一 session 内原位发生（ADR-0007），既没有 reload 也没有新进程，因此启动横幅和命令行参数都不再能说明当前身份。
- `/profile customize` 产生的 runtime overlay 会改变模型实际看到的能力，但它只在 `/profile status` 与 state 文件里可见；日常使用中容易忘记自己正在跑一个被收窄的 profile。

## Solution

在 Pi 的 footer status line 上显示一行常驻 badge：

```
profile: review        非 default profile 生效
profile: review*       该 runtime 另有 overlay（runtime ≠ catalog）
（不显示）             default —— Pi 原生基线
```

三条产品规则：

1. **一个权威字符串**：`profile: <name>`，与 `/profile status` 的 `### profile: <name> (<source>)` 同形；`*` 表示 overlay。
2. **只反映已应用的运行时状态**：badge 由扩展内唯一的运行时状态 `current` 派生，而 `current` 只在激活成功后才更新（`activateProfile` 失败时抛错，`setCurrent` 不会被调用）。因此 badge 永远不会声称一个没被应用的 profile。
3. **default 不改变 footer**：`default` 什么都不声明，因此也不该改变 footer。footer status line 只有在至少存在一个扩展状态时才渲染，所以不写 badge 时原生会话的 footer 与纯 Pi 完全一致。

## 设计

### 表面：`ctx.ui.setStatus`

| 依据（Pi 0.85.1） | 影响 |
| --- | --- |
| footer 把所有扩展状态拼成**独立一行**，空格连接，按 key 字母序排序 | key 取 `profile`：字母序早于 `mcp`、`pi-…`，窄终端从右侧截断时最后才轮到本 badge |
| 整行按终端宽度右侧截断 | 名字必须自己截断（见下） |
| `setStatus(key, undefined)` 删除条目；无条目时该行不存在 | 隐藏 badge 不占行（产品规则 3 的实现基础） |
| 状态字符串按原样渲染，颜色由扩展在设置时写入 | 渲染时取 `ctx.ui.theme`，见"主题" |
| `ctx.hasUI`：TUI 与 RPC 为 `true`，print/JSON 为 `false` | 无 UI 模式不调用；RPC 发 fire-and-forget 的 `extension_ui_request`，客户端可忽略 |

不替换 Pi 自带 footer（`setFooter`/`setHeader`）、不占用编辑器上下的常驻行（`setWidget`）、不接管终端标题（`setTitle` 已被 Pi 用于 `pi - <session name> - <cwd>`）。这些都会改动 Pi 的原生界面，违反"Pi 兼容优先"。

已知风险：status key 是全局命名空间，另一个扩展也用 `profile` 时会互相覆盖（Pi 没有读回状态的 API）；`profile` 按惯例已是本包的名字，先按此约定。

### 宽度预算

footer 是一条所有扩展共享的定宽行，而 profile 名是用户输入（schema 不限制长度，可以是 CJK）。`buildProfileBadge` 因此把名字截到 **16 列**（`PROFILE_BADGE_NAME_COLUMNS`），用 `…` 结尾，宽度按 East Asian wide/fullwidth 记 2 列计算。避免一个超长名字把 `pi-mcp-adapter` 等扩展的状态挤出屏幕。

### 单一写入点

```
activateProfile 成功 ─┐
customize/reset 成功 ─┼─→ setCurrent(ctx, activationOf(result)) ─→ refreshBadge(ctx) ─→ setStatus
session_start 开始 ───┘（先清空）
```

- `setCurrent` 是 `current` 的唯一写入者，`refreshBadge` 是 `setStatus` 的唯一调用者：`current` 与 badge 不可能不一致。
- `ActivationResult` 新增 `overlay` 字段：`/profile customize` 与 `/profile reset` 也把**实际应用的** overlay 交给 badge，不必再读一次 state 文件。
- `overlayNarrows()` 定义"是否有实际差异"：`disabledSkills`/`disabledMcp` 为空、或 overlay 为空对象时不算差异，`tools: []` 算（它选择"没有工具"）。

### 主题

Pi 没有面向扩展的主题变更事件，而 footer 状态是渲染完成的字符串，因此颜色会在 `/theme` 切换后过期。`before_agent_start` 每轮调用一次 `refreshBadge`：`badgeText` 缓存让未变化的渲染完全不产生 `setStatus` 调用（RPC 下不产生噪声），主题变化则在下一轮自愈。

## 验收标准

### Unit

- `default` 没有 badge（包括手写 state 里带 overlay 的 `default`）。
- 渲染结果固定为 `profile: <name>`，overlay 时追加 `*`；颜色在渲染时向 theme 索取。
- 超过 16 列的名字被截断且总宽不超过预算；CJK/全角字符按 2 列计；`columns <= 0` 返回空串。
- `overlayNarrows`：`undefined`、`{}`、全空数组为 false；非空 `disabled*` 与 `tools`（含 `[]`）为 true。

### Integration（真实 `pi --mode rpc`）

- 启动时 state 指向 `review`：RPC 流中出现 `statusKey: "profile"` 的 `setStatus`，去掉 ANSI 后文本为 `profile: review`。

### 手动（`docs/acceptance.md`）

- 非 default profile 启动后 footer 出现 `profile: <name>`；`/profile use` 后立即更新。
- `/profile customize …` 后出现 `*`，`/profile reset` 后消失。
- `pi --profile default` 与无 state 启动：footer 与原生 Pi 完全一致（没有状态行）。
- `/profile use <不存在的名字>` 失败后 badge 保持原值。

## Out of Scope

- 在 badge 上显示 skills 计数、tools、MCP 三态（属于 `/profile status`，会让定宽行抖动）。
- 显示 source scope（global/project）与 `label`：前者是罕见歧义，后者不是 `/profile use` 接受的名字。
- 开关 badge 的配置项（生态里 `pi-mcp-adapter` 有 `mcpFooterStatus: "off"` 的先例；先不加配置面）。
- 快捷键轮换 profile。
- TUI 自动化测试（badge 的 TUI 呈现仍走手动清单）。

## 文档影响

| 文件 | 变化 |
| --- | --- |
| `src/profile-badge.ts` | 新增：badge 构造、渲染、列宽截断 |
| `src/switching/activate-profile.ts` | `ActivationResult` 增加 `overlay` |
| `src/runtime-state-store.ts` | 新增 `overlayNarrows` |
| `extensions/pi-profile-switch/index.ts` | `setCurrent`/`refreshBadge`/`activationOf`，`before_agent_start` 每轮刷新 |
| `docs/acceptance.md` | 手动清单增加 badge 预期 |
| `README.md`、`README.zh-CN.md` | 命令章节说明 badge |
| `CONTEXT.md` | 新增 Profile badge 词条 |

## Comments

2026-09-13 — implemented on `feat/tui-profile-badge`；`npm run check` 干净，`npm test` 20 个测试文件 210/210 通过，其中包含真实 `pi --mode rpc` 的 badge 集成用例。
