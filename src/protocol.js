/**
 * dsh-cross-device protocol constants, frame schemas, and pure helpers.
 * This module is shared by the Host plugin, the hub, and tests. It must not
 * import Cordis or any Host service.
 */
import { z } from 'zod'
import { createHash, randomUUID } from 'node:crypto'

export const PROTOCOL_VERSION = 1
export const TOOL_PROTOCOL_VERSION = 1
export const PROVENANCE_VERSION = 1
export const PROVENANCE_TYPE = 'plugin:cross-device/provenance'
export const PROVENANCE_MARKER_PREFIX = '[[device:'
export const PROVENANCE_MARKER_SUFFIX = ']]'
export const DEFAULT_HUB_PORT = 8788
export const MAX_TOOL_RESULT_BYTES = 8 * 1024 * 1024

export const HUB_METHODS = Object.freeze({
  TOOL_CALL: 'tool.call',
  TOOL_CANCEL: 'tool.cancel',
  SESSION_SUBSCRIBE: 'session.subscribe',
  SESSION_UNSUBSCRIBE: 'session.unsubscribe',
  SESSION_HISTORY: 'session.history',
  SESSION_PROMPT: 'session.prompt',
  SESSION_CANCEL: 'session.cancel',
  SESSION_CLAIM: 'session.claim',
  SESSION_RELEASE: 'session.release',
  SESSION_EVENT: 'session.event',
  TAKEOVER_REQUEST: 'takeover.request',
  TAKEOVER_RESULT: 'takeover.result',
  NODE_LIST: 'node.list',
  NODE_CATALOG: 'node.catalog',
})

export const NodeId = z.string().regex(/^n_[A-Za-z0-9_-]{8,64}$/u)
export const ToolName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u)

export const CapabilitySchema = z.object({
  name: ToolName,
  description: z.string().min(1).max(4000),
  parameters: z.record(z.unknown()).default({ type: 'object', properties: {} }),
  output: z.record(z.unknown()).default({ type: 'object' }),
  danger: z.boolean().default(false),
  enabled: z.boolean().default(true),
  schemaVersion: z.number().int().positive().default(1),
})

export const NodeInfoSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  id: NodeId,
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
  platform: z.string().min(1).max(40),
  arch: z.string().min(1).max(40),
  dshVersion: z.string().max(80).optional(),
  publicKey: z.string().min(16).max(4096),
  trusted: z.boolean(),
  lanUrls: z.array(z.string().url()).max(8).default([]),
  capabilities: z.array(z.object({
    name: ToolName,
    description: z.string().max(500),
    danger: z.boolean().default(false),
  })).max(200).default([]),
  updatedAt: z.number().int().nonnegative(),
})

export const RpcRequestSchema = z.object({
  type: z.literal('rpc'),
  id: z.string().min(1).max(128),
  to: NodeId,
  from: NodeId,
  method: z.string().min(1).max(120),
  params: z.unknown().default({}),
  timestamp: z.number().int().nonnegative(),
  signature: z.string().min(16).max(4096).optional(),
})

export const RpcResultSchema = z.object({
  type: z.literal('rpc.result'),
  id: z.string().min(1).max(128),
  from: NodeId,
  to: NodeId.optional(),
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().max(4000),
    details: z.unknown().optional(),
  }).optional(),
})

export const HelloSchema = z.object({
  type: z.literal('hello'),
  protocol: z.literal(PROTOCOL_VERSION),
  node: NodeInfoSchema.pick({ id: true, name: true, platform: true, arch: true, publicKey: true }),
  challenge: z.string().min(16).max(4096),
  signature: z.string().min(16).max(4096),
})

export const WelcomeSchema = z.object({
  type: z.literal('welcome'),
  protocol: z.literal(PROTOCOL_VERSION),
  hubNodeId: NodeId,
  hubName: z.string().max(120),
  challenge: z.string().min(16).max(4096),
  peers: z.array(NodeInfoSchema).default([]),
})

export const CatalogSchema = z.object({
  type: z.literal('node.catalog'),
  nodeId: NodeId,
  capabilities: z.array(CapabilitySchema).max(200),
})

export const EventFrameSchema = z.object({
  type: z.literal('event'),
  event: z.string().min(1).max(80),
  data: z.unknown(),
})

const ProvenanceBase = {
  v: z.literal(PROVENANCE_VERSION),
  seq: z.number().int().nonnegative(),
  nodeId: NodeId,
  nodeName: z.string().min(1).max(120),
  platform: z.string().min(1).max(40),
  at: z.number().int().nonnegative(),
}

export const ProvenanceRecordSchema = z.discriminatedUnion('kind', [
  z.object({
    ...ProvenanceBase,
    kind: z.literal('user'),
    local: z.boolean(),
    requestId: z.string().max(200).optional(),
  }),
  z.object({
    ...ProvenanceBase,
    kind: z.literal('assistant'),
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    model: z.string().max(200).optional(),
    toolNodes: z.array(z.string()).max(32).default([]),
  }),
  z.object({
    ...ProvenanceBase,
    kind: z.literal('tool'),
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    tool: z.string().min(1).max(200),
  }),
])

export function slugify(value, fallback = 'node') {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
  return /^[a-z]/u.test(slug) ? slug : `${fallback}-${slug || 'x'}`.slice(0, 32)
}

export function nodeIdFromPublicKey(publicKey) {
  const digest = createHash('sha256').update(String(publicKey)).digest()
  return `n_${digest.toString('base64url').slice(0, 16)}`
}

export function newRequestId(prefix = 'cd') {
  return `${prefix}-${randomUUID()}`
}

export function remoteToolName(nodeSlug, capability) {
  return `node__${slugify(nodeSlug)}__${String(capability).replace(/[^A-Za-z0-9_-]+/gu, '_')}`
}

export function parseRemoteToolName(name) {
  const match = /^node__([a-z][a-z0-9_-]{0,31})__(.+)$/u.exec(String(name ?? ''))
  return match === null ? undefined : { slug: match[1], capability: match[2] }
}

export function buildDeviceMarker({ nodeId, nodeName, platform, at }) {
  const time = new Date(at ?? Date.now()).toISOString()
  const safeName = String(nodeName ?? '').replace(/[|\]\r\n]/gu, ' ').trim().slice(0, 80)
  return `${PROVENANCE_MARKER_PREFIX}${nodeId}|${safeName}|${platform}|${time}${PROVENANCE_MARKER_SUFFIX}`
}

export function parseDeviceMarker(text) {
  if (typeof text !== 'string' || !text.startsWith(PROVENANCE_MARKER_PREFIX)) return undefined
  const end = text.indexOf(PROVENANCE_MARKER_SUFFIX, PROVENANCE_MARKER_PREFIX.length)
  if (end < 0) return undefined
  const body = text.slice(PROVENANCE_MARKER_PREFIX.length, end)
  const parts = body.split('|')
  if (parts.length !== 4) return undefined
  const [nodeId, nodeName, platform, iso] = parts
  if (!NodeId.safeParse(nodeId).success) return undefined
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  return { nodeId, nodeName, platform, at, raw: text.slice(0, end + PROVENANCE_MARKER_SUFFIX.length) }
}

export function isProvenanceRecord(value) {
  return ProvenanceRecordSchema.safeParse(value).success
}

export function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Infinity
  }
}

export function safeJson(value, maxBytes = MAX_TOOL_RESULT_BYTES) {
  const text = JSON.stringify(value)
  if (text === undefined) return undefined
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { truncated: true, text: text.slice(0, Math.max(0, maxBytes - 64)) }
  }
  return value
}