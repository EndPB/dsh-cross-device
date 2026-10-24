import { describe, expect, it } from 'vitest'
import { createHubServer } from '../hub/server.js'
import { HubClient } from '../src/host/hub.js'
import { generateIdentity } from '../src/host/identity.js'

function waitFor(predicate, timeout = 5000) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) return resolve()
      } catch {}
      if (Date.now() - start > timeout) return reject(new Error('timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

function node(name, identity) {
  return { id: identity.id, name, slug: name.toLowerCase(), platform: 'linux', arch: 'x64', publicKey: identity.publicKey, privateKey: identity.privateKey }
}

describe('hub', () => {
  it('authenticates, broadcasts presence, and routes RPC', async () => {
    const hub = await createHubServer({ host: '127.0.0.1', port: 0, allowAny: true, logger: { info() {}, warn() {} } })
    const aId = generateIdentity()
    const bId = generateIdentity()
    const a = node('alpha', aId)
    const b = node('beta', bId)
    const eventsA = []
    const eventsB = []
    const clientA = new HubClient({
      url: `ws://127.0.0.1:${hub.port}`,
      node: a,
      privateKey: aId.privateKey,
      onEvent: (event) => eventsA.push(event),
      onRpc: async (method) => method === 'node.catalog' ? { nodeId: b.id, capabilities: [] } : { ok: true },
      log: { warn() {} },
    })
    const clientB = new HubClient({
      url: `ws://127.0.0.1:${hub.port}`,
      node: b,
      privateKey: bId.privateKey,
      onEvent: (event) => eventsB.push(event),
      onRpc: async (method, params) => {
        if (method === 'tool.call') return { text: `hello ${params.args?.name ?? ''}`, content: [{ type: 'text', text: 'ok' }] }
        return { ok: true }
      },
      log: { warn() {} },
    })
    clientA.setCatalog([{ name: 'system.info', description: 'x', parameters: { type: 'object', properties: {} } }])
    clientB.setCatalog([])
    await Promise.all([clientA.connect(), clientB.connect()])
    await waitFor(() => clientA.peers.has(b.id) && clientB.peers.has(a.id))
    const value = await clientA.call(b.id, 'tool.call', { callId: 'c1', tool: 'x', args: { name: 'world' } })
    expect(value.text).toBe('hello world')
    expect(eventsA).toContain('node.online')
    await clientA.dispose()
    await clientB.dispose()
    await hub.close()
  })
})