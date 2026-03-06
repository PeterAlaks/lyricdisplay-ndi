# LyricDisplay NDI Native Companion (Scaffold)

This directory contains the Phase-1 native companion foundation for LyricDisplay.

## Current status

Implemented in this scaffold:

- Standalone Rust process `lyricdisplay-ndi-native`
- Local IPC server (TCP JSON-lines)
- Output worker manager driven by `set_outputs` (start/stop/reconfigure per output)
- Frame scheduler with deterministic pacing and missed-tick skipping
- Software RGBA frame renderer with lightweight text drawing (for pipeline validation)
- Command handling for:
  - `hello`
  - `set_outputs`
  - `set_scene_style`
  - `set_content`
  - `set_media`
  - `set_transition`
  - `request_stats`
  - `shutdown`
- Telemetry event stubs (`stats`, `health`, `error`)
- Runtime state store for output/style/content/media/transition snapshots
- Per-output runtime telemetry (fps, frame timing, drops, send failures)
- Native NDI sender backend via dynamic runtime loading (`Processing.NDI.Lib` / `libndi`)
- Automatic fallback to mock sender when NDI runtime is unavailable
- Mock sender consumes full RGBA frames and tracks frame signatures for telemetry/testing
- Live command sync from main app for:
  - `set_content` (global lyrics + per-output line state)
  - `set_scene_style`, `set_media`, `set_transition`

Not yet implemented (next phases):

- Native GPU scene rendering
- Full native NDI integration hardening (connection monitoring, error recovery, advanced formats)
- Media decode pipeline
- Adaptive quality logic

## Build and run

```bash
cd lyricdisplay-ndi/native
cargo build --release
cargo run -- --host 127.0.0.1 --port 9137
```

## NDI Runtime Requirement

The native sender loads NDI runtime libraries at runtime:

- Windows: `Processing.NDI.Lib.x64.dll`
- macOS: `libndi.dylib`
- Linux: `libndi.so`

If the runtime is not available, the companion automatically falls back to mock send mode and exposes
`ndi_runtime_unavailable` in health telemetry.

Optional environment variable:

- `NDILIB_REDIST_FOLDER` to point to a custom runtime folder.

Release zips can bundle runtime libraries in `ndi-runtime/`; the main app sets
`NDILIB_REDIST_FOLDER` automatically when that folder exists.

## Transport format

One JSON object per line.

Example request:

```json
{"type":"hello","seq":1,"ts":1739486400000,"payload":{}}
```

Example response:

```json
{"type":"ack","seq":1,"ts":1739486400100,"payload":{"name":"lyricdisplay-ndi-native","version":"0.1.0"}}
```
