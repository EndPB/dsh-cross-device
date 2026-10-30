/**
 * Mirror the shared workspace across devices.
 *
 * Rules:
 *   - Only sessions whose cwd is a shared workspace take part. A session in a
 *     private project never leaves its device.
 *   - A session's identity is its ORIGIN: `{nodeId, sessionId}` of the device
 *     that created it. Every copy carries that origin (see `origins` in
 *     mirror.json), so a copy of a copy is still the same session and can never
 *     breed a new one.
 *   - The timestamp is the version: each mirrored session remembers the newest
 *     event time it already holds and the peer only sends the newer tail. When
 *     both sides advanced, the tails are unioned (git-like merge), never
 *     overwritten and never duplicated.
 */
import { materializeSession } from './materialize.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const EMPTY = Object.freeze({ events: [], latestTime: 0 })
const SHARED_CWD = /cross-device[\\/]workspace/iu

export class SessionMirror {
  constructor({ ctx, hub, settings, node, log = console }) {
    this.ctx = ctx
    this.hub = hub
    this.settings = settings
    this.node = node
    this.log = log
    // `${originNode}:${originSession}` -> { localId, time, seq, rev }
    this.local = new Map()
    // localId -> { nodeId, sessionId }
    this.origins = new Map()
    this.busy = false
    this.loaded = false
    this.syncedAt = 0
    this.failures = new Set()
    this.recent = []
    this.pending = new Map()
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
      for (const [localId, origin] of Object.entries(raw?.origins ?? {})) {
        if (origin?.nodeId === undefined) continue
        this.origins.set(localId, { nodeId: String(origin.nodeId), sessionId: String(origin.sessionId ?? '') })
      }
      this.syncedAt = Number(raw?.syncedAt ?? 0)
    } catch {}
  }

  async save() {
    const payload = {
      version: 2,
      syncedAt: this.syncedAt,
      sessions: Object.fromEntries(this.local),
      origins: Object.fromEntries(this.origins),
    }
    try {
      await mkdir(this.baseDir(), { recursive: true })
      await writeFile(this.stateFile(), `${JSON.stringify(payload, undefined, 2)}\n`, 'utf8')
    } catch (error) {
      this.report(`mirror state not saved: ${error?.message ?? error}`)
    }
  }

  originOf(localId) {
    return this.origins.get(localId)
  }

  /**
   * Page through a peer's log. A big session would otherwise exceed the
   * WebSocket frame limit and drop the whole connection.
   */
  async snapshot(peerId, sessionId, sinceTime) {
    const events = []
    let manifest
    let latestTime = 0
    let fromSeq = 0
    for (let page = 0; page < 1000; page += 1) {
      const value = await this.hub.call(peerId, 'session.snapshot',
        { sessionId, sinceTime, fromSeq, limit: 400 }, { timeoutMs: 30_000 })
      if (value === undefined || value === null) break
      manifest = manifest ?? value.manifest
      latestTime = Math.max(latestTime, Number(value.latestTime ?? 0))
      const chunk = Array.isArray(value.events) ? value.events : []
      events.push(...chunk)
      if (value.more !== true || chunk.length === 0) break
      fromSeq = Number(chunk[chunk.length - 1]?.seq ?? 0) + 1
    }
    return events.length === 0 && manifest === undefined ? EMPTY : { manifest, events, latestTime }
  }

  /** The live session, when this device already has the copy open. */
  liveSession(localId) {
    return this.ctx.get?.('sessions')?.get?.(localId)
  }

  /**
   * Append to a mirrored session. A copy that is currently open in this process
   * owns the write handle, so the live session is the only legal writer; only
   * when nothing has it open does the persistence handle get used.
   */
  async appendInto(localId, events) {
    const live = this.liveSession(localId)
    if (live?.appendEvents !== undefined) {
      await live.appendEvents(events)
      return
    }
    if (live?.append !== undefined) {
      await live.append(events)
      return
    }
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

  /** Retry appends that lost the race against an open session. */
  async flushPending() {
    if (this.pending.size === 0) return
    for (const [localId, events] of [...this.pending]) {
      try {
        await this.appendInto(localId, events)
        this.pending.delete(localId)
      } catch {}
    }
  }

  maxTime(events) {
    return events.reduce((max, event) => Math.max(max, Number(event.time ?? 0)), 0)
  }

  maxSeq(events) {
    return events.reduce((max, event) => Math.max(max, Number(event.seq ?? 0)), 0)
  }

  isSharedRow(row) {
    return SHARED_CWD.test(String(row?.cwd ?? ''))
  }

  /** Identity of a mirrored session: its birth stamp, on every device alike. */
  keyOf(row) {
    const createdAt = Number(row?.createdAt ?? 0)
    return createdAt > 0 ? `t${createdAt}` : ''
  }

  async ensure(peerId, row) {
    const remoteId = String(row?.id ?? '')
    if (remoteId === '') return undefined
    let key = this.keyOf(row)
    let current = key === '' ? undefined : this.local.get(key)
    if (current !== undefined && row?.rev !== undefined && current.rev === String(row.rev)) return current.localId
    const sinceTime = current?.time ?? 0
    const snap = await this.snapshot(peerId, remoteId, key === '' ? 0 : sinceTime)
    if (key === '') {
      // The birth stamp lives in the session header, which every copy carries,
      // so it works even against a peer that reports no extra fields.
      const born = Number(snap?.manifest?.header?.createdAt ?? 0)
      if (born > 0) {
        key = `t${born}`
        current = this.local.get(key)
      }
    }
    if (key === '') throw new Error('session header has no createdAt')
    let events = Array.isArray(snap.events) ? snap.events : []
    if (current !== undefined && current.seq >= 0) {
      events = events.filter((event) => Number(event.seq ?? 0) > current.seq)
    }
    const latestTime = Number(snap.latestTime ?? 0) || this.maxTime(events) || sinceTime
    if (current !== undefined) {
      if (events.length > 0) {
        try {
          await this.appendInto(current.localId, events)
        } catch (error) {
          // The copy is open and busy right now: keep the tail for the next pass
          // instead of losing it or racing the owning handle.
          const queued = this.pending.get(current.localId) ?? []
          this.pending.set(current.localId, [...queued, ...events])
          return current.localId
        }
        this.syncedAt = Math.max(this.syncedAt, latestTime)
        this.note(`merged ${events.length} event(s) into ${current.localId} (${key})`)
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
    this.origins.set(localId, row?.origin ?? { nodeId: peerId, sessionId: remoteId })
    this.syncedAt = Math.max(this.syncedAt, latestTime)
    this.note(`mirrored ${key} -> ${localId} (${events.length} events)`)
    return localId
  }

  async syncAll() {
    if (this.busy || this.hub === undefined || this.hub.connected !== true) return
    this.busy = true
    await this.load()
    await this.flushPending()
    const persistence = this.ctx.get?.('sessionPersistence')
    if (persistence?.stat !== undefined) {
      for (const [key, value] of [...this.local]) {
        const alive = await persistence.stat(value.localId).catch(() => undefined)
        if (alive === undefined) {
          this.local.delete(key)
          this.origins.delete(value.localId)
        }
      }
    }
    try {
      for (const peer of this.hub.peers.values()) {
        if (this.node !== undefined && peer.id === this.node.id) continue
        let page
        try {
          page = await this.hub.call(peer.id, 'session.list', {}, { timeoutMs: 8_000 })
        } catch (error) {
          this.report(`peer ${peer.name ?? peer.id} session.list failed: ${error?.message ?? error}`)
          continue
        }
        for (const row of page?.items ?? []) {
          if (!this.isSharedRow(row)) continue
          try {
            await this.ensure(peer.id, row)
          } catch (error) {
            this.report(`mirror ${String(row?.id)} from ${peer.name ?? peer.id} failed: ${error?.message ?? error}`)
          }
        }
      }
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
