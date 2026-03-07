# LyricDisplay NDI™ Companion

Headless Electron application that broadcasts [LyricDisplay](https://github.com/PeterAlaks/lyric-display-app) output pages over [NDI®](https://ndi.video) for use in OBS, vMix, and other NDI-capable production software.

## How it works

1. The main LyricDisplay app launches this companion automatically.
2. The companion opens invisible (offscreen) browser windows that load the same output pages you see on screen.
3. Each frame is captured via Chromium's offscreen rendering and sent over NDI using the [grandi](https://www.npmjs.com/package/grandi) native module.
4. NDI receivers on the local network (OBS, vMix, Wirecast, etc.) pick up the streams with full transparency support.

## Installation

End users do **not** need to install this manually. The main LyricDisplay app downloads, installs, and manages the companion automatically from the NDI settings panel.

### For development

```bash
cd lyricdisplay-ndi
npm install
```

The companion is launched automatically by the main app during development. You can also run it standalone:

```bash
npx electron . --host 127.0.0.1 --port 9137 --app-url http://localhost:5173 --no-hash
```

## CLI options

| Flag | Default | Description |
|------|---------|-------------|
| `--host <ip>` | `127.0.0.1` | IPC server bind address |
| `--port <port>` | `9137` | IPC server port |
| `--app-url <url>` | `http://127.0.0.1:4000` | Base URL of the LyricDisplay backend |
| `--no-hash` | _(hash routing)_ | Use path-based routing (for dev with Vite) |

## Building

```bash
npm run build
```

Produces a platform-specific `.zip` archive in `dist/` via electron-builder.

## Releasing

```bash
npm run release
```

Bumps the version, commits, tags, and pushes. GitHub Actions builds and uploads platform archives to the release.

## Architecture

```
src/
  main.js           – Electron entry point
  cli.js            – CLI argument parser
  settings.js       – Persistent settings (electron-store)
  outputManager.js  – Offscreen BrowserWindow lifecycle and frame capture
  ndiSender.js      – grandi NDI sender wrapper
  ipc.js            – TCP JSON-line protocol server
```

## Trademarks

NDI® is a registered trademark of Vizrt NDI AB. This project is not affiliated with or endorsed by Vizrt NDI AB. For more information about NDI, visit [ndi.video](https://ndi.video).

## License

This project is part of [LyricDisplay](https://github.com/PeterAlaks/lyric-display-app). See the main repository for license details.
