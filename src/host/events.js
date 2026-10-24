/** Bounded in-process event fanout for the plugin's SSE UI channel. */
export class EventBus {
  constructor({ maxQueue = 2000, log = console } = {}) {
    this.maxQueue = maxQueue
    this.log = log
    this.clients = new Set()
  }

  subscribe(send) {
    const client = { send, queue: [], closed: false }
    this.clients.add(client)
    return () => {
      client.closed = true
      this.clients.delete(client)
    }
  }

  publish(event, data) {
    for (const client of this.clients) {
      if (client.closed) continue
      try {
        const ok = client.send(event, data)
        if (ok === false) {
          client.queue.push({ event, data })
          if (client.queue.length > this.maxQueue) {
            client.queue = []
            client.send('reset', { reason: 'overflow' })
          }
        }
      } catch (error) {
        this.log.warn?.(`[cross-device] SSE publish failed: ${String(error)}`)
        client.closed = true
        this.clients.delete(client)
      }
    }
  }

  flush(client) {
    while (client.queue.length > 0 && !client.closed) {
      const item = client.queue.shift()
      if (client.send(item.event, item.data) === false) {
        client.queue.unshift(item)
        break
      }
    }
  }
}