# Discovery-first extension references spec

**Superseded by [ADR-0007](../../adr/0007-pure-extension-runtime.md).** Extensions are no longer a profile resource: every installed extension loads natively, so extension references, `resources.json`, `ResourceRegistry`, dependency closures, and `alwaysOn` do not exist. Kept for history.

Status: done

## Problem Statement

旧模型下，profile 引用 extension 前必须先在 `resources.json` 里注册逻辑 ID，且注册要求手写指向包内部文件的**绝对路径**。这带来三层摩擦：

1. 双文件心智负担：加一个 extension 要动两个文件，用户必须先理解"逻辑 ID"这个 pi-profile 自创概念。
2. 注册内容脆弱：entry 绝对路径要求用户翻 `node_modules` 找入口，换机器或 home 迁移即断——而这条信息 Pi 自己已经知道（`pi packages` 列表 + 包内 `package.json#pi.extensions`）。
3. 失败反馈不可行动：字面量 ID 未注册时激活失败但错误文案无修复指引；glob 引用零匹配则完全静默成功，extension 没加载用户毫无察觉。

这与 skills 的零注册模型（SkillRegistry 只读消费 Pi discovery）不对称，违反仓库两条设计原则（AGENTS.md）：不改 Pi 默认行为、用户体验优先。

## Solution

发现优先，注册降级为 override：

- **隐式发现**（`src/extension-discovery.ts`，只读、不执行扩展代码）：
  - 已配置 user 包：读 `package.json#pi.extensions` 声明的入口文件，包名即可引用名；`npm:<name>` 源字符串作为别名。
  - 散装文件：`<agentDir>/extensions/*.{ts,js}` 与已信任项目的 `.pi/extensions/*.{ts,js}`，文件名 stem 即 ID；项目覆盖同名全局。
- **显式 registry**（`resources.json`）合并于隐式层之上：同 ID 显式条目覆盖隐式条目；`entry` 可省略以继承隐式条目的入口（`alwaysOn`/`dependsOn` 覆盖不再需要复制路径）。registry 只剩三种用途：标准位置外的 extension 发 ID、声明 `alwaysOn`/`dependsOn`、覆盖隐式推导。
- **引用解析**（`ResourceRegistry.select()`）：字面量按 registry ID → 包名/别名 → 磁盘路径的顺序解析；路径引用（绝对或 `~/`）产生 ad-hoc 条目，绕过依赖闭包。未知字面量报错包含：已发现候选列表（截断 10 条）、相近名 did-you-mean、最小注册示例。glob 匹配 selectable names（条目 ID ∪ 包名），零匹配进入 `plan.unmatched`，经 launcher warnings 与 `/profile status` 可见。
- **碰撞规则**：散装文件 stem 与包名碰撞时散装文件赢得该 ID 并记录 warning；包仍可通过 source 别名选中。

## 命名规则

- 单入口包：条目 ID = 包名（如 `pi-mcp-adapter`）。
- 多入口包：每个入口 ID = `<包名>:<相对路径>`（如 `pi-multi:panel.ts`）；包名选中全部入口。
- 散装文件：ID = 文件名去扩展名；同 stem 的 `.ts`/`.js` 对取 `.ts`。
- `dependsOn` 与 overlay 的 `disabledExtensions` 按条目 ID 引用；多入口包没有以包名为键的 map 条目，依赖需指向具体条目 ID。

## User Stories

1. 作为用户，我希望 `"extensions": ["pi-mcp-adapter"]` 在包已安装时直接生效，无需创建或编辑 `resources.json`。
2. 作为用户，我希望引用 `~/.pi/agent/extensions/conventions.ts` 时写 `"conventions"` 或绝对路径即可。
3. 作为用户，我希望引用不存在时错误告诉我：发现了哪些候选、是不是拼写错误、需要注册时最小写法是什么。
4. 作为用户，我希望 glob 打错字（零匹配）在启动警告和 `/profile status` 中可见，而不是静默漏加载。
5. 作为高级用户，我希望仅写 `{ "pi-web-access": { "kind": "extension", "alwaysOn": true } }` 即可把已安装包标记为常驻，不复制入口路径。
6. 作为高级用户，我希望标准目录外的团队共享 extension 仍可通过 `resources.json` 注册稳定 ID。

## Acceptance Criteria

- 未注册情况下：包名、`npm:` 别名、散装 stem、绝对路径四种引用均可激活（unit：registry.select / resolveProfile）。
- 多入口包包名选中全部入口；单条目可按 `<name>:<rel>` 选中。
- 显式条目省略 `entry` 且匹配隐式条目时继承入口；无隐式匹配的悬空 override 延迟到引用时大声失败（非 alwaysOn 仅警告，不拖累无关 profile；alwaysOn 加入每个闭包，fail-closed）。
- 散装/包 ID 碰撞：散装胜出、记录 warning、包可经别名选中。
- 未知字面量错误含候选列表、did-you-mean 与注册示例；相对路径引用报专属错误。
- 零匹配 glob 进入 `plan.unmatched`、启动 warnings 与 `/profile status`；tool glob 不警告（扩展贡献的 tool 在 spawn 前不可知，误报比漏报更糟）。
- 未信任项目的 `.pi/extensions` 与 `.pi/resources.json` 从不被读取。
- schema：`entry` 不再 required；示例文件通过校验。

## Out of Scope

- `/profile resource list` 仍只列显式条目（隐式发现结果经错误指引与 status 可见；列表合并展示留作后续）。
- git:/github:/本地路径源的包按同一机制处理（root 可解析即可），不为它们引入额外语义。
- Pi 的 extensions 目录加载子目录形态（含 index 的目录）不做隐式发现——仅文件。

## Comments

- 2026-09-13 实现完成：代码（extension-discovery.ts 新增；resource-registry.ts / profile-resolver.ts / discovery.ts / initial-profile.ts / settings-generator.ts / apply-plan.ts / status.ts / resource-registry-store.ts / resource-crud.ts 修改；schema 与 examples 更新）+ 测试（新增 extension-discovery.test.ts 与 registry/resolver 用例；全套 42 文件 327 测试通过，`tsc --noEmit` 干净）。配套文档：ADR-0006、PRD 资源引用一节、架构 ResourceRegistry 契约、CONTEXT.md 术语。
