import { describe, expect, it } from 'vitest'
import { GitHubConfig } from '../src/host/github.js'

function fakeGitHub() {
  const files = new Map()
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    const method = options.method ?? 'GET'
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//u, ''))
    if (url.includes('/git/trees/')) {
      return new Response(JSON.stringify({ tree: [...files.keys()].map((name) => ({ path: name, type: 'blob' })), sha: 'tree' }), { status: 200, headers: { etag: '"t1"' } })
    }
    if (method === 'GET') {
      const entry = files.get(path)
      if (entry === undefined) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
      return new Response(JSON.stringify({ content: Buffer.from(entry).toString('base64'), encoding: 'base64', sha: 'sha-' + path }), { status: 200, headers: { etag: '"e1"' } })
    }
    if (method === 'PUT') {
      const body = JSON.parse(options.body)
      files.set(path, Buffer.from(body.content, 'base64').toString('utf8'))
      return new Response(JSON.stringify({ content: { sha: 'new' } }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  }
  return { files, calls, fetchImpl }
}

describe('GitHubConfig', () => {
  it('reads and writes JSON files', async () => {
    const fake = fakeGitHub()
    fake.files.set('hub.json', '{"url":"ws://x"}')
    const gh = new GitHubConfig({ repo: 'me/config', token: 't', fetchImpl: fake.fetchImpl, api: 'https://fake' })
    const read = await gh.readJson('hub.json')
    expect(read.value.url).toBe('ws://x')
    await gh.writeJson('nodes/n1.json', { id: 'n1' }, 'node')
    expect(JSON.parse(fake.files.get('nodes/n1.json')).id).toBe('n1')
  })

  it('lists tree files', async () => {
    const fake = fakeGitHub()
    fake.files.set('nodes/a.json', '{}')
    fake.files.set('sessions/b.json', '{}')
    const gh = new GitHubConfig({ repo: 'me/config', token: 't', fetchImpl: fake.fetchImpl, api: 'https://fake' })
    const tree = await gh.listTree()
    expect(tree.tree).toEqual(['nodes/a.json', 'sessions/b.json'])
  })
})