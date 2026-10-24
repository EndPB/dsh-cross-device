# dsh-cross-device

Distributed DeepSeek Harness node network: one logical session can run tools on
several devices, while every user message and assistant answer carries durable
device provenance.

## What works today

- **Node identity**: Ed25519 keypair, stable node id, fingerprint.
- **Hub**: authenticated WebSocket relay with presence and JSON-RPC routing.
- **Node fabric**: each node exposes local capabilities; peers register them as
  native DSH tools named `node__<slug>__<capability>`. A model can call desktop
  and phone tools in one chain of thought.
- **Capability packs**:
  - Desktop: `system.info`, `gpu.info`, `fs.read/list/write` (writes off by
    default), `shell.run` (off by default).
  - DSHA Android: screen dump, tap, input, key, swipe, screenshot, apps, launch,
    device, notify, toast, clipboard, sensors, sensor, location, torch through
    the local `127.0.0.1:3090` bridge.
- **Provenance**:
  - remote prompts carry a `[[device:<id>|<name>|<platform>|<time>]]` marker;
  - every user/assistant/tool event writes a sidecar provenance record under
    `$DSH_HOME/cross-device/provenance/`;
  - the system prompt includes recent provenance;
  - the `provenance_recent` tool returns the full recent history;
  - the shared panel and the standard conversation show provenance badges.
- **Session sharing (single-node/local demo)**: share a live root session, browse
  its transcript in the node panel, send a prompt, and see provenance. The
  coordinator/viewer broadcast protocol and takeover RPC are implemented; they
  need two live nodes and a hub to exercise end-to-end.
- **UI**: sidebar "节点网络" panel, settings page, share menu item, turn-tail and
  header badges. Responsive for DSHA's local WebView.

## What is not finished yet

- GitHub configuration UI/approval flow (the `Registry`/`GitHubConfig` client is
  implemented and unit-tested, but the settings page does not yet expose repo
  approval/pairing).
- cpolar supervisor (the hub can be started locally; cpolar process management
  and `hub.json` rotation are not wired yet).
- Two-node end-to-end takeover with real DSHA; the protocol-level pieces exist.
- Image/binary tool result transport (text/JSON only).
- Interactive questions/approvals forwarding.
- Automatic LAN discovery (use explicit hub/LAN URLs).

## Install (Desktop)

Source lives at `E:\data\vscode\ds-cross-devices` (exFAT). DSH plugin installs
need an NTFS copy:

```powershell
$dst = 'C:\Users\86132\Documents\ds-cross-device-build'
robocopy 'E:\data\vscode\ds-cross-devices' $dst /MIR /XD node_modules /XF '*.tmp'
cd $dst
pnpm install --ignore-scripts
pnpm test
```

Then install the bundle from `$dst` with `plugin_manager install_bundle`
(`target: $dst`). For DSHA, build/install the same package in DSHA's plugin
manager.

## Configure a local demo

1. Install and enable the plugin.
2. Open **节点网络 → 设置**.
3. Leave `Hub URL` empty for local-only use, or start a hub:
   ```powershell
   node hub/cli.js --port 8788 --allow-any
   ```
   and set `Hub URL` to `ws://127.0.0.1:8788`.
4. In **节点网络**, press **共享** on a local session. The session appears under
   **共享会话**; open it, send a prompt, and inspect provenance badges.

## Provenance

Remote prompts are prefixed with a marker; local prompts are unmarked. The
system prompt explains the marker and lists recent provenance. The sidecar is
plain JSONL and can be inspected:

```text
$DSH_HOME/cross-device/provenance/<session-id>.jsonl
```

Records are `user`, `assistant`, and `tool`, each with node id/name/platform,
event seq, time, and for assistants the tool nodes involved.

## Tests

```powershell
pnpm test
```

Covers protocol/marker helpers, GitHub config client, hub auth/routing, and
provenance sidecar/summary.

## Layout

```text
src/host/             Host plugin: settings, identity, hub, tools, provenance, sessions
src/host/capabilities desktop and DSHA Android capability packs
src/client/           Browser half (client.js is the built copy)
hub/                  standalone hub CLI/server
test/                 vitest suites
docs/                 protocol/deploy notes
```
## 实测：桌面 + 安卓平板（2026-10-24）

真实双节点已跑通，不是模拟：

- 桌面端（`两仪卨`，win32）起 hub：`node hub/cli.js --host 0.0.0.0 --port 8788 --allow-any`
- 平板端（OPPO OPD2506，Android 16，DSHA 0.2.21，proot/Ubuntu，node v24.19）在「插件市场 → 从链接安装」直接装本仓库，装完自动启用
- 平板 `settings.json` 写入 `hub.url = ws://127.0.0.1:8788`（测试期用 `adb reverse tcp:8788 tcp:8788` 打洞；同一 Wi-Fi 下可直接用 `ws://<桌面局域网IP>:8788`）
- 两端各自 Ed25519 身份，hub 上看到两个节点：

```
PEERS node:win32, dsha-tablet:linux
TABLET n_RVPBqSrD658ouj4Z caps= system.info,gpu.info,...,android.device,android.screenshot,...
RESULT {"text":"model=OPPO OPD2506\nandroid=16 (SDK 36)\nbattery=76% charging=true\nnetwork=wifi\nscreen=on\nstorage_free=33.56 GB total=99.56 GB"}
```

即：桌面侧发起 `tool.call` → hub 路由 → 平板上的插件执行 `android.device` → 走 DSHA 本机 3090 桥拿到真实设备数据并回传。整条链路（身份、鉴权、目录同步、RPC、桥调用）都在真实设备上验证过。

平板端面板截图见 `docs/tablet-panel.png`。

已知待办：平板侧 `index.js` 目前也会注册桌面能力（system/gpu/fs），在 Linux 上属噪声，应按平台过滤；桌面侧动态注册的 `node__<slug>__<tool>` 工具要在 DSH 重启或新会话后才稳定出现在模型工具表里。
