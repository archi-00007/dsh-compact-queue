# dsh-command-queue

> 让 `/compact` 这类**斜杠命令**在 agent 忙碌时不再立刻报错，而是进入命令队列，
> 等 agent 空闲后自动执行 —— 并在浏览器里以**复刻原生消息队列的样式**展示这份队列。

**Queue slash commands until the agent is idle — with a browser queue panel styled after DSH's native message queue.**

[![Release](https://img.shields.io/github/v/release/archi-00007/dsh-compact-queue?sort=semver)](https://github.com/archi-00007/dsh-compact-queue/releases)
[![License](https://img.shields.io/github/license/archi-00007/dsh-compact-queue)](./LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blueviolet)](https://github.com/topics/dsh-plugin)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.2-4f46e5)](https://github.com/deepseek-ai/deepseek-harness)

DeepSeek Harness（DSH）插件 · host + client 双面 · **不改 DSH 源码** · 卸载即完全还原

---

## 问题：agent 忙碌时 `/compact` 只会报错

DSH 里普通消息和斜杠命令走**两条完全不同的通道**：

| | 普通消息 | 斜杠命令 |
|---|---|---|
| 客户端 | `session.prompt({ mode })` | `remote.commands.execute()` |
| host 落点 | `agent.followup()` / `agent.steer()` → agent **inbox** | `ctx.commands.execute()` → 直接调 handler |
| 忙碌时 | **天然排队**，回合结束再消费 | **立即执行**，没有任何排队语义 |

`/compact` 的 handler 调 `compactNow()` → `agent.runMaintenance()`，后者在 agent 非 idle 时
**同步抛** `ManualCompactionError('busy')`。于是 agent 正在跑的时候敲 `/compact`，只会立刻收到：

```
Compaction is unavailable because this process has an active compaction,
or the agent is not idle.
```

既没有排队，也没有重试。DSH 作者把「命令自己进队列」当作有意排除的方案记录在案
（Agent Note: *"Queue the command itself. Rejected."*），所以官方没有开关 —— 这正是本插件补上的那一段。

## 效果

agent 忙碌时敲 `/compact`：

1. 命令**被排队**，输入框**不冻结**，你可以继续打字、继续排消息；
2. composer 上方、**原生消息队列正下方**立刻出现一条「命令队列」：
   单条直接列出一行 `/compact`，多条折叠成「已排队命令 · N」可展开，每行带一个移除按钮；
3. 回合结束后命令真正执行，transcript 里出现正常的命令卡片
   （「执行中…」→「已完成 · Compacted N history items」），队列里那行同时消失。

## 特性

| | |
|---|---|
| 🧩 **通用** | 拦截点在 `ctx.commands.execute()`，任何斜杠命令都能按需纳入排队（列进 `deferCommands`），默认只排 `/compact` |
| 👀 **看得见** | 浏览器队列面板，CSS 与 DOM **取自原生 QueueDock 原文**（仅换类名前缀），沿用全局主题变量 |
| 🔒 **零回归** | 默认只排 `/compact`；非命令语法 / 未列入 `deferCommands` / 强制立即（`/stop` 等）/ 注册表解析不到 / agent 已空闲 —— 一律照旧立即执行 |
| 🧯 **不吞命令** | 排队逻辑自身抛错时回落原行为；卸载时唤醒等待者让在队命令立刻执行完 |
| 🎛 **可控** | 按 agent 隔离、严格 FIFO 串行、可随 UI 请求取消、可从面板移除 |
| 🔐 **鉴权** | 面板数据走 `/api` 已鉴权路由（Host/Origin 围栏 + 签名 cookie），不用裸 webServer 路由 |
| ♻️ **可卸载** | 精确还原 `execute`（含原描述符），不留悬挂 RPC |

## 安装

本插件是**手写 ESM / 浏览器 bundle**，没有编译步骤；`lib/index.js` 与 `lib/client.js` 就是源码，
`npm run build` 只做语法校验 + 跑测试。

> **本包是 host + client 双面插件。** host 半边做排队与执行，client 半边
> （`exports["./client"]`，由 `package.json` 的 `dsh.client.platform: "web"` 声明）渲染队列面板。
> ⚠️ 客户端插件是**页面加载时**装配的 —— 安装后需要**刷新页面**才会出现面板。

本包自带 `cordis.patch.yml`，dsh 的 bundle 层会把 `command-queue` 这一行自动插进 loader，
**不需要手动写 patch 条目**。

> 包名是 `dsh-command-queue`（沿用上游 fork 的包标识），仓库名是 `dsh-compact-queue`。
> 因此安装后 profile 的 `dependencies` 键显示为 `dsh-command-queue`，这是正常的。

### 方式 A：dsh 插件管理器（推荐）

dsh Web → 设置 → 插件 → **安装第三方插件**，填入：

```
github:archi-00007/dsh-compact-queue
```

### 方式 B：命令行

```bash
dsh plugin --profile web add github:archi-00007/dsh-compact-queue
```

装好后确认 profile 的 `package.json` 里 `dsh.profile.bundles` 含有 `dsh-command-queue`：

```json
{ "dsh": { "profile": { "bundles": ["dsh-command-queue"] } } }
```

缺失就补上这一行再重启。

### 方式 C：本地目录（开发）

```bash
dsh plugin --profile web add file:/path/to/dsh-compact-queue
```

### 卸载

```bash
dsh plugin --profile web remove dsh-command-queue
```

`dsh.profile.bundles` 里若还有该名字，一并删掉；面板与 host 路由会随插件卸载一起消失。

## 使用

### 浏览器队列面板

挂在原生消息队列**同一个槽位** `conversation.input.dock` 上
（原生 `id:"queue"` / `order:20`，本插件 `id:"command-queue"` / `order:30`），
所以两条队列上下并排。**队列为空时面板完全不渲染**（返回 `null`），零视觉占用。

面板每 1.5s 轮询一次 host 快照；行右侧的按钮可以把一条还没执行的在队命令移除
（被移除的命令**不会执行**）。

命令被唤醒、真正进入执行之后（典型例子：`/compact` 触发的压缩要跑几十秒），
该行状态会变成**正在执行**，移除按钮同时禁用——它已经离开等待队列，不受队列控制了。

### `/cmdqueue` 命令（纯文本路径）

不想开浏览器面板时，用这个只读命令查看同一份队列：

```
/cmdqueue
→ 1 command(s) queued for this agent, waiting for it to become idle: /compact
→ No queued commands for this agent.
```

### 行为契约：什么时候排队

**规则是白名单**：只有名字明确列在 `deferCommands` 里的命令才可能被排队，默认只有
`/compact` —— 它是唯一「忙时必然失败」的命令（`compactNow` → `runMaintenance` 的
`phase.kind !== 'idle'` 同步闸门）。其余命令一律照旧立即执行，这就是零回归的来源。

以下情况**任一命中即立即执行**，不进队列：

1. **不是合法命令语法** —— 第 0 字节不是 `/`、名称含大写或非法字符（如 `/Compact`）、只有 `/`；
2. **命令名不在 `deferCommands` 里** —— 默认即绝大多数命令走这里；
3. **命令名在强制立即名单里** —— 内置 `stop` / `cancel` / `abort` / `interrupt` / `halt`
   永远立即（忙碌时敲 `/stop` 本该立刻中断，排队会失去意义甚至危险），
   用户配置的 `immediateCommands` / `alwaysImmediateCommands` 与之**取并集**；
4. **命令名在注册表里解析不到** —— `ctx.commands.find(agent, name)` 返回 `undefined`，
   客户端本来就会按「未命中」处理，没必要拖到空闲之后；
5. **agent 当前就是空闲** —— `status === 'idle'` 且 `phase.kind !== 'maintenance'`。
   压缩进行中 `status` 也报 `idle`，但 `runMaintenance()` 会拒绝，所以那段窗口算忙。

只有「合法 + 在 `deferCommands` 里 + 未被强制立即 + 已注册 + agent 正忙」才入队。
此外，**排队逻辑自身抛错**时兜底回落成原行为，绝不吞掉用户命令。

> 为什么默认只排 `/compact`：`/permission`（切权限预设）、`/plan`、`/goal` 是**改会话状态**的命令，
> 被推迟到回合结束等于彻底失效 —— 想在 agent 忙着时放宽权限去批准操作，却改不动。
> v0.2.0–0.2.1 的「除立即白名单外一律排队」正是这个回归的来源。

## 配置

无 schema，容错读取，全部可选。写在 profile 的 `cordis.patch.yml` 里对应条目下：

```yaml
- id: command-queue
  name: 'dsh-command-queue'
  config:
    deferCommands:                   # 主开关：只有列在这里的命令才排队（默认 ['compact']）
      - compact                      # 带不带前导 / 都可以
    verbose: true                    # 打开排队/执行日志（默认 false）
    pollIntervalMs: 250              # host 侧等空闲的轮询兜底间隔，50–5000（默认 250）
    exposeState: true                # 注册给浏览器面板的已鉴权路由（默认 true；false = 纯 host）
    immediateCommands:               # 强制立即：与内置名单取并集（v0.2.2 起不再整体替换）
      - export
    alwaysImmediateCommands:         # 同样是并集，语义上与 immediateCommands 等价
      - my-control-command
```

- `deferCommands` 是排队的白名单，默认 `['compact']`；显式写 `deferCommands: []`
  （空数组）= **没有任何命令排队**，等同于关闭排队功能。
- `immediateCommands` / `alwaysImmediateCommands` 是**强制立即**名单，与内置的
  `stop / cancel / abort / interrupt / halt` **取并集** —— 某命令即使同时列在
  `deferCommands` 里也立即执行；两个键语义等价，都只做「加」。

## 它是怎么做到的

一句话：**在 host 侧包装 `ctx.commands.execute()`** —— 只有列入 `deferCommands` 的命令
（默认只有 `/compact`）才会在 agent 忙时被挂起，等 `agent/status` 回到 `idle` 后调用原方法；
其余命令照旧直通。命令仍由原注册表解析、仍由 `CommandRuntime`
写 `command/run` + `command/done` 生命周期日志，只是执行时机被推迟到空闲窗口。

有两个不查代码就会踩的坑（都与 DSH 内部实现有关）：

- `ctx.commands` 是 cordis 的 **traceable Proxy**，`service.execute === patched` 这种身份比较
  **恒为 false**（get trap 对函数每次返回新的 shadow proxy）—— 用它做还原守卫会导致补丁永远摘不掉；
- `AgentLoop.kick()` 的 finally 是「同步 emit `agent/status` → `wakeDriver()`」，
  任何跨 promise 边界后再调用都会撞回 running —— 所以「检查 idle」与「调用」必须落在**同一个同步块**里。

**为什么不用 DSH 原生队列？** 原生队列（agent inbox）的条目只能是 `UserMessage`（模型可见内容），
没有「命令项」类型；且队列项在**下一个 step 边界**就被 `claim()` 取走，那一刻 agent 仍在 running，
`compactNow` 照样 busy。即「一直显示在原生队列里」与「等 idle 才执行」互斥 —— 所以本插件
另建一份队列，只把**样式与位置**复刻成原生队列的样子。

📖 完整调用链、`文件:行` 证据、实测运行时行为与验证记录见 **[docs/INTERNALS.md](./docs/INTERNALS.md)**。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| **刷新了也看不到面板** | 客户端插件只在页面加载时装配。先确认 profile 的 `dsh.profile.bundles` 含 `dsh-command-queue`，且插件在管理页里是启用状态；若是从旧版升级过来仍不显示，重启 host 清掉 `pkgMeta` 负缓存 |
| **从 v0.1.0 升级后 client 一直是 ✗** | `dsh-client-modules` 的 `resolveMeta()` 有 `pkgMeta` 负缓存：包在**没有** `dsh.client` 声明的形态下加载过一次，`null` 就被缓存。**重启 host** 即可；全新安装不受影响 |
| **排队期间 transcript 里没提示** | 设计如此：`command/run` 事件在 handler 调用前才写入，而我们在它之前就挂住了。提示在**队列面板**里，不在 transcript |
| **命令一直不执行** | 它在等 agent 空闲。agent 若一直有排队消息，空闲窗口会被不断占用 —— 用 `/cmdqueue` 或面板确认它还在队列里 |
| **改动类命令（`/permission` 换权限预设、`/plan`、`/goal`）在 agent 忙的时候不生效，要等回合结束** | v0.2.0–v0.2.1 的排队规则是「除立即白名单外一律排队」，把这些命令也排了。**升级到 v0.2.2**（默认只排 `compact`）即可；若你把 `immediateCommands` 当整体替换用过，注意它现在是与内置名单取并集 |
| **`/stop` 也进了队列** | 不该发生 —— 内置控制动词永远强制立即，`immediateCommands` 只能往里加、不能把它们替换掉。检查是否把 `stop` 同时写进了 `deferCommands`（同时命中时强制立即优先） |
| **不同 agent 互相影响** | 不会。队列按 agent 隔离，一个 agent 空闲不会放行另一个在队的命令 |

## 开发

```bash
npm test      # node --test tests/*.test.mjs
npm run check # node --check lib/index.js && node --check lib/client.js
npm run build # 语法校验 + 全套测试
```

| 测试文件 | 覆盖 |
|---|---|
| `tests/queue.test.mjs` | host 半边：立即放行（未空闲 / 未注册 / 非命令 / 不在 `deferCommands` / 强制立即）、默认只排 `compact`、`deferCommands` 可延展与 `[]` 关闭排队、`immediateCommands` 取并集、忙碌挂起后执行、FIFO 串行、多 agent 隔离、取消、卸载不丢命令、轮询兜底、异常回落、traceable Proxy 的 patch 与精确还原、两条 client 路由 |
| `tests/client-bundle.test.mjs` | 浏览器半边：用最小 React 运行时 + 假 `window.__ModuleLoader__` **真正加载并渲染** bundle —— bundle 形态（id / factory / 无 default）、dock 条目 id 与 order、异常自吞、空队列渲染 `null`、有命令时渲染并能经 drop 路由移除 |

> 第二道测试不是可选项：DSH 的 boot 审计**没有 per-plugin 隔离**，
> 客户端 bundle 抛错会让整个 Web 应用无法 mount。

## 本 fork 相对上游的改动

上游基线 `dsh-command-queue@0.2.2`，本仓库在 `@deepseek-ai/dsh@0.2.1-rc.2` 上实测后改了两处：

| 改动 | 原因 |
|---|---|
| `isIdle()` 排除 `phase.kind === 'maintenance'` | 压缩进行中 `agent.status` 仍报 `idle`，但 `runMaintenance()` 会以 *already has active work* 拒绝。不排除的话，排队命令会在压缩期间被误判为空闲而唤醒，立刻撞回 busy |
| 队列条目新增 `running` 状态 | 从唤醒到 `execute()` 真正 settle 之间，条目仍留在快照里。面板据此显示**正在执行**而不是谎报「等待空闲」；执行中的行禁用移除按钮，host 侧 `dropQueued` 同步拒绝 |

完整改动见 `git diff 39845aa`。

## 兼容性

针对运行中的 `@deepseek-ai/dsh@0.2.1-rc.2` 实现，依据其源码逐行核对。
只使用公开面：`ctx.commands.execute/find/register`、`agent.status`、
`agent.ctx.on('agent/status')`、`ctx.connection.fetch.register`、`ctx.slots.*`。

> 读 `phase.kind` 判断 maintenance 是唯一一处非公开面依赖（TypeScript 的 `private` 在运行时只是普通属性）。
> 读不到时自动退化为只看 `status`，即上游原本的行为，不会因此报错。

> **上游仍未支持「忙时排队命令」**：`dsh-command-compact` 的官方文档明写
> *"the command itself is not queued"*，并把 *"Queued commands"* 列为
> *undecided / open direction*。若某天落地，本插件应默认停用 host 侧包装，
> 以免同一命令被排队两次。

## 许可

[MIT](./LICENSE) · 问题与建议欢迎提到 [Issues](https://github.com/archi-00007/dsh-compact-queue/issues)。
