/**
 * DSHA Android capability pack. Calls the local 3090 bridge with the bridge
 * token written by DSHA; the plugin never talks to Android directly and never
 * modifies DSHA.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DSHA_BRIDGE = 'http://127.0.0.1:3090'

async function readBridgeToken(env = process.env) {
  const candidates = [
    env.DSHA_BRIDGE_HEADERS,
    join(env.DSH_HOME || '/root/.dsh', '.bridge_headers'),
    '/root/.dsh/.bridge_headers',
  ].filter(Boolean)
  for (const path of candidates) {
    try {
      const text = await readFile(path, 'utf8')
      const match = /(?:^|\n)\s*X-Token\s*:\s*([^\s\r\n]+)/iu.exec(text)
      if (match !== null) return match[1]
    } catch {}
  }
  return env.DSHA_BRIDGE_TOKEN
}

export async function bridgeRequest(path, { query, method = 'GET', body, token, signal, timeoutMs = 30_000 } = {}) {
  const auth = token ?? await readBridgeToken()
  if (!auth) throw Object.assign(new Error('DSHA bridge token is not available; run this inside DSHA'), { code: 'BRIDGE_NO_TOKEN' })
  const url = new URL(path, DSHA_BRIDGE)
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, {
      method,
      headers: { 'x-token': auth, ...body === undefined ? {} : { 'content-type': 'application/json' } },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) throw Object.assign(new Error(text || `bridge ${response.status}`), { code: 'BRIDGE_HTTP', status: response.status })
    return text
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function textCapability(name, description, parameters, build) {
  return {
    name,
    description,
    parameters: { type: 'object', properties: parameters, additionalProperties: false },
    output: { type: 'object', properties: { text: { type: 'string' } } },
    danger: false,
    async handler(args, context) {
      const text = await build(args ?? {}, context)
      return { text, content: [{ type: 'text', text }] }
    },
  }
}

export async function androidCapabilities(env = process.env) {
  const token = await readBridgeToken(env)
  const available = Boolean(token)
  const caps = [
    textCapability('android.screen_dump', 'Read the current Android screen as a textual UI tree with clickable centers. Use before tapping.', {}, async () => {
      return bridgeRequest('/app/ui/dump', { token })
    }),
    textCapability('android.tap', 'Tap an Android UI element by visible text, or by absolute screen coordinates.', {
      text: { type: 'string', description: 'Visible text of the element to tap; preferred over coordinates.' },
      x: { type: 'number', description: 'Absolute X coordinate when text is unavailable.' },
      y: { type: 'number', description: 'Absolute Y coordinate when text is unavailable.' },
    }, async (args) => {
      if (typeof args.text === 'string' && args.text !== '') return bridgeRequest('/app/ui/tap', { query: { text: args.text }, token })
      if (Number.isFinite(args.x) && Number.isFinite(args.y)) return bridgeRequest('/app/ui/tap', { query: { x: args.x, y: args.y }, token })
      throw new Error('android.tap needs text or x/y')
    }),
    textCapability('android.input', 'Type text into the currently focused Android input field. Tap the field first if needed.', {
      text: { type: 'string', description: 'Text to type.' },
    }, async (args) => bridgeRequest('/app/ui/input', { query: { text: args.text ?? '' }, token })),
    textCapability('android.key', 'Press a system Android key: back, home, recents, notifications, quicksettings, or lock.', {
      name: { type: 'string', description: 'back | home | recents | notifications | quicksettings | lock' },
    }, async (args) => bridgeRequest('/app/ui/key', { query: { name: args.name ?? 'back' }, token })),
    textCapability('android.swipe', 'Swipe on the Android screen from (x1,y1) to (x2,y2) over ms milliseconds.', {
      x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, ms: { type: 'number' },
    }, async (args) => bridgeRequest('/app/ui/swipe', { query: args, token })),
    textCapability('android.screenshot', 'Capture the Android screen to a PNG file and return its path.', {}, async () => {
      return bridgeRequest('/app/ui/screenshot', { token })
    }),
    textCapability('android.apps', 'List installed Android apps (user and system).', {
      q: { type: 'string', description: 'Optional filter.' }, limit: { type: 'number' }, user: { type: 'boolean' },
    }, async (args) => bridgeRequest('/app/apps', { query: args, token })),
    textCapability('android.launch', 'Launch an installed Android app by package name.', {
      pkg: { type: 'string', description: 'Android package name.' },
    }, async (args) => bridgeRequest('/app/launch', { query: { pkg: args.pkg }, token })),
    textCapability('android.device', 'Read Android device status: model, OS, battery, network, screen, storage, memory.', {}, async () => {
      return bridgeRequest('/app/device', { token })
    }),
    textCapability('android.notify', 'Post an Android notification.', {
      title: { type: 'string' }, text: { type: 'string' },
    }, async (args) => bridgeRequest('/app/notify', { query: args, token })),
    textCapability('android.toast', 'Show an in-app Android toast.', { text: { type: 'string' } }, async (args) => {
      return bridgeRequest('/app/toast', { query: { text: args.text ?? '' }, token })
    }),
    textCapability('android.clipboard', 'Read or write the Android clipboard. Reading requires DSHA to be in the foreground.', {
      text: { type: 'string', description: 'When provided, write this text; otherwise read.' },
    }, async (args) => bridgeRequest('/app/clip', { query: args.text === undefined ? {} : { text: args.text }, token })),
    textCapability('android.sensors', 'List Android sensors available on this phone.', {}, async () => bridgeRequest('/app/sensors', { token })),
    textCapability('android.sensor', 'Read one Android sensor value (light, accel, gyro, magnet, pressure, proximity, gravity, rotation, steps).', {
      name: { type: 'string' },
    }, async (args) => bridgeRequest('/app/sensor', { query: { name: args.name }, token })),
    textCapability('android.location', 'Read the current Android location. May take seconds.', {
      fresh: { type: 'boolean' },
    }, async (args) => bridgeRequest('/app/location', { query: args.fresh ? { fresh: 1 } : {}, token })),
    textCapability('android.torch', 'Turn the Android flashlight on or off.', {
      on: { type: 'boolean' },
    }, async (args) => bridgeRequest('/app/torch', { query: { on: args.on ? 1 : 0 }, token })),
  ]
  return caps.map((cap) => ({ ...cap, enabled: available, unavailableReason: available ? undefined : 'DSHA bridge token not found' }))
}