# Changelog

## v0.2.3 — 2026-10-21

**在 `@deepseek-ai/dsh@0.2.1-rc.2` 上实测后的两处修正。**

### 问题

压缩（`phase.kind === 'maintenance'`）进行中，`agent.status` 仍报 `idle`——因为
`AgentLoop` 的 status getter 把 `maintenance` 也算作 idle——但 `runMaintenance()`
会以 *already has active work* 拒绝。

后果有两个：

1. **面板谎报在排队**：命令被唤醒后调 `run()`，而 `execute()` 的 Promise 要等压缩
   真正结束才 settle，`release` 又挂在它之后。整个压缩期间条目留在快照里，面板按
   固定文案显示「等待 agent 空闲」。
2. **压缩期间再发 `/compact` 直接失败**：`isIdle()` 把 maintenance 判为空闲，于是
   不排队、立即执行、立刻撞回 busy。

### 修复

- `isIdle()` 排除 `phase.kind === 'maintenance'`。读不到 `phase` 时退化为只看
  `status`，即上游原本的行为。
- 条目新增 `running` 标记：`run()` 前一刻置位，快照多带该字段。面板据此把文案切换成
  「正在执行」，并在执行中禁用移除按钮；host 侧 `dropQueued` 同步拒绝移除。

### 验证

- `npm test` 32/32 通过。
- 在运行中的 `@deepseek-ai/dsh@0.2.1-rc.2` 上实测：压缩期间面板显示「正在执行」；
  压缩期间再发 `/compact` 会正常排队而不是报 busy。

---

## v0.2.2 — 2026-09-24

**修复回归：不再把「改会话状态」的命令排进队列。**

### 问题

v0.2.0–v0.2.1 的排队规则是「除立即白名单外一律排队」。实测在运行中的
`@deepseek-ai/dsh@0.1.7-alpha.2` 上共注册 11 条命令，旧规则排掉了其中 10 条：

```
cmdqueue, compact, export, feedback, goal, ha, ha-orch-resume,
orchestrate, permission, plan, room
```

其中 `/permission`（切权限预设）、`/plan`、`/goal` 是**改会话状态**的命令，
被推迟到回合结束后就完全失去意义 —— 用户想在 agent 忙着的时候放宽权限以批准操作，
却改不动。

### 修复

- **默认规则反转为白名单**：只有名字列在 `deferCommands` 里的命令才可能被排队，
  默认 `['compact']` —— 它是唯一「忙时必然失败」的命令（`compactNow` →
  `runMaintenance` 的 `phase.kind !== 'idle'` 同步闸门）。只有明确需要 agent
  空闲的命令才排队，其余一律立即执行。
- 完整判定顺序（任一命中即立即执行）：不是合法命令语法 → 命令名不在
  `deferCommands` 里 → 命令名在强制立即名单里 → 命令名在注册表里解析不到 →
  agent 当前就是 idle。只有「合法 + 在 `deferCommands` 里 + 未被强制立即 +
  已注册 + agent 正忙」才入队。
- `immediateCommands` / `alwaysImmediateCommands` 仍是**强制立即**名单，与内置的
  `stop / cancel / abort / interrupt / halt` 取并集；某命令即使同时列在
  `deferCommands` 里也立即执行。

### ⚠️ 破坏性配置变更

- **`immediateCommands` 从「整体替换内置名单」改为「与内置名单取并集」。**
  v0.2.1 及以前写 `immediateCommands: ['foo']` 会**丢掉** `stop / cancel / abort /
  interrupt / halt` 的立即语义；v0.2.2 起内置控制动词永远强制立即，该键只做「加」。
  若你曾为了保住控制动词而在 `immediateCommands` 里重复列出它们，现在可以删掉。

### 新增配置

- `deferCommands`（命令名数组，接受带或不带前导 `/`）—— 排队的白名单，默认
  `['compact']`；显式空数组 `[]` = 没有任何命令排队，等同于关闭排队功能。

### 验证

- `npm test` **全套通过**。
- 在运行中的 `@deepseek-ai/dsh@0.1.7-alpha.2` 上实测：`/permission` 在 agent
  忙碌时**立即执行**；`/compact` 忙碌时仍被挂起排队，并可从队列面板移除。

---

## v0.2.1 — 2026-09-24

**针对 `@deepseek-ai/dsh@0.1.7-alpha.2` 的兼容性核查 + 客户端样式同步。**

### 兼容性核查结论

上游**没有**原生支持「忙时排队斜杠命令」：`dsh-command-compact/README.md:141` 明写
*"the command itself is not queued"*，`:153` 把 *"Queued commands"* 记为
*undecided / open direction*；`dsh-commands` 业务代码对
`queue|busy|whenIdle|status` 零命中；UI 层 `plainMessageDraft` 显式把 `/` 开头的草稿
排除在 queue/steer 语义之外。本插件补的这段能力，0.1.7 线（含 `0.1.7-rc.1`）仍然缺席。

> 易误读的一点：0.1.7 确实原生支持忙时排队 —— 但排的是**普通消息**
> （`BUSY_ENTER_BEHAVIORS = ["queue","steer"]` + inbox `next-turn` + QueueDock），
> 不是斜杠命令。

依赖的内部 API **逐条仍在**（21 项 host + 10 项 client）：`ctx.commands` 仍是 cordis
traceable Proxy、`Symbol.for('cordis.original')` 仍可穿透、`dsh-api-gateway` 仍每次调用
动态 `Reflect.get(callReceiver, 'execute')`、`conversation.input.dock` 槽位与
`__ModuleLoader__` 协议未变。其中 `dsh-commands/lib/index.js` 与 0.1.6-alpha.1
**字节完全相同**。

### 修复

- **客户端 QueueDock 样式同步到 0.1.7**。CSS 复刻源从
  `dsh-client-ui-conversation/lib/client.js:14142` 更新为 `:15078`。0.1.7 重做了这块面板，
  按旧写法渲染与原生队列并排时观感不一致：
  - `.dshcq_panel` 去掉 `background:var(--dsw-specific-tip)`，改 `isolation:isolate`，
    并新增 `:before` 半透明菜单层（`--dsw-specific-menu` + `--dsw-menu-backdrop-filter`）
    —— 这是最明显的一处，旧写法在深色主题下底色偏差可见；
  - `.dshcq_header` 新增 `:disabled{cursor:default}`；
  - `.dshcq_row` 的 `height:36px` → `min-height:36px`（长内容可换行）；
  - `.dshcq_preview` / `.dshcq_status` 的 `13px` / `12px` → `font:var(--dsw-font-xs-13)`，
    改为跟随用户的内容字号设置；
  - `.dshcq_action` 新增 `corner-shape:round`。
- **`npm run build` 不再依赖 bash**。原脚本是 `bash scripts/build.sh`，需要环境里有可用的
  bash；新版 DSH 的运行环境里 `bash` 垫片失效时会直接抛
  `CreateInstance/0x800705aa` 而构建失败。现改为等价的 node 直调
  （`node --check` ×2 + `node --test` 指定两个测试文件），跨平台开箱可用；
  `scripts/build.sh` 保留给 Unix 用户。

### 文档

- README 重写为**仓库门面**：简介 + 徽章 + 问题背景 + 效果 + 特性表 + 安装（三种方式）
  + 使用（浏览器面板 / `/cmdqueue` / 行为契约）+ 配置 + 原理简述 + **故障排查表**
  + 开发 + 兼容性 + 许可。
- 原有的深度技术内容（实现原理、行为契约、浏览器半边、实测运行时行为、验证记录、
  `文件:行` 代码出处）原样移至 **[docs/INTERNALS.md](./docs/INTERNALS.md)**，一条证据未丢。
- 新增故障排查项：客户端面板不出现 / v0.1.0→v0.2.0 的 `pkgMeta` 负缓存坑 /
  排队期间 transcript 无提示 / 命令迟迟不执行 / 白名单被整体替换的副作用 / 多 agent 隔离。
- 兼容性声明与 `docs/INTERNALS.md` 的基线从 `0.1.6-alpha.1` 更新为
  「已验证兼容至 `0.1.7-alpha.2`」，`文件:行` 出处全部按 0.1.7 重新定位
  （`dsh-commands/lib/index.js:327` 未变；`typert.host.js` → `:54`；
  `dsh-api-gateway` → `:977-978`；`dsh-compaction` types → `:137`；
  `dsh-agent` types → `:90,147,149,254`；QueueDock CSS → `:15078`）。
- `docs/INTERNALS.md` 修正补丁机制的措辞：`execute` 位于 `CommandRuntime.prototype`，
  实例上没有自有描述符，因此还原实际走 `delete target.execute` 分支把原型方法露回来。

### 验证

- `npm test` → **29/29 通过**（含 traceable Proxy 的 patch 与精确还原两个回归用例）。
- 活体探针（真 `cordis.Context` 上 `new CommandRuntime(root)`，真打补丁，再经另一个
  scope 的代理调用 —— 精确模拟 typert gateway 的取值路径）：
  `patched actually invoked :: true`，即补丁确实被网关采纳。
  关键读数：`proxy[Symbol.for('cordis.original')] === raw :: true`、
  `typeof raw.execute / arity :: function / 4`、
  `getOwnPropertyDescriptor(raw,'execute') :: undefined`（故走 `delete` 还原）。

---

## v0.2.0 — 2026-09-18

**新增浏览器队列面板：排队中的斜杠命令现在看得见了。**

### 背景

v0.1.0 的排队是 host 侧的延迟执行，功能正确但**排队期间没有任何可见提示** ——
UI 的「执行中…」卡片由会话事件 `command/run` 驱动，而它在 handler 调用前才写入，
我们正是卡在它之前。

排查后确认**不能用 DSH 原生队列**达成这件事，这是结构性的：

1. 原生队列（agent inbox）的条目只能是 `UserMessage`（模型可见内容），
   没有「命令项」这个类型；
2. 队列项在**下一个 step 边界**就被 `claim()` 取走，那一刻 agent 仍在
   running，`compactNow` 照样报 busy —— 只是把错误推迟几十秒；
3. 若用官方 `agent/pre-step` waterfall 把标记从 `messages` 里摘掉（让模型看不见），
   它此时已经出队，原生队列 UI 上随之消失。

即「一直待在原生队列里显示」与「等到 idle 才执行」在 `/compact` 上互斥。
这正是 DSH 作者写下 *"Queue the command itself. Rejected."* 的原因。

### 做法：自建队列 + 复刻原生队列样式

原生消息队列本身就是槽位 `conversation.input.dock` 上的一个 **list 贡献**
（`id: "queue"`、`order: 20`）。list 槽允许第三方携带自己的 `id` 追加条目，
于是本插件注册 `id: "command-queue"`、`order: 30`，在原生队列正下方并排渲染
自己的命令队列：

- **样式**：CSS 取自原生 QueueDock 的 CSS 模块原文
  （`dsh-client-ui-conversation/lib/client.js:14142`），类名前缀改为 `dshcq_`，
  设计变量沿用全局主题，深浅色下与原生队列一致；DOM 结构同样复刻
  （`dock > panel > header(可折叠计数) / ul.list > li.row`，每行一个移除按钮）。
- **数据通道**：`ctx.connection.fetch.register()` 注册两条**已鉴权**路由
  `/api/command-queue/state`（GET 快照）与 `/api/command-queue/drop`（POST 移除）。
  它们由 `/api` 前缀处理器分发，因此先过 `requestRejection()` 的 Host/Origin
  围栏与浏览器签名 cookie 校验。刻意**不用**裸 `ctx.webServer.register()`：
  那条路径完全绕过鉴权，把 exact 路由注册在 `/api/*` 下还会遮蔽内建鉴权。
- client 每 1.5s 轮询一次；**空队列渲染 `null`**，零视觉占用。

### ⚠️ 从 v0.1.0 升级的注意点

`dsh-client-modules` 的 `resolveMeta()` 有一层 **`pkgMeta` 负缓存**
（`dsh-client-modules/lib/index.js:652`）：包在**没有** `dsh.client` 声明的形态下
被加载过一次，`null` 就会被缓存，之后即使补上 `dsh.client` 也读不到，
client 半边不会注册。

- **重启 host** 即可（缓存冷启动，最省事）；
- 不想重启时，清掉该进程里的 `clientModules.pkgMeta` 里对应条目再调
  `processOne(包名)` + `compose()` + `notifyGraphChanged()` 即可（本次升级就是这样处理的）。
- 全新安装不受影响。

另外别忘了：客户端插件是**页面加载时**装配的，升级后需要**刷新页面**。

### 其它变更

- 队列条目改为带 id（`cq1`、`cq2`…），支持从面板/接口移除一条在队命令
  （被移除的命令**不会执行**，RPC 返回 `removed from the command queue`）。
- 新增配置 `exposeState`（默认 `true`）；设为 `false` 即回到纯 host 形态。
- `/cmdqueue` 与浏览器面板读同一份队列。

### 兼容性与风险控制

- host 侧仅用到公开面：`ctx.commands.execute/find/register`、`agent.status`、
  `agent.ctx.on('agent/status')`、`ctx.connection.fetch.register`。
- 客户端 bundle 抛错会让**整个 Web 应用无法 mount**（DSH 的 boot 审计没有
  per-plugin 隔离），因此：`apply` 整体 try/catch、组件内网络/DOM 操作全自吞、
  空队列返回 `null`、`React.useId` 缺失时降级为常量。
- 新增 `tests/client-bundle.test.mjs`：用最小 React 运行时 + 假
  `window.__ModuleLoader__` 把 bundle 真正加载并渲染，覆盖 bundle 形态
  （id/factory/无 default）、dock 条目 id 与 order、异常自吞、空队列渲染 `null`、
  有队列时渲染命令行并经 drop 路由移除。
- 客户端插件是**页面加载时**装配的 —— 安装/注入后需要**刷新页面**才会出现面板。

### 验证

- 单元测试：`npm test` → **29/29 通过**（host 22 + client 7）。
- 真实端到端（v0.1.0 已验，逻辑未变）：非命令行 2ms 返回 200；
  已注册命令在 agent running 时被挂起排队（8s 无响应）。

---

## v0.1.0 — 2026-09-18

首个版本：让 `/compact` 这类**斜杠命令**在 agent 忙碌时不再立刻报错，
而是进入按 agent 串行的命令队列，等 agent 空闲后自动执行。

### 背景

DSH 里普通消息与斜杠命令走两条完全不同的通道：

| | 普通消息 | 斜杠命令 |
|---|---|---|
| 客户端 | `session.prompt({ mode })` | `remote.commands.execute()` |
| host 落点 | `agent.followup()` / `agent.steer()` → agent **inbox** | `ctx.commands.execute()` → 直接调 handler |
| 忙碌时 | **天然排队** | **立即执行**，无排队语义 |

`/compact` 的 handler 调 `compactNow()` → `agent.runMaintenance()`，后者的同步
gate 是 `if (this.phase.kind !== 'idle') throw`，被包成
`ManualCompactionError('busy')`。所以 agent 忙碌时敲 `/compact` 只会立刻收到
"Compaction is unavailable because this process has an active compaction, or the
agent is not idle."——既没排队，也没有任何重试。

> DSH 作者把「命令自己进队列」当作有意排除的方案记录在案
> （Agent Note: *"Queue the command itself. Rejected."*），因此官方没有开关。
> 本插件在**不改 DSH 源码**的前提下补上这一段。

### 新增

- 包装 host 侧 `ctx.commands.execute()`：合法 + 已注册 + 未豁免 + agent 正忙的
  调用进入该 agent 的 FIFO 队列，等 `agent/status → idle` 后按原顺序执行。
- 命令仍由原注册表解析，`command/run` + `command/done` 生命周期日志仍由
  `CommandRuntime` 写入，只是执行时机推迟到空闲窗口。
- 新增只读命令 `/cmdqueue`，查看当前 agent 还排着哪些命令。
- 可选配置：`verbose`、`pollIntervalMs`、`immediateCommands`、
  `alwaysImmediateCommands`。

### 安全边界

- 非命令语法 / 注册表解析不到 / 控制动词（`stop`、`cancel`、`abort`、`interrupt`、
  `halt`）/ agent 已空闲 —— 一律照旧立即执行，零回归；
- 排队逻辑自身抛错时回落原行为，**绝不吞掉用户命令**；
- 按 agent 隔离，一个 agent 空闲不会放行另一个在队的命令；
- 严格 FIFO 串行，多个 `/compact` 不会挤进同一个空闲窗口；
- 可随 UI 请求的 `signal` 取消（浏览器断连是唯一实际取消源）；
- 插件卸载时唤醒所有等待者，已排队命令立刻按原顺序执行完，不留悬挂 RPC。

### 两个踩过的实现坑

1. `ctx.commands` 是 cordis 的 **traceable Proxy**，get trap 对函数值每次返回新的
   shadow method，所以 `service.execute === patched` 这种身份比较**恒为 false**
   （用它做还原守卫会导致补丁永远摘不掉）。改为经
   `Symbol.for('cordis.original')` 取 raw 实例，用
   `Object.getOwnPropertyDescriptor` 记录原状、精确 patch、精确还原。
2. `AgentLoop.kick()` 的 finally 是「`setPhase(idle)` **同步** emit
   `agent/status` → `wakeDriver()`」。任何跨 promise 边界后再调用都会撞回
   running，`compactNow` 仍是 busy。因此把「检查 `agent.status === 'idle'`」和
   「调用 `run()`」放在**同一个同步块**内，中间绝不 `await`。

### 验证

- 单元测试：`node --test tests/*.test.mjs` → **17/17 通过**
  （含 traceable Proxy 的 patch 与精确还原两个回归用例）。
- 真实端到端（插件注入运行中的 host，经 typert gateway HTTP 直连）：

  ```
  T1  line="hello"      → 200 {"ok":true}      0.002s   ✅ 通路正常、非命令不排队
  T2  line="/cmdqueue"  → 8s 无响应（curl 28）          ✅ 命令在 agent running 时被挂起排队
  ```

### 兼容性

针对运行中的 `@deepseek-ai/dsh@0.1.6-alpha.1` 实现，依据其编译产物逐行核对。
不依赖任何 DSH 内部私有结构，只用公开面：`ctx.commands.execute/find/register`、
`agent.status`、`agent.ctx.on('agent/status')`。
