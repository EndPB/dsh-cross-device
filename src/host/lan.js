/**
 * LAN link: a small UDP broadcast beacon so a node finds the desktop hub (or
 * another node) with no address typed anywhere. One beacon packet every few
 * seconds; every node listens on the same port and keeps the freshest peers.
 */
import dgram from 'node:dgram'

export const LAN_PORT = 8789
const BEACON_MS = 4000
const STALE_MS = 15_000

export class LanLink {
  constructor({ nodeId, name, platform, log = console } = {}) {
    this.nodeId = nodeId
    this.name = name
    this.platform = platform
    this.log = log
    this.url = ''
    this.peers = new Map()
    this.socket = undefined
    this.timer = undefined
  }

  start() {
    if (this.socket !== undefined) return this
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', (error) => { this.log.warn?.(`[cross-device] lan socket: ${String(error)}`) })
    socket.on('message', (buffer, remote) => {
      let packet
      try { packet = JSON.parse(String(buffer)) } catch { return }
      if (packet?.t !== 'cd' || typeof packet.id !== 'string' || packet.id === this.nodeId) return
      this.peers.set(packet.id, {
        id: packet.id,
        name: String(packet.name ?? ''),
        platform: String(packet.platform ?? ''),
        url: typeof packet.url === 'string' ? packet.url : '',
        address: remote.address,
        seenAt: Date.now(),
      })
    })
    socket.bind(LAN_PORT, () => {
      try { socket.setBroadcast(true) } catch {}
      this.announce()
      this.timer = setInterval(() => this.announce(), BEACON_MS)
      this.timer.unref?.()
    })
    return this
  }

  announce() {
    if (this.socket === undefined) return
    const packet = JSON.stringify({ t: 'cd', id: this.nodeId, name: this.name, platform: this.platform, url: this.url })
    const buffer = Buffer.from(packet)
    for (const target of ['255.255.255.255', ...this.broadcastAddresses()]) {
      this.socket.send(buffer, LAN_PORT, target, () => {})
    }
  }

  broadcastAddresses() {
    try {
      const { networkInterfaces } = process.getBuiltinModule?.('node:os') ?? require('node:os')
      const out = []
      for (const list of Object.values(networkInterfaces() ?? {})) {
        for (const entry of list ?? []) {
          if (entry.family !== 'IPv4' || entry.internal) continue
          const parts = entry.address.split('.')
          if (parts.length === 4) out.push(`${parts[0]}.${parts[1]}.${parts[2]}.255`)
        }
      }
      return [...new Set(out)]
    } catch { return [] }
  }

  setHubUrl(url) {
    this.url = url ?? ''
    this.announce()
  }

  livePeers() {
    const now = Date.now()
    for (const [id, peer] of this.peers) if (now - peer.seenAt > STALE_MS) this.peers.delete(id)
    return [...this.peers.values()]
  }

  /** Wait for any peer that advertises a hub URL. */
  async waitForHub(timeoutMs = 6000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const hub = this.livePeers().find((peer) => peer.url !== '')
      if (hub !== undefined) return hub.url
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return undefined
  }

  dispose() {
    clearInterval(this.timer)
    try { this.socket?.close() } catch {}
    this.socket = undefined
  }
}
