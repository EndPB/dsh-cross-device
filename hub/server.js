/**
 * dsh-cross-device hub: authenticated WebSocket relay for node RPC and
 * presence. The hub never runs an agent and never stores a session log.
 */
import { WebSocketServer } from 'ws'
import { createHash, randomBytes, timingSafeEqual, verify } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PROTOCOL_VERSION, HelloSchema } from '../src/protocol.js'

const HUB_ID = 'n_hub000000000000'

function decodeKey(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    return Buffer.from(value, 'base64')
  } catch {
    return undefined
  }
}

function verifySignature(publicKey, challenge, signature) {
  try {
    const key = decodeKey(publicKey)
    if (key === undefined) return false
    return verify(null, Buffer.from(challenge, 'utf8'), { key, format: 'der', type: 'spki' }, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

async function loadTrustFile(path) {
  if (path === undefined || path === null || path === '') return new Map()
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  const nodes = Array.isArray(parsed) ? parsed : Array.isArray(parsed.nodes) ? parsed.nodes : []
  return new Map(nodes.map((node) => [node.id, { publicKey: node.publicKey, trusted: node.trusted !== false, name: node.name }]))
}

function publicNode(node) {
  return {
    version: PROTOCOL_VERSION,
    id: node.id,
    name: node.name,
    slug: node.slug,
    platform: node.platform,
    arch: node.arch,
    ...node.dshVersion === undefined ? {} : { dshVersion: node.dshVersion },
    publicKey: node.publicKey,
    trusted: true,
    lanUrls: node.lanUrls ?? [],
    capabilities: node.capabilities ?? [],
    updatedAt: Date.now(),
  }
}

export async function createHubServer(options = {}) {
  const {
    host = '127.0.0.1',
    port = 8788,
    trustFile,
    trusted = new Map(),
    allowAny = false,
    hubName = 'DSH Hub',
    logger = console,
  } = options
  const trust = new Map(trusted)
  for (const [id, entry] of await loadTrustFile(trustFile)) trust.set(id, entry)
  const server = new WebSocketServer({ host, port, maxPayload: 64 * 1024 * 1024 })
  const peers = new Map() // nodeId -> { ws, info, challenge, catalog }
  const pending = new Map() // ws -> { challenge, timer }
  let closed = false

  function send(ws, value) {
    if (ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify(value))
    } catch (error) {
      logger.warn?.(`[hub] send failed: ${String(error)}`)
    }
  }

  function broadcast(value, except) {
    for (const record of peers.values()) {
      if (record.ws === except) continue
      send(record.ws, value)
    }
  }

  function peerSnapshot() {
    return [...peers.values()].map((record) => publicNode(record.info))
  }

  function broadcastPresence(node, online) {
    broadcast({ type: 'event', event: online ? 'node.online' : 'node.offline', data: publicNode(node) })
  }

  function resolveTarget(to) {
    return peers.get(String(to ?? ''))
  }

  function routeResult(from, value) {
    const target = peers.get(from)
    if (target !== undefined) send(target.ws, value)
  }

  function dropPeer(record, reason) {
    if (record === undefined) return
    const { ws, info } = record
    if (peers.get(info.id)?.ws === ws) {
      peers.delete(info.id)
      broadcastPresence(info, false)
      logger.info?.(`[hub] node offline ${info.id} ${info.name}${reason ? ` (${reason})` : ''}`)
    }
  }

  server.on('connection', (ws, request) => {
    const challenge = randomBytes(32).toString('base64')
    pending.set(ws, { challenge, timer: setTimeout(() => ws.close(4401, 'hello timeout'), 10_000) })
    send(ws, { type: 'challenge', protocol: PROTOCOL_VERSION, challenge })

    ws.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(String(raw))
      } catch {
        send(ws, { type: 'error', error: { code: 'bad-frame', message: 'frame is not JSON' } })
        ws.close(4400, 'bad frame')
        return
      }

      if (pending.has(ws)) {
        const entry = pending.get(ws)
        const hello = HelloSchema.safeParse(frame)
        if (!hello.success) {
          send(ws, { type: 'error', error: { code: 'bad-hello', message: 'invalid hello', details: hello.error.issues } })
          ws.close(4400, 'invalid hello')
          return
        }
        const node = hello.data.node
        const known = trust.get(node.id)
        if (!allowAny) {
          if (known === undefined || known.trusted !== true) {
            send(ws, { type: 'error', error: { code: 'untrusted', message: `node ${node.id} is not trusted` } })
            ws.close(4403, 'untrusted')
            return
          }
          if (decodeKey(known.publicKey)?.toString('base64') !== decodeKey(node.publicKey)?.toString('base64')) {
            send(ws, { type: 'error', error: { code: 'key-mismatch', message: 'public key does not match the trusted registry' } })
            ws.close(4403, 'key mismatch')
            return
          }
        }
        if (!verifySignature(node.publicKey, entry.challenge, hello.data.signature)) {
          send(ws, { type: 'error', error: { code: 'bad-signature', message: 'challenge signature is invalid' } })
          ws.close(4401, 'bad signature')
          return
        }
        clearTimeout(entry.timer)
        pending.delete(ws)
        const info = {
          ...node,
          slug: infoSlug(node.name),
          capabilities: [],
          lanUrls: [],
        }
        const existing = peers.get(node.id)
        if (existing !== undefined && existing.ws !== ws) {
          try { existing.ws.close(4409, 'replaced by a newer connection') } catch {}
        }
        peers.set(node.id, { ws, info, challenge: entry.challenge, catalog: [] })
        send(ws, { type: 'welcome', protocol: PROTOCOL_VERSION, hubNodeId: HUB_ID, hubName, challenge: randomBytes(32).toString('base64'), peers: peerSnapshot().filter((peer) => peer.id !== node.id) })
        broadcastPresence(info, true)
        logger.info?.(`[hub] node online ${info.id} ${info.name} (${info.platform})`)
        return
      }

      const record = [...peers.values()].find((entry) => entry.ws === ws)
      if (record === undefined) return

      if (frame.type === 'node.catalog') {
        if (frame.nodeId !== record.info.id || !Array.isArray(frame.capabilities)) return
        record.catalog = frame.capabilities
        record.info.capabilities = frame.capabilities.map((item) => ({
          name: item.name,
          description: item.description,
          danger: item.danger === true,
        }))
        broadcast({ type: 'node.catalog', nodeId: record.info.id, capabilities: frame.capabilities })
        return
      }

      if (frame.type === 'rpc') {
        if (frame.from !== record.info.id) {
          send(ws, { type: 'error', error: { code: 'bad-from', message: 'rpc.from must match the authenticated node' } })
          return
        }
        const target = resolveTarget(frame.to)
        if (target === undefined) {
          send(ws, { type: 'rpc.result', id: frame.id, from: frame.to, ok: false, error: { code: 'NODE_OFFLINE', message: `node ${frame.to} is offline` } })
          return
        }
        send(target.ws, frame)
        return
      }

      if (frame.type === 'rpc.result') {
        const caller = peers.get(String(frame.to ?? ''))
        if (caller !== undefined) send(caller.ws, frame)
        return
      }

      if (frame.type === 'ping') {
        send(ws, { type: 'pong', time: Date.now() })
        return
      }

      if (frame.type === 'subscribe') {
        record.subscriptions = new Set(Array.isArray(frame.sessions) ? frame.sessions : [])
        return
      }

      if (frame.type === 'event' && frame.event === 'session.event') {
        const data = frame.data
        if (data === null || typeof data !== 'object') return
        for (const peer of peers.values()) {
          if (peer.subscriptions?.has(data.sessionId)) {
            send(peer.ws, { type: 'event', event: 'session.event', data: { ...data, from: record.info.id } })
          }
        }
      }
    })

    ws.on('close', () => {
      clearTimeout(pending.get(ws)?.timer)
      pending.delete(ws)
      const record = [...peers.values()].find((entry) => entry.ws === ws)
      if (record !== undefined) dropPeer(record, 'socket closed')
    })
    ws.on('error', (error) => {
      logger.warn?.(`[hub] socket error: ${String(error)}`)
    })
  })

  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  logger.info?.(`[hub] listening ws://${host}:${actualPort}`)

  return {
    server,
    port: actualPort,
    host,
    hubNodeId: HUB_ID,
    get peers() { return peerSnapshot() },
    close: async () => {
      if (closed) return
      closed = true
      for (const ws of server.clients) {
        try { ws.close(1001, 'hub shutting down') } catch {}
      }
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

function infoSlug(name) {
  return String(name ?? 'node').toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 32) || 'node'
}