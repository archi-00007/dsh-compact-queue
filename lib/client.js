/**
 * dsh-command-queue — 浏览器半边。
 *
 * 在 composer 的 dock 槽位 `conversation.input.dock` 上注册一个「命令队列」面板，
 * 与 DSH 原生消息队列（`QueueDock`，同槽 id `queue` / order 20）**并排显示**，
 * 视觉样式复刻 QueueDock。
 *
 * 本文件是**手写的 ModuleLoader bundle**（没有构建步骤）：
 * 形态取自 DSH 官方的客户端 bundle 约定 ——
 * `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => ... })`，
 * factory 返回的 exports 必须带 `name` / `inject` / `apply`，且**不能有 default**
 * （loader 的 `unwrapExports` 是 default-first，有 default 就会丢掉命名导出）。
 * 参照：`E:\dsh-wait-skill\skeletons\host-client-ui\lib\client.js`（本环境已构建验证）、
 * 官方 `dsh-client-ui-conversation/lib/client.js` 的 queue dock 注册
 * （0.1.7-alpha.2 位于 `:15535`，槽位声明在 `:17789`）。
 *
 * ⚠️ 客户端 bundle 抛错会让**整个 Web 应用无法 mount**（DSH 的 boot 审计没有
 * per-plugin 隔离）。因此这里所有入口都做了 try/catch 兜底：
 * `apply` 只做注册、组件内所有异步都自行吞错。
 *
 * 数据来自 host 半边的**已鉴权**路由 `/api/command-queue/state`（GET，轮询）
 * 与 `/api/command-queue/drop`（POST，移除一条排队命令）。
 * 这两个路由由 `/api` 前缀处理器分发，因此带 Host/Origin 围栏与签名 cookie 校验。
 */

window.__ModuleLoader__.load({
  id: 'dsh-command-queue',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** 由 bundle banner 提供的 free React（与官方客户端模块同一实现）。 */
    var React = require('react')

    /**
     * `useId` 降级：React 18+ 才有。万一宿主 React 更旧，退回一个稳定常量，
     * 保证组件不会在渲染期抛错（渲染期抛错可能连带打挂整个会话视图）。
     */
    var useId = typeof React.useId === 'function' ? React.useId : function () { return 'dshcq-list' }

    /** cordis 插件名。 */
    var name = 'command-queue-client'

    /** 只依赖槽位服务；缺它会停在 pending，不会让 boot 失败。 */
    var inject = ['slots']

    /** 队列快照轮询间隔（毫秒）。 */
    var POLL_INTERVAL_MS = 1500

    /** host 侧已鉴权路由。 */
    var STATE_PATH = '/api/command-queue/state'
    var DROP_PATH = '/api/command-queue/drop'

    /**
     * 原生 QueueDock 的 CSS 原文，类名统一换成 `dshcq_` 前缀以避免与官方 CSS 冲突。
     *
     * 来源：`dsh-client-ui-conversation/lib/client.js:15078` 的 `css$6`
     * （DSH 0.1.7 重做过这一版：面板底色改为 `isolation:isolate` + `:before`
     * 半透明菜单层、行高改 `min-height`、字号统一走 `--dsw-font-xs-13` token、
     * 图标按钮加 `corner-shape`）。本插件同步跟到 0.1.7。
     *
     * 设计变量（`--dsw-alias-*` / `--dsh-composer-*`）沿用全局主题，因此深色/浅色
     * 主题下与原生队列表现一致。原生面板另支持附件缩略图与就地编辑，本插件有意
     * 不跟进（保持「单行摘要 + 移除按钮」），故未复刻 `_attachments` / `_editor` 等规则。
     */
    var CSS = [
      '.dshcq_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto calc(0px - var(--dsh-composer-stack-gap) - 3px);padding:0 var(--dsh-composer-dock-inset);flex:none}',
      '.dshcq_panel{isolation:isolate;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px 12px 0 0;width:100%;padding:2px 0;position:relative;overflow:hidden}',
      '.dshcq_panel:before{z-index:-1;border-radius:inherit;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);content:"";pointer-events:none;position:absolute;inset:0}',
      '.dshcq_panel:after{border:.5px solid var(--dsw-alias-border-l1);border-radius:inherit;content:"";pointer-events:none;border-bottom:none;position:absolute;inset:0}',
      '.dshcq_header{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:none;border-radius:8px;align-items:center;gap:10px;padding:4px 12px;display:flex}',
      '.dshcq_header:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}',
      '.dshcq_header:disabled{cursor:default}',
      '.dshcq_lead{color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}',
      '.dshcq_count{min-width:0;font-family:Inter, var(--dsw-font-family);flex:auto;font-size:13px;font-weight:500;line-height:24px}',
      '.dshcq_chevron{width:14px;height:14px;color:var(--dsw-alias-label-tertiary);flex:none;place-items:center;display:grid}',
      '.dshcq_list{max-height:180px;margin:0;padding:0;list-style:none;overflow-y:auto}',
      '.dshcq_row{box-sizing:border-box;border-radius:8px;align-items:center;gap:10px;width:100%;min-height:36px;padding:4px 5px 4px 12px;display:flex}',
      '.dshcq_row+.dshcq_row{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}',
      '.dshcq_preview{min-width:0;color:var(--dsw-alias-label-primary-dimmed);font:var(--dsw-font-xs-13);font-family:Inter, var(--dsw-font-family);flex:auto;text-overflow:ellipsis;white-space:nowrap;word-break:break-word;overflow:hidden}',
      '.dshcq_status{color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xs-13);white-space:nowrap;flex:none}',
      '.dshcq_actions{flex:none;align-items:center;gap:10px;display:flex}',
      '.dshcq_action{corner-shape:round;width:28px;height:28px;color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;place-items:center;padding:0;display:grid}',
      '.dshcq_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshcq_action:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}',
      '.dshcq_action:disabled{cursor:default;opacity:.45}',
    ].join('')

    /** 把样式插进 <head>（幂等；同一 tag 已存在就跳过）。 */
    function installStyles() {
      try {
        if (typeof document === 'undefined') return
        var tagId = 'dsh-command-queue/CommandQueueDock.css'
        if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
        var tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-command-queue'
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (error) {
        console.error('[dsh-command-queue] style install failed:', error)
      }
    }

    /** 内联队列图标（不依赖 primitives 模块，避免未验证的导出名）。 */
    function QueueIcon() {
      return React.createElement(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('path', {
          d: 'M2 3.5h10M2 7h10M2 10.5h6',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      )
    }

    /** 折叠指示箭头。 */
    function Chevron(props) {
      return React.createElement(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('path', {
          d: props.up === true ? 'M3.5 8.5 7 5l3.5 3.5' : 'M3.5 5.5 7 9l3.5-3.5',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** 移除按钮的叉形图标。 */
    function CloseIcon() {
      return React.createElement(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true' },
        React.createElement('path', {
          d: 'M4 4l6 6M10 4l-6 6',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * 命令队列面板。
     *
     * props 来自 `slots.register({ inject: (sessionId) => ({ sessionId }) })`：
     * 槽位注册的 inject 返回值就是传给组件的 props。
     *
     * @param props - `{ sessionId }`。
     * @returns 面板元素；队列为空时返回 null（零视觉占用）。
     */
    function CommandQueueDock(props) {
      var sessionId = props !== null && props !== undefined && typeof props.sessionId === 'string' ? props.sessionId : ''

      var rowsState = React.useState([])
      var rows = rowsState[0]
      var setRows = rowsState[1]

      var collapsedState = React.useState(true)
      var collapsed = collapsedState[0]
      var setCollapsed = collapsedState[1]

      var busyState = React.useState(null)
      var busy = busyState[0]
      var setBusy = busyState[1]

      var listId = useId()

      // 轮询 host 快照。挂载期间每 POLL_INTERVAL_MS 一次；卸载即停。
      React.useEffect(
        function () {
          var alive = true
          var timer = undefined

          var tick = function () {
            var url = STATE_PATH + '?sessionId=' + encodeURIComponent(sessionId)
            fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
              .then(function (response) {
                if (!response.ok) return null
                return response.json()
              })
              .then(function (data) {
                if (!alive || data === null || data === undefined) return
                setRows(Array.isArray(data.items) ? data.items : [])
              })
              .catch(function () {
                // 网络/鉴权失败：保持上一次快照，下一轮再试。绝不抛到 boot。
              })
              .then(function () {
                if (alive) timer = setTimeout(tick, POLL_INTERVAL_MS)
              })
          }

          tick()
          return function () {
            alive = false
            if (timer !== undefined) clearTimeout(timer)
          }
        },
        [sessionId],
      )

      var rowCount = rows.length
      // 已经离开等待队列、正在执行（例如压缩进行中）的条目。
      var runningCount = rows.filter(function (row) { return row.running === true }).length

      React.useEffect(
        function () {
          if (rowCount === 0 && !collapsed) setCollapsed(true)
        },
        [rowCount, collapsed],
      )

      if (rowCount === 0) return null

      var expanded = !collapsed || busy !== null
      var listVisible = rowCount === 1 || expanded

      var remove = function (id) {
        setBusy(id)
        fetch(DROP_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sessionId, id: id }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + String(response.status))
            return response.json()
          })
          .then(function () {
            // 立即本地移除，不等下一轮轮询，交互更跟手。
            setRows(function (current) {
              return current.filter(function (row) {
                return row.id !== id
              })
            })
          })
          .catch(function (error) {
            console.error('[dsh-command-queue] drop failed:', error)
          })
          .then(function () {
            setBusy(function (current) {
              return current === id ? null : current
            })
          })
      }

      var children = []

      if (rowCount > 1) {
        children.push(
          React.createElement(
            'button',
            {
              key: 'header',
              type: 'button',
              className: 'dshcq_header',
              'aria-controls': listId,
              'aria-expanded': expanded,
              disabled: busy !== null,
              onClick: function () {
                setCollapsed(function (value) {
                  return !value
                })
              },
            },
            React.createElement('span', { className: 'dshcq_lead', 'aria-hidden': true, key: 'lead' }, React.createElement(QueueIcon)),
            React.createElement('span', { className: 'dshcq_count', key: 'count' }, '已排队命令 · ' + String(rowCount)),
            expanded
              ? null
              : React.createElement(
                  'span',
                  { className: 'dshcq_status', key: 'status' },
                  runningCount > 0 ? (runningCount === 1 ? '正在执行' : String(runningCount) + ' 个正在执行') : '等待 agent 空闲',
                ),
            React.createElement(
              'span',
              { className: 'dshcq_chevron', 'aria-hidden': true, key: 'chevron' },
              React.createElement(Chevron, { up: expanded }),
            ),
          ),
        )
      }

      var items = listVisible
        ? rows.map(function (row) {
            var label = typeof row.line === 'string' && row.line.length > 0 ? row.line : '/' + String(row.name)
            var rowChildren = []
            if (rowCount === 1) {
              rowChildren.push(
                React.createElement('span', { className: 'dshcq_lead', 'aria-hidden': true, key: 'lead' }, React.createElement(QueueIcon)),
              )
            }
            rowChildren.push(
              React.createElement('span', { className: 'dshcq_preview', key: 'preview', title: label }, label),
            )
            if (rowCount === 1) {
              rowChildren.push(
                React.createElement(
                  'span',
                  { className: 'dshcq_status', key: 'status' },
                  row.running === true ? '正在执行…' : '等待空闲',
                ),
              )
            }
            rowChildren.push(
              React.createElement(
                'span',
                { className: 'dshcq_actions', key: 'actions' },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dshcq_action',
                    title: row.running === true ? '正在执行，无法移除' : '从队列移除',
                    'aria-label': (row.running === true ? '正在执行，无法移除 ' : '从队列移除 ') + label,
                    disabled: busy === row.id || row.running === true,
                    onClick: function () {
                      remove(row.id)
                    },
                  },
                  React.createElement(CloseIcon),
                ),
              ),
            )
            return React.createElement('li', { className: 'dshcq_row', key: row.id }, rowChildren)
          })
        : []

      children.push(
        React.createElement('ul', { key: 'list', id: listId, className: 'dshcq_list', hidden: !listVisible }, items),
      )

      return React.createElement(
        'div',
        { className: 'dshcq_dock', 'data-command-queue-dock': '' },
        React.createElement('div', { className: 'dshcq_panel' }, children),
      )
    }

    /**
     * 注册队列面板。
     *
     * 槽位 `conversation.input.dock` 是 **list** 槽：自带 id 的贡献会**追加**在
     * 官方条目旁边（原生队列 id `queue` / order 20），`order: 30` 让我们排在它后面。
     * `slots.inject` 在槽位尚未声明时挂起、声明后自动执行，所以加载顺序无关。
     *
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      try {
        installStyles()
        ctx.slots.inject('conversation.input.dock', function () {
          return ctx.slots.register(
            {
              name: 'conversation.input.dock',
              id: 'command-queue',
              order: 30,
              inject: function (sessionId) {
                return { sessionId: sessionId }
              },
            },
            CommandQueueDock,
          )
        })
      } catch (error) {
        // boot 审计会因客户端插件抛错而整体失败，这里必须自吞。
        console.error('[dsh-command-queue] client apply failed:', error)
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
