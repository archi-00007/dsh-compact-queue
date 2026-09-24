# 设计与实现细节

本文是 [dsh-command-queue](https://github.com/kuyueliuhun-ctrl/dsh-command-queue) 的
**完整技术细节**：实现原理、行为契约、浏览器半边、实测运行时行为、验证记录与代码出处。

面向想改这个插件、或想在 DSH 里做同类拦截的维护者。只想用它的话看 [README](../README.md) 就够了。

所有 `文件:行` 引用均以运行中的 `@deepseek-ai/dsh@0.1.7-alpha.2`（路径前缀
`…\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`）的**编译产物**为准，
并已回对 `0.1.7-rc.1` 抽样复核。

> **兼容性结论（0.1.7 复核）**：原始基线是 `0.1.6-alpha.1`。上游**未**原生支持
> 「忙时排队斜杠命令」——`dsh-command-compact/README.md:141,153` 明写
> *"the command itself is not queued"* 并把 *"Queued commands"* 列为
> *undecided / open direction*；`dsh-commands` 业务代码零排队逻辑；UI 层
> `plainMessageDraft` 显式把 `/` 草稿排除在 queue/steer 之外。本插件依赖的内部 API
> 逐条仍在（`dsh-commands/lib/index.js` 与 0.1.6-alpha.1 **字节完全相同**），
> 唯一需要跟进的是客户端 QueueDock 样式（已同步，见 §3）。

---

## 1. 实现原理

在 host 侧包装 `ctx.commands.execute()`：

```
浏览器 ──POST commands/execute──▶ typert gateway
                                     │  Reflect.get(receiver, 'execute')   ← 每次调用动态取方法
                                     ▼
                            ┌─ patched execute ─┐
                            │  合法命令？        │
                            │  注册表能解析到？  │
                            │  不在立即白名单？  │
                            │  agent 正忙？      │
                            └────────┬──────────┘
                              是 ────┴────▶ 该 agent 的 FIFO 队列
                                             │  等 agent/status → idle
                                             ▼
                                      original.execute(...)  ← 原方法：原注册表解析、原生命周期日志
```

**为什么打这个补丁有效**：typert gateway 在 `prepareInvocation()` 里每次调用都执行
`Reflect.get(receiver, descriptor.implementation ?? descriptor.method)`
（`dsh-api-gateway/lib/index.js:977-978`）；而 `commands/execute` 的 strict descriptor
只声明 `method: 'execute'`，**不携带方法引用**（`dsh-commands/lib/typert.host.js:54`）。
所以给服务对象加一个自有的 `execute` 会被后续所有请求采纳，
`agentId` 参数解析、参数校验、结果 schema 全部不变。

> **两个必须知道的细节**（都踩过）：
> 1. `execute` 定义在 **`CommandRuntime.prototype`** 上，实例本身没有自有描述符
>    （`Object.getOwnPropertyDescriptor(raw, 'execute') === undefined`）。插件用
>    `Object.defineProperty(target, 'execute', …)` 建一个**遮蔽**原型方法的自有属性；
>    还原时 `previous === undefined`，因此实际走 `delete target.execute` 把原型方法
>    重新露出来。若改成 `defineProperty(target, 'execute', previous)` 会直接抛错。
> 2. **不能**用 `service.execute === patched` 判断补丁是否生效 —— `ctx.commands` 是
>    cordis 的 traceable Proxy，每次读函数属性都返回新的 shadow 方法，恒为 `false`。
>    要拿原始实例走 `ctx.commands[Symbol.for('cordis.original')]`（只在代理上有效）。

命令仍由**原注册表**解析（`ctx.commands.find()` / 层遮蔽规则都不动），
`command/run` + `command/done` 生命周期日志仍由 `CommandRuntime` 自己写，
只是执行时机被推迟到空闲窗口。

---

## 2. 行为契约：什么时候**不**排队

以下情况一律保持原行为（立即执行），保证零回归：

- **不是合法命令语法** —— 第 0 字节不是 `/`、名称含大写或非法字符（如 `/Compact`）、只有 `/`；
- **命令名在注册表里解析不到** —— `ctx.commands.find(agent, name)` 返回 `undefined`
  （客户端本来就会按「未命中」处理，没必要拖到空闲后）；
- **命令名在立即执行白名单里** —— 默认 `stop` / `cancel` / `abort` / `interrupt` / `halt`，
  这些控制动词排队会失去意义，甚至危险（忙碌时敲 `/stop` 本该立刻中断）；
- **agent 当前就是 idle**；
- **排队逻辑自身抛错** —— 兜底回落成原行为，绝不吞掉用户命令。

只有「合法 + 已注册 + 未豁免 + agent 正忙」才入队。

其它保证：

- **按 agent 隔离** —— 一个 agent 空闲不会放行另一个 agent 在队的命令；
- **严格 FIFO 串行** —— 同一 agent 内第 N 个命令只在第 N-1 个 settle 之后才去等空闲，
  多个 `/compact` 不会挤进同一个空闲窗口；
- **可取消** —— UI 请求的 `signal` 中止时，命令返回
  `{ kind: 'error', text: '/xxx was cancelled before it could run.' }` 且**不会执行**；
- **卸载不丢命令** —— 插件卸载时唤醒所有等待者，已排队的命令立刻按原顺序执行完。

---

## 3. 浏览器队列面板

**它挂在哪**：DSH 原生消息队列本身就是槽位 `conversation.input.dock` 上的一个
**list 贡献**（`dsh-client-ui-conversation/lib/client.js:15535-15537`，`id: "queue"`；
槽位声明见同文件 `:17789`）。list 槽允许第三方携带自己的 `id` **追加**条目，
所以本插件注册 `id: "command-queue"`、`order: 30`，两条队列上下并排：

```js
ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
  name: 'conversation.input.dock',
  id: 'command-queue',
  order: 30,
  inject: (sessionId) => ({ sessionId }),   // 返回值就是组件 props
}, CommandQueueDock))
```

兼容边界：0.1.7 给 list 槽新增了两个**可选**字段 `label` / `priority`
（槽位内核 `dsh-client-ui-slots/lib/index.js` 与 0.1.6-alpha.2 **字节相同**），
本插件不传即取默认值，向后兼容。

**样式来源**：CSS 取自原生 QueueDock 的 CSS 模块原文
（`dsh-client-ui-conversation/lib/client.js:15078` 的 `css$6`），类名统一改前缀为
`dshcq_` 避免冲突，设计变量（`--dsw-alias-*`、`--dsh-composer-*`）沿用全局主题，
因此深浅色主题下与原生队列表现一致。样式通过官方那套
`<style data-plugin-css=…>` 注入模式幂等插入。

> 0.1.7 重做过这块面板，本插件 CSS 已于 v0.2.1 同步：面板改为 `isolation:isolate`
> + `:before` 半透明菜单层（原写法是 `background:var(--dsw-specific-tip)`，深色主题下
> 底色偏差可见）、行高 `min-height`、字号走 `--dsw-font-xs-13` token、
> 图标按钮补 `corner-shape:round`。原生面板另支持附件缩略图与就地编辑，本插件
> **有意不跟进**（保持「单行摘要 + 移除按钮」），避免下次审计重复排查这一点。

**数据从哪来**：`ctx.connection.fetch.register()` 注册两条**已鉴权**路由：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/command-queue/state` | GET / HEAD | 按 `?sessionId=` 返回队列快照 `{ok, items:[{id,name,line,queuedAt}]}` |
| `/api/command-queue/drop` | POST | `{sessionId, id}` 移除一条在队命令（命令不会被执行） |

它们由 `/api` 前缀处理器分发，因此**先过** `requestRejection()`
（Host/Origin 信任围栏 + 浏览器签名 cookie）。
刻意**不用**裸 `ctx.webServer.register()` —— 那条路径完全绕过鉴权，
且把 exact 路由注册在 `/api/*` 下还会遮蔽内建鉴权。

**容错**：`apply` 整体 try/catch，组件内所有网络/DOM 操作自吞异常，空队列渲染
`null`，`useId` 缺失时降级为常量。这些不是洁癖——客户端 bundle 抛错会让整个
Web 应用无法 mount。

---

## 4. 你会看到什么（实测的运行时行为）

这些结论来自对运行中 `@deepseek-ai/dsh@0.1.7-alpha.2` 客户端/host 代码的逐行核对。

**提交 `/compact`（agent 正在跑）时：**

1. 命令**被挂起排队**，输入框**不会冻结**——因为 `/compact` 没有 `input` 描述符，
   客户端走 `runDetached`（fire-and-forget）路径，本来就不等 RPC 返回。
   你可以继续打字、继续排消息。
2. **composer 上方立刻出现「命令队列」面板**（v0.2.0 起），样式复刻原生消息队列：
   单条直接列出一行 `/compact`，多条折叠成「已排队命令 · N」可展开列表，
   每行右侧有一个移除按钮。它挂在原生队列**同一个槽位** `conversation.input.dock`
   上（原生 id `queue` / order 20，本插件 id `command-queue` / order 30），
   所以两条队列是上下并排的。
3. **回合结束后**，命令真正执行，此时 `command/run` + `command/done` 落盘并流回
   浏览器，transcript 里出现正常的命令卡片：先「执行中…」，再「已完成」+
   真实结果文案（例如 `Compacted 12 history items (~3456 tokens).`），失败则红色「指令失败」。
   队列面板里对应的那行同时消失。
4. 不想开浏览器面板时：`/cmdqueue` 用纯文本报告同一份队列。

> 注：面板每 1.5s 轮询一次 host 快照，**只在有排队命令时才渲染**（空队列返回 `null`，
> 零视觉占用）。轮询走的是已鉴权路由，刷新页面后自动恢复。

**取消语义（重要）**：

- **只有浏览器断开**（刷新 / 关页）会 abort 这次 RPC——服务端 `res.on('close')` → `AbortController`。
  此时插件返回 `{ kind:'error', text:'/xxx was cancelled before it could run.' }`，命令**不会执行**。
- 点「停止」按钮走的是另一条 RPC（`session/cancel` → `agent.cancel`），**不会**取消命令。
  也就是说：排队期间点停止只会中断当前回合，排队中的 `/compact` 会在回合结束后照常执行。
- 切换会话**不会**取消；结果仍会回到该会话自己的 transcript。

**其它**：

- **无 RPC 超时**：宿主 webserver / `/api` bridge / typert gateway / 浏览器 fetch 全链路
  都没有 per-request deadline（唯一的 `requestTimeout=300s` 是 Node 默认值，只作用于
  「收完请求」阶段，实测不会杀掉 pending 响应）。所以挂住几分钟是安全的。
- **无幂等键**：`commands/execute` 的参数只有 `agentId / line / submittedAttachments`，
  没有 requestId。手动重发同一行命令会真的执行两次——插件不做去重。
- **依赖 `agent.status`**（`AgentStatus = 'idle' | 'running'`）。状态不可读时按
  「忙碌」处理（宁可排队，不可抢跑）。
- **`idle` 不蕴含「能跑维护任务」**：`phase.kind === 'maintenance'` 期间 `status`
  仍是 `idle` 且不发事件，此时若有另一个 maintenance 占用 agent，`compactNow` 仍会
  报 `busy`。这种情况插件不掩盖，按原样返回该报错。
- 只对**命令**生效。普通消息的排队是 DSH 内建行为，本插件不介入。

---

## 5. 验证记录

**单元测试**：`npm test` → **29/29 通过**，含两个专门针对踩过的坑的回归用例
（traceable Proxy 的 patch 与精确还原）。

**浏览器半边冒烟测试**（`tests/client-bundle.test.mjs`，7 项）：用最小 React 运行时 +
假 `window.__ModuleLoader__` 把 `lib/client.js` 真正加载并渲染，断言 bundle 形态
（id/factory/无 default）、dock 条目 id 与 order、异常自吞、空队列渲染 `null`、
有队列时渲染出命令行并能经 drop 路由移除。
> 这道测试是必需的而非可选的：DSH 的 boot 审计**没有 per-plugin 隔离**，
> 客户端 bundle 抛错会让整个 Web 应用无法 mount。

**真实端到端**（插件注入运行中的 host 后，经 typert gateway 用 HTTP 直连验证）：

```
# T1 非命令行：证明网关通路正常、且非命令不被排队
POST /api/commands/execute  {"agentId":"session-…","line":"hello",…}
→ 200 {"ok":true}                                        耗时 0.002s   ✅

# T2 已注册命令 + agent 正在 running：证明命令被排队挂起
POST /api/commands/execute  {"agentId":"session-…","line":"/cmdqueue",…}
→ curl exit 28（8s 无响应，被挂起排队）                               ✅
```

T1 与 T2 的对比同时证明了：补丁确实落在 gateway 的调用路径上（否则 `/cmdqueue`
会立刻返回），且排队判定确实基于 agent 忙闲。

> 上面这组 T1/T2 记录采集自 `0.1.6-alpha.1` 基线。0.1.7-alpha.2 上重跑的是更强的一版
> **活体探针**（`probe-cq-017.mjs`）：真 `cordis.Context` 上 `new CommandRuntime(root)`，
> 真打补丁，再经**另一个 scope 的代理**调用 —— 精确模拟 gateway 的
> `receiverContext.extend({invocation}).get('commands')` 取值路径。关键读数：
> `patched actually invoked :: true`、`proxy[Symbol.for('cordis.original')] === raw :: true`、
> `typeof raw.execute / arity :: function / 4`、
> `getOwnPropertyDescriptor(raw,'execute') :: undefined`（故还原走 `delete` 分支）。

---

## 6. 代码出处

实现依据（运行中的 `@deepseek-ai/dsh@0.1.7-alpha.2`，路径为
`…\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`）：

- `dsh-commands/lib/index.js:327` —— `async execute(agent, line, submittedAttachments, signal)`（原型方法，可包装）；该文件与 `0.1.6-alpha.1` **字节完全相同**
- `dsh-commands/lib/types/index.d.ts:142` —— `execute(agent, line, submittedAttachments, signal)` 公开契约
- `dsh-commands/lib/typert.host.js:54` —— strict descriptor 只声明 `method: 'execute'`（同处 `cancellation: { parameter: 'signal' }`）
- `dsh-api-gateway/lib/index.js:977-978` —— `implementation = descriptor.implementation ?? descriptor.method` / `Reflect.get(callReceiver, implementation)`：每次调用动态取方法
- `dsh-command-compact/lib/index.js:49-73` —— `/compact` handler 与 busy 文案（`:18-23` 是 `code === 'busy'` 的用户可见文案）
- `dsh-compaction-basic/lib/index.js:984-1010` —— `compactNow` 把 `runMaintenance` 的同步抛错包成 `ManualCompactionError('busy', …)`
- `dsh-compaction/lib/types/index.d.ts:137` —— `compactNow(agent, signal, sourceCommandId)`
- `dsh-agent-loop/lib/index.js:822-823` —— `runMaintenance` 的忙时闸门：`if (this.phase.kind !== "idle") throw`
- `dsh-agent-loop/lib/index.js:870` —— `async whenIdle()`
- `dsh-agent/lib/types/runtime-types.d.ts:90,147,149,254` —— `AgentStatus` / `agent.status` / `agent.ctx` / `agent/status` 事件
- `dsh-client-ui-conversation/lib/client.js:15078` —— 原生 QueueDock 的 `css$6`（本插件 CSS 出处）
- `dsh-client-ui-conversation/lib/client.js:15535-15537`、`:17789` —— 原生队列 dock 贡献（`id: "queue"`）与 `conversation.input.dock` 槽位声明
