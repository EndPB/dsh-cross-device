/**
 * GitHub OAuth device flow (same public client dsh-mnemon uses), with a curl
 * fallback for hosts whose ambient fetch cannot reach GitHub through the local
 * proxy. The token never leaves the Host; the browser only ever sees the user
 * code and the account login.
 */
import { execFile } from 'node:child_process'

export const DEVICE_CODE_URL = 'https://github.com/login/device/code'
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_CLIENT_ID = 'Ov23liq4i7n8UsylGRfb'
export const GITHUB_SCOPE = 'repo'
const GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

function form(values) {
  return new URLSearchParams(values).toString()
}

async function viaCurl(url, body) {
  return await new Promise((resolve, reject) => {
    const args = ['-sS', '--max-time', '25']
    // Prefer the system proxy the desktop already uses; harmless when absent.
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy
    if (proxy) args.push('--proxy', proxy)
    else args.push('--socks5-hostname', '127.0.0.1:7890')
    args.push('-H', 'Accept: application/json', '-H', 'Content-Type: application/x-www-form-urlencoded', '-X', 'POST', '-d', body, url)
    execFile(process.platform === 'win32' ? 'curl.exe' : 'curl', args, { timeout: 30_000 }, (error, stdout) => {
      if (error) reject(new Error(`GitHub request failed: ${String(error)}`))
      else resolve(String(stdout))
    })
  })
}

async function request(url, body) {
  let lastError
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(25_000),
    })
    const text = await response.text()
    if (text.trim() !== '') return text
    lastError = new Error(`GitHub answered HTTP ${response.status} with an empty body`)
  } catch (error) {
    lastError = error
  }
  try {
    return await viaCurl(url, body)
  } catch (error) {
    throw new Error(`${lastError instanceof Error ? lastError.message : String(lastError)}; ${error instanceof Error ? error.message : String(error)}`)
  }
}

function parse(text) {
  try { return JSON.parse(text) } catch {}
  const out = {}
  for (const [key, value] of new URLSearchParams(text)) out[key] = value
  return out
}

export class GitHubDeviceFlow {
  constructor({ clientId = GITHUB_CLIENT_ID, scope = GITHUB_SCOPE } = {}) {
    this.clientId = clientId
    this.scope = scope
    this.pending = new Map()
  }

  async start() {
    const text = await request(DEVICE_CODE_URL, form({ client_id: this.clientId, scope: this.scope }))
    const body = parse(text)
    if (typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
      throw new Error(`GitHub device code refused: ${body.error ?? 'unexpected answer'}`)
    }
    const flow = {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri ?? 'https://github.com/login/device',
      interval: Math.max(Number(body.interval) || 5, 1),
      expiresAt: Date.now() + (Number(body.expires_in) || 900) * 1000,
      token: undefined,
      login: undefined,
      error: undefined,
    }
    this.pending.set('default', flow)
    return { userCode: flow.userCode, verificationUri: flow.verificationUri, interval: flow.interval, expiresIn: Math.round((flow.expiresAt - Date.now()) / 1000) }
  }

  async poll() {
    const flow = this.pending.get('default')
    if (flow === undefined) return { state: 'idle' }
    if (flow.token !== undefined) return { state: 'done', token: flow.token, login: flow.login }
    if (Date.now() > flow.expiresAt) { this.pending.delete('default'); return { state: 'expired' } }
    const text = await request(ACCESS_TOKEN_URL, form({ client_id: this.clientId, device_code: flow.deviceCode, grant_type: GRANT }))
    const body = parse(text)
    if (typeof body.access_token === 'string') {
      flow.token = body.access_token
      try {
        const who = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${body.access_token}`, accept: 'application/vnd.github+json' } })
        const profile = await who.json()
        flow.login = typeof profile.login === 'string' ? profile.login : undefined
      } catch {}
      return { state: 'done', token: flow.token, login: flow.login, scope: body.scope }
    }
    if (body.error === 'authorization_pending') return { state: 'pending', interval: flow.interval }
    if (body.error === 'slow_down') { flow.interval = Math.min(flow.interval + 5, 60); return { state: 'pending', interval: flow.interval } }
    if (body.error === 'expired_token') { this.pending.delete('default'); return { state: 'expired' } }
    if (body.error === 'access_denied') { this.pending.delete('default'); return { state: 'denied' } }
    this.pending.delete('default')
    return { state: 'error', error: body.error ?? 'unknown', description: body.error_description }
  }
}
