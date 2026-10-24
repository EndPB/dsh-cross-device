/** Owner-only local RPC for the shared panel and settings. */
export function registerRpc(ctx, api) {
  ctx.inject(['connection', 'webServer'], (connectionCtx) => {
    const owner = typeof connectionCtx.extend === 'function'
      ? connectionCtx.extend({ webServer: connectionCtx.get('webServer') })
      : connectionCtx
    return owner.effect(
      () => owner.connection.rpc.handle('/dsh-cross-device', async (endpoint, payload) => {
        const input = payload !== null && typeof payload === 'object' ? payload : {}
        try {
          const value = await api(endpoint, input)
          return { ok: true, value }
        } catch (error) {
          return {
            ok: false,
            error: {
              code: error?.code ?? 'cross-device/failed',
              message: error instanceof Error ? error.message : String(error),
              details: error?.details ?? {},
            },
          }
        }
      }),
      'dsh-cross-device: local rpc',
    )
  })
}