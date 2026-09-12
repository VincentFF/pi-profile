# pi-profile

Pi 的命名 profile 扩展。一个 profile 引用一组已存在的 skills、extensions、MCP server 和 tools，并在同一 Pi 进程内切换这些引用，无需重启。

- 用户直接拥有并维护自己的 profile；profile 引用资源，从不复制资源。
- 不增加白名单、审批层或额外定制开关；只有影响 Pi 正常运行或安全边界的行为才受限制。
- 本仓库同时维护作者的 pi skills 集合（`.agents/skills/`，由 `skills-lock.json` 锁定来源）。

## 使用

```bash
# 原生 Pi：总是使用内建 default profile（全量资源）
pi

# pi-profile host：使用上次保存的 profile；不存在时使用 default
pi-profile

# 本次启动使用指定 profile；之后可用 /profile use 保存选择
pi-profile review

# 第一个 -- 后面的参数原样传给 pi
pi-profile review -- --model openai/gpt-5.4
```

## 文档

- 产品需求：[docs/product/prd.md](docs/product/prd.md)
- 架构设计：[docs/architecture/overview.md](docs/architecture/overview.md)
- 术语表（英文，agent 用）：[CONTEXT.md](CONTEXT.md)
- 架构决策记录：[docs/adr/](docs/adr/)

## 状态

设计已完成，产品代码尚未实现。
