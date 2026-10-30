/**
 * dsh-cross-device Host entry.
 *
 * Composes the node identity, GitHub registry, hub client/server, capability
 * fabric, provenance, session sharing, and the local Web UI channel.
 */
import { networkInterfaces } from 'node:os'
import { connect as netConnect } from 'node:net'
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
import { GitHubDeviceFlow } from './src/host/github-device.js'
import { LanLink } from './src/host/lan.js'

export const name = 'dsh-cross-device'
export const inject = ['tools', 'sessions']

function log(message) {
  console.log(`[cross-device] ${message}`)
}

function lanUrls(port) {
  // Only physical interfaces: a VPN/TUN adapter (vgate0, tun0, utun, tailscale)
  // produces an address that is routable inside that tunnel and nowhere else.
  const skip = /(^|\b)(tun\d*|tap\d*|utun\d*|wg\d*|ipsec|ppp\d*|tailscale|zerotier|vgate|vpn|docker|veth|br-|virbr|vmnet|vbox|wsl|hyper-v)/iu
  const out = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (skip.test(name)) continue
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      const mask = String(address.netmask ?? '255.255.255.0').split('.').map(Number)
      if (mask.every((part) => part === 255)) continue
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

  const githubFlow = new GitHubDeviceFlow()
  const lanLink = new LanLink({ nodeId: node.id, name: node.name, platform: node.platform, log }).start()
  const bus = new EventBus({ log })
  const registry = new Registry({ settings, identity, log })
  await registry.sync(true).catch(() => {})

  let hub
  const toolFabric = new ToolFabric({ ctx, hub: undefined, node, settings, log })
  const androidCaps = await androidCapabilities()
  const isMobile = androidCaps.some((capability) => capability.enabled !== false)
  if (!isMobile) toolFabric.addLocalAll(await desktopCapabilities(settings))
  toolFabric.addLocalAll(androidCaps)
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
  let hubTarget = ''
  let hubError = ''
  const shownHubUrl = () => {
    const localUrl = `ws://127.0.0.1:${localHub?.port ?? settings.hub.port ?? 8788}`
    if (hubTarget === '' || hubTarget === localUrl) return lanUrls(localHub?.port ?? settings.hub.port ?? 8788)[0] ?? hubTarget
    return hubTarget
  }
  const rankOf = (platform) => (platform === 'win32' || platform === 'darwin') ? 0 : platform === 'linux' ? 1 : 2

  const buildState = () => ({
    node: { id: node.id, name: node.name, slug: node.slug, platform: node.platform, arch: node.arch, fingerprint: publicKeyFingerprint(node.publicKey) },
    hub: {
      url: shownHubUrl(),
      mode: registry.hub?.mode ?? settings.hub.mode,
      connected: hub?.connected === true,
      state: hub?.state ?? 'idle',
      hubNodeId: hub?.hubNodeId,
      local: localHub !== undefined,
      hubCapable: settings.hub.runLocal === true,
      runLocal: settings.hub.runLocal === true,
      lanUrl: (lanUrls(localHub?.port ?? settings.hub.port ?? 8788)[0] ?? ''),
      relay: hubTarget,
      lastError: hubError,
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
    github: { repo: settings.github.repo, login: settings.github.login ?? '', hasToken: Boolean(settings.github.token) },
    isDesktop: !isMobile,
    githubConfigured: Boolean(settings.github.repo),
  })

  const onUpdate = () => {
    bus.publish('state', buildState())
    bus.publish('sessions', { coordinating: sessionFabric?.listCoordinating() ?? [], viewing: sessionFabric?.listViewing() ?? [] })
  }

  sessionFabric = new SessionFabric({ ctx, hub: undefined, node, registry, provenance, settings, log, onUpdate })
  await sessionFabric.init()
  const listLocalSessions = async () => {
    const controller = ctx.get?.('sessionController')
    if (controller?.list === undefined) return []
    const value = await controller.list({}, new AbortController().signal)
    return (value?.items ?? []).map((item) => ({
      id: String(item.sessionId ?? item.id ?? ''),
      title: item.title ?? undefined,
      cwd: item.cwd,
      running: item.running === true,
      updatedAt: item.updatedAt ?? item.mtime,
      node: node.name,
      nodeId: node.id,
      local: true,
    })).filter((row) => row.id !== '')
  }
  const createLocalSession = async (cwd) => {
    const controller = ctx.get?.('sessionController')
    if (controller?.create === undefined) throw new Error('this DSH build exposes no sessionController.create')
    const created = await controller.create({ cwd }, new AbortController().signal)
    const id = created?.sessionId ?? created?.id ?? created?.session?.id
    return { id }
  }
  const onRpc = async (method, params, frame) => {
    if (method === 'session.list') return { items: await listLocalSessions() }
    if (method === 'sessions.create') return await createLocalSession(params?.cwd)
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
      host: '0.0.0.0',
      port,
      allowAny: settings.hub.allowAny === true || (settings.hub.runLocal === true && !settings.github.repo),
      hubName: `${node.name} hub`,
      logger: { info: log, warn: log },
    })
    const urls = lanUrls(localHub.port)
    lanLink.setHubUrl(urls[0] ?? `ws://127.0.0.1:${localHub.port}`, urls); lanLink.hub = true
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
    const found = await lanLink.waitForHub(6000)
    if (found !== undefined) return found
    await registry.sync(true).catch(() => {})
    return registry.hub?.url
  }

  const publishNode = async () => {
    if (settings.github.token === '') return
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
      case 'github.start':
        return githubFlow.start()
      case 'github.poll': {
        const result = await githubFlow.poll()
        if (result.state === 'done') {
          const repo = settings.github.repo || (result.login ? `${result.login}/dsh-cross-device-config` : '')
          settings = await store.save({ ...settings, github: { ...settings.github, token: result.token, login: result.login ?? '', repo } })
          await publishNode()
          await refresh()
          onUpdate()
          return { ...result, repo }
        }
        return result
      }      case 'sharedWorkspace': {
        const { mkdir, readFile, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const dir = join(settings.dataDir, 'workspace')
        const marker = join(settings.dataDir, 'workspace.json')
        await mkdir(dir, { recursive: true })
        let created = false
        try { await readFile(marker, 'utf8') } catch {
          await writeFile(marker, `${JSON.stringify({ path: dir, createdAt: new Date().toISOString() })}\n`, 'utf8')
          created = true
        }
        return { path: dir, created }
      }      case 'sessions.create': {
        const peer = input.nodeId !== undefined && input.nodeId !== ''
          ? [...(hub?.peers?.values?.() ?? [])].find((row) => row.id === input.nodeId || row.slug === input.nodeId)
          : undefined
        const created = peer === undefined
          ? await createLocalSession(input.cwd)
          : await hub.call(peer.id, 'sessions.create', { cwd: input.cwd }, { timeoutMs: 30_000 })
        onUpdate()
        return { ...created, nodeId: peer?.id ?? node.id, node: peer?.name ?? node.name }
      }
      case 'sessions.all': {
        const items = await listLocalSessions()
        for (const peer of hub?.peers?.values?.() ?? []) {
          try {
            const remote = await hub.call(peer.id, 'session.list', {}, { timeoutMs: 4000 })
            for (const row of remote?.items ?? []) items.push({ ...row, node: peer.name, nodeId: peer.id, local: false })
          } catch {}
        }
        items.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
        return { items }
      }      case 'nodes':
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
  // Every node can host, but the mesh elects ONE relay: the smallest node id
  // that is currently advertising a hub. When that node leaves, the next one
  // takes over, so no single desktop is required for the network to exist.
  const localHubUrl = () => `ws://127.0.0.1:${localHub?.port ?? settings.hub.port ?? 8788}`
  const hubBlockedUntil = new Map()
  const reachable = (url) => new Promise((resolve) => {
    let done = false
    const finish = (value) => { if (!done) { done = true; try { socket.destroy() } catch {}; resolve(value) } }
    let socket
    try {
      const parsed = new URL(url)
      socket = netConnect({ host: parsed.hostname, port: Number(parsed.port || 8788) })
    } catch { resolve(false); return }
    socket.setTimeout(1500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
  const pickHub = async () => {
    const now = Date.now()
    const local = { id: node.id, url: localHubUrl(), rank: rankOf(node.platform) }
    const candidates = settings.hub.runLocal === true ? [local] : []
    for (const peer of lanLink.livePeers()) {
      if (peer.url === '' || peer.hub !== true) continue
      if ((hubBlockedUntil.get(peer.id) ?? 0) > now) continue
      candidates.push({ id: peer.id, url: peer.url, urls: peer.urls ?? [peer.url], rank: rankOf(peer.platform) })
    }
    candidates.sort((left, right) => (left.rank ?? 9) - (right.rank ?? 9) || String(left.id).localeCompare(String(right.id)))
    // The smallest id wins only when it is actually reachable from here; a
    // VPN/tunnel or firewall failure must not strand the whole node.
    for (const candidate of candidates) {
      for (const url of candidate.urls ?? [candidate.url]) {
        if (await reachable(url)) return { id: candidate.id, url, rank: candidate.rank ?? 9 }
      }
      if (candidate.id !== node.id) hubBlockedUntil.set(candidate.id, Date.now() + 60_000)
    }
    return local
  }

  if (settings.hub.runLocal === true) await startLocalHub()
  const localUrl = localHubUrl()
  const betterHub = async () => {
    const mine = rankOf(node.platform)
    const peers = lanLink.livePeers()
      .filter((row) => row.hub === true && row.url !== '' && (localHub === undefined || rankOf(row.platform) < mine))
      .sort((a, b) => rankOf(a.platform) - rankOf(b.platform))
    for (const peer of peers) if (await reachable(peer.url)) return peer.url
    return undefined
  }
  const firstHub = (await betterHub()) ?? (localHub !== undefined ? localUrl : undefined)
  if (firstHub !== undefined) await startHubClient(firstHub)
  else log('no hub yet; waiting for a LAN beacon')
  const electionTimer = setInterval(async () => {
    if (hub === undefined || hub.connected !== true) {
      const fallback = (await betterHub()) ?? (localHub !== undefined ? localUrl : undefined)
      if (fallback !== undefined) { log(`retry hub ${fallback}`); void startHubClient(fallback) }
      return
    }
    const better = await betterHub()
    if (better !== undefined && better !== hub.url) { log(`better hub ${better}`); void startHubClient(better) }
  }, 15000)

  pollTimer = setInterval(() => { void refresh() }, 60_000)
  pollTimer.unref?.()

  ctx.effect(() => () => {
    disposed = true
    clearInterval(pollTimer)
    clearTimeout(reconnectTimer)
    sessionFabric.dispose()
    toolFabric.dispose()
    provenance.dispose()
    clearInterval(electionTimer)
    lanLink.dispose()
    void hub?.dispose()
    void localHub?.close()
  }, 'dsh-cross-device: lifecycle')

}