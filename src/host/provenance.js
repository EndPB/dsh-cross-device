/**
 * Device provenance: durable records in the Session log, a model-visible
 * marker on remote prompts, a compact system-prompt summary, and a tool for
 * full history. Records are ignorable plugin records and survive takeover.
 */
import { parseDeviceMarker, remoteToolName, parseRemoteToolName, PROVENANCE_TYPE, PROVENANCE_VERSION, buildDeviceMarker } from '../protocol.js'
import { appendFile, mkdir, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class Provenance {
  constructor({ node, settings, getPeer, dataDir, log = console }) {
    this.node = node
    this.settings = settings
    this.getPeer = getPeer
    this.dataDir = dataDir ?? settings.dataDir ?? join(process.env.DSH_HOME ?? '.', 'cross-device')
    this.log = log
    this.pendingRemote = new Map() // requestId -> nodeInfo
    this.recordsBySession = new Map() // sessionId -> array
    this.queues = new Map() // sessionId -> Promise
    this.cache = new Map() // sessionId -> {seq, records}
    this.sidecars = new Map() // sessionId -> records loaded from disk
    this.disposers = []
  }

  enabled() {
    return this.settings.provenance?.enabled !== false
  }

  noteRemotePrompt(requestId, nodeInfo) {
    if (typeof requestId === 'string' && requestId !== '') {
      this.pendingRemote.set(requestId, { ...nodeInfo })
      setTimeout(() => this.pendingRemote.delete(requestId), 10 * 60_000).unref?.()
    }
  }

  marker() {
    return buildDeviceMarker({
      nodeId: this.node.id,
      nodeName: this.node.name,
      platform: this.node.platform,
      at: Date.now(),
    })
  }

  attachMarker(content) {
    if (!this.enabled() || this.settings.provenance?.marker === false) return content
    const marker = this.marker()
    if (Array.isArray(content)) return [{ type: 'text', text: marker }, ...content]
    return marker
  }

  async onEvent(session, event) {
    if (!this.enabled()) return
    if (event.type === PROVENANCE_TYPE) return
    let record
    if (event.type === 'user/message') {
      const source = event.data?.message?.source
      const requestId = source?.rpcId
      const remote = requestId === undefined ? undefined : this.pendingRemote.get(requestId)
      const info = remote ?? this.selfInfo()
      record = {
        v: PROVENANCE_VERSION,
        kind: 'user',
        seq: event.seq,
        nodeId: info.id,
        nodeName: info.name,
        platform: info.platform,
        local: remote === undefined,
        at: event.time ?? Date.now(),
        ...requestId === undefined ? {} : { requestId },
      }
      if (remote !== undefined) this.pendingRemote.delete(requestId)
    } else if (event.type === 'assistant/message') {
      record = {
        v: PROVENANCE_VERSION,
        kind: 'assistant',
        seq: event.seq,
        turn: event.data?.turn ?? 0,
        step: event.data?.step ?? 0,
        nodeId: this.node.id,
        nodeName: this.node.name,
        platform: this.node.platform,
        model: modelOf(event.data?.message),
        toolNodes: this.toolNodesFor(session, event.data?.turn, event.data?.step),
        at: event.time ?? Date.now(),
      }
    } else if (event.type === 'tool/call') {
      const parsed = parseRemoteToolName(event.data?.name)
      const peer = parsed === undefined ? undefined : this.getPeer?.(parsed.slug)
      const info = peer ?? this.selfInfo()
      record = {
        v: PROVENANCE_VERSION,
        kind: 'tool',
        seq: event.seq,
        turn: event.data?.turn ?? 0,
        step: event.data?.step ?? 0,
        nodeId: info.id,
        nodeName: info.name,
        platform: info.platform,
        tool: String(event.data?.name ?? ''),
        at: event.time ?? Date.now(),
      }
    }
    if (record === undefined) return
    this.enqueue(session, record)
  }

  enqueue(session, record) {
    const id = session.id
    let list = this.recordsBySession.get(id)
    if (list === undefined) {
      list = []
      this.recordsBySession.set(id, list)
    }
    list.push(record)
    if (list.length > 2000) list.splice(0, list.length - 2000)
    this.cache.delete(id)
    const previous = this.queues.get(id) ?? Promise.resolve()
    const next = previous.then(() => this.writeRecord(session, record)).catch((error) => {
      this.log.warn?.(`[cross-device] provenance record failed: ${String(error)}`)
    })
    this.queues.set(id, next)
  }

  async writeRecord(session, record) {
    await new Promise((resolve) => queueMicrotask(resolve))
    if (session === undefined || session.disposed === true) return
    try {
      const file = this.sidecarPath(session.id)
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8')
    } catch (error) {
      this.log.warn?.(`[cross-device] provenance sidecar write failed: ${String(error)}`)
      this.fallbackWrite(session, record)
    }
  }

  sidecarPath(sessionId) {
    const safe = String(sessionId).replace(/[^A-Za-z0-9._-]+/gu, '_')
    return join(this.dataDir, 'provenance', `${safe}.jsonl`)
  }

  loadSidecar(sessionId) {
    if (this.sidecars.has(sessionId)) return this.sidecars.get(sessionId)
    const records = []
    try {
      const text = readFileSync(this.sidecarPath(sessionId), 'utf8')
      for (const line of text.split(/\r?\n/u)) {
        if (line.trim() === '') continue
        try { const record = JSON.parse(line); if (record?.v === PROVENANCE_VERSION) records.push(record) } catch {}
      }
    } catch {}
    this.sidecars.set(sessionId, records)
    return records
  }

  fallbackWrite(session, record) {
    // The durable log is preferred; keep the in-memory copy as a last resort.
    // A sidecar file is written by the Host when append support is unavailable.
    session.__crossDeviceProvenance ??= []
    session.__crossDeviceProvenance.push(record)
  }

  toolNodesFor(session, turn, step) {
    const records = this.records(session)
    const names = new Set()
    for (const record of records) {
      if (record.kind !== 'tool' || record.turn !== turn || record.step !== step) continue
      if (record.nodeId !== this.node.id) names.add(record.nodeName)
    }
    return [...names]
  }

  records(session) {
    if (session === undefined) return []
    const id = session.id
    const cached = this.cache.get(id)
    if (cached !== undefined && cached.seq === session.seq) return cached.records
    const byKey = new Map()
    const remember = (record) => {
      if (record === null || typeof record !== 'object' || record.v !== PROVENANCE_VERSION) return
      byKey.set(`${record.kind}:${record.seq}`, record)
    }
    for (const record of this.loadSidecar(id)) remember(record)
    for (const record of this.recordsBySession.get(id) ?? []) remember(record)
    for (const event of session.snapshotEvents?.() ?? []) {
      if (event.type === PROVENANCE_TYPE) remember(event.data)
    }
    const records = [...byKey.values()].sort((a, b) => a.seq - b.seq || a.kind.localeCompare(b.kind))
    this.cache.set(id, { seq: session.seq, records })
    return records
  }

  recent(session, limit = this.settings.provenance?.recentLimit ?? 4) {
    return this.records(session).slice(-Math.max(1, Math.min(Number(limit) || 4, 50)))
  }

  promptText(agent) {
    const session = agent?.session
    const header = [
      '## Distributed DSH nodes',
      `You are the coordinator running on ${this.node.name} (${this.node.platform}).`,
      'User messages sent from another node start with a `[[device:<nodeId>|<name>|<platform>|<time>]]` marker; unmarked user messages were sent on this node.',
      'Tools named `node__<slug>__<tool>` execute on that node. One answer may use tools from several devices.',
      'Use `provenance_recent` when the user asks which device sent a message or which device produced an earlier answer.',
    ]
    if (session === undefined) return header.join('\n')
    const records = this.recent(session)
    if (records.length === 0) return header.join('\n')
    const lines = records.map((record) => {
      const who = `${record.nodeName} (${record.platform})`
      if (record.kind === 'user') return `- user from ${who}${record.local ? '' : ' [remote]'} at ${new Date(record.at).toISOString()}`
      if (record.kind === 'assistant') return `- assistant on ${who} at ${new Date(record.at).toISOString()}${record.toolNodes?.length ? ` (tools: ${record.toolNodes.join(', ')})` : ''}`
      return `- tool ${record.tool} on ${who} at ${new Date(record.at).toISOString()}`
    })
    return `${header.join('\n')}\n\nRecent device provenance:\n${lines.join('\n')}`
  }

  registerSystemPrompt(ctx) {
    const prompt = ctx.get?.('systemPrompt')
    if (prompt === undefined) return
    this.disposers.push(prompt.section({
      name: 'cross-device:provenance',
      order: 9500,
      text: (context) => this.promptText(context?.agent),
    }))
  }

  registerTool(ctx) {
    const provenance = this
    const definition = {
      name: 'provenance_recent',
      description: 'Read recent device provenance for this session: which device sent each user message, which coordinator produced each assistant answer, and which devices executed tools.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum records to return, 1-50.' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args, exec) {
        const session = exec?.agent?.session
        const records = session === undefined ? [] : provenance.recent(session, args?.limit ?? 10)
        return { records, coordinator: provenance.selfInfo() }
      },
    }
    this.disposers.push(ctx.tools.register(definition))
  }

  selfInfo() {
    return { id: this.node.id, name: this.node.name, platform: this.node.platform, slug: this.node.slug }
  }

  dispose() {
    for (const dispose of this.disposers) {
      try { dispose?.() } catch {}
    }
    this.disposers = []
    this.recordsBySession.clear()
    this.queues.clear()
    this.cache.clear()
  }
}

function modelOf(message) {
  const source = message?.source
  if (source === null || typeof source !== 'object') return undefined
  return [source.provider, source.model].filter(Boolean).join('/') || undefined
}

export { parseDeviceMarker, remoteToolName }