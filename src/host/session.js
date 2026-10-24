/**
 * Session sharing between nodes.
 *
 * A shared session has one coordinator that owns the live DSH Session. The
 * coordinator publishes durable events to subscribers and accepts prompts
 * from other trusted nodes. Viewers keep a replica for display and future
 * takeover.
 */
import { HUB_METHODS, PROVENANCE_TYPE, newRequestId } from '../protocol.js'
import { materializeSession } from './materialize.js'

export class SessionFabric {
  constructor({ ctx, hub, node, registry, provenance, settings, log = console, onUpdate }) {
    this.ctx = ctx
    this.hub = hub
    this.node = node
    this.registry = registry
    this.provenance = provenance
    this.settings = settings
    this.log = log
    this.onUpdate = onUpdate
    this.coordinating = new Map() // sessionId -> { session, epoch, spaceId, title, lastSeq, subscribers:Set, timer }
    this.viewing = new Map() // sessionId -> { manifest, events, lastSeq }
    this.disposers = []
  }

  async init() {
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      const state = this.coordinating.get(session.id)
      if (state === undefined || state.released === true) return
      state.lastSeq = event.seq
      this.publishEvent(session.id, event)
      if (event.seq % 50 === 0) this.scheduleManifest(session.id)
    }, { global: true }))
  }

  async share(sessionId, spaceId, title) {
    if (this.coordinating.has(sessionId)) return this.coordinating.get(sessionId)
    const session = this.ctx.get?.('sessions')?.get(sessionId)
    if (session === undefined) throw new Error(`session ${sessionId} is not live; open it first`)
    const header = session.header
    if (header.parentSession !== undefined || header.origin === 'subagent') throw new Error('only root sessions can be shared')
    const titleText = title ?? await this.titleFor(session)
    const manifest = await this.registry.publishSession({
      id: session.id,
      spaceId,
      title: titleText,
      coordinatorNodeId: this.node.id,
      epoch: 1,
      lastSeq: session.seq - 1,
      formatVersion: header.version,
      header: { version: header.version, cwd: header.cwd, createdAt: header.createdAt, isSeeded: false, agentPreset: header.agentPreset }
    })
    const state = {
      session,
      epoch: 1,
      spaceId,
      title: titleText,
      lastSeq: session.seq - 1,
      subscribers: new Set(),
      manifest,
      timer: undefined,
    }
    this.coordinating.set(session.id, state)
    this.hub?.subscribeSessions?.([session.id])
    this.onUpdate?.()
    return this.describeCoordinating(session.id)
  }

  async titleFor(session) {
    try {
      const titles = await this.ctx.get?.('sessionQuery')?.readTitleSnapshots?.([session.id])
      const title = titles?.[0]?.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim().slice(0, 120)
    } catch {}
    const firstUser = session.snapshotEvents().find((event) => event.type === 'user/message')
    const text = firstUser?.data?.message?.content?.find?.((block) => block.type === 'text')?.text
    if (typeof text === 'string' && text.trim() !== '') return text.trim().slice(0, 80)
    return `Shared ${String(session.id).slice(0, 8)}`
  }

  scheduleManifest(sessionId) {
    const state = this.coordinating.get(sessionId)
    if (state === undefined) return
    if (state.timer !== undefined) return
    state.timer = setTimeout(async () => {
      state.timer = undefined
      try {
        state.manifest = await this.registry.publishSession({
          id: sessionId,
          spaceId: state.spaceId,
          title: state.title,
          coordinatorNodeId: this.node.id,
          epoch: state.epoch,
          lastSeq: state.lastSeq,
          formatVersion: state.session.header.version,
          header: { version: state.session.header.version, cwd: state.session.header.cwd, createdAt: state.session.header.createdAt, isSeeded: false, agentPreset: state.session.header.agentPreset },
        })
        this.onUpdate?.()
      } catch (error) {
        this.log.warn?.(`[cross-device] session manifest update failed: ${String(error)}`)
      }
    }, 2000)
    state.timer.unref?.()
  }

  publishEvent(sessionId, event) {
    this.hub.send({
      type: 'event',
      event: 'session.event',
      data: { sessionId, seq: event.seq, event },
    })
  }

  describeCoordinating(sessionId) {
    const state = this.coordinating.get(sessionId)
    if (state === undefined) return undefined
    return {
      id: sessionId,
      title: state.title,
      spaceId: state.spaceId,
      coordinatorNodeId: this.node.id,
      epoch: state.epoch,
      lastSeq: state.lastSeq,
      formatVersion: state.session.header.version,
    }
  }

  listCoordinating() {
    return [...this.coordinating.keys()].map((id) => this.describeCoordinating(id)).filter(Boolean)
  }

  listViewing() {
    return [...this.viewing.values()].map((state) => state.manifest)
  }

  async subscribe(sessionId) {
    const manifest = this.registry.sessions.get(sessionId) ?? (await this.registry.sync(true)).sessions.find((item) => item.id === sessionId)
    if (manifest === undefined) throw new Error(`shared session ${sessionId} is unknown`)
    if (manifest.coordinatorNodeId === this.node.id) return this.describeCoordinating(sessionId)
    this.hub?.subscribeSessions?.([sessionId])
    const history = await this.hub.call(manifest.coordinatorNodeId, HUB_METHODS.SESSION_HISTORY, { sessionId, limit: 2000 }, { timeoutMs: 30_000 })
    const events = Array.isArray(history?.events) ? history.events : []
    this.viewing.set(sessionId, {
      manifest,
      events,
      lastSeq: events.length === 0 ? manifest.lastSeq : events[events.length - 1].seq,
    })
    await this.hub.call(manifest.coordinatorNodeId, HUB_METHODS.SESSION_SUBSCRIBE, { sessionId }, { timeoutMs: 15_000 }).catch(() => {})
    this.onUpdate?.()
    return manifest
  }

  async prompt(sessionId, content, { mode = 'queue', requestId, nodeInfo } = {}) {
    const local = this.coordinating.get(sessionId)
    if (local !== undefined) {
      return this.promptLocal(sessionId, content, mode, requestId, nodeInfo ?? this.node)
    }
    const manifest = this.viewing.get(sessionId)?.manifest ?? this.registry.sessions.get(sessionId)
    if (manifest === undefined) throw new Error(`shared session ${sessionId} is unknown`)
    const id = requestId ?? newRequestId('prompt')
    const result = await this.hub.call(manifest.coordinatorNodeId, HUB_METHODS.SESSION_PROMPT, {
      sessionId,
      requestId: id,
      mode,
      content,
      node: this.node,
    }, { timeoutMs: 60_000 })
    return result
  }

  async promptLocal(sessionId, content, mode, requestId, nodeInfo) {
    const controller = this.ctx.get?.('sessionController')
    if (controller === undefined) throw new Error('sessionController is unavailable on this node')
    const id = requestId ?? newRequestId('prompt')
    const remote = nodeInfo !== undefined && nodeInfo.id !== this.node.id
    if (remote) this.provenance?.noteRemotePrompt(id, nodeInfo)
    const marked = remote ? (this.provenance?.attachMarker(content) ?? content) : content
    const response = await controller.prompt({
      requestId: id,
      sessionId,
      mode,
      content: Array.isArray(marked) ? marked : [{ type: 'text', text: String(marked) }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, new AbortController().signal)
    return { ...response, requestId: id }
  }

  async takeover(sessionId, { force = false, cwd } = {}) {
    const state = this.viewing.get(sessionId)
    if (state === undefined) throw new Error('subscribe to the shared session before taking it over')
    const manifest = state.manifest
    const claimed = await this.hub.call(manifest.coordinatorNodeId, HUB_METHODS.SESSION_CLAIM, {
      sessionId,
      force,
      requester: this.node.id,
    }, { timeoutMs: 30_000 })
    if (claimed?.ok === false || Array.isArray(claimed?.events) === false) throw new Error(claimed?.error ?? 'takeover claim failed')
    const result = await materializeSession({
      ctx: this.ctx,
      manifest: { ...manifest, header: claimed.header ?? manifest.header },
      events: claimed.events,
      cwd,
      title: manifest.title,
    })
    const nextManifest = await this.registry.publishSession({
      id: sessionId,
      spaceId: manifest.spaceId,
      title: manifest.title,
      coordinatorNodeId: this.node.id,
      epoch: claimed.epoch,
      lastSeq: result.agent.session.seq - 1,
      formatVersion: result.agent.session.header.version,
      header: {
        version: result.agent.session.header.version,
        cwd: result.agent.session.header.cwd,
        createdAt: result.agent.session.header.createdAt,
        isSeeded: false,
        agentPreset: result.agent.session.header.agentPreset,
      },
    })
    this.viewing.delete(sessionId)
    const localState = {
      session: result.agent.session,
      epoch: claimed.epoch,
      spaceId: manifest.spaceId,
      title: manifest.title,
      lastSeq: result.agent.session.seq - 1,
      subscribers: new Set(),
      manifest: nextManifest,
      timer: undefined,
      released: false,
    }
    this.coordinating.set(sessionId, localState)
    this.hub?.subscribeSessions?.([sessionId])
    this.onUpdate?.()
    return { ...result, manifest: nextManifest }
  }

  async cancel(sessionId) {
    const local = this.coordinating.get(sessionId)
    if (local !== undefined) {
      const controller = this.ctx.get?.('sessionController')
      return controller?.cancel({ sessionId })
    }
    const manifest = this.viewing.get(sessionId)?.manifest
    if (manifest === undefined) throw new Error(`shared session ${sessionId} is unknown`)
    return this.hub.call(manifest.coordinatorNodeId, HUB_METHODS.SESSION_CANCEL, { sessionId }, { timeoutMs: 15_000 })
  }

  async handleRpc(method, params, frame) {
    if (method === HUB_METHODS.SESSION_SUBSCRIBE) {
      const state = this.coordinating.get(params?.sessionId)
      if (state === undefined) throw new Error('this node is not the coordinator of that session')
      state.subscribers.add(frame.from)
      return { subscribed: true }
    }
    if (method === HUB_METHODS.SESSION_HISTORY) {
      const state = this.coordinating.get(params?.sessionId)
      const session = state?.session ?? this.ctx.get?.('sessions')?.get(params?.sessionId)
      if (session === undefined) throw new Error('session is not live on this node')
      const limit = Math.min(Math.max(Number(params?.limit ?? 2000), 1), 10_000)
      const events = session.snapshotEvents().slice(-limit)
      return { events, lastSeq: session.seq - 1 }
    }
    if (method === HUB_METHODS.SESSION_PROMPT) {
      const state = this.coordinating.get(params?.sessionId)
      if (state === undefined) throw new Error('this node is not the coordinator of that session')
      const nodeInfo = params?.node ?? this.hub.peers.get(frame.from) ?? { id: frame.from, name: frame.from, platform: 'unknown', slug: frame.from }
      return this.promptLocal(params.sessionId, params.content, params.mode ?? 'queue', params.requestId, nodeInfo)
    }
    if (method === HUB_METHODS.SESSION_CLAIM) {
      const state = this.coordinating.get(params?.sessionId)
      if (state === undefined) throw new Error('this node is not the coordinator of that session')
      if (state.released === true) throw new Error('session was already handed off')
      if (frame.from !== this.node.id && params?.force !== true) {
        throw Object.assign(new Error('session is being driven here; retry with force'), { code: 'LEASE_HELD' })
      }
      state.released = true
      state.epoch += 1
      const events = state.session.snapshotEvents()
      const header = state.manifest?.header ?? {
        version: state.session.header.version,
        cwd: state.session.header.cwd,
        createdAt: state.session.header.createdAt,
        isSeeded: false,
        agentPreset: state.session.header.agentPreset,
      }
      state.manifest = await this.registry.publishSession({
        id: params.sessionId,
        spaceId: state.spaceId,
        title: state.title,
        coordinatorNodeId: frame.from,
        epoch: state.epoch,
        lastSeq: state.session.seq - 1,
        formatVersion: state.session.header.version,
        header,
      })
      this.onUpdate?.()
      return { ok: true, events, header, epoch: state.epoch, lastSeq: state.session.seq - 1 }
    }
    if (method === HUB_METHODS.SESSION_CANCEL) {
      const controller = this.ctx.get?.('sessionController')
      if (!this.coordinating.has(params?.sessionId)) throw new Error('this node is not the coordinator of that session')
      return controller?.cancel({ sessionId: params.sessionId })
    }
    throw Object.assign(new Error(`unknown session method ${method}`), { code: 'UNKNOWN_METHOD' })
  }

  handleHubEvent(event, data) {
    if (event !== 'session.event') return
    if (data === null || typeof data !== 'object') return
    const state = this.viewing.get(data.sessionId)
    if (state === undefined) return
    const seq = Number(data.event?.seq)
    if (!Number.isSafeInteger(seq) || seq <= state.lastSeq) return
    if (seq !== state.lastSeq + 1) {
      // Gap: ask the coordinator for a fresh history rather than accepting a
      // partially ordered replica.
      const manifest = state.manifest
      void this.hub.call(manifest.coordinatorNodeId, HUB_METHODS.SESSION_HISTORY, { sessionId: data.sessionId, limit: 2000 }, { timeoutMs: 30_000 }).then((history) => {
        if (Array.isArray(history?.events)) {
          state.events = history.events
          state.lastSeq = history.events.length === 0 ? -1 : history.events[history.events.length - 1].seq
          this.onUpdate?.()
        }
      }).catch(() => {})
      return
    }
    state.events.push(data.event)
    state.lastSeq = seq
    if (state.events.length > 5000) state.events.splice(0, state.events.length - 5000)
    this.onUpdate?.()
  }

  events(sessionId) {
    const state = this.viewing.get(sessionId)
    if (state !== undefined) return state.events
    const local = this.coordinating.get(sessionId)
    if (local !== undefined) return local.session.snapshotEvents()
    return []
  }

  dispose() {
    for (const dispose of this.disposers) {
      try { dispose?.() } catch {}
    }
    this.disposers = []
    for (const state of this.coordinating.values()) clearTimeout(state.timer)
    this.coordinating.clear()
    this.viewing.clear()
  }
}