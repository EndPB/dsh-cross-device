/**
 * Capability registry and remote tool bridge.
 *
 * Local capabilities are plain handlers. A peer's capabilities are exposed to
 * the model either as one tool per capability ("individual") or as a single
 * dispatcher tool per node ("dispatcher"). The dispatcher keeps a node with
 * 20+ capabilities from spending that many full JSON schemas on every request,
 * which is the dominant fixed context cost of this plugin.
 */
import { HUB_METHODS, parseRemoteToolName, remoteToolName } from '../protocol.js'

const DEFAULT_TOOLS = { mode: 'auto', individualLimit: 6, maxOutputChars: 4000, descriptionBudget: 1500 }

function toolSettings(settings) {
  return { ...DEFAULT_TOOLS, ...(settings?.tools ?? {}) }
}

function capabilityKey(capability) {
  return String(capability.name ?? '')
}

function oneLine(text, max = 120) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function clip(text, limit) {
  const value = String(text ?? '')
  if (limit <= 0 || value.length <= limit) return value
  const head = value.slice(0, Math.max(1, limit - 120))
  return `${head}\n…[truncated ${value.length - head.length} chars; narrow the query or pass a limit]`
}

function trimResult(result, limit) {
  if (result === null || typeof result !== 'object') return clip(String(result ?? ''), limit)
  let changed = false
  const out = { ...result }
  if (typeof result.text === 'string') {
    const text = clip(result.text, limit)
    if (text !== result.text) { out.text = text; changed = true }
  }
  if (Array.isArray(result.content)) {
    out.content = result.content.map((part) => {
      if (part?.type === 'text' && typeof part.text === 'string') {
        const text = clip(part.text, limit)
        if (text !== part.text) { changed = true; return { ...part, text } }
      }
      return part
    })
  }
  return changed ? out : result
}

export class ToolFabric {
  constructor({ ctx, hub, node, settings, log = console }) {
    this.ctx = ctx
    this.hub = hub
    this.node = node
    this.settings = settings
    this.log = log
    this.local = new Map()
    this.remote = new Map() // nodeId -> Map<toolName, { dispose, capability, mode }>
    this.calls = new Map() // callId -> AbortController
    this.unsubscribers = []
  }

  addLocal(capability) {
    this.local.set(capability.name, capability)
  }

  addLocalAll(capabilities) {
    for (const capability of capabilities) this.addLocal(capability)
  }

  catalog() {
    return [...this.local.values()]
      .filter((capability) => capability.enabled !== false)
      .map((capability) => ({
        name: capability.name,
        description: capability.description,
        parameters: capability.parameters ?? { type: 'object', properties: {} },
        output: capability.output ?? { type: 'object' },
        danger: capability.danger === true,
        enabled: true,
        schemaVersion: 1,
      }))
  }

  summary() {
    return [...this.local.values()]
      .filter((capability) => capability.enabled !== false)
      .map((capability) => ({ name: capability.name, description: oneLine(capability.description, 100), danger: capability.danger === true }))
  }

  async handleRpc(method, params, frame) {
    if (method === HUB_METHODS.TOOL_CALL) return this.callLocal(params, frame)
    if (method === HUB_METHODS.TOOL_CANCEL) {
      const controller = this.calls.get(params?.callId)
      controller?.abort(new Error('remote tool cancelled'))
      return { accepted: true }
    }
    if (method === 'node.catalog' || method === HUB_METHODS.NODE_CATALOG) {
      return { nodeId: this.node.id, capabilities: this.catalog() }
    }
    if (method === HUB_METHODS.NODE_LIST) {
      return { nodes: this.hub?.peers ? [...this.hub.peers.values()] : [] }
    }
    throw Object.assign(new Error(`unknown node method ${method}`), { code: 'UNKNOWN_METHOD' })
  }

  async callLocal(params, frame) {
    const name = String(params?.tool ?? '')
    const capability = this.local.get(name)
    if (capability === undefined || capability.enabled === false) {
      throw Object.assign(new Error(`capability ${name} is not enabled on this node`), { code: 'CAPABILITY_UNAVAILABLE' })
    }
    const callId = String(params?.callId ?? `call-${Date.now()}`)
    const controller = new AbortController()
    this.calls.set(callId, controller)
    const signal = controller.signal
    const onFrameAbort = () => controller.abort(new Error('remote call cancelled'))
    try {
      return await capability.handler(params?.args ?? {}, {
        from: frame?.from,
        sessionId: params?.sessionId,
        callId,
        signal,
      })
    } finally {
      this.calls.delete(callId)
      onFrameAbort()
    }
  }

  exposeMode(capabilities) {
    const tools = toolSettings(this.settings)
    if (tools.mode === 'individual' || tools.mode === 'dispatcher') return tools.mode
    return capabilities.length <= tools.individualLimit ? 'individual' : 'dispatcher'
  }

  async syncRemote() {
    if (!this.hub) return
    const peers = [...(this.hub.peers?.values?.() ?? [])].filter((peer) => peer.id !== this.node.id)
    const seen = new Set()
    for (const peer of peers) {
      if (peer.trusted === false) continue
      const capabilities = Array.isArray(peer.capabilities) ? peer.capabilities : []
      if (capabilities.length === 0) continue
      if (capabilities[0]?.parameters === undefined) {
        // Welcome only carries a summary; ask for the full catalog.
        this.requestCatalog(peer.id)
        continue
      }
      seen.add(peer.id)
      const usable = capabilities.filter((capability) => capability.enabled !== false && capabilityKey(capability) !== '')
      const mode = this.exposeMode(usable)
      const wanted = mode === 'individual'
        ? new Map(usable.map((capability) => [remoteToolName(peer.slug ?? peer.name ?? peer.id, capabilityKey(capability)), capability]))
        : new Map([[`node__${String(peer.slug ?? peer.name ?? peer.id).replace(/[^A-Za-z0-9_-]+/gu, '_')}`, { dispatcher: usable }]])
      const registered = this.remote.get(peer.id) ?? new Map()
      this.remote.set(peer.id, registered)
      for (const [toolName, entry] of [...registered]) {
        if (wanted.has(toolName) && entry.mode === mode) continue
        try { entry.dispose?.() } catch {}
        registered.delete(toolName)
      }
      for (const [toolName, capability] of wanted) {
        if (registered.has(toolName)) continue
        try {
          const dispose = capability.dispatcher === undefined
            ? this.registerRemoteTool(peer, capability, toolName)
            : this.registerDispatcher(peer, capability.dispatcher, toolName)
          registered.set(toolName, { dispose, capability, mode })
        } catch (error) {
          this.log.warn?.(`[cross-device] register ${toolName} failed: ${String(error)}`)
        }
      }
    }
    for (const [nodeId, registered] of this.remote) {
      if (seen.has(nodeId)) continue
      for (const entry of registered.values()) {
        try { entry.dispose?.() } catch {}
      }
      this.remote.delete(nodeId)
    }
  }

  requestCatalog(nodeId) {
    if (this.hub === undefined || !this.hub.connected) return
    void this.hub.call(nodeId, 'node.catalog', {}, { timeoutMs: 15_000 }).then((value) => {
      const peer = this.hub.peers.get(nodeId)
      if (peer !== undefined && Array.isArray(value?.capabilities)) {
        peer.capabilities = value.capabilities
        this.hub.peers.set(nodeId, peer)
      }
      void this.syncRemote()
    }).catch(() => {})
  }

  async callRemote(peer, capabilityName, args, exec) {
    const tools = toolSettings(this.settings)
    const callId = String(exec?.callId ?? `tool-${Date.now()}`)
    const result = await this.hub.call(peer.id, HUB_METHODS.TOOL_CALL, {
      callId,
      sessionId: exec?.agent?.session?.id,
      tool: capabilityName,
      args: args ?? {},
    }, { signal: exec?.signal, timeoutMs: tools.timeoutMs ?? 120_000 })
    if (result?.isError === true) throw new Error(result.errorText ?? 'remote tool failed')
    return trimResult(result ?? { text: '' }, tools.maxOutputChars)
  }

  registerRemoteTool(peer, capability, toolName) {
    const fabric = this
    const definition = {
      name: toolName,
      description: `[${peer.name} · ${peer.platform}] ${capability.description ?? ''}`.slice(0, 4000),
      parameters: capability.parameters ?? { type: 'object', properties: {} },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          if (value === null || typeof value !== 'object') return [{ type: 'text', text: String(value ?? '') }]
          if (Array.isArray(value.content)) return value.content
          return [{ type: 'text', text: String(value.text ?? '') }]
        },
      },
      async execute(args, exec) {
        return fabric.callRemote(peer, capability.name, args, exec)
      },
    }
    return this.ctx.tools.register(definition)
  }

  /**
   * One tool per peer. The JSON schema stays tiny: a `tool` enum plus a free
   * `args` object. Descriptions are one line each and the whole listing is
   * capped, so a 25-capability phone costs ~1 schema slot instead of 25.
   */
  registerDispatcher(peer, capabilities, toolName) {
    const fabric = this
    const tools = toolSettings(this.settings)
    const names = capabilities.map((capability) => capabilityKey(capability))
    const lines = []
    let used = 0
    for (const capability of capabilities) {
      const line = `- ${capabilityKey(capability)}: ${oneLine(capability.description, 90)}`
      if (used + line.length > tools.descriptionBudget) { lines.push('- …more capabilities omitted; they still callable'); break }
      lines.push(line)
      used += line.length + 1
    }
    const definition = {
      name: toolName,
      description: [
        `[${peer.name} · ${peer.platform}] Run one capability on this node over the hub.`,
        `Pass {"tool":"<name>","args":{…}}. Capabilities:`,
        ...lines,
      ].join('\n').slice(0, 8000),
      parameters: {
        type: 'object',
        properties: {
          tool: { type: 'string', enum: names, description: 'Capability to run on the remote node.' },
          args: { type: 'object', additionalProperties: true, description: 'Arguments for that capability; see its line above.' },
        },
        required: ['tool'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => {
          if (value === null || typeof value !== 'object') return [{ type: 'text', text: String(value ?? '') }]
          if (Array.isArray(value.content)) return value.content
          return [{ type: 'text', text: String(value.text ?? '') }]
        },
      },
      async execute(args, exec) {
        const name = String(args?.tool ?? '')
        if (!names.includes(name)) throw new Error(`unknown capability "${name}" on ${peer.name}`)
        return fabric.callRemote(peer, name, args?.args ?? {}, exec)
      },
    }
    return this.ctx.tools.register(definition)
  }

  dispose() {
    for (const registered of this.remote.values()) {
      for (const entry of registered.values()) {
        try { entry.dispose?.() } catch {}
      }
    }
    this.remote.clear()
    for (const controller of this.calls.values()) controller.abort(new Error('tool fabric disposed'))
    this.calls.clear()
  }
}

export function remoteToolFor(nodeSlug, capability) {
  return `node__${nodeSlug}__${String(capability).replace(/[^A-Za-z0-9_-]+/gu, '_')}`
}

export { parseRemoteToolName }
