/**
 * Hub client: one authenticated outbound WebSocket per node, JSON-RPC
 * routing, presence/catalog tracking, heartbeat, and reconnect.
 */
import WebSocket from 'ws'
import { PROTOCOL_VERSION, HUB_METHODS } from '../protocol.js'
import { signText } from './identity.js'

export class HubClient {
  constructor({ url, node, privateKey, onRpc, onEvent, log = console, reconnect = true }) {
    this.url = url
    this.node = node
    this.privateKey = privateKey
    this.onRpc = onRpc
    this.onEvent = onEvent
    this.log = log
    this.reconnectEnabled = reconnect
    this.ws = undefined
    this.readyPromise = undefined
    this.readyResolve = undefined
    this.ready = false
    this.hubNodeId = undefined
    this.peers = new Map()
    this.catalog = []
    this.pending = new Map()
    this.closed = false
    this.attempt = 0
    this.heartbeat = undefined
    this.reconnectTimer = undefined
    this.state = 'idle'
  }

  get connected() {
    return this.ready && this.ws?.readyState === WebSocket.OPEN
  }

  subscribeSessions(sessions) {
    this.subscriptions ??= new Set()
    for (const id of sessions ?? []) this.subscriptions.add(String(id))
    return this.send({ type: 'subscribe', sessions: [...this.subscriptions] })
  }

  setCatalog(capabilities) {
    this.catalog = capabilities
    if (this.connected) this.send({ type: 'node.catalog', nodeId: this.node.id, capabilities })
  }

  async connect() {
    if (this.connected) return this
    if (this.readyPromise !== undefined) return this.readyPromise
    this.closed = false
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.open()
    return this.readyPromise
  }

  open() {
    clearTimeout(this.reconnectTimer)
    if (this.closed) return
    this.setState('connecting')
    let ws
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 15_000, maxPayload: 64 * 1024 * 1024 })
    } catch (error) {
      this.scheduleReconnect(`connect failed: ${String(error)}`)
      return
    }
    this.ws = ws
    let challenge
    const helloTimer = setTimeout(() => {
      try { ws.terminate() } catch {}
    }, 15_000)
    ws.on('message', (raw) => {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (frame.type === 'challenge' && frame.challenge) {
        challenge = frame.challenge
        clearTimeout(helloTimer)
        this.send({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          node: {
            id: this.node.id,
            name: this.node.name,
            platform: this.node.platform,
            arch: this.node.arch,
            publicKey: this.node.publicKey,
          },
          challenge,
          signature: signText(this.privateKey, challenge),
        })
        return
      }
      if (frame.type === 'welcome') {
        clearTimeout(helloTimer)
        this.hubNodeId = frame.hubNodeId
        this.peers.clear()
        for (const peer of frame.peers ?? []) this.peers.set(peer.id, peer)
        this.ready = true
        this.attempt = 0
        this.setState('online')
        this.startHeartbeat()
        this.send({ type: 'node.catalog', nodeId: this.node.id, capabilities: this.catalog })
        this.readyResolve?.(this)
        return
      }
      if (frame.type === 'rpc.result') {
        const pending = this.pending.get(frame.id)
        if (pending !== undefined) {
          this.pending.delete(frame.id)
          clearTimeout(pending.timer)
          if (frame.ok) pending.resolve(frame.value)
          else pending.reject(Object.assign(new Error(frame.error?.message ?? 'remote call failed'), { code: frame.error?.code, details: frame.error?.details }))
        }
        return
      }
      if (frame.type === 'rpc') {
        void this.handleRpc(frame)
        return
      }
      if (frame.type === 'event') {
        this.handleEvent(frame)
        return
      }
      if (frame.type === 'pong') return
      if (frame.type === 'error') {
        this.log.warn?.(`[cross-device] hub error: ${frame.error?.code} ${frame.error?.message}`)
      }
    })
    ws.on('close', (code, reason) => {
      clearTimeout(helloTimer)
      this.ready = false
      this.stopHeartbeat()
      this.ws = undefined
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(Object.assign(new Error('hub connection closed'), { code: 'HUB_CLOSED' }))
      }
      this.pending.clear()
      if (!this.closed) this.scheduleReconnect(`closed ${code} ${String(reason)}`)
    })
    ws.on('error', (error) => {
      this.log.warn?.(`[cross-device] hub socket: ${String(error)}`)
    })
  }

  scheduleReconnect(reason) {
    if (this.closed || !this.reconnectEnabled) return
    this.setState('offline')
    if (this.readyPromise !== undefined && this.readyReject !== undefined && !this.ready) {
      // Keep the first connect promise pending across retries; callers wait for
      // the first successful welcome, while UI shows offline state.
    }
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.attempt++, 6))
    this.log.warn?.(`[cross-device] hub reconnect in ${delay}ms: ${reason}`)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.open(), delay)
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (this.connected) this.send({ type: 'ping', time: Date.now() })
    }, 15_000)
    this.heartbeat.unref?.()
  }

  stopHeartbeat() {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }

  send(value) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify(value))
      return true
    } catch {
      return false
    }
  }

  async call(to, method, params = {}, options = {}) {
    const { signal, timeoutMs = 60_000 } = options
    if (!this.connected) throw Object.assign(new Error('hub is not connected'), { code: 'HUB_OFFLINE' })
    const id = `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const request = {
      type: 'rpc',
      id,
      from: this.node.id,
      to,
      method,
      params,
      timestamp: Date.now(),
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`remote call ${method} timed out`), { code: 'TIMEOUT' }))
      }, timeoutMs)
      const onAbort = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        this.send({ type: 'rpc', id: `${id}-cancel`, from: this.node.id, to, method: HUB_METHODS.TOOL_CANCEL, params: { callId: params.callId }, timestamp: Date.now() })
        reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => { signal?.removeEventListener('abort', onAbort); resolve(value) },
        reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error) },
        timer,
      })
      if (!this.send(request)) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(Object.assign(new Error('hub is not connected'), { code: 'HUB_OFFLINE' }))
      }
    })
  }

  async handleRpc(frame) {
    try {
      if (typeof this.onRpc !== 'function') throw Object.assign(new Error('no rpc handler'), { code: 'NO_HANDLER' })
      const value = await this.onRpc(frame.method, frame.params, frame)
      this.send({ type: 'rpc.result', id: frame.id, to: frame.from, from: this.node.id, ok: true, value })
    } catch (error) {
      this.send({
        type: 'rpc.result',
        id: frame.id,
        to: frame.from,
        from: this.node.id,
        ok: false,
        error: { code: error?.code ?? 'REMOTE_ERROR', message: error instanceof Error ? error.message : String(error), details: error?.details },
      })
    }
  }

  handleEvent(frame) {
    if (frame.event === 'node.online' && frame.data?.id) this.peers.set(frame.data.id, frame.data)
    if (frame.event === 'node.offline' && frame.data?.id) this.peers.delete(frame.data.id)
    if (frame.event === 'node.catalog' && frame.data?.nodeId) {
      const peer = this.peers.get(frame.data.nodeId)
      if (peer !== undefined) {
        peer.capabilities = Array.isArray(frame.data.capabilities) ? frame.data.capabilities : []
        this.peers.set(peer.id, peer)
      }
    }
    this.onEvent?.(frame.event, frame.data)
  }

  setState(state) {
    this.state = state
    this.onEvent?.('hub.state', { state })
  }

  async dispose() {
    this.closed = true
    clearTimeout(this.reconnectTimer)
    this.stopHeartbeat()
    this.ready = false
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(Object.assign(new Error('hub client disposed'), { code: 'DISPOSED' }))
    }
    this.pending.clear()
    try { this.ws?.close(1000, 'disposed') } catch {}
    this.ws = undefined
  }
}