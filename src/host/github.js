/**
 * Minimal GitHub Contents/Trees client for the private configuration repo.
 * No Git clone; each node owns its own files to avoid concurrent write
 * conflicts. This is a config/discovery/trust server, never a data plane.
 */
const API = 'https://api.github.com'

export class GitHubError extends Error {
  constructor(message, status, details) {
    super(message)
    this.name = 'GitHubError'
    this.status = status
    this.details = details
  }
}

export class GitHubConfig {
  constructor({ repo, branch = 'main', token, fetchImpl = globalThis.fetch, api = API, log = console }) {
    if (typeof repo !== 'string' || !/^[^/]+\/[^/]+$/u.test(repo)) throw new Error('github.repo must be "owner/name"')
    this.repo = repo
    this.branch = branch || 'main'
    this.token = token
    this.fetch = fetchImpl
    this.api = api
    this.log = log
    this.treeEtag = undefined
    this.fileCache = new Map()
  }

  headers() {
    return {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...this.token ? { authorization: `Bearer ${this.token}` } : {},
    }
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.api}${path}`, {
      ...options,
      headers: { ...this.headers(), ...options.headers },
    })
    if (response.status === 304) return { notModified: true, response }
    if (!response.ok) {
      let details
      try { details = await response.json() } catch {}
      throw new GitHubError(`GitHub ${options.method ?? 'GET'} ${path} failed: ${response.status}`, response.status, details)
    }
    return { response, value: response.status === 204 ? undefined : await response.json() }
  }

  async getFile(path, { etag } = {}) {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const headers = etag === undefined ? {} : { 'if-none-match': etag }
    const result = await this.request(`/repos/${this.repo}/contents/${encoded}?ref=${encodeURIComponent(this.branch)}`, { headers })
    if (result.notModified) return { notModified: true, etag, path }
    const value = result.value
    const content = value.encoding === 'base64' ? Buffer.from(value.content ?? '', 'base64').toString('utf8') : String(value.content ?? '')
    return { path, content, sha: value.sha, etag: result.response.headers.get('etag') ?? etag, url: value.html_url }
  }

  async putFile(path, content, message) {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    let sha
    try {
      const current = await this.getFile(path)
      sha = current.sha
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 404) throw error
    }
    const body = {
      message,
      content: Buffer.from(String(content), 'utf8').toString('base64'),
      branch: this.branch,
      ...sha === undefined ? {} : { sha },
    }
    const result = await this.request(`/repos/${this.repo}/contents/${encoded}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return result.value
  }

  async deleteFile(path, message) {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    const current = await this.getFile(path)
    await this.request(`/repos/${this.repo}/contents/${encoded}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, branch: this.branch, sha: current.sha }),
    })
  }

  async listTree({ etag } = {}) {
    const headers = etag === undefined ? {} : { 'if-none-match': etag }
    const result = await this.request(`/repos/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`, { headers })
    if (result.notModified) return { notModified: true, etag }
    const tree = Array.isArray(result.value?.tree) ? result.value.tree : []
    return {
      tree: tree.filter((entry) => entry.type === 'blob').map((entry) => entry.path),
      etag: result.response.headers.get('etag') ?? result.value?.sha,
      truncated: result.value?.truncated === true,
    }
  }

  async readJson(path) {
    const file = await this.getFile(path)
    if (file.notModified) return undefined
    try { return { value: JSON.parse(file.content), sha: file.sha, path } } catch { return undefined }
  }

  async writeJson(path, value, message) {
    return this.putFile(path, `${JSON.stringify(value, null, 2)}\n`, message)
  }

  async listJson(prefix) {
    const tree = await this.listTree()
    if (tree.notModified) return []
    const paths = tree.tree.filter((path) => path.startsWith(prefix) && path.endsWith('.json'))
    const out = []
    for (const path of paths) {
      const item = await this.readJson(path)
      if (item !== undefined) out.push({ path, ...item })
    }
    return out
  }
}