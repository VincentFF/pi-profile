# TUI 手动验收清单

全新用户可复现。前置条件：已安装 `pi` 与 `pi-profile-switch`（`pi install npm:pi-profile-switch` 或本仓库 `pi install ./`），有一个可用的模型 provider 配置；可选：已安装 `pi-mcp-adapter` 并在其配置中有名为 `atlassian` 的 server（步骤 7–8 需要）。

步骤 0 只有在 `~/.pi/agent/profiles.json` 不存在时才能复现；已有该文件时先备份并移走。

## 准备

```bash
# 1. 全局 skills：alpha-skill、beta-skill
mkdir -p ~/.pi/agent/skills/alpha-skill ~/.pi/agent/skills/beta-skill
printf -- '---\nname: alpha-skill\ndescription: Alpha\n---\n\nAlpha body v1.\n' > ~/.pi/agent/skills/alpha-skill/SKILL.md
printf -- '---\nname: beta-skill\ndescription: Beta\n---\n\nBeta body v1.\n' > ~/.pi/agent/skills/beta-skill/SKILL.md

# 2. 两个 profile（global catalog）
cat > ~/.pi/agent/profiles.json <<'EOF'
{
  "schemaVersion": 1,
  "profiles": {
    "review": { "skills": ["alpha-skill"], "mcps": ["atlassian"] },
    "implement": { "skills": ["beta-skill"], "mcps": ["atlassian"], "tools": ["read", "grep", "find", "ls"] }
  }
}
EOF
```

## 步骤

| # | 操作 | 预期 |
|---|------|------|
| 0 | 在空配置下第一次启动 `pi`（任意模式），退出后查看 `~/.pi/agent/profiles.json` | 文件被自动创建，内容为随包的 `read-only` profile；再次启动不改变文件；你自己写入的 catalog 不会被覆盖 |
| 3 | `pi --profile review` 启动，执行 `/profile status` | 报告 `review (global)`；`skills: 1 of 2 loaded`；`alpha-skill` 可见、`beta-skill` 不可见；footer 出现 `profile: review` |
| 4 | 在同一会话执行 `/skill:beta-skill` | 未选中的 skill 仍可被用户手动调用并注入内容（可见性只约束模型） |
| 5 | 编辑 `~/.pi/agent/skills/alpha-skill/SKILL.md`（改为 v2），再让模型读取该 skill 或执行 `/skill:alpha-skill` | 立即读到 v2；无需任何 reload 命令 |
| 6 | `/profile use implement` | MCP 选择变化时会看到一条 `MCP servers updated — reloading runtime` 提示；footer 变为 `profile: implement`；`/profile status` 显示 `implement`、`beta-skill` 可见、tools 为 `[read, grep, find, ls]`；session 延续（`/session` 的 id 与文件不变） |
| 7 | `/profile customize disable skill beta-skill`，随后 `/profile reset` | disable 后 status 显示 overlay 且 footer 变为 `profile: implement*`，`beta-skill` 不可见；reset 后恢复定义且 `*` 消失；catalog 文件从未被修改 |
| 8 | `/mcp disable atlassian` | `~/.pi/agent/profiles.json` 的 `implement.mcps` 数组移除该名；status 显示 `enabled=[]`；`~/.pi/agent/mcp.json` 里该 server 被标 `disabled`（生成文件），你的 server 定义在 `~/.pi/agent/mcp.user.json` |
| 9 | 退出后用 `pi --profile default` 启动 | 行为与原生 Pi 一致：全部 skills 可见，`/profile status` 显示 `default (builtin)`，footer 与纯 Pi 相同（无状态行、无 badge） |
| 10 | `/profile use ghost`（不存在的名字） | 报 unknown profile 与候选列表；footer 仍是上一个成功激活的 `profile: <name>` |
| 11 | 给两个 profile 分别声明 `mcps: ["atlassian"]` 与 `mcps: []`，来回切换后检查 MCP 工具面 | 只有白名单里的 server 连接并暴露工具；空数组时全部 server 不可用（adapter 网关调用被拒） |
| 12 | 查看 `~/.pi/agent/mcp.json` 与 `~/.pi/agent/mcp.user.json` | 前者是生成物（含 `piProfileSwitch` 标记），后者是你自己的 server 定义；把 sidecar 覆盖回 `mcp.json` 并删除 sidecar 即完全还原 |
| 13 | 把某个 profile 的 `mcps` 键手写改回旧名 `mcp`，启动该 profile 后执行 `/mcp enable <已发现的 server>` | 旧键仍按 MCP 白名单生效；一次保存后文件中该键变为 `mcps`，旧键消失 |

任一步失败：收集 `pi --debug` 日志与 `~/.pi/agent/profiles.json`、`~/.pi/agent/pi-profile-state.json`，对照 `docs/architecture/overview.md` 的错误语义排查（解析错误必须响亮并指明文件）。
