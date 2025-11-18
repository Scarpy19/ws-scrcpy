# ws-scrcpy Agents

This repository turns a browser into a remote control surface for Android (and optionally iOS) devices by bridging Genymobile's `scrcpy` streaming server with a Node.js gateway and a rich web UI. The codebase is organized around a handful of long-lived "agents"—services with clear responsibilities that cooperate over WebSockets, ADB, and HTTP. This document summarizes each agent, the modules that implement it, and the major flows tying them together.

## System Goal

1. Detect devices connected to a host (USB or over network) and keep their metadata fresh.
2. Spin up or reuse a WebSocket-enabled `scrcpy` server on each Android device.
3. Expose device capabilities to browsers through a single Node.js endpoint that serves the UI, proxies traffic, and multiplexes side-channels (shell, devtools, file listing, etc.).
4. Let the browser stream video, inject input events, push files, open shells, and inspect WebViews using pluggable players and tools.

## Primary Agents

| Agent | Responsibility | Key Modules |
| --- | --- | --- |
| Android Device Agent | Keeps `scrcpy` running on each device, tracks interfaces, exposes adb-powered helpers (shell, devtools, file ops). | `src/server/goog-device/Device.ts`, `ScrcpyServer.ts`, `AdbUtils.ts`, `vendor/Genymobile/scrcpy/` |
| Node Gateway Agent | Boots HTTP+WS servers, loads middleware, manages trackers, multiplexes channels, proxies remote hosts. | `src/server/index.ts`, `services/HttpServer.ts`, `services/WebSocketServer.ts`, `mw/*.ts`, `server/goog-device/**/*`, `server/appl-device/**/*` |
| Browser Client Agent | Hosts the UI, device list, stream players, interaction handlers, tooling overlays, and persistence. | `src/app/index.ts`, `app/client/**/*.ts`, `app/googDevice/**/*.ts`, `app/player/**/*`, `style/*.css` |
| Optional iOS Agent | Mirrors Android flow using WebDriverAgent, ws-qvh, or MJPEG for capture/inputs. | `src/server/appl-device/**`, `src/app/applDevice/**`, `config` flags |
| Multiplexer & Shared Infrastructure | Shares a single WS transport between logical channels (host tracking, trackers, shell, etc.) and unifies typed messages. | `packages/multiplexer/**/*`, `common/*.ts`, `types/*.ts` |

### Android Device Agent

- **Lifecycle management**: `ControlCenter` (`src/server/goog-device/services/ControlCenter.ts`) watches adb trackers, instantiates a `Device` per UDID, and emits descriptors consumed by trackers.
- **Server bootstrap**: `Device.startServer()` delegates to `ScrcpyServer.run()`. The helper copies `scrcpy-server.jar` from `vendor/Genymobile/scrcpy/`, executes it with the correct `ARGS_STRING` (see `src/common/Constants.ts`), and polls PID files until WebSockets are live.
- **State reporting**: Each `Device` gathers build props, surface network interfaces, and learns which TCP endpoints expose `scrcpy`. Descriptors conform to `types/GoogDeviceDescriptor.d.ts` and include PIDs, Wi-Fi interface names, etc.
- **ADB utilities**: `AdbUtils` handles TCP forwarding, file stats, pulling/pushing, devtools socket inspection, and piping shell/listing responses back through multiplexer channels.

### Node Gateway Agent

- **Entry point**: `src/server/index.ts` loads config (`Config.ts`), instantiates `HttpServer` (serves `dist/public` and optional MJPEG proxy) and `WebSocketServer` (listens on the same ports). It lazily imports Android/iOS services based on build flags to avoid bundling unused targets.
- **Middleware chain**: Requests that hit the WS endpoint include an `action` query parameter. `WebSocketServer` hands the socket to registered middleware (`mw/Mw.ts`). Examples:
  - `WebsocketProxy` (`ACTION.PROXY_WS`) mirrors raw WebSockets to arbitrary upstreams.
  - `WebsocketMultiplexer` (`ACTION.MULTIPLEX`) upgrades the socket to the custom multiplexing protocol so subsequent logical channels (HostTracker, DeviceTracker, shell, file listing, etc.) can coexist.
  - `HostTracker` (channel code `HSTS`) sends the list of available local/remote trackers as soon as a multiplexer channel opens.
  - Android-specific MWs (`server/goog-device/mw/*`) bind channel codes to capabilities: device listing (`GTRC`), shell, devtools, file listing, and WebSocket proxy over adb.
- **Control loop**: `ControlCenter` and the `Device` classes act like an internal agent that supervises devices (start/kill/add interfaces). Commands flow from browser → tracker channel → `ControlCenterCommand` → `ControlCenter.runCommand()` → `Device` methods.
- **Host federation**: If `Config.remoteHostList` is populated, `HostTracker` advertises additional endpoints; the browser then spins up trackers pointed at those hosts with optional proxying.

### Browser Client Agent

- **Bootstrap**: `src/app/index.ts` loads CSS, optional decoders (Broadway, MSE, TinyH264, WebCodecs), and starts the `Tool` registry plus `HostTracker`.
- **Device discovery**: `HostTracker` (`app/client/HostTracker.ts`) opens an `ACTION.LIST_HOSTS` multiplexer channel, receives available host descriptors, and launches platform trackers. `BaseDeviceTracker` renders the responsive device list UI, while `googDevice/client/DeviceTracker.ts` wires Android-specific controls (interface selector, PID actions, stream links).
- **Streaming agent**: `StreamClientScrcpy` pairs with `StreamReceiverScrcpy` to manage video/control channels. `StreamReceiver` handles binary framing: first the scrcpy initial metadata blob (device name, display list, other clients, encoders), then H.264 frames or device messages; it replays cached control messages once connected.
- **Players and interactions**: Player implementations in `app/player/*` wrap different decoders. Input is captured via `interactionHandler/FeaturedInteractionHandler`, `KeyInputHandler`, and `controlMessage/*` classes which serialize gestures/keycodes back to the device. File push flows go through `filePush` classes and `ScrcpyFilePushStream`, reusing the stream receiver transport.
- **Toolbox**: `GoogToolBox`, `GoogMoreBox`, and `Tool` plugins add UI sections for shell terminals, devtools listings, file managers, etc.—matching the middleware available on the server.
- **State & routing**: Stream links embed parameters in the hash (`#!/action=stream&udid=...`). `BaseClient.parseParameters()` normalizes query strings so features like proxying or secure WebSockets work consistently.

### Optional iOS Agent

- Controlled by webpack flags (`INCLUDE_APPL`, `USE_QVH_SERVER`, `USE_WDA_MJPEG_SERVER`). When enabled, the server loads `src/server/appl-device/**` services to talk to WebDriverAgent or ws-qvh, and the client mirrors the Android tracker/streamer pattern inside `src/app/applDevice/**`.
- Interactions are limited to taps, scrolls, and home button events routed through WebDriverAgent (see README instructions).

### Multiplexer & Shared Infrastructure

- A single TCP/WebSocket connection can host multiple logical channels via `packages/multiplexer/Multiplexer.ts`. Channels advertise a 4-byte code (see `common/ChannelCode.ts`) so both Node middleware and browser clients know which handler to attach.
- `ManagerClient` and `BaseDeviceTracker` encapsulate the client-side use of the multiplexer, automatically reusing sockets, buffering outbound messages until open, and wrapping channel metadata.
- Typed messages and DTOs live under `src/common` and `src/types`, keeping serialization consistent across agents.

## End-to-End Flows

1. **Device discovery**
   - Browser connects to `/ws?action=multiplex`; `HostTracker` channel (`HSTS`) responds with the set of trackers.
   - For Android, `DeviceTracker` (`GTRC` channel) subscribes to `ControlCenter` updates. Each descriptor includes PID and network info, enabling UI buttons for "Start/Kill server", "proxy over adb", or direct IP streaming.

2. **Starting a stream**
   - Selecting an interface emits an `ACTION.STREAM_SCRCPY` link. If the browser cannot reach the device directly, the link can include `useProxy=true`, instructing the client to wrap the target URL in a `proxy-ws` action that rides the Node gateway and optionally an adb port-forward (`WebsocketProxyOverAdb`).
   - `StreamReceiverScrcpy` connects to the scrcpy WebSocket (`ws://device:8886/` or proxied). The first binary blob synchronizes display info and other clients; afterwards the browser negotiates `VideoSettings` (bitrate, bounds, encoder choice) and begins ingesting H.264 NALUs.
   - User input travels back as `ControlMessage`s (touch, keycode, clipboard, orientation) over the same WebSocket, so no extra server components are required.

3. **Secondary channels**
   - **Remote shell**: `ACTION.SHELL` channels spawn `RemoteShell` middleware that bridges `node-pty` to adb shell sessions, rendered by `xterm.js` on the client.
   - **Devtools**: `RemoteDevtools` uses `AdbUtils.getRemoteDevtoolsInfo()` to fetch `/json` metadata from Chrome instances on-device, rewrites WebSocket URLs, and shows inspect/bundled/remote links described in `docs/Devtools.md`.
   - **File listing & transfer**: `FileListing` middleware streams directory stats and file payloads via multiplexer frames. The UI lets users drag/drop uploads (`AdbUtils.push`) or download files (`pipePullFileToStream`).

## Build- and Run-Time Controls

- Webpack flags (see `webpack/default.build.config.json` and `build.config.override.json`) decide which agents compile into the bundle (Android, iOS, shell, devtools, file listing, decoder variants, etc.). Tree-shaking keeps unused features out of production builds.
- Runtime environment variables (`WS_SCRCPY_CONFIG`, `WS_SCRCPY_PATHNAME`) select config files and base path. YAML config controls listening ports, TLS certificates, and remote host lists.

## Security Notes

Per `README.md` the current setup lacks transport encryption and authentication between the browser, Node gateway, and on-device WebSocket server. If you expose the gateway beyond a trusted LAN, add HTTPS/TLS at the Node layer, restrict who can reach port 8886 on devices, and consider fronting the service with an authenticated proxy.

## Where to Go Next

- Follow the ASCII diagram in `docs/scheme.md` to visualize the same topology.
- Use `docs/debug.md` for adb debugging tips and `docs/Devtools.md` for remote inspection workflows.
- When extending the system, identify which agent should own the feature (device action, proxy, UI) and add the corresponding middleware + client tool pair.
