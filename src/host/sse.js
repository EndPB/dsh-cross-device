/** Local SSE endpoint for the shared panel and provenance badges. */
export function registerSse(ctx, { bus, buildState, log = console }) {
  const connection = ctx.get?.('connection')
  if (connection?.fetch?.register === undefined) return undefined
  return connection.fetch.register({
    path: '/api/cross-device/events',
    methods: ['GET'],
    requestBody: 'none',
    fetch: async (request) => {
      const accept = request.headers.get('accept') ?? ''
      if (!accept.includes('text/event-stream')) {
        return new Response('expected text/event-stream', { status: 406 })
      }
      const encoder = new TextEncoder()
      let closed = false
      let cleanup = () => {}
      const stream = new ReadableStream({
        start(controller) {
          const send = (event, data) => {
            if (closed) return false
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
              return true
            } catch {
              closed = true
              return false
            }
          }
          let unsubscribe = () => {}
          const ping = setInterval(() => send('ping', { time: Date.now() }), 15_000)
          ping.unref?.()
          unsubscribe = bus.subscribe(send)
          send('state', buildState())
          cleanup = () => {
            if (closed) return
            closed = true
            clearInterval(ping)
            unsubscribe()
            try { controller.close() } catch {}
          }
          request.signal?.addEventListener('abort', cleanup, { once: true })
        },
        cancel() {
          cleanup()
        },
      })
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        },
      })
    },
  })
}