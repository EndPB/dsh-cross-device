/**
 * Capability registry and remote tool bridge.
 *
 * Local capabilities are plain handlers. Peers' capabilities are registered
 * as ordinary DSH ToolDefinitions whose execute() routes a tool.call over the
 * hub and returns the remote content. The coordinator's Session therefore
 * records the call like any local tool.
 */
import { HUB_METHODS, parseRemoteToolName, remoteToolName } from '../protocol.js'

export class ToolFabric {
  constructor({ ctx, hub, node, settings, log = console }) {
    this.ctx = ctx
    this.hub = hub
    this.node = node
    this.settings = settings
    this.log = log
    this.local = new Map()
    this.remote = new Map() // nodeId -> Map<name, { dispose, capability }>
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
      .map((capability) => ({ name: capability.name, description: capability.description, danger: capability.danger === true }))
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
      const result = await capability.handler(params?.args ?? {}, {
        from: frame?.from,
        sessionId: params?.sessionId,
        callId,
        signal,
      })
      return result
    } finally {
      this.calls.delete(callId)
      onFrameAbort()
    }
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
      let registered = this.remote.get(peer.id)
      if (registered === undefined) {
        registered = new Map()
        this.remote.set(peer.id, registered)
      }
      const names = new Set()
      for (const capability of capabilities) {
        if (capability.enabled === false) continue
        if (capability.name === undefined) continue
        const toolName = remoteToolName(peer.slug ?? peer.name ?? peer.id, capability.name)
        names.add(toolName)
        if (registered.has(toolName)) continue
        try {
          const dispose = this.registerRemoteTool(peer, capability, toolName)
          registered.set(toolName, { dispose, capability })
        } catch (error) {
          this.log.warn?.(`[cross-device] register ${toolName} failed: ${String(error)}`)
        }
      }
      for (const [toolName, entry] of registered) {
        if (!names.has(toolName)) {
          try { entry.dispose?.() } catch {}
          registered.delete(toolName)
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
        const callId = String(exec?.callId ?? `tool-${Date.now()}`)
        const signal = exec?.signal
        const result = await fabric.hub.call(peer.id, HUB_METHODS.TOOL_CALL, {
          callId,
          sessionId: exec?.agent?.session?.id,
          tool: capability.name,
          args: args ?? {},
        }, { signal, timeoutMs: capability.timeoutMs ?? 120_000 })
        if (result?.isError === true) throw new Error(result.errorText ?? 'remote tool failed')
        return result ?? { text: '' }
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