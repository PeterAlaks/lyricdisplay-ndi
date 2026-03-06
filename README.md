# LyricDisplay NDI Companion (Native Rust)

Native companion process for [LyricDisplay](https://github.com/PeterAlaks/lyric-display-app).

This repository is now native-only. The companion runtime is `lyricdisplay-ndi-native` (Rust) under [`native/`](./native/).

## User Flow (Preserved in Main App)

LyricDisplay still handles the full companion lifecycle from within the app:

1. Download/install companion
2. Launch/stop companion
3. Enable/disable per-output NDI broadcast
4. Check/update/uninstall companion

The main app downloads platform assets from GitHub Releases using:

- `lyricdisplay-ndi-win.zip`
- `lyricdisplay-ndi-mac.zip`
- `lyricdisplay-ndi-linux.zip`

Each zip contains `lyricdisplay-ndi-native` (`.exe` on Windows).

To keep user setup zero-touch, platform runtime libraries can be bundled in the zip under `ndi-runtime/`.
The main app auto-detects that folder and launches the companion with `NDILIB_REDIST_FOLDER`.

## Local Development

```bash
cd lyricdisplay-ndi/native
cargo run -- --host 127.0.0.1 --port 9137
```

## Build Release Asset

```bash
cd lyricdisplay-ndi
node build.js
```

Output: `dist/lyricdisplay-ndi-<win|mac|linux>.zip`

Optional runtime bundling:

```bash
set NDI_RUNTIME_DIR=C:\path\to\ndi-runtime
node build.js
```

If `NDI_RUNTIME_DIR` is set, `build.js` stages runtime libs and writes `ndi-runtime-manifest.json`.

## Release

```bash
cd lyricdisplay-ndi
node scripts/release.js --patch
```

The release script:

1. Bumps version in `native/Cargo.toml` (and `package.json` mirror)
2. Commits/tags/pushes
3. Triggers GitHub Actions to build and upload platform zip assets

Optional for zero-touch runtime packaging:

- Add repository secrets with direct downloadable runtime library URLs:
  - `NDI_RUNTIME_LIB_URL_WINDOWS` -> `Processing.NDI.Lib.x64.dll`
  - `NDI_RUNTIME_LIB_URL_MACOS` -> `libndi.dylib`
  - `NDI_RUNTIME_LIB_URL_LINUX` -> `libndi.so.6`
- Workflow will download these files into `.ndi-runtime/` and bundle them in release zips.

## Repository Layout

```text
lyricdisplay-ndi/
  native/
    Cargo.toml
    src/
      main.rs
      ipc/
      render/
      scene/
      ndi/
      media/
      telemetry/
  build.js
  scripts/release.js
```
