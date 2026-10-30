/**
 * Mirror peer sessions into this node's own store, so a session created on one
 * device shows up (and opens) on every other device in the same workspace.
 *
 * DSH sessions are per-device files; there is no shared store to point at. The
 * mirror therefore keeps a local copy: one local session per remote session,
 * created once, then appended as the remote log grows.
 *
 * Versioning is by timestamp, in two scopes:
 *   - the shared workspace carries one timestamp: the newest event time seen
 *     across every mirrored session (`syncedAt`);
 *   - each mirrored session carries its own timestamp: the newest event time
 *     already written into its local copy (`time`).
 * A peer only has to hand over events newer than `time`, so a pass over ten
 * idle sessions transfers nothing.
 *
 * Mirrors must never mirror each other: a copy is created with `cwd` inside
 * `<dataDir>/workspace`, and a row whose cwd is such a workspace is skipped, so
 * desktop -> tablet -> desktop cannot breed copies of copies.
 */
import { materializeSession } from './materialize.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const EMPTY = Object.freeze({ events: [], latestTime: 0 })
const MIRROR_CWD = /cross-device[\\/]workspace/iu

export class SessionMirror {
  constructor({ ctx, hub, settings, node, log = console }) {
    this.ctx = ctx
    this.hub = hub
    this.settings = settings
    this.node = node
    this.log = log
    // `${peerId}:${remoteId}` -> { localId, time, seq, rev }
    this.local = new Map()
    this.busy = false
    this.loaded = false
    this.syncedAt = 0
    this.failures = new Set()
    /** Ring of human-readable activity lines, shown in the node page. */
    this.recent = []
  }

  baseDir() {
    return this.settings?.dataDir ?? join(process.env.DSH_HOME ?? '.', 'cross-device')
  }

  sharedCwd() {
    return join(this.baseDir(), 'workspace')
  }

  stateFile() {
    return join(this.baseDir(), 'mirror.json')
  }

  note(text) {
    this.recent.push({ t: Date.now(), text })
    if (this.recent.length > 60) this.recent.splice(0, this.recent.length - 60)
    this.log(text)
  }

  /** Log each distinct failure once; a poll loop must not flood the log. */
  report(message) {
    if (this.failures.has(message)) return
    this.failures.add(message)
    this.note(message)
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.stateFile(), 'utf8'))
      for (const [key, value] of Object.entries(raw?.sessions ?? {})) {
        if (value?.localId === undefined) continue
        this.local.set(key, {
          localId: String(value.localId),
          time: Number(value.time ?? 0),
          seq: Number(value.seq ?? -1),
          rev: value.rev === undefined ? undefined : String(value.rev),
        })
      }
      this.syncedAt = Number(raw?.syncedAt ?? 0)
    } catch {}
  }

  async save() {
    const payload = {
      version: 1,
      syncedAt: this.syncedAt,
      sessions: Object.fromEntries(this.local),
    }
    try {
      await mkdir(this.baseDir(), { recursive: true })
      await writeFile(this.stateFile(), `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8')
    } catch (error) {
      this.report(`mirror state not saved: ${error?.message ?? error}`)
    }
  }

  async snapshot(peerId, sessionId, sinceTime) {
    const value = await this.hub.call(peerId, 'session.snapshot', { sessionId, sinceTime }, { timeoutMs: 20_000 })
    return value === undefined || value === null ? EMPTY : value
  }

  /** Append new events to an existing mirrored session. */
  async appendInto(localId, events) {
    const persistence = this.ctx.get?.('sessionPersistence')
    if (persistence?.open === undefined) throw new Error('sessionPersistence.open is unavailable')
    const handle = await persistence.open(localId, 'write')
    try {
      await handle.append(events)
      await handle.flush()
    } finally {
      try { await handle.close() } catch {}
    }
  }

  maxTime(events) {
    return events.reduce((max, event) => Math.max(max, Number(event.time ?? 0)), 0)
  }

  maxSeq(events) {
    return events.reduce((max, event) => Math.max(max, Number(event.seq ?? 0)), 0)
  }

  isMirrorRow(row) {
    const cwd = String(row?.cwd ?? '')
    return cwd !== '' && MIRROR_CWD.test(cwd)
  }

  async ensure(peerId, row) {
    const remoteId = String(row?.id ?? '')
    if (remoteId === '') return undefined
    const key = `${peerId}:${remoteId}`
    const known = this.local.get(key)
    if (known !== undefined && row?.rev !== undefined && known.rev === String(row.rev)) return known.localId
    if (known !== undefined) {
      const persistence = this.ctx.get?.('sessionPersistence')
      const exists = await persistence?.stat?.(known.localId).catch(() => undefined)
      if (exists === undefined) this.local.delete(key)
    }
    const current = this.local.get(key)
    const sinceTime = current?.time ?? 0
    const snap = await this.snapshot(peerId, remoteId, sinceTime)
    let events = Array.isArray(snap.events) ? snap.events : []
    if (current !== undefined && current.seq >= 0) {
      events = events.filter((event) => Number(event.seq ?? 0) > current.seq)
    }
    const latestTime = Number(snap.latestTime ?? 0) || this.maxTime(events) || sinceTime
    if (current !== undefined) {
      if (events.length > 0) {
        await this.appendInto(current.localId, events)
        this.syncedAt = Math.max(this.syncedAt, latestTime)
        this.note(`streamed ${events.length} event(s) into ${current.localId} from ${remoteId}`)
      }
      current.time = latestTime
      current.seq = Math.max(current.seq, this.maxSeq(events))
      if (row?.rev !== undefined) current.rev = String(row.rev)
      return current.localId
    }
    if (snap.manifest === undefined || events.length === 0) return undefined
    const cwd = this.sharedCwd()
    await mkdir(cwd, { recursive: true }).catch(() => {})
    const { localId } = await materializeSession({
      ctx: this.ctx,
      manifest: snap.manifest,
      events,
      cwd,
      title: snap.title ?? row?.title,
    })
    this.local.set(key, {
      localId,
      time: latestTime,
      seq: this.maxSeq(events),
      rev: row?.rev === undefined ? undefined : String(row.rev),
    })
    this.syncedAt = Math.max(this.syncedAt, latestTime)
    this.note(`mirrored ${remoteId} -> ${localId} (${events.length} events)`)
    return localId
  }

  async syncAll() {
    if (this.busy || this.hub === undefined || this.hub.connected !== true) return
    this.busy = true
    await this.load()
    // Forget mappings whose local copy no longer exists (the workspace was
    // cleaned by hand, or the session was deleted from the UI).
    const persistence = this.ctx.get?.('sessionPersistence')
    if (persistence?.stat !== undefined) {
      for (const [key, value] of [...this.local]) {
        const alive = await persistence.stat(value.localId).catch(() => undefined)
        if (alive === undefined) this.local.delete(key)
      }
    }
    let peers = 0
    let skipped = 0
    try {
      for (const peer of this.hub.peers.values()) {
        if (this.node !== undefined && peer.id === this.node.id) continue
        peers += 1
        let page
        try {
          page = await this.hub.call(peer.id, 'session.list', {}, { timeoutMs: 8_000 })
        } catch (error) {
          this.report(`peer ${peer.name ?? peer.id} session.list failed: ${error?.message ?? error}`)
          continue
        }
        for (const row of page?.items ?? []) {
          if (this.isMirrorRow(row)) { skipped += 1; continue }
          try {
            await this.ensure(peer.id, row)
          } catch (error) {
            this.report(`mirror ${String(row?.id)} from ${peer.name ?? peer.id} failed: ${error?.message ?? error}`)
          }
        }
      }
      if (peers === 0) this.note('no peers online')
      else this.syncedAt = Math.max(this.syncedAt, 0)
      if (skipped > 0) this.failures.delete('loop')
    } finally {
      await this.save()
      this.busy = false
    }
  }

  summary() {
    return {
      syncedAt: this.syncedAt,
      count: this.local.size,
      sharedCwd: this.sharedCwd(),
      recent: this.recent.slice(-30),
    }
  }
}
