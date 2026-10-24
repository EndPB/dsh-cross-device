/**
 * GitHub-backed registry: node files, hub address, spaces, and session
 * manifests. Node files are individually owned; no shared mutable document is
 * rewritten by every node.
 */
import { GitHubConfig, GitHubError } from './github.js'

export class Registry {
  constructor({ settings, identity, fetchImpl, log = console }) {
    this.settings = settings
    this.identity = identity
    this.log = log
    this.github = settings.github?.repo
      ? new GitHubConfig({ repo: settings.github.repo, branch: settings.github.branch, token: settings.github.token, fetchImpl })
      : undefined
    this.nodes = new Map()
    this.sessions = new Map()
    this.spaces = new Map()
    this.hub = undefined
    this.lastSyncAt = 0
    this.syncing = undefined
  }

  configured() {
    return this.github !== undefined
  }

  async sync(force = false) {
    if (!this.configured()) return this.snapshot()
    if (!force && Date.now() - this.lastSyncAt < 15_000) return this.snapshot()
    if (this.syncing !== undefined) return this.syncing
    this.syncing = (async () => {
      try {
        const tree = await this.github.listTree({ etag: this.treeEtag })
        if (!tree.notModified) this.treeEtag = tree.etag
        const paths = tree.notModified ? undefined : tree.tree
        if (paths !== undefined) {
          const wantedNodes = paths.filter((path) => path.startsWith('nodes/') && path.endsWith('.json'))
          const wantedSessions = paths.filter((path) => path.startsWith('sessions/') && path.endsWith('.json'))
          const wantedSpaces = paths.filter((path) => path.startsWith('spaces/') && path.endsWith('.json'))
          const nextNodes = new Map()
          for (const path of wantedNodes) {
            const item = await this.github.readJson(path)
            if (item?.value?.id) nextNodes.set(item.value.id, item.value)
          }
          const nextSessions = new Map()
          for (const path of wantedSessions) {
            const item = await this.github.readJson(path)
            if (item?.value?.id) nextSessions.set(item.value.id, item.value)
          }
          const nextSpaces = new Map()
          for (const path of wantedSpaces) {
            const item = await this.github.readJson(path)
            if (item?.value?.id) nextSpaces.set(item.value.id, item.value)
          }
          this.nodes = nextNodes
          this.sessions = nextSessions
          this.spaces = nextSpaces
        }
        const hub = await this.github.readJson('hub.json')
        if (hub?.value) this.hub = hub.value
        this.lastSyncAt = Date.now()
      } catch (error) {
        this.lastError = String(error)
        this.log.warn?.(`[cross-device] registry sync failed: ${String(error)}`)
      } finally {
        this.syncing = undefined
      }
      return this.snapshot()
    })()
    return this.syncing
  }

  snapshot() {
    return {
      configured: this.configured(),
      hub: this.hub,
      nodes: [...this.nodes.values()],
      sessions: [...this.sessions.values()],
      spaces: [...this.spaces.values()],
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    }
  }

  async publishNode({ name, slug, platform, arch, dshVersion, lanUrls, capabilities, trusted = false }) {
    if (!this.configured()) return undefined
    const node = {
      version: 1,
      id: this.identity.id,
      name,
      slug,
      platform,
      arch,
      ...dshVersion === undefined ? {} : { dshVersion },
      publicKey: this.identity.publicKey,
      trusted,
      lanUrls: lanUrls ?? [],
      capabilities: capabilities ?? [],
      updatedAt: Date.now(),
    }
    const path = `nodes/${this.identity.id}.json`
    await this.github.writeJson(path, node, `node: register ${name}`)
    this.nodes.set(node.id, node)
    return node
  }

  async publishHub(hub) {
    if (!this.configured()) return undefined
    const value = {
      version: 1,
      url: hub.url,
      mode: hub.mode ?? 'cpolar',
      hubNodeId: hub.hubNodeId ?? this.identity.id,
      lanUrls: hub.lanUrls ?? [],
      updatedAt: Date.now(),
    }
    await this.github.writeJson('hub.json', value, `hub: ${value.mode} ${value.url}`)
    this.hub = value
    return value
  }

  async publishSession(session) {
    if (!this.configured()) return undefined
    const value = {
      version: 1,
      id: session.id,
      spaceId: session.spaceId,
      title: session.title,
      coordinatorNodeId: session.coordinatorNodeId,
      epoch: session.epoch ?? 0,
      lastSeq: session.lastSeq ?? -1,
      formatVersion: session.formatVersion ?? 4,
      ...session.header === undefined ? {} : { header: session.header },
      updatedAt: Date.now(),
    }
    await this.github.writeJson(`sessions/${value.id}.json`, value, `session: ${value.title}`)
    this.sessions.set(value.id, value)
    return value
  }

  async createSpace(name) {
    const id = `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const value = { version: 1, id, name, createdAt: Date.now() }
    if (this.configured()) await this.github.writeJson(`spaces/${id}.json`, value, `space: ${name}`)
    this.spaces.set(id, value)
    return value
  }

  async readNodesFresh() {
    await this.sync(true)
    return [...this.nodes.values()]
  }
}

export { GitHubError }