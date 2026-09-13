# TUI 手动验收清单

全新用户可复现。前置条件：已安装 `pi` 与 `pi-profile`（`pi install npm:pi-profile` 或本仓库 `pi install ./`），有一个可用的模型 provider 配置；可选：已安装 `pi-mcp-adapter` 并在其配置中有名为 `atlassian` 的 server（步骤 7–8 需要）。

## 准备

```bash
# 1. 全局 skills：alpha-skill、beta-skill
mkdir -p ~/.pi/agent/skills/alpha-skill ~/.pi/agent/skills/beta-skill
printf -- '---\nname: alpha-skill\ndescription: Alpha\n---\n\nAlpha body v1.\n' > ~/.pi/agent/skills/alpha-skill/SKILL.md
printf -- '---\nname: beta-skill\ndescription: Beta\n---\n\nBeta body v1.\n' > ~/.pi/agent/skills/beta-skill/SKILL.md

# 2. 两个 profile（global catalog）
cat > ~/.pi/agent/profiles.json <<'EOF'
{
  "schemaVersion": 2,
  "profiles": {
    "review": { "skills": ["alpha-skill"], "mcp": ["atlassian"] },
    "implement": { "skills": ["beta-skill"], "mcp": ["atlassian"], "tools": ["read", "grep", "find", "ls"] }
  }
}
EOF
```

## 步骤

| # | 操作 | 预期 |
|---|------|------|
| 3 | `pi --profile review` 启动，执行 `/profile status` | 报告 `review (global)`；`skills: 1 of 2 loaded`；`alpha-skill` 可见、`beta-skill` 不可见 |
| 4 | 在同一会话执行 `/skill:beta-skill` | 未选中的 skill 仍可被用户手动调用并注入内容（可见性只约束模型） |
| 5 | 编辑 `~/.pi/agent/skills/alpha-skill/SKILL.md`（改为 v2），再让模型读取该 skill 或执行 `/skill:alpha-skill` | 立即读到 v2；无需任何 reload 命令 |
| 6 | `/profile use implement` | 无 reload 提示；`/profile status` 显示 `implement`、`beta-skill` 可见、tools 为 `[read, grep, find, ls]`；session 延续（`/session` 的 id 与文件不变） |
| 7 | `/profile customize disable skill beta-skill`，随后 `/profile reset` | disable 后 status 显示 overlay 且 `beta-skill` 不可见；reset 后恢复定义，catalog 文件从未被修改 |
| 8 | `/mcp disable atlassian` | `~/.pi/agent/profiles.json` 的 `implement.mcp` 数组移除该名；status 显示 `enabled=[]`；adapter 的 `mcp.json` 未被修改 |
| 9 | 退出后用 `pi --profile default` 启动 | 行为与原生 Pi 一致：全部 skills 可见，`/profile status` 显示 `default (builtin)` |

任一步失败：收集 `pi --debug` 日志与 `~/.pi/agent/profiles.json`、`~/.pi/agent/pi-profile-state.json`，对照 `docs/architecture/overview.md` 的错误语义排查（解析错误必须响亮并指明文件）。
