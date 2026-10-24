#!/usr/bin/env node
/**
 * Standalone DSH node hub.
 *
 *   node hub/cli.js --port 8788 --trusted ./data/trusted-nodes.json
 *
 * A local hub is also started by the Host plugin when "run hub on this node"
 * is enabled; this CLI is for running the hub on a NAS/VPS/another process.
 */
import { parseArgs } from 'node:util'
import { createHubServer } from './server.js'

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8788' },
    trusted: { type: 'string' },
    'allow-any': { type: 'boolean', default: false },
    name: { type: 'string', default: 'DSH Hub' },
  },
})

const port = Number(values.port)
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
  console.error('invalid --port')
  process.exit(2)
}

const hub = await createHubServer({
  host: values.host,
  port,
  trustFile: values.trusted,
  allowAny: values['allow-any'],
  hubName: values.name,
})

console.log(`dsh-cross-device hub listening on ws://${values.host}:${hub.port}`)
console.log(`hub node id: ${hub.hubNodeId}`)
if (values['allow-any']) console.warn('WARNING: --allow-any is for local testing only')
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await hub.close()
    process.exit(0)
  })
}