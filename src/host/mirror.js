/**
 * Mirror peer sessions into this node's own store, so a session created on one
 * device shows up (and opens) on every other device in the same workspace.
 *
 * DSH sessions are per-device files; there is no shared store to point at. The
 * mirror therefore keeps a local copy: one local session per remote session,
 * created once, then appended as the remote log grows.
 */
import { materializeSession } from './materialize.js'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export class SessionMirror {
  constructor({ ctx, hub, settings, log = console }) {
    this.ctx = ctx
    this.hub = hub
    this.settings = settings
    this.log = log
    this.local = new Map() // `${peerId}:${remoteId}` -> localId
    this.lastSeq = new Map() // `${peerId}:${remoteId}` -> number
    this.busy = false
  }

  sharedCwd() {
    const base = this.settings?.dataDir ?? join(process.env.DSH_HOME ?? '.', 'cross-device')
    return join(base, 'workspace')
  }

  async snapshot(peerId, sessionId) {
    return await this.hub.call(peerId, 'session.snapshot', { sessionId }, { timeoutMs: 20_000 })
  }

  async ensure(peerId, sessionId) {
    const key = `${peerId}:${sessionId}`
    const known = this.local.get(key)
    if (known !== undefined) return known
    const snap = await this.snapshot(peerId, sessionId)
    if (snap?.manifest === undefined || !Array.isArray(snap.events)) return undefined
    const cwd = this.sharedCwd()
    await mkdir(cwd, { recursive: true }).catch(() => {})
    const { localId } = await materializeSession({
      ctx: this.ctx,
      manifest: snap.manifest,
      events: snap.events,
      cwd,
      title: snap.title,
    })
    this.local.set(key, localId)
    this.lastSeq.set(key, snap.events.reduce((max, event) => Math.max(max, Number(event.seq ?? 0)), 0))
    this.log(`mirrored ${sessionId} -> ${localId}`)
    return localId
  }

  async syncAll() {
    if (this.busy || this.hub === undefined || this.hub.connected !== true) return
    this.busy = true
    try {
      for (const peer of this.hub.peers.values()) {
        if (peer.id === this.ctx.get?.('sessions')?.localNodeId) continue
        let page
        try {
          page = await this.hub.call(peer.id, 'session.list', {}, { timeoutMs: 5_000 })
        } catch {
          continue
        }
        for (const row of page?.items ?? []) {
          if (row?.id === undefined) continue
          try {
            await this.ensure(peer.id, String(row.id))
          } catch (error) {
            this.log(`mirror ${String(row.id)} failed: ${error?.message ?? error}`)
          }
        }
      }
    } finally {
      this.busy = false
    }
  }
}
