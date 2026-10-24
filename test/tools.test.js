import { describe, expect, it } from 'vitest'
import { ToolFabric } from '../src/host/tools.js'

function fakeCtx(registered) {
  return {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
  }
}

describe('tool fabric', () => {
  it('registers peer capabilities and routes calls over the hub', async () => {
    const registered = new Map()
    const hub = {
      connected: true,
      peers: new Map([['n_phone00000001', {
        id: 'n_phone00000001', name: 'Phone', slug: 'phone', platform: 'android', arch: 'arm64', trusted: true,
        capabilities: [{ name: 'android.tap', description: 'tap', parameters: { type: 'object', properties: { text: { type: 'string' } } }, danger: false, enabled: true }],
      }]]),
      call: async () => ({ text: 'remote ok', content: [{ type: 'text', text: 'remote ok' }] }),
    }
    const fabric = new ToolFabric({
      ctx: fakeCtx(registered), hub, node: { id: 'n_desktop0000001', name: 'Desktop', slug: 'desktop', platform: 'win32' },
      settings: { capabilities: {} }, log: { warn() {} },
    })
    fabric.addLocal({
      name: 'system.info', description: 'sys', parameters: { type: 'object', properties: {} },
      handler: async () => ({ text: 'local ok' }),
    })
    expect(fabric.catalog().map((cap) => cap.name)).toContain('system.info')
    await fabric.syncRemote()
    expect(registered.has('node__phone__android_tap')).toBe(true)
    const value = await registered.get('node__phone__android_tap').execute({ text: 'Hello' }, {
      callId: 'c1', agent: { session: { id: 'session-x' } },
    })
    expect(value.text).toBe('remote ok')
    fabric.dispose()
    expect(registered.has('node__phone__android_tap')).toBe(false)
  })

  it('executes a local capability through rpc', async () => {
    const registered = new Map()
    const fabric = new ToolFabric({ ctx: fakeCtx(registered), hub: undefined, node: { id: 'n1', name: 'Node' }, settings: {}, log: { warn() {} } })
    fabric.addLocal({ name: 'system.info', description: 'sys', parameters: { type: 'object' }, handler: async () => ({ text: 'ok' }) })
    const result = await fabric.handleRpc('tool.call', { callId: 'c', tool: 'system.info', args: {} }, { from: 'n2' })
    expect(result.text).toBe('ok')
  })
})