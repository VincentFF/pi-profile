# TUI 手动验收清单

PRD 的 8 步验收流程，全新用户可复现。前置条件：已安装 `pi` 与 `pi-profile`（`npm i -g pi-profile` 或本仓库 `npm link`），有一个可用的模型 provider 配置；可选：已安装 `pi-mcp-adapter` 并在其配置中有名为 `atlassian` 的 server（步骤 6–8 需要；两个 profile 的 `mcp` 数组都在准备阶段声明该 server——`/mcp disable` 只从数组移除，没有数组时是无操作）。没有 adapter 时换成任意已发现的 server 名，并相应修改两个数组。

## 准备

```bash
# 1. 全局 skill：git-commit
mkdir -p ~/.pi/agent/skills/git-commit
cat > ~/.pi/agent/skills/git-commit/SKILL.md <<'EOF'
---
name: git-commit
description: Commit helper
---

Commit helper body v1.
EOF

# 2. 两个 profile 都引用 git-commit（global catalog）
cat > ~/.pi/agent/profiles.json <<'EOF'
{
  "schemaVersion": 1,
  "profiles": {
    "review": { "skills": ["git-commit"], "mcps": ["atlassian"] },
    "implement": { "skills": ["git-commit"], "mcps": ["atlassian"] }
  }
}
EOF
```

## 步骤

| # | 操作 | 预期 |
|---|------|------|
| 3 | `pi-profile review` 启动，问模型 `/profile status` 或直接观察 | 只有 `review` 声明的 skills 可见（`/profile list` 中 `review ← active`）；模型第一个 turn 起只暴露 `git-commit` |
| 4 | 编辑 `~/.pi/agent/skills/git-commit/SKILL.md`（改 body 为 v2），执行 `/profile reload` | reload 后新内容生效；`/profile use implement` 后同样读到 v2（引用同一文件，非复制） |
| 5 | `/profile customize disable skill git-commit`，再 `/profile status`，然后 `/profile reset` | disable 后 skill 消失（overlay 出现在 status）；reset 后恢复定义（overlay 消失），catalog 文件从未被修改 |
| 6 | 在 `review` 中 `/mcp disable atlassian` | `~/.pi/agent/profiles.json` 的 `review.mcp` 数组移除该名；reload 后该 server 的 tools 不在活动集 |
| 7 | `/profile use implement` | `implement` 的 `mcp` 数组不受步骤 6 影响；其声明的 servers 正常 |
| 8 | 退出后直接运行 `pi` | adapter 的 `.pi/mcp.json` 原有启用状态未被任何切换修改 |

全部通过即验收完成。任一步失败：收集 `~/.pi/agent/pi-profile/runtime/launch-*/` 下的 `settings.json` 与 `pi-profile.json`、会话 stderr，对照 `docs/architecture/overview.md` 的失败语义排查（所有解析/注册表错误都应响亮失败并指明文件）。
