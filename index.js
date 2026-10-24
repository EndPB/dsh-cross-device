/**
 * dsh-cross-device Host entry.
 *
 * Composes the node identity, GitHub registry, hub client/server, capability
 * fabric, provenance, session sharing, and the local Web UI channel.
 */
import { networkInterfaces } from 'node:os'
import { defaultSettings, SettingsStore } from './src/host/settings.js'
import { ensureIdentity, publicKeyFingerprint } from './src/host/identity.js'
import { Registry } from './src/host/registry.js'
import { HubClient } from './src/host/hub.js'
import { createHubServer } from './hub/server.js'
import { ToolFabric } from './src/host/tools.js'
import { Provenance } from './src/host/provenance.js'
import { SessionFabric } from './src/host/session.js'
import { EventBus } from './src/host/events.js'
import { registerSse } from './src/host/sse.js'
import { registerRpc } from './src/host/rpc.js'
import { desktopCapabilities } from './src/host/capabilities/desktop.js'
import { androidCapabilities } from './src/host/capabilities/android.js'
import { slugify } from './src/protocol.js'

export const name = 'dsh-cross-device'
export const inject = ['tools', 'sessions']

function log(message) {
  console.log(`[cross-device] ${message}`)
}

function lanUrls(port) {
  const out = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      out.push(`ws://${address.address}:${port}`)
    }
  }
  return out
}

function sanitizeSettings(settings) {
  return {
    ...settings,
    github: { ...settings.github, token: settings.github?.token ? '***' : '' },
    node: { ...settings.node, privateKey: settings.node?.privateKey ? '***' : '' },
  }
}

export async function apply(ctx, config = {}) {
  const store = new SettingsStore(defaultSettings().settingsFile)
  let settings = await store.load()
  const identity = ensureIdentity(settings)
  settings = await store.save({ ...settings, node: { ...settings.node, ...identity, slug: settings.node.slug || slugify(settings.node.name) } })

  const node = {
    id: identity.id,
    name: settings.node.name,
    slug: settings.node.slug,
    platform: settings.platform,
    arch: settings.arch,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    dshVersion: process.env.DSH_VERSION,
  }
  log(`node ${node.id} ${node.name} (${node.platform}/${node.arch}) fingerprint ${publicKeyFingerprint(node.publicKey)}`)

  const bus = new EventBus({ log })
  const registry = new Registry({ settings, identity, log })
  await registry.sync(true).catch(() => {})

  let hub
  const toolFabric = new ToolFabric({ ctx, hub: undefined, node, settings, log })
  toolFabric.addLocalAll(await desktopCapabilities(settings))
  toolFabric.addLocalAll(await androidCapabilities())
  toolFabric.hub = undefined

  const provenance = new Provenance({
    node,
    settings,
    getPeer: (slug) => [...(hub?.peers?.values?.() ?? [])].find((peer) => peer.slug === slug),
    dataDir: settings.dataDir,
    log,
  })
  provenance.registerSystemPrompt(ctx)
  provenance.registerTool(ctx)
  ctx.on('session/event', (session, event) => { void provenance.onEvent(session, event) }, { global: true })

  let sessionFabric
  let localHub
  let reconnectTimer
  let pollTimer
  let disposed = false

  const buildState = () => ({
    node: { id: node.id, name: node.name, slug: node.slug, platform: node.platform, arch: node.arch, fingerprint: publicKeyFingerprint(node.publicKey) },
    hub: {
      url: settings.hub.url || registry.hub?.url,
      mode: registry.hub?.mode ?? settings.hub.mode,
      connected: hub?.connected === true,
      state: hub?.state ?? 'idle',
      hubNodeId: hub?.hubNodeId,
      local: settings.hub.runLocal === true,
    },
    peers: [...(hub?.peers?.values?.() ?? [])].map((peer) => ({
      id: peer.id,
      name: peer.name,
      slug: peer.slug,
      platform: peer.platform,
      arch: peer.arch,
      capabilities: (peer.capabilities ?? []).map((capability) => ({ name: capability.name, description: capability.description, danger: capability.danger === true })),
    })),
    registry: registry.snapshot(),
    coordinating: sessionFabric?.listCoordinating() ?? [],
    viewing: sessionFabric?.listViewing() ?? [],
    capabilities: toolFabric.summary(),
    githubConfigured: Boolean(settings.github.repo),
  })

  const onUpdate = () => {
    bus.publish('state', buildState())
    bus.publish('sessions', { coordinating: sessionFabric?.listCoordinating() ?? [], viewing: sessionFabric?.listViewing() ?? [] })
  }

  sessionFabric = new SessionFabric({ ctx, hub: undefined, node, registry, provenance, settings, log, onUpdate })
  await sessionFabric.init()
  const onRpc = async (method, params, frame) => {
    if (method.startsWith('tool.') || method.startsWith('node.')) return toolFabric.handleRpc(method, params, frame)
    if (method.startsWith('session.') || method.startsWith('takeover.')) return sessionFabric.handleRpc(method, params, frame)
    throw Object.assign(new Error(`unknown rpc method ${method}`), { code: 'UNKNOWN_METHOD' })
  }

  const onHubEvent = (event, data) => {
    if (event === 'session.event') {
      sessionFabric.handleHubEvent(event, data)
      bus.publish('events', data)
      return
    }
    if (event === 'node.online' || event === 'node.offline' || event === 'node.catalog') {
      void toolFabric.syncRemote()
    }
    bus.publish('hub', { event, data })
    bus.publish('state', buildState())
  }

  const startHubClient = async (url) => {
    if (!url) {
      log('no hub URL configured; running local-only')
      return
    }
    if (hub !== undefined) {
      await hub.dispose().catch(() => {})
      hub = undefined
    }
    hub = new HubClient({ url, node, privateKey: node.privateKey, onRpc, onEvent: onHubEvent, log })
    toolFabric.hub = hub
    sessionFabric.hub = hub
    hub.url = url
    hub.setCatalog(toolFabric.catalog())
    void hub.connect().then(async () => {
      log(`connected to hub ${url} as ${hub.hubNodeId ?? '?'}`)
      await toolFabric.syncRemote()
      for (const peer of hub.peers.values()) toolFabric.requestCatalog(peer.id)
    }).catch((error) => {
      log(`hub connect failed: ${String(error)}`)
    })
  }

  const startLocalHub = async () => {
    if (localHub !== undefined) return localHub
    const port = Number(settings.hub.port ?? 8788)
    localHub = await createHubServer({
      host: '127.0.0.1',
      port,
      allowAny: settings.hub.allowAny === true || (settings.hub.runLocal === true && !settings.github.repo),
      hubName: `${node.name} hub`,
      logger: { info: log, warn: log },
    })
    const urls = lanUrls(localHub.port)
    const publicUrl = settings.hub.url || urls[0] || `ws://127.0.0.1:${localHub.port}`
    await registry.publishHub({ url: publicUrl, mode: settings.hub.url ? 'cpolar' : 'lan', hubNodeId: node.id, lanUrls: [`ws://127.0.0.1:${localHub.port}`, ...urls] }).catch((error) => log(`hub publish failed: ${String(error)}`))
    return localHub
  }

  const resolveHubUrl = async () => {
    if (settings.hub.runLocal) {
      await startLocalHub()
      return `ws://127.0.0.1:${localHub.port}`
    }
    if (settings.hub.url) return settings.hub.url
    await registry.sync(true).catch(() => {})
    return registry.hub?.url
  }

  const publishNode = async () => {
    await registry.publishNode({
      name: node.name,
      slug: node.slug,
      platform: node.platform,
      arch: node.arch,
      dshVersion: node.dshVersion,
      lanUrls: lanUrls(localHub?.port ?? settings.hub.port ?? 8788),
      capabilities: toolFabric.summary(),
      trusted: settings.trusted === true,
    }).catch((error) => log(`node publish failed: ${String(error)}`))
  }

  const refresh = async () => {
    if (disposed) return
    await registry.sync(true).catch(() => {})
    const url = settings.hub.runLocal ? `ws://127.0.0.1:${localHub?.port ?? settings.hub.port}` : settings.hub.url || registry.hub?.url
    if (url && (hub === undefined || hub.url !== url || hub.connected === false)) {
      await startHubClient(url)
    }
    bus.publish('state', buildState())
  }

  registerSse(ctx, { bus, buildState, log })
  registerRpc(ctx, async (endpoint, input) => {
    switch (endpoint) {
      case 'status':
        return buildState()
      case 'configure': {
        settings = await store.save({
          ...settings,
          ...input,
          github: { ...settings.github, ...(input.github ?? {}) },
          hub: { ...settings.hub, ...(input.hub ?? {}) },
          capabilities: { ...settings.capabilities, ...(input.capabilities ?? {}) },
          provenance: { ...settings.provenance, ...(input.provenance ?? {}) },
          node: { ...settings.node, ...(input.node ?? {}), id: node.id, publicKey: node.publicKey, privateKey: node.privateKey },
        })
        await publishNode()
        await refresh()
        onUpdate()
        return sanitizeSettings(settings)
      }
      case 'nodes':
        return {
          self: buildState().node,
          peers: buildState().peers,
          registry: registry.snapshot().nodes,
        }
      case 'sessions':
        return {
          coordinating: sessionFabric.listCoordinating(),
          viewing: sessionFabric.listViewing(),
          registry: registry.snapshot().sessions,
        }
      case 'spaces':
        return { spaces: registry.snapshot().spaces }
      case 'createSpace':
        return registry.createSpace(String(input.name ?? '共享区').slice(0, 80))
      case 'history': {
        const events = sessionFabric.events(String(input.sessionId ?? ''))
        const limit = Math.min(Math.max(Number(input.limit ?? 500), 1), 5000)
        return { events: events.slice(-limit), lastSeq: events.length === 0 ? -1 : events[events.length - 1].seq }
      }
      case 'provenance': {
        const session = ctx.get?.('sessions')?.get?.(input.sessionId)
        return { records: provenance.records(session), self: provenance.selfInfo() }
      }
      case 'localSessions': {
        const controller = ctx.get?.('sessionController')
        if (controller === undefined) return { items: [] }
        const value = await controller.list({}, new AbortController().signal)
        return { items: value?.items ?? [] }
      }
      case 'share': {
        let spaceId = String(input.spaceId ?? '')
        if (spaceId === '' || spaceId === 'default') {
          const existing = registry.snapshot().spaces[0]
          spaceId = existing?.id ?? (await registry.createSpace('默认共享区')).id
        }
        return sessionFabric.share(String(input.sessionId ?? ''), spaceId, input.title)
      }
      case 'unshare': {
        const state = sessionFabric.coordinating.get(String(input.sessionId ?? ''))
        if (state === undefined) return { ok: false }
        state.released = true
        sessionFabric.coordinating.delete(String(input.sessionId ?? ''))
        onUpdate()
        return { ok: true }
      }
      case 'subscribe':
        return sessionFabric.subscribe(String(input.sessionId ?? ''))
      case 'prompt':
        return sessionFabric.prompt(String(input.sessionId ?? ''), input.content ?? [{ type: 'text', text: String(input.text ?? '') }], {
          mode: input.mode === 'steer' ? 'steer' : 'queue',
          requestId: input.requestId,
          nodeInfo: node,
        })
      case 'cancel':
        return sessionFabric.cancel(String(input.sessionId ?? ''))
      case 'takeover':
        return sessionFabric.takeover(String(input.sessionId ?? ''), { force: input.force === true, cwd: input.cwd })
      case 'refresh':
        await refresh()
        return buildState()
      default:
        throw Object.assign(new Error(`unknown endpoint ${JSON.stringify(endpoint)}`), { code: 'UNKNOWN_ENDPOINT' })
    }
  })

  await publishNode()
  const url = await resolveHubUrl()
  await startHubClient(url)

  pollTimer = setInterval(() => { void refresh() }, 60_000)
  pollTimer.unref?.()

  ctx.effect(() => () => {
    disposed = true
    clearInterval(pollTimer)
    clearTimeout(reconnectTimer)
    sessionFabric.dispose()
    toolFabric.dispose()
    provenance.dispose()
    void hub?.dispose()
    void localHub?.close()
  }, 'dsh-cross-device: lifecycle')

}