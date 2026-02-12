# LyricDisplay NDI Companion

> Broadcasts LyricDisplay output pages as NDI video sources for integration with OBS, vMix, and other NDI-compatible software.

**Author:** Peter Alakembi

## Overview

The LyricDisplay NDI Companion is a lightweight Node.js application that runs alongside [LyricDisplay](https://github.com/PeterAlaks/lyric-display-app). It renders your lyric output pages in a headless Chromium browser and sends the frames as NDI video sources over your local network — with full transparency support.

This means you can bring your lyric outputs into any NDI-compatible production software (OBS, vMix, Wirecast, NewTek TriCaster, etc.) without using browser sources, and with proper alpha channel transparency.

## How It Works

1. LyricDisplay runs its backend server (Express + Socket.io) on port 4000
2. The NDI companion launches headless Chromium pages pointed at your output URLs (`/output1`, `/output2`, `/stage`)
3. Each page renders identically to the real browser output — same HTML, CSS, JS, same real-time lyric updates
4. Frames are captured via CDP screenshots with transparent backgrounds
5. Frames are sent as NDI video sources using [grandi](https://github.com/tux-tn/grandi) (Node.js NDI SDK bindings)

Each enabled output becomes a separate NDI source on your network, discoverable by any NDI receiver.

## Installation

### From LyricDisplay (Recommended)

The easiest way to install is directly from within LyricDisplay:

1. Open LyricDisplay
2. Go to **Preferences → NDI Broadcasting**
3. Click **Download NDI Companion**
4. Once installed, click **Launch NDI Companion**

LyricDisplay handles downloading, installing, updating, and launching the companion automatically.

### Manual Installation

```bash
# Clone the repository
git clone https://github.com/PeterAlaks/lyricdisplay-ndi.git
cd lyricdisplay-ndi

# Install dependencies
npm install

# Run
node src/index.js --port 4000
```

### Prerequisites

- **Node.js** 20 or later
- **LyricDisplay** running (the companion connects to its backend)
- A local network for NDI discovery

## Usage

```bash
# Basic usage (connects to LyricDisplay backend on port 4000)
node src/index.js --port 4000

# Custom host
node src/index.js --port 4000 --host 192.168.1.100

# Development mode (connects to Vite dev server)
node src/index.js --port 4000 --frontend-url http://localhost:5173
```

### CLI Options

| Option | Default | Description |
|---|---|---|
| `--port` | `4000` | LyricDisplay backend port |
| `--host` | `127.0.0.1` | LyricDisplay backend host |
| `--frontend-url` | *(derived)* | Override the frontend URL (for development) |

### Configuring Outputs

Output settings are managed from LyricDisplay's UI:

1. In LyricDisplay, go to **Preferences → NDI Broadcasting**
2. Enable the outputs you want to broadcast (Output 1, Output 2, Stage)
3. Configure per-output settings:
   - **NDI Source Name** — how the source appears to NDI receivers
   - **Resolution** — 720p, 1080p, 1440p, 4K, or custom
   - **Framerate** — 15, 24, 25, 30, or 60 fps

Settings are saved to `ndi-settings.json` in your LyricDisplay user data directory. The companion watches this file and applies changes in real time — no restart needed.

## Architecture

```
lyricdisplay-ndi/
├── src/
│   ├── index.js       # Entry point — orchestrates all modules
│   ├── settings.js    # Reads/watches ndi-settings.json from electron-store
│   ├── browser.js     # Headless Chromium via Puppeteer with CDP sessions
│   ├── capture.js     # Adaptive frame capture loop (PNG → RGBA)
│   └── ndi.js         # grandi NDI SDK wrapper — sends RGBA frames
├── scripts/
│   └── release.js     # Release script for building and publishing
└── package.json
```

### Module Responsibilities

- **settings.js** — Locates and reads the `ndi-settings.json` file written by LyricDisplay's electron-store. Watches for file changes using chokidar and emits events when settings update.
- **browser.js** — Manages a headless Chromium instance via Puppeteer. Creates one page per enabled output at the correct viewport resolution. Uses persistent CDP sessions with `Emulation.setDefaultBackgroundColorOverride` for transparent backgrounds.
- **capture.js** — Polls each output page using `Page.captureScreenshot` (CDP) with `optimizeForSpeed`. Decodes PNG frames to raw RGBA buffers using pngjs.
- **ndi.js** — Wraps grandi's NDI send API. Creates one NDI sender per output and pushes RGBA frames at the configured framerate.

### First Launch

On first launch, if Chromium is not already cached, the companion will automatically download it for your platform and architecture. This is a one-time download (~170–280 MB depending on platform). Subsequent launches use the cached browser.

## Releasing

The release script builds a universal zip and publishes it to GitHub Releases:

```bash
cd lyricdisplay-ndi

# Interactive release
npm run release

# Or specify version bump directly
npm run release -- --patch
npm run release -- --minor
npm run release -- --major
npm run release -- --version 1.2.3
```

The script:
1. Bumps the version in `package.json`
2. Installs production dependencies (without Chromium — it downloads on first launch)
3. Installs grandi native binaries for all platforms (Windows, macOS Intel/Silicon, Linux)
4. Creates a universal zip with platform-specific naming
5. Commits, tags, and pushes to GitHub
6. Creates a GitHub release with all platform zips attached

**Prerequisites:** [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated.

### Universal Build

The release zip is universal — it contains native binaries for all platforms and architectures. A single build from any machine produces zips that work on Windows, macOS (Intel and Apple Silicon), and Linux. Chromium is not bundled; it's downloaded on first launch for the correct architecture.

## Updates

LyricDisplay automatically checks for NDI companion updates on startup. When a new version is available:

- A modal notification appears in LyricDisplay with release notes
- The NDI Broadcasting preferences page shows an update banner
- You can update with one click — the companion is stopped, updated, and ready to relaunch

You can also manually check for updates from **Preferences → NDI Broadcasting → Check for Updates**.

## Dependencies

| Package | Purpose |
|---|---|
| [puppeteer](https://pptr.dev) | Headless Chromium for rendering output pages |
| [grandi](https://github.com/tux-tn/grandi) | Node.js NDI SDK bindings (prebuilt for all platforms) |
| [chokidar](https://github.com/paulmillr/chokidar) | File watching for settings changes |
| [pngjs](https://github.com/lukeapage/pngjs) | PNG decoding for frame capture |

## Troubleshooting

**NDI sources not appearing:**
- Ensure LyricDisplay is running and its backend is accessible
- Check that at least one output is enabled in NDI Broadcasting settings
- Verify the companion is running (check the status in Preferences → NDI Broadcasting)
- NDI sources are only visible to receivers on the same network subnet

**Companion fails to launch:**
- Ensure Node.js 20+ is installed and available on your system PATH
- Check the LyricDisplay console for error messages from the companion process

**Chromium download fails on first launch:**
- Check your internet connection
- Try running manually: `npx puppeteer browsers install chrome` from the companion directory
- If behind a proxy, set `HTTPS_PROXY` environment variable

**High CPU usage:**
- Lower the framerate in NDI output settings (15 fps is sufficient for lyrics)
- Reduce the output resolution
- Disable outputs you're not using

## License

MIT

---

*Part of the [LyricDisplay](https://github.com/PeterAlaks/lyric-display-app) ecosystem — powering worship experiences worldwide.*
