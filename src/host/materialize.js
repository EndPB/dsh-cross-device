/** Materialize a shared event log as a real local DSH Session for takeover. */
import { randomUUID } from 'node:crypto'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export async function chooseCwd(ctx, sourceCwd) {
  if (typeof sourceCwd === 'string' && isAbsolute(sourceCwd)) {
    try {
      if ((await stat(sourceCwd)).isDirectory()) return sourceCwd
    } catch {}
  }
  const fallback = ctx.get?.('workingDirectory')?.defaultDirectory
  return typeof fallback === 'string' && isAbsolute(fallback) ? fallback : resolve(process.cwd())
}

export async function localFormatVersion(ctx) {
  try {
    const probe = ctx.get?.('sessions')?.prepare()
    return probe?.header?.version
  } catch {
    return undefined
  }
}

export async function materializeSession({ ctx, manifest, events, cwd, title }) {
  const persistence = ctx.get?.('sessionPersistence')
  if (persistence === undefined) throw new Error('sessionPersistence is unavailable on this node')
  const sourceHeader = manifest?.header
  if (sourceHeader === undefined) throw new Error('shared session manifest is missing its source header')
  const localVersion = await localFormatVersion(ctx)
  if (localVersion !== undefined && sourceHeader.version !== undefined && sourceHeader.version !== localVersion) {
    throw new Error(`session format mismatch: shared v${sourceHeader.version}, local v${localVersion}`)
  }
  const selectedCwd = cwd ?? await chooseCwd(ctx, sourceHeader.cwd)
  const localId = `session-${randomUUID()}`
  const header = {
    version: sourceHeader.version ?? localVersion,
    id: localId,
    createdAt: sourceHeader.createdAt ?? Date.now(),
    cwd: selectedCwd,
    isSeeded: false,
    ...sourceHeader.agentPreset === undefined ? {} : { agentPreset: sourceHeader.agentPreset },
  }
  let handle
  try {
    handle = await persistence.create(header)
    if (events.length > 0) await handle.append(events)
    await handle.flush()
    await handle.close()
    handle = undefined
  } catch (error) {
    try { await handle?.close() } catch {}
    throw error
  }
  const controller = ctx.get?.('sessionController')
  if (controller === undefined) throw new Error('sessionController is unavailable on this node')
  const agent = await controller.resolveAgent(localId)
  if (agent === undefined || agent === null) throw new Error('failed to resume the materialized session')
  return { localId, cwd: selectedCwd, agent }
}

export { access }