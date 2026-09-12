# dsh-memento-tab

> 给 DeepSeek Harness 的 **会话级记忆 tab** —— 挂在「对话 / 轨迹 / 上下文」旁边。

[`dsh-memento`](https://www.npmjs.com/package/dsh-memento) 的**伴随插件**，不是它的 fork。
它只消费上游公开的 `ctx.memory` 接缝，自己注册路由、自己注册 tab，所以上游发版永远不会
产生合并冲突 —— 上游只能通过改动**已发布的接缝**来影响它，不能通过重构内部实现。

```
┌─ 对话 ─┬─ 轨迹 ─┬─ 上下文 ─┬─ 记忆 ─┐
                              ↑ 这个插件
```

## 它做什么

一个覆盖**整个库**的管理面，而不是当前会话的只读视图：

- **四层预算卡** `user` / `agent` × `user-global` / `workspace`，每层一条用量进度条
  （≥80% 转黄，写满转红）——和 `/memory budgets` 是同一个口径。
- **子串搜索**（防抖 220ms）+ 轨道 / 层筛选 + 「仅本会话」开关。
- **内联改写与删除**：改写就地变文本框；删除用条目全文作为唯一子串定位，
  因为接缝只接受唯一子串。
- **待批提案**：批准 / 驳回。批准不是翻个标志位就完事 —— 它会带着提案文本重新走一遍
  审批门，和模型调用 `memory` 工具走的是同一个门。
- **审计尾**：`snapshot` / `recalled` / 每次写入，带时间戳与结果。

样式全部走宿主自己的设计令牌（`--dsw-alias-*`），所以自动跟随亮/暗主题，不硬编码配色。

## 写入：门是上游的，不是这里的

这个插件**没有任何特权写入路径**。每一次写都会向 `approval/request` 提问，和上游
`/memory` 命令完全一样，因此 `dsh-memento` 前置注册的 answerer 会先按
`writePolicy` / `writePolicies` 裁决：

| 配置 | 结果 |
|---|---|
| `writePolicy: ask` | 落到 DSH 内置审批 UI，人点确认 |
| `writePolicy: auto` | 上游 answerer 放行，但仍然写 `approval/asked` + `approval/decided` 审计对 |
| `writePolicy: off` | 拒绝，并且拒绝也进审计 |
| 会话级 `never` | 在审批服务内部、任何 answerer 之前裁决 —— 本插件同样绕不过 |

## 安装

```sh
# 先确认 dsh-memento 已装
dsh plugin --profile web add dsh-memento

# 再装本插件
dsh plugin --profile web add github:inxups/dsh-memento-tab

# 本地开发用 link:（改完 client/client.js 热更，host 改动需重启）
dsh plugin --profile web add link:/path/to/dsh-memento-tab
```

装完重启 dsh，会话顶部会出现第 4 个 tab。

## 依赖与边界

- **硬依赖** `ctx.memory`：`inject: ['memory']`。上游不在时本插件不激活，不会半死不活。
- **路由**：本插件自己注册 `/api/memento-tab/{state,write,decide}`，是精确路径路由，
  和上游的 `/api/memento/*` 不冲突。`webServer` 缺失的组合里会退化为「无数据路由」并打日志。
- **只读降级**：`auditList` / `proposalList` / `proposalDecide` 在上游是 provider 账本而非
  类型化接缝，所以这里全部**特性探测**调用 —— 上游改名只会让审计尾和提案区显示
  「此版本未暴露账本」，不会让整个 tab 挂掉。
- **一处刻意耦合**：审批 `reason` 必须以上游的请求标记 `[dsh-memento] ` 开头，因为那是上游
  answerer 认领请求的依据。格式在 `index.mjs` 的 `writeReason()` 里镜像了一份，并有冒烟测试
  断言。除此之外没有复制任何上游内部知识。
- **不认证**：DSH 的 webserver 对自定义 `/api/*` 路由不做鉴权（上游面板路由同理）。
  服务只监听回环地址；若把 `writePolicy` 设成 `auto`，同机进程即可写入，这是配置取舍。

## 许可

MIT。本仓库不含 `dsh-memento` 的任何代码。
