import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Provenance } from '../src/host/provenance.js'
import { PROVENANCE_TYPE } from '../src/protocol.js'

function fakeSession() {
  const events = []
  const session = {
    id: 'session-test',
    seq: 0,
    disposed: false,
    header: { version: 4 },
    snapshotEvents: () => events.slice(),
    push(event) { events.push(event); session.seq = event.seq + 1 },
  }
  return session
}

describe('provenance', () => {
  it('records user, assistant, and tool provenance and summarizes it', async () => {
    const session = fakeSession()
    const node = { id: 'n_desktop0000001', name: 'Desktop', slug: 'desktop', platform: 'win32' }
    const provenance = new Provenance({
      node,
      settings: { provenance: { enabled: true, marker: true, recentLimit: 4 } },
      getPeer: (slug) => slug === 'phone' ? { id: 'n_phone00000001', name: 'Phone', platform: 'android', slug: 'phone' } : undefined,
      dataDir: mkdtempSync(join(tmpdir(), 'cd-prov-')),
      log: { warn() {} },
    })
    provenance.noteRemotePrompt('req-1', { id: 'n_phone00000001', name: 'Phone', platform: 'android', slug: 'phone' })
    session.push({ type: 'user/message', seq: 0, time: Date.now(), data: { message: { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user', rpcId: 'req-1' } } } })
    await provenance.onEvent(session, session.snapshotEvents().find((event) => event.type === 'user/message'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    session.push({ type: 'tool/call', seq: 1, time: Date.now(), data: { turn: 1, step: 1, callId: 'c1', name: 'node__phone__android_tap', arguments: '{}' } })
    await provenance.onEvent(session, session.snapshotEvents().find((event) => event.type === 'tool/call'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    session.push({ type: 'assistant/message', seq: 2, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'deepseek', model: 'flash' } } } })
    await provenance.onEvent(session, session.snapshotEvents().find((event) => event.type === 'assistant/message'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    const records = provenance.records(session)
    expect(records.some((record) => record.kind === 'user' && record.nodeName === 'Phone')).toBe(true)
    expect(records.some((record) => record.kind === 'tool' && record.nodeName === 'Phone')).toBe(true)
    const assistant = records.find((record) => record.kind === 'assistant')
    expect(assistant.nodeName).toBe('Desktop')
    expect(assistant.toolNodes).toContain('Phone')
    const text = provenance.promptText({ session })
    expect(text).toContain('Desktop')
    expect(text).toContain('Phone')
  })

  it('prepends a marker only when enabled', () => {
    const node = { id: 'n_desktop0000001', name: 'Desktop', slug: 'desktop', platform: 'win32' }
    const provenance = new Provenance({ node, settings: { provenance: { enabled: true, marker: true } } })
    const content = provenance.attachMarker([{ type: 'text', text: 'hello' }])
    expect(content[0].text.startsWith('[[device:')).toBe(true)
    expect(content[1].text).toBe('hello')
  })
})