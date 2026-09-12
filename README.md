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

一个覆盖**整个库**的管理面，不是当前会话的只读视图。`/memory` 的全部 11 个动词在这里都有
对应操作，另外多两个上游没有的：内联改写、导出下载。

- **四层预算卡** `user` / `agent` × `user-global` / `workspace`，每层一条用量进度条
  （≥80% 转黄，写满转红）——和 `/memory budgets` 是同一个口径。
- **子串搜索**（防抖 220ms）+ 轨道 / 层筛选 + 「仅本会话」开关。
- **内联改写与删除**：改写就地变文本框；删除用条目全文作为唯一子串定位，
  因为接缝只接受唯一子串。
- **合并（consolidate）**：勾选 ≥2 条 → 预填原文 → 删减成一条新文本提交。跨层选中会被禁用
  （上游一次只整合同一层），上限读取宿主报的 `maxMergeMatches`，不自己写死。
- **待批提案**：批准 / 驳回。批准不是翻个标志位就完事 —— 它会带着提案文本重新走一遍
  审批门，和模型调用 `memory` 工具走的是同一个门。
- **数据卡**：导出（memento 信封或任一适配器格式）+ 复制 / 下载；导入（选文件或粘贴）。
- **适配器卡**：当前构建注册了哪些适配器、各自吃什么格式、导出成什么。
- **审计尾**：`snapshot` / `recalled` / 每次写入，带时间戳与结果。

样式全部走宿主自己的设计令牌（`--dsw-alias-*`），所以自动跟随亮/暗主题，不硬编码配色。

## 数据：导出与导入

**导出**走 `GET /api/memento-tab/export`，两种格式：

- 不带 `adapterId` → `dsh-memento` 信封（`memory-export-v1`），**和 `/memory export` 出的文件
  是同一格式**，`/memory import` 直接吃得下；
- 带 `adapterId` → 该适配器自己的产出（内置三个：`mem0-facts`、`hermes-memory-md`、
  `claude-code-memory-md`）。

拿到文本后可以一键复制或下载成文件（浏览器侧 `Blob`，不需要额外服务）。

**导入**走 `POST /api/memento-tab/import`，走的是 `memory.seed()`：**一次审批批准整批 +
全量预算预检 + 单事务原子落盘**。任何一条超预算就整批拒绝，不会写进去一半。超预算的
`used/limit/needed` 会原样回到界面，提示先合并再试。单次上限 1000 条（上游协议常量）。

- 默认**保留文件里的层键**（`workspaceKey` / `agentKey`），所以导回原工作区的条目还在原工作区；
  勾「按当前会话重写层键」才会整批重新归属。
- 提交前会弹一次确认。信封格式能本地数出条目数与目标层；适配器格式只有宿主能解码，所以
  确认框照实说、不编造条数。
- 没有适配器注册表的构建里，导入仍可用（走信封），只是没有适配器可选。

## 写入：门是组合出来的，不是拆掉的

这个插件**没有特权写入路径**。每一次写都会向 `approval/request` 提问，所以
`dsh-memento` 前置注册的 answerer 永远**先**拿到请求，硬开关一律有效：

| 配置 | 结果 |
|---|---|
| `writePolicy: off` | 拒绝，并且拒绝也进审计。**tab 也绕不过** |
| `writePolicies: {'track/scope': 'off'}` | 同上，在 tab 之前就裁决完 |
| `writePolicy: auto` | 放行，仍然写 `approval/asked` + `approval/decided` 审计对 |
| 会话级 `never` | 在进入瀑布之前就被拦下，本插件同样绕不过 |
| `writePolicy: ask` | **tab 发起的写不再弹审批。** 见下 |

`ask` 是唯一被改写的分支，改的是**最后那一步「问人」**：从 tab 点「保存」的是人，人就是审批人，
再让他审批自己刚点的那一下是双重确认，不是安全属性。实现方式是自己注册一个**非 prepend** 的
answerer，只认自己打上的 tab 标记：

- 上游 answerer（prepend）先跑 → `off` / 细粒度策略在这里就已经 `rejected`，轮不到我
- 落到「要问人」这一步 → 我的 answerer 对 tab 标记的请求回 `allowed-once`
- 请求不带 tab 标记（模型调 `memory` 工具、`/memory` 命令）→ 原样落到人工审批 UI，**行为不变**
- 瀑布兜底是 `unavailable`（fail closed），没人认领的请求一律拒绝

标记不能放在 `reason` 里——上游按字节解析那个字符串——所以它走审批请求对象上的一个私有字段。

### 一次点击换来的取舍

`ask` 下 tab 的写变成免确认（**导入也走同一条**，因为点「导入」的同样是本人），意味着
**本机上的任何进程**只要伪造那个请求头，也能不弹窗写入。路由和其它插件路由一样不做鉴权，
我用一个自定义请求头（`x-memento-tab: 1`）挡住**网页**发起的跨站请求（跨域带自定义头需要
CORS 预检，这个服务不满足），但挡不住本机进程。

导出虽然只读，也要求同一个请求头 —— 它一次带走整个库，比单条写入更值得挡。

想彻底关掉从 tab 写入：把 `writePolicy` 设成 `off`，或对该 `track/scope` 单独设 `off`。

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

- **硬依赖** `ctx.memory` 与 `approval`：`inject: ['memory', 'approval']`。上游不在时本插件
  不激活，不会半死不活。
- **路由**：本插件自己注册 `/api/memento-tab/{state,write,decide}` 三条，加上只读的
  `export`（GET）与 `import`（POST），都是精确路径路由，和上游的 `/api/memento/*` 不冲突。
- **`webServer` 故意不写进 `inject`**：没有 web server 的组合里本插件仍然激活，只是没有数据
  路由；服务出现得晚也会被接上。注意 Cordis 对**未声明的服务做属性访问会直接抛错** ——
  `if (ctx.webServer === undefined)` 这种写法根本执行不到，属性访问本身就是那次抛出。
  可选服务一律走 `ctx.get()`（`webServer` 与 `memoryAdapters` 都是这么拿的）。
- **只读降级**：`auditList` / `proposalList` / `proposalDecide` / `listEntries` 在上游是
  provider 账本而非类型化接缝，`memoryAdapters` 也是独立服务，所以这里全部**特性探测**调用 ——
  上游改名只会让审计尾、提案区、适配器卡显示「此版本未暴露」，导出退化成「无法导出」，
  不会让整个 tab 挂掉。
- **几处刻意耦合**：审批 `reason` 的格式（`writeReason()`）、导出信封的
  `plugin` / `schema`（`EXPORT_PLUGIN` / `EXPORT_SCHEMA`）、以及两个协议上限
  （`MAX_IMPORT_ENTRIES` / `MAX_MERGE_MATCHES`）都是从上游镜像来的常量。**冒烟测试会拿装好的
  上游逐个断言**：常量直接比对，导出的信封再喂给上游自己的 `validateExportEnvelope` 过一遍，
  所以「镜像错了」会在测试里响，而不是在用户导文件时响。除此之外没有复制任何上游内部知识。
- **不认证，但有请求头闸门**：DSH 的 webserver 对自定义 `/api/*` 路由不做鉴权（上游面板路由
  同理），服务只监听回环地址。本插件的 `write` / `decide` / `import` / `export` 四条路由额外
  要求 `x-memento-tab: 1` 这个请求头，用来挡跨站网页（跨域带自定义头要过 CORS 预检，本服务
  不满足）；挡不住本机进程。`state` 是唯一不要头的路由，这样 tab 出问题时 `curl` 还能直接看。
- **`apply()` 永不抛出**：见下一节。插件内部的任何异常都只打日志，不让 dsh 起不来。

## 启动安全（这是踩过坑的地方）

插件的 `apply()` 一旦抛错，失败的是**整个 loader 树** —— dsh 完全起不来，不是这个 tab 消失。
所以这里有两条硬约束：

1. **`apply()` 整体包了 try/catch**：任何异常只打日志并退化成「无数据路由」，绝不阻断启动。
2. **`test/load.mjs` 在真实 Cordis 上下文里加载本插件**，覆盖三种情形：有 web server（注册
   五条路由）、没有 web server（必须仍能激活）、web server 后到（从 `internal/service`
   接上）。第一条写错的版本就是死在第二种情形上。同一份测试还驱动了 export / import 两条
   新路由，包括「没有条目账本」「没有适配器注册表」这两种降级路径。

```sh
npm test          # 两个测试都跑
npm run test:load # 只跑加载契约测试（默认在 /Users/inxups/project/deepseek-harness 找 cordis，
                  # 用 DSH_SOURCE 覆盖；找不到就 skip 而非失败）
                  # 冒烟测试里的上游对照默认找 /Users/inxups/.dsh/profiles/web/node_modules/dsh-memento，
                  # 用 DSH_MEMENTO_SOURCE 覆盖；同样 skip 而非失败
```

## 许可

MIT。本仓库不含 `dsh-memento` 的任何代码。
