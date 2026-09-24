/**
 * dsh-command-queue — 让斜杠命令在 agent 忙碌时"进入队列"，空闲后自动执行。
 *
 * ## 问题
 *
 * DSH 里有两条完全不同的输入通道：
 *
 * - **普通消息**：客户端 `session.prompt({ mode })` → host `agent.followup()` /
 *   `agent.steer()` → 写进 agent 的 inbox（`next-turn` / `next-step`）。
 *   agent 忙时天然排队，等当前回合结束再被消费。
 * - **斜杠命令**：客户端 `remote.commands.execute()` → host
 *   `ctx.commands.execute(agent, line, ...)` → **立即**调用注册表里的 handler。
 *   它完全不经过 inbox，因此没有任何排队语义。
 *
 * `/compact` 的 handler 调 `ctx.compaction.compactNow()` → `agent.runMaintenance()`，
 * 后者的同步 gate 是 `if (this.phase.kind !== 'idle') throw`，被包成
 * `ManualCompactionError('busy')`。于是忙碌时敲 `/compact` 只会立刻收到一句
 * "Compaction is unavailable because this process has an active compaction,
 *  or the agent is not idle."——既没排队，也没有任何重试。
 *
 * DSH 作者把这个行为当作有意设计记录在案（Agent Note："Queue the command
 * itself. Rejected."），所以官方没有开关。本插件在**不改 DSH 源码**的前提下
 * 补上这一段。
 *
 * ## 做法
 *
 * 包装 host 侧 `ctx.commands.execute()`。
 *
 * **为什么有效**：typert gateway 在 `prepareInvocation()` 里每次调用都执行
 * `Reflect.get(receiver, descriptor.implementation ?? descriptor.method)`，
 * 而 `commands/execute` 的 strict descriptor 只声明 `method: 'execute'`
 * （不含方法引用），descriptor 从不缓存函数。所以在服务实例上替换 `execute`
 * 会被后续所有请求采纳，`agentId` 参数解析、参数校验、结果 schema 全不变。
 *
 * **两个必须注意的实现细节**（都踩过）：
 *
 * 1. `ctx.commands` 是 cordis 的 **traceable Proxy**，每次 `ctx.get` 都新建；
 *    get trap 对函数值返回一层新的 shadow proxy，所以
 *    `ctx.commands.execute === patched` 这种身份比较**恒为 false**。
 *    因此这里经 `Symbol.for('cordis.original')` 拿到 raw 实例，
 *    用 `Object.getOwnPropertyDescriptor` 记录原状、精确 patch、精确还原。
 * 2. `AgentLoop.kick()` 的 finally 是
 *    `setPhase({kind:'idle'})`（**同步** emit `agent/status`）→ `wakeDriver()`。
 *    也就是说 idle 事件派发后，同一个同步块里 agent 可能立刻被 inbox 里的
 *    排队消息拉回 running。任何跨 promise 边界后再调用命令都会撞回 busy。
 *    所以下面的循环把「检查 `agent.status === 'idle'`」和「调用 `run()`」
 *    放在**同一个同步块**内，中间绝不 `await`。
 *
 * **谁会被排队**（v0.2.2 起是白名单，不再"除少数外全排"）：
 * 只有被明确列入 `deferCommands` 的命令才排队，默认**只有 `compact`** ——
 * 它是唯一"忙时必然失败"的命令（`compactNow` → `runMaintenance` 的
 * `phase.kind !== 'idle'` 同步 gate）。
 *
 * `/permission`（切权限预设）、`/plan`、`/goal` 这类**改会话状态**的命令必须在
 * 忙碌时立刻生效：把它们排到回合结束，用户当下就改不了权限、进不了计划模式，
 * 功能等于失效。查看/IO 类命令同理。
 *
 * 被包装的调用在以下**任一**条件下照旧立即执行，行为零变化：
 *   - 不是合法命令语法；
 *   - 命令名**不在** `deferCommands` 里（默认即绝大多数命令）；
 *   - 命令名在强制立即名单里（内置 `/stop` 这类控制动词，或用户配置的
 *     `immediateCommands` / `alwaysImmediateCommands`）；
 *   - 命令名在注册表里解析不到（`ctx.commands.find()` 返回 `undefined`）；
 *   - agent 当前就是 idle。
 *
 * 只有"合法 + 在 deferCommands + 未被强制立即 + 已注册 + agent 正忙"的调用
 * 才进入该 agent 的 FIFO 队列，等 agent 回到 idle 后**按原顺序依次**调用原方法。
 * 命令仍由原注册表解析，仍由 `CommandRuntime` 写 `command/run` + `command/done`
 * 生命周期日志，只是执行时机被推迟到空闲窗口。
 *
 * ## client 半边
 *
 * 本包的 `lib/client.js`（`exports["./client"]`）在浏览器里把这份队列渲染成
 * 一个**复刻 DSH 原生消息队列（QueueDock）视觉风格**的面板，挂在同一个槽位
 * `conversation.input.dock` 上（原生队列 id `queue` / order 20，本插件
 * id `command-queue` / order 30，并排显示）。
 *
 * 数据通道是 `ctx.connection.fetch.register()` 注册的**已鉴权**路由
 * `/api/command-queue/state`（GET）与 `/api/command-queue/drop`（POST）：
 * 它们由 `/api` 前缀处理器分发，因此先过 `requestRejection()` 的
 * Host/Origin 围栏与浏览器签名 cookie 校验。
 * 刻意不用裸 `ctx.webServer.register()` —— 那条路径**完全绕过鉴权**。
 *
 * ## 卸载
 *
 * 插件卸载时精确还原 `execute` 并唤醒所有等待者：已经排队的用户命令
 * 立刻按原顺序执行完，而不是被静默丢弃，也不会留下悬挂的 RPC。
 *
 * @module dsh-command-queue
 */

/** cordis 插件名（loader 用）。 */
export const name = 'command-queue'

/**
 * 只依赖命令注册表。`agent/status` 事件从 `agent.ctx` 上监听，
 * 不需要额外注入 `agents` 服务；`connection` 是可选依赖，用 `ctx.inject` 探测。
 */
export const inject = ['commands']

/** cordis traceable Proxy 上指向 raw 实例的注册符号。 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/** client 半边读取队列快照的已鉴权路由（由 /api 前缀处理器分发）。 */
const STATE_PATH = '/api/command-queue/state'

/** client 半边请求移除一条排队命令的已鉴权路由。 */
const DROP_PATH = '/api/command-queue/drop'

/**
 * 内置的"强制立即"名单：这些控制动词排队会失去意义甚至造成危险
 * （例如忙碌时敲 `/stop` 本该立刻中断当前回合）。永远立即执行。
 */
const DEFAULT_IMMEDIATE = ['stop', 'cancel', 'abort', 'interrupt', 'halt']

/**
 * 默认的"需要空闲才排队"白名单。
 *
 * **默认只有 `compact`**：`/compact` 的 handler 走 `agent.runMaintenance()`，
 * 其同步 gate 是 `phase.kind !== 'idle'`，忙时必然失败 —— 这是本插件诞生的
 * 唯一真实场景。
 *
 * 反过来把"除少数外全排"当默认是错的：`/permission`（切权限预设）、`/plan`、
 * `/goal` 都是**改会话状态**的命令，被推迟到回合结束后就完全失去意义
 * （想在 agent 忙着时放宽权限去批准操作，却改不动）。未知的第三方命令同理：
 * 默认一律立即执行，确实需要排队时由用户显式加进 `deferCommands`。
 */
const DEFAULT_DEFER = ['compact']

/**
 * 命令语法（与 `@deepseek-ai/dsh-commands` 的 `parseCommand` 同构，从严判定）：
 * 第 0 字节必须是斜杠，随后是小写名称（字母/数字/`_`/`-`），再之后是输入末尾或空白。
 * 从严判定的好处是：判不出来就回落成原行为，绝不误排队。
 */
const COMMAND_PATTERN = /^\/([a-z0-9_-]+)(?=$|\s)/

/**
 * 解析一行候选命令。
 * @param line - 客户端提交的完整命令行。
 * @returns 命令名与其后的原始输入；不是命令时返回 `undefined`。
 */
function parseCommand(line) {
  if (typeof line !== 'string' || line.length === 0 || line[0] !== '/') return undefined
  const matched = COMMAND_PATTERN.exec(line)
  if (matched === null) return undefined
  const commandName = matched[1]
  return { name: commandName, rawInput: line.slice(1 + commandName.length) }
}

/**
 * 穿透 cordis traceable Proxy 拿到 raw 服务实例。
 * 拿不到时回落成传入值（此时 set/get 都走 Proxy，语义仍然正确）。
 * @param service - `ctx.commands`（可能是 Proxy）。
 * @returns 可直接 `defineProperty` 的目标对象。
 */
function resolveRawTarget(service) {
  try {
    const raw = service?.[CORDIS_ORIGINAL]
    if (raw !== null && raw !== undefined && typeof raw === 'object') return raw
  } catch {
    // 取不到就用 Proxy 本身
  }
  return service
}

/**
 * 读取并规范化插件配置。没有 schema：直接容错读取，缺省即默认行为。
 * @param config - loader 传入的原始配置对象（可能为 undefined）。
 * @returns 规范化后的选项。
 */
function readOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}

  // 排队白名单：默认只有 compact。显式传空数组 = 没有任何命令排队（等于关掉排队）。
  const defer = new Set()
  const deferSource = Array.isArray(raw.deferCommands) ? raw.deferCommands : DEFAULT_DEFER
  for (const entry of deferSource) {
    if (typeof entry === 'string' && entry.length > 0) defer.add(entry.replace(/^\//, ''))
  }

  // 强制立即名单：内置安全动词 + 用户配置，**取并集** —— 即使某命令同时列在
  // deferCommands 里也立即执行。注意 v0.2.1 及以前 `immediateCommands` 是
  // "整体替换"内置名单，v0.2.2 起改为并集（CHANGELOG 里的破坏性变更）。
  const immediate = new Set(DEFAULT_IMMEDIATE)
  for (const key of ['immediateCommands', 'alwaysImmediateCommands']) {
    const list = raw[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (typeof entry === 'string' && entry.length > 0) immediate.add(entry.replace(/^\//, ''))
    }
  }

  const pollIntervalMs = Number.isFinite(raw.pollIntervalMs)
    ? Math.min(5000, Math.max(50, Number(raw.pollIntervalMs)))
    : 250
  return {
    defer,
    immediate,
    pollIntervalMs,
    verbose: raw.verbose === true,
    exposeState: raw.exposeState !== false,
  }
}

/**
 * agent 是否空闲。`AgentStatus` 只有 `'idle' | 'running'` 两种取值。
 *
 * 注意：`status === 'idle'` 并**不蕴含** `runMaintenance` 一定能进
 * （`phase.kind === 'maintenance'` 期间 status 也是 idle 且不发事件），
 * 那种竞态只能靠 `compactNow` 自己的 busy 报错暴露，本插件不掩盖它。
 *
 * @param agent - 接收命令的 agent。
 * @returns 布尔值；拿不到状态时按"不空闲"处理（宁可排队，不可抢跑）。
 */
function isIdle(agent) {
  return agent?.status === 'idle'
}

/**
 * 等这个 agent 回到 idle。
 *
 * 两条腿同时走：`agent/status` 事件（拿到最早的转换时机）与一个轮询兜底
 * （事件作用域若不在 `agent.ctx` 上也能收敛）。`signal` 中止、条目被移除、
 * 或插件卸载（`state.released`）时立即返回。
 *
 * @param agent - 目标 agent。
 * @param signal - 派发这次命令的 UI 请求的取消信号。
 * @param options - 规范化选项。
 * @param state - 该 agent 的队列状态；卸载/移除时用它唤醒等待者。
 * @returns 空闲（或已取消/已释放）时 resolve 的 Promise。
 */
function waitUntilIdle(agent, signal, options, state) {
  if (state.released || signal?.aborted === true) return Promise.resolve()
  if (isIdle(agent)) return Promise.resolve()

  return new Promise((resolve) => {
    let settled = false
    let dispose = undefined
    let timer = undefined

    const finish = () => {
      if (settled) return
      settled = true
      state.wakeups.delete(finish)
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch {
          // disposer 失败不影响收敛
        }
      }
      if (timer !== undefined) clearTimeout(timer)
      try {
        signal?.removeEventListener?.('abort', finish)
      } catch {
        // 忽略：signal 实现不完整时也不阻塞
      }
      resolve()
    }

    state.wakeups.add(finish)

    const observe = () => {
      if (isIdle(agent)) finish()
    }

    try {
      const scope = agent?.ctx
      if (scope !== undefined && typeof scope.on === 'function') {
        dispose = scope.on('agent/status', observe)
      }
    } catch {
      // 事件不可用：交给下面的轮询兜底
    }

    const tick = () => {
      if (settled) return
      if (isIdle(agent)) {
        finish()
        return
      }
      timer = setTimeout(tick, options.pollIntervalMs)
    }
    timer = setTimeout(tick, options.pollIntervalMs)

    try {
      signal?.addEventListener?.('abort', finish, { once: true })
    } catch {
      // 忽略
    }
  })
}

/**
 * 为一个 agent 取出（或建立）队列状态，并登记会话索引。
 * @param queues - agent → 队列状态的表。
 * @param bySession - sessionId → 队列状态的索引（client 半边按会话查询）。
 * @param agent - 目标 agent。
 * @returns 可变的队列状态。
 */
function stateFor(queues, bySession, agent) {
  let state = queues.get(agent)
  if (state === undefined) {
    const sessionId = agent?.session?.id
    state = {
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      chain: Promise.resolve(),
      entries: [],
      wakeups: new Set(),
      released: false,
    }
    queues.set(agent, state)
    if (state.sessionId !== undefined) bySession.set(state.sessionId, state)
  }
  return state
}

/** 吞掉 settle 结果，仅供链式占位。 */
function noop() {}

/**
 * 把一次命令调用排进该 agent 的 FIFO 队列。
 *
 * `state.chain` 保证同一 agent 内**严格串行**：第 N 个命令只有在第 N-1 个
 * 命令 settle 之后才开始等空闲，因此多个 `/compact` 不会挤进同一个空闲窗口。
 *
 * @param ctx - 插件上下文（日志用）。
 * @param queues - agent → 队列状态的表。
 * @param bySession - sessionId → 队列状态的索引。
 * @param agent - 接收命令的 agent。
 * @param parsed - 解析出的命令名。
 * @param line - 原始命令行（client 面板展示用）。
 * @param run - 真正调用原 `execute` 的 thunk。
 * @param signal - UI 请求的取消信号。
 * @param options - 规范化选项。
 * @param log - 日志函数。
 * @param mintId - 条目 id 生成器。
 * @returns 与未排队时同形的命令执行结果。
 */
function enqueue(ctx, queues, bySession, agent, parsed, line, run, signal, options, log, mintId) {
  const state = stateFor(queues, bySession, agent)
  const entry = { id: mintId(), name: parsed.name, line, queuedAt: Date.now() }
  state.entries.push(entry)
  log(`queued /${parsed.name} for session ${state.sessionId ?? '(unknown)'} — ${state.entries.length} waiting`)

  const release = () => {
    const index = state.entries.indexOf(entry)
    if (index >= 0) state.entries.splice(index, 1)
    if (state.entries.length === 0) {
      queues.delete(agent)
      if (state.sessionId !== undefined && bySession.get(state.sessionId) === state) {
        bySession.delete(state.sessionId)
      }
    }
  }

  const result = (async () => {
    // 严格 FIFO：先等前一个排队命令 settle（读的是入队这一刻的链尾）。
    await state.chain
    for (;;) {
      if (signal?.aborted === true) {
        return { kind: 'error', text: `/${entry.name} was cancelled before it could run.` }
      }
      if (entry.removed === true) {
        return { kind: 'error', text: `/${entry.name} was removed from the command queue.` }
      }
      // ↓↓↓ 关键：`isIdle` 检查与 `run()` 必须落在同一个同步块里。
      //    中间任何 await 都会给 AgentLoop.kick() finally 里的 wakeDriver()
      //    可乘之机，把 agent 拉回 running，于是 compactNow 又拿到 busy。
      if (state.released || isIdle(agent)) {
        log(`running queued /${entry.name} for session ${state.sessionId ?? '(unknown)'}`)
        return run()
      }
      // 还没空闲（或刚被 wakeDriver 拉回 running）：等下一个空闲窗口，然后再查一次。
      await waitUntilIdle(agent, signal, options, state)
    }
  })()

  // chain 永不 reject，否则后续排队项会被永久卡住。
  state.chain = result.then(noop, noop)
  result.then(release, release)
  return result
}

/**
 * 从 client 半边移除一条排队命令：标记移除并唤醒等待者，
 * 等待循环随即返回一个 error 结果（命令不会被执行）。
 *
 * @param bySession - sessionId → 队列状态的索引。
 * @param sessionId - 目标会话。
 * @param id - 队列条目 id。
 * @returns 是否移除了一个在队条目。
 */
function dropQueued(bySession, sessionId, id) {
  const state = bySession.get(sessionId)
  if (state === undefined) return false
  const entry = state.entries.find((candidate) => candidate.id === id)
  if (entry === undefined) return false
  entry.removed = true
  const index = state.entries.indexOf(entry)
  if (index >= 0) state.entries.splice(index, 1)
  for (const wake of [...state.wakeups]) wake()
  return true
}

/**
 * 安装插件。
 * @param ctx - host 根上下文（已满足 `commands` 注入）。
 * @param config - 可选配置，见 README。
 */
export function apply(ctx, config) {
  const options = readOptions(config)
  /** @type {Map<object, {sessionId?: string, chain: Promise<unknown>, entries: object[], wakeups: Set<() => void>, released: boolean}>} */
  const queues = new Map()
  /** @type {Map<string, object>} */
  const bySession = new Map()
  let sequence = 0
  const mintId = () => `cq${++sequence}`

  const log = (message) => {
    if (!options.verbose) return
    try {
      ctx.logger?.info?.(`[command-queue] ${message}`)
    } catch {
      // 日志失败绝不影响命令
    }
  }

  /** 当前会话的队列快照（client 面板的数据源）。 */
  const snapshot = (sessionId) => {
    const state = typeof sessionId === 'string' ? bySession.get(sessionId) : undefined
    if (state === undefined) return { ok: true, items: [] }
    return {
      ok: true,
      items: state.entries.map((entry) => ({
        id: entry.id,
        name: entry.name,
        line: entry.line,
        queuedAt: entry.queuedAt,
      })),
    }
  }

  // 包装执行入口。返回的 disposer 会在插件卸载/重载时精确还原原方法。
  ctx.effect(() => {
    const target = resolveRawTarget(ctx.commands)
    const previous = Object.getOwnPropertyDescriptor(target, 'execute')
    const original = target.execute
    if (typeof original !== 'function') {
      ctx.logger?.warn?.('[command-queue] ctx.commands.execute is not callable; plugin inactive')
      return () => {}
    }

    const patched = function execute(agent, line, submittedAttachments, signal) {
      const run = () => original.call(target, agent, line, submittedAttachments, signal)
      try {
        const parsed = parseCommand(line)
        if (parsed === undefined) return run()
        // 主闸门：只有明确"需要 agent 空闲"的命令才排队（默认仅 /compact）。
        // `/permission`（切权限预设）、`/plan`、`/goal` 这类**改会话状态**的命令
        // 必须在忙碌时立刻生效——排到回合结束等于功能失效。所以默认规则是
        // "只排 deferCommands"，而不是 v0.2.1 及以前的"除立即白名单外全排"。
        if (!options.defer.has(parsed.name)) return run()
        if (options.immediate.has(parsed.name)) return run()
        // 解析不到的命令名交给原实现（它会返回 undefined，客户端按未命中处理），
        // 绝不因为"看起来像命令"就把一次注定失败的调用拖到空闲之后。
        if (ctx.commands.find(agent, parsed.name) === undefined) return run()
        if (isIdle(agent)) return run()
        return enqueue(ctx, queues, bySession, agent, parsed, line, run, signal, options, log, mintId)
      } catch (error) {
        // 排队逻辑自身出错时绝不能吞掉命令：回落成原行为。
        ctx.logger?.warn?.('[command-queue] deferral failed; running the command immediately:', error)
        return run()
      }
    }

    // 用 defineProperty 精确覆盖：记录下来的 previous 描述符是还原的唯一依据
    // （不能用 `target.execute === patched` 判定，traceable Proxy 每次返回新函数）。
    Object.defineProperty(target, 'execute', {
      value: patched,
      writable: true,
      enumerable: false,
      configurable: true,
    })
    log('wrapped ctx.commands.execute')

    return () => {
      if (previous === undefined) delete target.execute
      else Object.defineProperty(target, 'execute', previous)
      // 唤醒所有等待者：已排队的用户命令随即按原顺序执行完，不会被丢弃。
      for (const state of queues.values()) {
        state.released = true
        for (const wake of [...state.wakeups]) wake()
      }
      queues.clear()
      bySession.clear()
      log('restored ctx.commands.execute')
    }
  }, 'dsh-command-queue: wrap ctx.commands.execute')

  // 可见性（纯文本路径）：`/cmdqueue` 报告当前 agent 还排着哪些命令。
  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'cmdqueue',
        description: 'Show slash commands waiting for this agent to become idle',
        handler: (invocation) => {
          const state = queues.get(invocation.agent)
          if (state === undefined || state.entries.length === 0) {
            return { kind: 'success', text: 'No queued commands for this agent.' }
          }
          const list = state.entries.map((entry) => `/${entry.name}`).join(', ')
          return {
            kind: 'success',
            text: `${state.entries.length} command(s) queued for this agent, waiting for it to become idle: ${list}`,
          }
        },
      }),
    'dsh-command-queue: /cmdqueue',
  )

  // 可见性（浏览器路径）：把队列快照与被鉴权的移除操作暴露给 client 半边。
  //
  // 刻意使用 `connection.fetch`：它注册进 `/api` 共享路由表，由 `/api` 前缀
  // 处理器分发，因此**先过** `requestRejection()`（Host/Origin 围栏 + 浏览器
  // 签名 cookie）。裸 `ctx.webServer.register()` 会绕过全部鉴权，不用。
  if (options.exposeState && typeof ctx.inject === 'function') {
    ctx.inject(['connection'], (connectionCtx) => {
      connectionCtx.effect(
        () =>
          connectionCtx.connection.fetch.register({
            path: STATE_PATH,
            methods: ['GET', 'HEAD'],
            requestBody: 'buffered',
            fetch: (request) => {
              const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
              const body = JSON.stringify(snapshot(sessionId))
              return Promise.resolve(
                new Response(request.method === 'HEAD' ? null : body, {
                  status: 200,
                  headers: {
                    'content-type': 'application/json; charset=utf-8',
                    'cache-control': 'no-store',
                  },
                }),
              )
            },
          }),
        'dsh-command-queue: state route',
      )

      connectionCtx.effect(
        () =>
          connectionCtx.connection.fetch.register({
            path: DROP_PATH,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              let payload
              try {
                payload = await request.json()
              } catch {
                return new Response(JSON.stringify({ ok: false, error: 'invalid-json' }), {
                  status: 400,
                  headers: { 'content-type': 'application/json; charset=utf-8' },
                })
              }
              const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
              const id = typeof payload?.id === 'string' ? payload.id : ''
              const dropped = dropQueued(bySession, sessionId, id)
              return new Response(JSON.stringify({ ok: true, dropped }), {
                status: 200,
                headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
              })
            },
          }),
        'dsh-command-queue: drop route',
      )
    })
  }
}
