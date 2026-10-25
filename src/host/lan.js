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
    this.senders = new Map()
    this.urls = []
    this.hub = false
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
      // The sender may advertise a virtual/VPN address that the peer cannot
      // reach. The packet's own source address is always reachable, so it wins.
      const advertised = typeof packet.url === 'string' ? packet.url : ''
      const port = /:(\d+)\/?(?:$|\?)/u.exec(advertised)?.[1] ?? '8788'
      const direct = `ws://${remote.address}:${port}`
      const extra = Array.isArray(packet.urls) ? packet.urls.filter((value) => typeof value === 'string') : []
      const candidates = [...new Set([direct, ...extra, advertised].filter((value) => value !== ''))]
      this.peers.set(packet.id, {
        id: packet.id,
        name: String(packet.name ?? ''),
        platform: String(packet.platform ?? ''),
        url: candidates[0] ?? '',
        hub: packet.hub === true,
        urls: candidates,
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
    const packet = JSON.stringify({ t: 'cd', id: this.nodeId, name: this.name, platform: this.platform, url: this.url, urls: this.urls ?? [], hub: this.hub })
    const buffer = Buffer.from(packet)
    const interfaces = this.physical()
    if (interfaces.length === 0) {
      this.socket.send(buffer, LAN_PORT, '255.255.255.255', () => {})
      return
    }
    for (const entry of interfaces) {
      const sender = this.sendVia(entry.ip)
      if (sender === undefined) continue
      this.send(sender, buffer, entry.broadcast)
    }
  }

  /** Physical LAN interfaces only: VPN/TUN/VirtualBox/WSL adapters are skipped,
   *  otherwise the beacon leaves through the tunnel and every peer learns an
   *  address that is routable only inside that tunnel. */
  physical() {
    const os = process.getBuiltinModule?.('node:os')
    if (os === undefined) return []
    const skip = /(^|\b)(tun\d*|tap\d*|utun\d*|wg\d*|ipsec|ppp\d*|tailscale|zerotier|vgate|vpn|docker|veth|br-|virbr|vmnet|vbox|wsl|hyper-v|loopback)/iu
    const out = []
    for (const [name, list] of Object.entries(os.networkInterfaces() ?? {})) {
      if (skip.test(name)) continue
      for (const entry of list ?? []) {
        if (entry.family !== 'IPv4' || entry.internal) continue
        const mask = String(entry.netmask ?? '255.255.255.0').split('.').map(Number)
        if (mask[0] === 255 && mask[1] === 255 && mask[2] === 255 && mask[3] === 255) continue
        const ip = entry.address
        const octets = ip.split('.').map(Number)
        const broadcast = octets.map((value, index) => (value | (~mask[index] & 255)) & 255).join('.')
        out.push({ name, ip, broadcast, cidr: `${ip}/${mask.reduce((sum, part) => sum + part.toString(2).split('1').length - 1, 0)}` })
      }
    }
    return out
  }

  sendVia(ip) {
    const existing = this.senders.get(ip)
    if (existing !== undefined) return existing
    if (this.senders.size > 6) return undefined
    try {
      const socket = dgram.createSocket({ type: 'udp4' })
      const entry = { socket, ready: false, queue: [] }
      socket.on('error', () => {})
      socket.on('listening', () => {
        try { socket.setBroadcast(true) } catch {}
        entry.ready = true
        for (const [buffer, port, target] of entry.queue) socket.send(buffer, port, target, () => {})
        entry.queue = []
      })
      socket.bind({ address: ip, port: 0 })
      this.senders.set(ip, entry)
      return entry
    } catch { return undefined }
  }

  send(entry, buffer, target) {
    if (entry.ready) entry.socket.send(buffer, LAN_PORT, target, () => {})
    else entry.queue.push([buffer, LAN_PORT, target])
  }

  setHubUrl(url, urls) {
    this.url = url ?? ''
    this.urls = Array.isArray(urls) ? urls : []
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
    for (const entry of this.senders.values()) { try { entry.socket.close() } catch {} }
    this.senders.clear()
    try { this.socket?.close() } catch {}
    this.socket = undefined
  }
}
