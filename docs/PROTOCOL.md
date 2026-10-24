# Protocol notes

- Hub transport: WebSocket, JSON frames, Ed25519 challenge-response.
- Node RPC: `{type:"rpc", id, from, to, method, params, timestamp}`.
- Tool method: `tool.call {callId, sessionId, tool, args, deadlineMs}`.
- Session methods: `session.subscribe`, `session.history`, `session.prompt`,
  `session.cancel`, `session.claim`, `session.release`.
- Remote tool names: `node__<slug>__<capability>`.
- Provenance marker: `[[device:<nodeId>|<name>|<platform>|<ISO time>]]`.
- Provenance sidecar: JSONL, one record per user/assistant/tool event.