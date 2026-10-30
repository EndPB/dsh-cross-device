/**
 * dsh-cross-device browser half: node network panel, shared session viewer,
 * settings, and provenance badges. Plain host-styled React; works inside
 * DSHA's local DSH WebView.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-cross-device',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const CHANNEL = '/dsh-cross-device'
    const NS = 'dsh-cross-device'

    const DICTS = {
      zh: {
        nav: '节点网络', title: '节点网络',
        lead: '同一会话可以在多台设备上执行工具。这里只管理节点与来源；会话仍在左侧工作区。', leadNodesOnly: '这里只管理节点、连接与来源。会话请在左侧工作区新建和管理。',
        nodes: '节点', sessions: '共享会话', settings: '设置', online: '在线', offline: '离线',
        coordinator: '当前执行', share: '共享到节点网络', takeover: '在本机接管', messages: '消息',
        send: '发送', sending: '发送中…', promptPlaceholder: '向这个共享会话发送消息…',
        noSessions: '还没有共享会话。在会话菜单里选择“共享到节点网络”。',
        noNodes: '还没有其他节点。先在另一台设备上安装并连接同一 GitHub 配置仓库。',
        localSessions: '会话', shareSelected: '共享', newSession: '新建会话', space: '共享区', refresh: '刷新',
        connected: '已连接', disconnected: '未连接', save: '保存', saved: '已保存',
        githubRepo: '配置仓库', githubToken: 'GitHub Token（只存本机）', githubSection: 'GitHub 配置服务器', githubLogin: '登录 GitHub', githubSignedIn: '已登录', githubNotSignedIn: '未登录，点按钮自动读取本机 git 凭据', githubRepoAuto: '登录后自动使用 dsh-cross-device-config', hubSection: '连接方式', hubLan: '局域网（默认，自动发现）', hubCustom: '自定义地址（cpolar / 公网）',
        hubUrl: 'Hub 地址', runLocalHub: '在本机启动 Hub', nodeName: '本机节点名',
        allowAny: '允许任意节点（仅本地测试）', capabilities: '能力', provenance: '来源记录',
        answeredOn: '回答于', toolsOn: '工具', from: '来自', you: '你', load: '加载中…',
        error: '出错了', noHub: '未连接 Hub', fingerprint: '指纹', session: '会话',
        toolCall: '工具调用', toolResult: '工具结果', coordinatorBadge: '执行节点',
        provenanceHint: '来源显示在该 turn 的尾部；远端消息开头会带设备标记。',
      },
      en: {
        nav: 'Nodes', title: 'Node Network',
        lead: 'One session can run tools on many devices. This page manages nodes only; sessions stay in the workspace.',
        leadNodesOnly: 'Nodes, connection and provenance only. Create and manage sessions from the workspace.',
        nodes: 'Nodes', sessions: 'Shared sessions', settings: 'Settings', online: 'Online', offline: 'Offline',
        coordinator: 'Coordinator', share: 'Share to node network', takeover: 'Take over here', messages: 'Messages',
        send: 'Send', sending: 'Sending…', promptPlaceholder: 'Message this shared session…',
        noSessions: 'No shared sessions yet. Use “Share to node network” in a session menu.',
        noNodes: 'No other nodes yet. Install the plugin on another device and connect the same GitHub config repo.',
        localSessions: 'Sessions', shareSelected: 'Share', newSession: 'New session', space: 'Space', refresh: 'Refresh',
        connected: 'Connected', disconnected: 'Disconnected', save: 'Save', saved: 'Saved',
        githubRepo: 'Config repo', githubToken: 'GitHub token (stored locally)', githubSection: 'GitHub config server', githubLogin: 'Sign in to GitHub', githubSignedIn: 'Signed in', githubNotSignedIn: 'Not signed in - the button reuses this machine git credential', githubRepoAuto: 'uses dsh-cross-device-config automatically', hubSection: 'Connection', hubLan: 'LAN (default, auto)', hubCustom: 'Custom URL (cpolar/public)',
        hubUrl: 'Hub URL', runLocalHub: 'Run hub on this node', nodeName: 'This node name',
        allowAny: 'Allow any node (local testing only)', capabilities: 'Capabilities', provenance: 'Provenance',
        answeredOn: 'Answered on', toolsOn: 'Tools', from: 'from', you: 'you', load: 'Loading…',
        error: 'Something went wrong', noHub: 'Hub not connected', fingerprint: 'Fingerprint', session: 'Session',
        toolCall: 'Tool call', toolResult: 'Tool result', coordinatorBadge: 'Coordinator',
        provenanceHint: 'Provenance appears in each turn tail; remote messages start with a device marker.',
      },
    }

    const CSS = `
      .nf-root{display:flex;flex-direction:column;gap:12px;width:100%;max-width:980px;min-width:0;color:var(--dsw-alias-label-primary);padding:16px 16px calc(20px + env(safe-area-inset-bottom));box-sizing:border-box}
      .nf-title{font-size:20px;font-weight:650;margin:0}
      .nf-lead{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;margin:0}
      .nf-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .nf-card{border:1px solid var(--dsw-alias-border-secondary);border-radius:10px;background:var(--dsw-alias-bg-secondary);padding:12px;display:flex;flex-direction:column;gap:10px;min-width:0}
      .nf-section-title{font-size:14px;font-weight:650;margin:0}
      .nf-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
      .nf-pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 8px;font-size:11px;border:1px solid var(--dsw-alias-border-secondary);color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .nf-dot{width:7px;height:7px;border-radius:50%;background:#ef4444}
      .nf-dot.online{background:#22c55e}
      .nf-btn{border:1px solid var(--dsw-alias-border-secondary);border-radius:8px;background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary);padding:8px 12px;font-size:13px;cursor:pointer;min-height:36px}
      .nf-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
      .nf-btn:disabled{opacity:.5;cursor:not-allowed}
      .nf-input,.nf-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-secondary);border-radius:8px;background:var(--dsw-alias-bg-primary);color:var(--dsw-alias-label-primary);padding:9px 10px;font-size:13px;font-family:inherit}
      .nf-textarea{min-height:76px;resize:vertical}
      .nf-list{display:flex;flex-direction:column;gap:8px}
      .nf-item{border:1px solid var(--dsw-alias-border-secondary);border-radius:9px;padding:10px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-primary);min-width:0;cursor:pointer}
      .nf-item.selected{border-color:var(--dsw-alias-brand-primary)}
      .nf-item-head{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}
      .nf-item-title{font-size:13px;font-weight:600;overflow-wrap:anywhere}
      .nf-item-sub{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
      .nf-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:12px}
      .nf-msg{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-secondary)}
      .nf-msg:last-child{border-bottom:0}
      .nf-msg-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
      .nf-msg-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.55}
      .nf-pre{white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,Consolas,monospace;font-size:11px;max-height:260px;overflow:auto;background:var(--dsw-alias-bg-tertiary);padding:8px;border-radius:6px;margin:4px 0 0}
      .nf-badge{font-size:10px;border-radius:5px;padding:1px 6px;border:1px solid var(--dsw-alias-border-secondary);color:var(--dsw-alias-label-secondary)}
      .nf-badge.self{color:#16a34a;border-color:#86efac}
      .nf-badge.remote{color:#2563eb;border-color:#93c5fd}
      .nf-badge.tool{color:#9333ea;border-color:#d8b4fe}
      .nf-empty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:14px 4px}
      .nf-error{color:#ef4444;font-size:12px;white-space:pre-wrap}
      .nf-textarea-wrap{display:flex;flex-direction:column;gap:8px;position:sticky;bottom:0;background:var(--dsw-alias-bg-primary);padding-top:8px}
      .nf-turn-tail{display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);padding:2px 0}
      .nf-header-badge{display:inline-flex;gap:5px;align-items:center;font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-secondary);border-radius:999px;padding:2px 8px;cursor:pointer;white-space:nowrap;background:transparent}
      @media(max-width:760px){.nf-grid{grid-template-columns:1fr}.nf-root{padding:12px 12px calc(16px + env(safe-area-inset-bottom))}.nf-btn{min-height:44px}}
    `

    function installStyles() {
      const tag = document.createElement('style')
      tag.dataset.dshCrossDevice = '1'
      tag.textContent = CSS
      document.head.append(tag)
      return () => tag.remove()
    }

    function createRpc(ctx) {
      return async function call(endpoint, payload) {
        const response = await ctx.connection.rpc.call(CHANNEL, endpoint, payload ?? null)
        if (response === null || typeof response !== 'object' || response.ok !== true) {
          const error = new Error(response?.error?.message ?? 'node network request failed')
          error.code = response?.error?.code
          throw error
        }
        return response.value
      }
    }

    function createStore(rpc) {
      const listeners = new Set()
      const state = {
        status: undefined, sessions: { coordinating: [], viewing: [], registry: [] },
        localSessions: [], spaces: [], error: undefined, loading: true,
        eventSource: undefined, lastEvents: [],
      }
      const emit = () => { for (const listener of listeners) listener() }
      const store = {
        get: () => state,
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        set(patch) { Object.assign(state, patch); emit() },
        async refresh() {
          try {
            const [status, sessions, spaces] = await Promise.all([rpc('status'), rpc('sessions'), rpc('spaces')])
            store.set({ status, sessions, spaces: spaces?.spaces ?? [], loading: false, error: undefined })
          } catch (error) { store.set({ error: error.message, loading: false }) }
        },
        async loadLocalSessions() {
          try { const value = await rpc('localSessions'); store.set({ localSessions: value?.items ?? [] }) }
          catch (error) { store.set({ error: error.message }) }
        },
        async loadHistory(sessionId) {
          try { const value = await rpc('history', { sessionId, limit: 1000 }); store.set({ lastEvents: value?.events ?? [] }) }
          catch (error) { store.set({ error: error.message }) }
        },
        connect() {
          if (state.eventSource !== undefined) return
          try {
            const source = new EventSource('/api/cross-device/events')
            state.eventSource = source
            source.addEventListener('state', (event) => {
              try { store.set({ status: JSON.parse(event.data), loading: false }) } catch {}
            })
            source.addEventListener('events', (event) => {
              try { const data = JSON.parse(event.data); store.set({ lastEvents: [...state.lastEvents, data.event].slice(-2000) }) } catch {}
            })
            source.addEventListener('sessions', () => { void store.refresh() })
            source.addEventListener('reset', () => { void store.refresh() })
            source.onerror = () => { try { source.close() } catch {}; state.eventSource = undefined; setTimeout(() => store.connect(), 3000) }
          } catch { setTimeout(() => store.connect(), 3000) }
        },
      }
      return store
    }

    function useStore(store) {
      const [, force] = React.useState(0)
      React.useEffect(() => store.subscribe(() => force((value) => value + 1)), [store])
      return store.get()
    }

    function Pill({ online, children }) {
      return h('span', { className: 'nf-pill', style: { whiteSpace: 'normal', overflowWrap: 'anywhere', maxWidth: '100%' } }, h('span', { className: `nf-dot ${online ? 'online' : ''}` }), children)
    }

    function NodeList({ status, t }) {
      const peers = status?.peers ?? []
      if (peers.length === 0) return h('div', { className: 'nf-empty' }, t('noNodes'))
      return h('div', { className: 'nf-list' }, peers.map((peer) => h('div', { className: 'nf-item', key: peer.id },
        h('div', { className: 'nf-item-head' }, h('div', { className: 'nf-item-title' }, peer.name), h(Pill, { online: true }, t('online'))),
        h('div', { className: 'nf-item-sub' }, `${peer.platform}/${peer.arch ?? ''} · ${peer.id}`),
        h('div', { className: 'nf-item-sub' }, (peer.capabilities ?? []).map((cap) => cap.name).join(' · ') || t('capabilities')),
      )))
    }

    function SessionList({ state, t, selected, onSelect }) {
      const rows = [...(state.sessions?.coordinating ?? []).map((item) => ({ ...item, mine: true })), ...(state.sessions?.viewing ?? []).map((item) => ({ ...item, mine: false }))]
      const unique = new Map()
      for (const row of rows) unique.set(row.id, row)
      const list = [...unique.values()]
      if (list.length === 0) return h('div', { className: 'nf-empty' }, t('noSessions'))
      return h('div', { className: 'nf-list' }, list.map((row) => h('div', {
        key: row.id, className: `nf-item ${selected === row.id ? 'selected' : ''}`,
        onClick: () => onSelect(row.id), role: 'button', tabIndex: 0,
      },
        h('div', { className: 'nf-item-head' }, h('div', { className: 'nf-item-title' }, row.title || row.id), h('span', { className: 'nf-badge' }, row.mine ? t('coordinator') : t('sessions'))),
        h('div', { className: 'nf-item-sub' }, `${row.id} · epoch ${row.epoch ?? 0} · seq ${row.lastSeq ?? -1}`),
      )))
    }

    function cleanUserText(text) {
      return String(text ?? '').replace(/^\[\[device:[^\]]*\]\]\s*/u, '')
    }

    function Transcript({ events, provenanceRecords, t }) {
      if (!events || events.length === 0) return h('div', { className: 'nf-empty' }, t('messages'))
      const recordFor = (seq) => provenanceRecords.find((record) => record.seq === seq)
      return h('div', null, events.map((event) => {
        if (event.type === 'user/message') {
          const record = recordFor(event.seq)
          const text = (event.data?.message?.content ?? []).map((block) => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
          return h('div', { className: 'nf-msg', key: `u-${event.seq}` },
            h('div', { className: 'nf-msg-head' }, h('span', { className: 'nf-badge remote' }, `${t('from')} ${record?.nodeName ?? t('you')}`), h('span', null, new Date(event.time).toLocaleTimeString())),
            h('div', { className: 'nf-msg-text' }, cleanUserText(text)),
          )
        }
        if (event.type === 'assistant/message') {
          const record = recordFor(event.seq)
          const content = event.data?.message?.content ?? []
          return h('div', { className: 'nf-msg', key: `a-${event.seq}` },
            h('div', { className: 'nf-msg-head' },
              h('span', { className: 'nf-badge self' }, `${t('answeredOn')} ${record?.nodeName ?? '?'}`),
              record?.toolNodes?.length ? h('span', { className: 'nf-badge tool' }, `${t('toolsOn')}: ${record.toolNodes.join(', ')}`) : null,
              h('span', null, new Date(event.time).toLocaleTimeString()),
            ),
            h('div', { className: 'nf-msg-text' }, content.map((block) => block.type === 'text' ? block.text : block.type === 'reasoning' ? `\n[reasoning]\n${block.text}` : `[${block.type}]`).join('\n')),
          )
        }
        if (event.type === 'tool/call') {
          const record = recordFor(event.seq)
          const args = String(event.data?.arguments ?? '')
          return h('div', { className: 'nf-msg', key: `t-${event.seq}` },
            h('div', { className: 'nf-msg-head' }, h('span', { className: 'nf-badge tool' }, `🔧 ${event.data?.name ?? 'tool'}`), h('span', { className: 'nf-badge' }, record?.nodeName ?? '?')),
            h('pre', { className: 'nf-pre' }, args.length > 1200 ? `${args.slice(0, 1200)}…` : args),
          )
        }
        if (event.type === 'tool/result') {
          const text = (event.data?.message?.content ?? []).map((block) => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
          return h('div', { className: 'nf-msg', key: `r-${event.seq}` },
            h('div', { className: 'nf-msg-head' }, h('span', { className: 'nf-badge' }, t('toolResult'))),
            h('pre', { className: 'nf-pre' }, text.length > 2000 ? `${text.slice(0, 2000)}…` : text),
          )
        }
        if (event.type === 'turn/error') return h('div', { className: 'nf-msg', key: `e-${event.seq}` }, h('div', { className: 'nf-error' }, JSON.stringify(event.data).slice(0, 2000)))
        return null
      }).filter(Boolean))
    }

    function AllSessionsPlaceholder() { return null }

    function AllSessions({ rpc, t, onOpen }) {
      const [items, setItems] = React.useState([])
      React.useEffect(() => {
        let cancelled = false
        const load = () => rpc('sessions.all', {}).then((value) => { if (!cancelled) setItems(value?.items ?? []) }).catch(() => {})
        void load()
        const timer = setInterval(load, 15000)
        return () => { cancelled = true; clearInterval(timer) }
      }, [rpc])
      if (items.length === 0) return h('div', { className: 'nf-empty' }, t('noSessions'))
      return h('div', { className: 'nf-list' }, items.slice(0, 40).map((row) => h('div', {
        key: `${row.nodeId}:${row.id}`, className: 'nf-item', role: 'button', tabIndex: 0, onClick: () => onOpen(row),
      },
        h('div', { className: 'nf-item-head' },
          h('div', { className: 'nf-item-title' }, row.title || row.id),
          h('span', { className: 'nf-badge self' }, row.node ?? ''),
        ),
        h('div', { className: 'nf-item-sub' }, `${row.cwd ?? ''} · ${row.running ? 'running' : 'idle'}`),
      )))
    }
    function NodeFabricPanel({ rpc, ctx, t }) {
      const store = React.useMemo(() => createStore(rpc), [rpc])
      const state = useStore(store)
      const [selected, setSelected] = React.useState(undefined)
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState(undefined)
      const [newTarget, setNewTarget] = React.useState('')
      const [provenanceRecords, setProvenanceRecords] = React.useState([])
      React.useEffect(() => { void store.refresh(); void store.loadLocalSessions(); store.connect() }, [store])
      React.useEffect(() => {
        if (selected === undefined) return
        void store.loadHistory(selected)
        void rpc('provenance', { sessionId: selected }).then((value) => setProvenanceRecords(value?.records ?? [])).catch(() => {})
      }, [selected, rpc])
      const status = state.status
      const selectedSession = [...(state.sessions?.coordinating ?? []), ...(state.sessions?.viewing ?? [])].find((row) => row.id === selected)
      const send = async () => {
        if (selected === undefined || text.trim() === '') return
        setBusy('send')
        try { await rpc('prompt', { sessionId: selected, text }); setText('') }
        catch (error) { store.set({ error: error.message }) }
        finally { setBusy(undefined) }
      }
      const share = async (sessionId) => {
        setBusy(`share-${sessionId}`)
        try {
          const spaceId = state.spaces?.[0]?.id
          // The backend creates a default shared space when none is supplied.
          await rpc('share', { sessionId, spaceId })
          await store.refresh(); setSelected(sessionId)
        } catch (error) { store.set({ error: error.message }) }
        finally { setBusy(undefined) }
      }
      const takeover = async () => {
        if (selected === undefined) return
        if (!window.confirm('Take over this shared session on this node? The current coordinator will stop.')) return
        setBusy('takeover')
        try {
          const result = await rpc('takeover', { sessionId: selected, force: true })
          await store.refresh()
          if (result?.localId) ctx.uiWorkspace.openSession(result.localId)
        } catch (error) { store.set({ error: error.message }) }
        finally { setBusy(undefined) }
      }
      const localItems = (state.localSessions ?? []).filter((item) => item.origin !== 'subagent' && item.formatStatus !== 'migration-required')
      return h('div', { className: 'nf-root' },
        h('h1', { className: 'nf-title' }, t('title')),
        h('p', { className: 'nf-lead' }, t('leadNodesOnly')),
        h('div', { className: 'nf-row' },
          h(Pill, { online: status?.hub?.connected === true }, `${t('hubUrl')}: ${status?.hub?.connected === true ? t('connected') : t('disconnected')}`),
          h('span', { className: 'nf-muted' }, status?.node?.name ?? ''),
          h('span', { className: 'nf-muted' }, `${t('fingerprint')}: ${status?.node?.fingerprint ?? ''}`),
          h('button', { className: 'nf-btn', onClick: () => void store.refresh() }, t('refresh')),
        ),
        h('div', { className: 'nf-card' },
          h('h2', { className: 'nf-section-title' }, '状态 / Status'),
          h('div', { className: 'nf-muted' }, `node: ${status?.node?.name ?? '?'} (${status?.node?.platform ?? '?'}) ${status?.node?.fingerprint ?? ''}`),
          h('div', { className: 'nf-muted' }, `hub: ${status?.hub?.url || '(none)'} · local=${status?.hub?.local === true} · port=${status?.hub?.localPort ?? 0}`),
          h('div', { className: 'nf-muted' }, `connected: ${status?.hub?.connected === true} · state=${status?.hub?.state ?? '?'} · attempts=${status?.hub?.attempts ?? 0}`),
          h('div', { className: 'nf-muted' }, `peers: ${(status?.peers ?? []).length} · lan: ${(status?.hub?.lanUrl ?? '') || '(none)'}`),
          status?.hub?.lastError ? h('div', { className: 'nf-error' }, `last error: ${status.hub.lastError}`) : null,
        ),
        state.error ? h('div', { className: 'nf-error' }, state.error) : null,
        h('div', { className: 'nf-grid' },
          h('div', { className: 'nf-card' }, h('h2', { className: 'nf-section-title' }, t('nodes')), h(NodeList, { status, t })),
        ),
      )
    }

    function SettingsPage({ rpc, t }) {
      const store = React.useMemo(() => createStore(rpc), [rpc])
      const state = useStore(store)
      const status = state.status
      const [form, setForm] = React.useState(undefined)
      const [notice, setNotice] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      React.useEffect(() => { void store.refresh() }, [store])
      React.useEffect(() => {
        if (status === undefined || form !== undefined) return
        const gh = status.github ?? {}
        setForm({
          repo: gh.repo ?? '',
          login: gh.login ?? '',
          hasToken: gh.hasToken === true,
          mode: status.hub?.mode === 'custom' ? 'custom' : 'lan',
          hubUrl: status.hub?.url ?? '',
          runLocal: status.hub?.runLocal === true,
          allowAny: status.hub?.allowAny === true,
          nodeName: status.node?.name ?? '',
        })
      }, [status, form])
      if (form === undefined) return h('div', { className: 'nf-root' }, t('load'))
      const set = (key) => (event) => setForm({ ...form, [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value })
      const login = async () => {
        setBusy(true); setNotice(undefined)
        try {
          const start = await rpc('github.start', {})
          setForm({ ...form, deviceCode: start.userCode, deviceUri: start.verificationUri })
          try { window.open(start.verificationUri, '_blank', 'noopener') } catch {}
          setNotice(`${t('githubCode')}: ${start.userCode} · ${start.verificationUri}`)
          const tick = async () => {
            const result = await rpc('github.poll', {})
            if (result?.state === 'done') {
              setForm((current) => ({ ...current, repo: result.repo ?? current.repo, login: result.login ?? '', hasToken: true, deviceCode: undefined }))
              setNotice(`${t('githubSignedIn')}: ${result.login ?? 'ok'} · ${result.repo ?? ''}`)
              await store.refresh()
              setBusy(false)
              return
            }
            if (result?.state === 'pending') { setTimeout(() => { void tick() }, Math.max(2, result.interval ?? 5) * 1000); return }
            setNotice(`GitHub: ${result?.state ?? 'error'} ${result?.error ?? ''}`)
            setBusy(false)
          }
          setTimeout(() => { void tick() }, Math.max(2, start.interval ?? 5) * 1000)
        } catch (error) { setNotice(error.message); setBusy(false) }
      }
      const save = async () => {
        setBusy(true)
        try {
          await rpc('configure', {
            github: form.hasToken ? { repo: form.repo || undefined } : undefined,
            hub: { mode: form.mode, url: form.mode === 'custom' ? form.hubUrl : '', runLocal: form.runLocal, allowAny: form.allowAny },
            node: { name: form.nodeName || undefined },
          })
          setNotice(t('saved')); await store.refresh()
        } catch (error) { setNotice(error.message) } finally { setBusy(false) }
      }
      const lanUrl = status?.hub?.url
      return h('div', { className: 'nf-root' },
        h('h2', { className: 'nf-title' }, t('settings')),
        notice ? h('div', { className: 'nf-muted' }, notice) : null,
        h('div', { className: 'nf-card' },
          h('h2', { className: 'nf-section-title' }, t('githubSection')),
          h('div', { className: 'nf-row' },
            h('div', { className: 'nf-muted' }, form.hasToken ? `${t('githubSignedIn')}: ${form.login || 'ok'}` : t('githubNotSignedIn')),
            h('button', { className: 'nf-btn', onClick: () => void login(), disabled: busy }, t('githubLogin')),
          ),
          h('div', { className: 'nf-muted' }, `${t('githubRepo')}: ${form.repo || t('githubRepoAuto')}`),
        ),
        h('div', { className: 'nf-card' },
          h('h2', { className: 'nf-section-title' }, t('hubSection')),
          h('label', { className: 'nf-row' },
            h('input', { type: 'radio', name: 'hubmode', checked: form.mode === 'lan', onChange: () => setForm({ ...form, mode: 'lan' }) }),
            `${t('hubLan')}${lanUrl ? ` · ${lanUrl}` : ''}`),
          h('label', { className: 'nf-row' },
            h('input', { type: 'radio', name: 'hubmode', checked: form.mode === 'custom', onChange: () => setForm({ ...form, mode: 'custom' }) }),
            t('hubCustom')),
          form.mode === 'custom' ? h('input', { className: 'nf-input', value: form.hubUrl, onChange: set('hubUrl'), placeholder: 'wss://' }) : null,
          h('label', { className: 'nf-row' }, h('input', { type: 'checkbox', checked: form.runLocal, onChange: set('runLocal') }), t('runLocalHub')),
          h('label', { className: 'nf-row' }, h('input', { type: 'checkbox', checked: form.allowAny, onChange: set('allowAny') }), t('allowAny')),
          h('div', { className: 'nf-muted' }, t('nodeName')),
          h('input', { className: 'nf-input', value: form.nodeName, onChange: set('nodeName') }),
        ),
        h('div', { className: 'nf-card' }, h('h2', { className: 'nf-section-title' }, t('capabilities')), h('div', { className: 'nf-muted' }, (status?.capabilities ?? []).map((cap) => cap.name).join(' · '))),
        h('button', { className: 'nf-btn primary', onClick: () => void save(), disabled: busy }, t('save')),
      )
    }

    function ProvenanceTurnTail({ rpc, sessionId, seq, t }) {
      const [record, setRecord] = React.useState(undefined)
      React.useEffect(() => {
        let cancelled = false
        void rpc('provenance', { sessionId }).then((value) => {
          if (cancelled) return
          const records = value?.records ?? []
          const assistant = records.filter((item) => item.kind === 'assistant' && item.seq <= seq).sort((a, b) => b.seq - a.seq)[0]
          setRecord(assistant)
        }).catch(() => {})
        return () => { cancelled = true }
      }, [rpc, sessionId, seq])
      if (record === undefined) return null
      return h('span', { className: 'nf-turn-tail' },
        h('span', { className: 'nf-badge self' }, `${t('answeredOn')} ${record.nodeName}`),
        record.toolNodes?.length ? h('span', { className: 'nf-badge tool' }, `${t('toolsOn')}: ${record.toolNodes.join(', ')}`) : null,
      )
    }

    function CoordinatorBadge({ rpc, sessionId, t, ctx }) {
      const [nodeName, setNodeName] = React.useState(undefined)
      React.useEffect(() => {
        void rpc('sessions').then((value) => {
          const all = [...(value?.coordinating ?? []), ...(value?.viewing ?? [])]
          const hit = all.find((row) => row.id === sessionId)
          setNodeName(hit?.coordinatorNodeId)
        }).catch(() => {})
      }, [rpc, sessionId])
      if (nodeName === undefined) return null
      return h('button', { className: 'nf-header-badge', onClick: () => ctx.layout.selectPanel('node-fabric'), title: t('coordinatorBadge') }, `🧠 ${String(nodeName).slice(0, 14)}`)
    }

    function ShareMenuItem({ rpc, sessionId, displayTitle, t, useMenuOpenState }) {
      const close = useMenuOpenState?.() ?? (() => {})
      return h('button', {
        role: 'menuitem',
        onClick: async () => {
          try {
            const spaces = await rpc('spaces')
            const spaceId = spaces?.spaces?.[0]?.id
            // The backend creates a default shared space when none is supplied.
            await rpc('share', { sessionId, spaceId, title: displayTitle })
            close()
          } catch (error) { window.alert(error.message) }
        },
      }, t('share'))
    }

    function ensureSharedWorkspace(ctx) {
      const rpc = createRpc(ctx)
      let tries = 0
      const attempt = () => {
        tries += 1
        if (typeof ctx.workspaces?.create !== 'function') { if (tries < 10) setTimeout(attempt, 1500); return }
        void rpc('sharedWorkspace', {}).then((value) => {
          if (value?.created !== true) return undefined
          return ctx.workspaces.create({ path: value.path })
        }).catch(() => { if (tries < 10) setTimeout(attempt, 1500) })
      }
      setTimeout(attempt, 1200)
    }

    function register(ctx) {
      ensureSharedWorkspace(ctx)
      const rpc = createRpc(ctx)
      const t = (key) => {
        const snapshot = ctx.locale.getLocale?.() ?? {}
        const locale = snapshot.id ?? snapshot.locale ?? 'zh'
        const dict = locale.startsWith('zh') ? DICTS.zh : DICTS.en
        return dict[key] ?? DICTS.en[key] ?? key
      }
      ctx.effect(() => ctx.locale.register(NS, 'zh', DICTS.zh), 'dsh-cross-device: zh locale')
      ctx.effect(() => ctx.locale.register(NS, 'en', DICTS.en), 'dsh-cross-device: en locale')
      ctx.effect(() => installStyles(), 'dsh-cross-device: styles')
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: 'node-fabric', order: 25, label: () => t('nav') },
        () => h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } }, '🕸'),
      ))
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: 'node-fabric' },
        () => h(NodeFabricPanel, { rpc, ctx, t }),
      ))
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'node-fabric', order: 16, label: () => t('nav') },
        () => h(SettingsPage, { rpc, t }),
      ))
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
        { name: 'conversation.session.header.utilities', id: 'node-fabric-coordinator', order: 22, label: () => t('coordinator') },
        (props) => h(CoordinatorBadge, { rpc, sessionId: props.sessionId, t, ctx }),
      ))
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
        { name: 'conversation.chat.turnTail', id: 'node-fabric-provenance', order: 35, label: () => t('provenance') },
        (props) => h(ProvenanceTurnTail, { rpc, sessionId: props.sessionId, seq: props.seq, t }),
      ))
    }

    return {
      name: '@local/dsh-cross-device',
      inject: ['slots', 'connection', 'locale', 'layout', 'uiWorkspace', 'workspaces'],
      apply: register,
    }
  },
})
