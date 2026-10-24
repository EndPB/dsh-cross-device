import { describe, expect, it } from 'vitest'
import { buildDeviceMarker, parseDeviceMarker, remoteToolName, parseRemoteToolName, slugify, nodeIdFromPublicKey } from '../src/protocol.js'

describe('protocol helpers', () => {
  it('round-trips a device marker', () => {
    const at = Date.UTC(2026, 9, 24, 14, 0, 0)
    const marker = buildDeviceMarker({ nodeId: 'n_abcdefgh12345678', nodeName: 'Pixel 9', platform: 'android', at })
    const parsed = parseDeviceMarker(marker)
    expect(parsed.nodeId).toBe('n_abcdefgh12345678')
    expect(parsed.nodeName).toBe('Pixel 9')
    expect(parsed.platform).toBe('android')
    expect(parsed.at).toBe(at)
  })

  it('rejects malformed markers', () => {
    expect(parseDeviceMarker('hello')).toBeUndefined()
    expect(parseDeviceMarker('[[device:n_bad|name|android|now]]')).toBeUndefined()
  })

  it('names and parses remote tools', () => {
    expect(remoteToolName('desktop', 'gpu.info')).toBe('node__desktop__gpu_info')
    expect(parseRemoteToolName('node__phone__android_tap')).toEqual({ slug: 'phone', capability: 'android_tap' })
    expect(parseRemoteToolName('bash')).toBeUndefined()
  })

  it('slugifies names safely', () => {
    expect(slugify('DESKTOP-ABC')).toBe('desktop-abc')
    expect(slugify('123')).toMatch(/^node-/)
  })

  it('derives a stable node id', () => {
    expect(nodeIdFromPublicKey('abc')).toBe(nodeIdFromPublicKey('abc'))
    expect(nodeIdFromPublicKey('abc')).toMatch(/^n_[A-Za-z0-9_-]{8,64}$/u)
  })
})