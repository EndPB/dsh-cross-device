/**
 * Durable plugin settings under $DSH_HOME/cross-device/settings.json.
 * Writes are atomic on the same volume (temp + rename) and keep mode 0600.
 */
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hostname, platform, arch } from 'node:os'

export const SETTINGS_VERSION = 1

export function defaultSettings(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || process.cwd(), '.dsh')
  return {
    version: SETTINGS_VERSION,
    node: {
      name: hostname() || 'dsh-node',
      slug: '',
      privateKey: '',
      publicKey: '',
      id: '',
    },
    github: {
      repo: '',
      branch: 'main',
      token: '',
    },
    hub: {
      url: '',
      mode: 'lan',
      runLocal: false,
      port: 8788,
    },
    capabilities: {
      android: true,
      system: true,
      gpu: true,
      fs: true,
      shell: false,
    },
    provenance: {
      enabled: true,
      marker: true,
      recentLimit: 4,
    },
    ui: {
      autoFocus: true,
    },
    settingsFile: join(home, 'cross-device', 'settings.json'),
    dataDir: join(home, 'cross-device'),
    platform: platform(),
    arch: arch(),
  }
}

export class SettingsStore {
  constructor(file) {
    this.file = file
    this.value = undefined
    this.loadedAt = 0
  }

  async load() {
    if (this.value !== undefined) return this.value
    const base = defaultSettings()
    try {
      const text = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(text)
      this.value = merge(base, parsed)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`[cross-device] settings read failed: ${String(error)}`)
      }
      this.value = base
    }
    this.loadedAt = Date.now()
    return this.value
  }

  async save(next) {
    const value = merge(defaultSettings(), next ?? this.value ?? {})
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    try { await chmod(tmp, 0o600) } catch {}
    await rename(tmp, this.file)
    this.value = value
    this.loadedAt = Date.now()
    return value
  }

  async patch(patch) {
    const current = await this.load()
    return this.save(merge(current, patch))
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function merge(base, extra) {
  if (!isObject(base)) return extra
  if (!isObject(extra)) return base
  const out = { ...base }
  for (const [key, value] of Object.entries(extra)) {
    out[key] = isObject(base[key]) && isObject(value) ? merge(base[key], value) : value
  }
  return out
}