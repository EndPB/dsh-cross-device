# Security notes

- All nodes are trusted as the same person; there is no multi-user ACL.
- Each node has an Ed25519 keypair. The hub currently supports `--allow-any` for
  local testing and a trusted-nodes JSON file for pinned nodes.
- Remote tool calls bypass the coordinator's approval prompt by design; the
  target node's own sandbox/DSHA permissions still apply. Dangerous capabilities
  (`shell.run`, `fs.write`, `android.shell`) are disabled by default.
- The DSHA bridge token stays on the phone; it is never sent to other nodes.
- Provenance sidecars may contain message/device metadata; protect `$DSH_HOME`.
- GitHub tokens are stored in the local plugin settings file; do not commit it.