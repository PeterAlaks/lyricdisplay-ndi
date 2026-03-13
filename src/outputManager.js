/**
 * Output Manager
 *
 * Creates and manages offscreen BrowserWindows for each NDI output.
 * Each output loads the corresponding page from the main app backend,
 * captures frames via the `paint` event, and feeds them to an NdiSender.
 */

import { BrowserWindow, screen } from 'electron';
import { createNdiSender, destroyNdiSender } from './ndiSender.js';

const RESOLUTION_MAP = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4k': { width: 3840, height: 2160 },
};

const OUTPUT_PATHS = {
  output1: 'output1',
  output2: 'output2',
  stage: 'stage',
};

/** @type {Map<string, OutputHandle>} */
const outputs = new Map();
let baseAppUrl = 'http://127.0.0.1:4000';
let useHashRouting = true;

/**
 * @typedef {Object} OutputHandle
 * @property {BrowserWindow} win
 * @property {object|null} sender  – NdiSenderHandle from ndiSender.js
 * @property {number} framerate
 * @property {string} sourceName
 * @property {number} width
 * @property {number} height
 * @property {NodeJS.Timeout|null} invalidateTimer – forces repaints for static content
 * @property {number} framesSent
 * @property {number} framesDropped
 * @property {number} ndiSendFailures
 * @property {number} lastPaintTs
 * @property {number[]} frameTimes  – ring buffer of recent frame durations (ms)
 * @property {number} frameTimeIdx
 * @property {number} prevPaintTs   – timestamp of previous paint for FPS calc
 * @property {number} paintCount    – total paint events received
 */

const FRAME_TIME_BUFFER_SIZE = 120; // ~2-4 seconds of samples at 30-60fps

/**
 * Initialise the output manager.
 * @param {string} appUrl   Base URL of the main LyricDisplay backend
 * @param {object} [opts]
 * @param {boolean} [opts.hashRouting=true]  Use hash-based routing (production)
 */
export function initOutputManager(appUrl, opts = {}) {
  baseAppUrl = appUrl || baseAppUrl;
  useHashRouting = opts.hashRouting !== false;
}

export function destroyOutputManager() {
  for (const key of [...outputs.keys()]) {
    disableOutput(key);
  }
}

/**
 * Build the full URL for an output page.
 */
function buildOutputUrl(outputKey) {
  const p = OUTPUT_PATHS[outputKey];
  if (!p) return null;
  if (useHashRouting) {
    return `${baseAppUrl}/#/${p}`;
  }
  return `${baseAppUrl}/${p}`;
}

export function enableOutput(outputKey, config = {}) {
  if (outputs.has(outputKey)) {
    disableOutput(outputKey);
  }

  const url = buildOutputUrl(outputKey);
  if (!url) {
    console.warn(`[OutputManager] Unknown output key: ${outputKey}`);
    return;
  }

  const resolution = config.resolution || '1080p';
  const customWidth = config.customWidth || 1920;
  const customHeight = config.customHeight || 1080;
  const { width, height } = RESOLUTION_MAP[resolution] || { width: customWidth, height: customHeight };
  const framerate = config.framerate || 30;
  const sourceName = config.sourceName || `LyricDisplay ${outputKey}`;

  const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
  const logicalW = Math.round(width / scaleFactor);
  const logicalH = Math.round(height / scaleFactor);

  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setContentSize(logicalW, logicalH);

  win.webContents.setFrameRate(framerate);

  win.webContents.on('dom-ready', () => {
    win.webContents.insertCSS(
      'html, body, #root { background: transparent !important; }'
    ).catch(() => { });
  });

  const sender = createNdiSender(sourceName, width, height, framerate);

  /** @type {OutputHandle} */
  const handle = {
    win,
    sender,
    framerate,
    sourceName,
    width,
    height,
    invalidateTimer: null,
    framesSent: 0,
    framesDropped: 0,
    ndiSendFailures: 0,
    lastPaintTs: 0,
    frameTimes: new Array(FRAME_TIME_BUFFER_SIZE).fill(0),
    frameTimeIdx: 0,
    prevPaintTs: 0,
    paintCount: 0,
  };

  win.webContents.on('paint', (_event, _dirty, image) => {
    const now = performance.now();

    if (handle.prevPaintTs > 0) {
      const delta = now - handle.prevPaintTs;
      handle.frameTimes[handle.frameTimeIdx % FRAME_TIME_BUFFER_SIZE] = delta;
      handle.frameTimeIdx++;
    }
    handle.prevPaintTs = now;
    handle.paintCount++;

    if (!handle.sender || !handle.sender.ready) return;

    const size = image.getSize();
    if (size.width === 0 || size.height === 0) return;

    try {
      const bitmap = image.toBitmap();
      const wasBusy = handle.sender.sending;
      handle.sender.sendFrame(bitmap, size.width, size.height);
      if (wasBusy) {
        handle.framesDropped++;
      } else {
        handle.framesSent++;
        handle.lastPaintTs = Date.now();
      }
    } catch (err) {
      handle.ndiSendFailures++;
      handle.framesDropped++;
      if (handle.ndiSendFailures <= 3) {
        console.error(`[OutputManager] NDI send error (${outputKey}):`, err.message);
      }
    }
  });

  const invalidateIntervalMs = Math.max(Math.floor(1000 / framerate) - 2, 8);
  handle.invalidateTimer = setInterval(() => {
    try {
      if (!win.isDestroyed()) {
        win.webContents.invalidate();
      }
    } catch { /* window may be closing */ }
  }, invalidateIntervalMs);

  console.log(`[OutputManager] Enabling ${outputKey}: ${url} @ ${width}x${height} ${framerate}fps → "${sourceName}"`);
  win.loadURL(url);

  outputs.set(outputKey, handle);
}

export function disableOutput(outputKey) {
  const handle = outputs.get(outputKey);
  if (!handle) return;

  console.log(`[OutputManager] Disabling ${outputKey}`);

  if (handle.invalidateTimer) {
    clearInterval(handle.invalidateTimer);
    handle.invalidateTimer = null;
  }

  try {
    handle.win.webContents.removeAllListeners('paint');
    handle.win.destroy();
  } catch { /* already destroyed */ }

  if (handle.sender) {
    destroyNdiSender(handle.sender);
    handle.sender = null;
  }

  outputs.delete(outputKey);
}

export function updateOutputConfig(outputKey, config) {
  const handle = outputs.get(outputKey);
  if (!handle) return;

  const resolution = config.resolution || '1080p';
  const customWidth = config.customWidth || handle.width;
  const customHeight = config.customHeight || handle.height;
  const { width, height } = RESOLUTION_MAP[resolution] || { width: customWidth, height: customHeight };
  const framerate = config.framerate || handle.framerate;
  const sourceName = config.sourceName || handle.sourceName;

  const needsRecreate =
    width !== handle.width ||
    height !== handle.height ||
    framerate !== handle.framerate ||
    sourceName !== handle.sourceName;

  if (needsRecreate) {
    enableOutput(outputKey, { resolution, customWidth, customHeight, framerate, sourceName });
  }
}

/**
 * Compute frame-time statistics from the ring buffer.
 */
function computeFrameStats(handle) {
  const count = Math.min(handle.frameTimeIdx, FRAME_TIME_BUFFER_SIZE);
  if (count === 0) {
    return { avg_frame_ms: 0, p95_frame_ms: 0, render_fps: 0 };
  }

  const samples = [];
  const start = handle.frameTimeIdx >= FRAME_TIME_BUFFER_SIZE
    ? handle.frameTimeIdx - FRAME_TIME_BUFFER_SIZE
    : 0;
  for (let i = start; i < handle.frameTimeIdx; i++) {
    samples.push(handle.frameTimes[i % FRAME_TIME_BUFFER_SIZE]);
  }

  const sum = samples.reduce((a, b) => a + b, 0);
  const avg = sum / samples.length;

  const sorted = [...samples].sort((a, b) => a - b);
  const p95Idx = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1);
  const p95 = sorted[p95Idx];

  const fps = avg > 0 ? 1000 / avg : 0;

  return {
    avg_frame_ms: avg,
    p95_frame_ms: p95,
    render_fps: fps,
  };
}

/**
 * Get aggregated stats across all active outputs.
 * Returns the format expected by the main app's telemetry grid:
 *   render_fps, send_fps, dropped_frames, ndi_send_failures, avg_frame_ms, p95_frame_ms
 */
export function getOutputStats() {
  let totalFramesSent = 0;
  let totalFramesDropped = 0;
  let totalNdiSendFailures = 0;
  let weightedAvgFrameMs = 0;
  let maxP95FrameMs = 0;
  let weightedRenderFps = 0;
  let totalPaintCount = 0;

  const perOutput = {};

  for (const [key, handle] of outputs) {
    const frameStats = computeFrameStats(handle);

    totalFramesSent += handle.framesSent;
    totalFramesDropped += handle.framesDropped;
    totalNdiSendFailures += handle.ndiSendFailures;
    totalPaintCount += handle.paintCount;

    weightedAvgFrameMs += frameStats.avg_frame_ms * handle.paintCount;
    weightedRenderFps += frameStats.render_fps * handle.paintCount;
    if (frameStats.p95_frame_ms > maxP95FrameMs) {
      maxP95FrameMs = frameStats.p95_frame_ms;
    }

    perOutput[key] = {
      enabled: true,
      sourceName: handle.sourceName,
      width: handle.width,
      height: handle.height,
      framerate: handle.framerate,
      framesSent: handle.framesSent,
      framesDropped: handle.framesDropped,
      ndiSendFailures: handle.ndiSendFailures,
      lastPaintTs: handle.lastPaintTs,
      senderReady: handle.sender?.ready || false,
      ...frameStats,
    };
  }

  const avgFrameMs = totalPaintCount > 0 ? weightedAvgFrameMs / totalPaintCount : 0;
  const renderFps = totalPaintCount > 0 ? weightedRenderFps / totalPaintCount : 0;

  const sendFps = renderFps;

  return {
    render_fps: renderFps,
    send_fps: sendFps,
    dropped_frames: totalFramesDropped,
    ndi_send_failures: totalNdiSendFailures,
    avg_frame_ms: avgFrameMs,
    p95_frame_ms: maxP95FrameMs,
    outputs: perOutput,
  };
}

export function isOutputEnabled(outputKey) {
  return outputs.has(outputKey);
}