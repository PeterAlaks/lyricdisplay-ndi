/**
 * Output Manager
 *
 * Creates and manages offscreen BrowserWindows for each NDI output.
 * Each output loads the corresponding page from the main app backend,
 * captures frames via the `paint` event, and feeds them to an NdiSender.
 */

import { BrowserWindow, screen } from 'electron';
import { createNdiSender, destroyNdiSender, getNdiBackendState } from './ndiSender.js';

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
const outputOperations = new Map();
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
  return Promise.all([...outputs.keys()].map((key) => disableOutput(key)));
}

/**
 * Build the full URL for an output page.
 */
function buildOutputUrl(outputKey) {
  const p = OUTPUT_PATHS[outputKey] || (/^output\d+$/i.test(String(outputKey)) ? outputKey : null);
  if (!p) return null;
  if (useHashRouting) {
    return `${baseAppUrl}/#/${p}`;
  }
  return `${baseAppUrl}/${p}`;
}

function queueOutputOperation(outputKey, operation) {
  const key = String(outputKey || '');
  const previous = outputOperations.get(key) || Promise.resolve();
  const next = previous.catch(() => null).then(operation);
  const tracked = next.finally(() => {
    if (outputOperations.get(key) === tracked) {
      outputOperations.delete(key);
    }
  });
  outputOperations.set(key, tracked);
  return next;
}

export function enableOutput(outputKey, config = {}) {
  return queueOutputOperation(outputKey, () => enableOutputNow(outputKey, config));
}

async function enableOutputNow(outputKey, config = {}) {
  if (outputs.has(outputKey)) {
    await disableOutputNow(outputKey);
  }

  const url = buildOutputUrl(outputKey);
  if (!url) {
    console.warn(`[OutputManager] Unknown output key: ${outputKey}`);
    return false;
  }

  const resolution = config.resolution || '1080p';
  const customWidth = config.customWidth || 1920;
  const customHeight = config.customHeight || 1080;
  const { width, height } = RESOLUTION_MAP[resolution] || { width: customWidth, height: customHeight };
  const framerate = config.framerate || 30;
  const sourceName = config.sourceName || `LyricDisplay ${outputKey}`;
  const backendState = getNdiBackendState();

  if (!backendState.available) {
    console.warn(`[OutputManager] Cannot enable ${outputKey}: NDI backend unavailable${backendState.error ? ` (${backendState.error})` : ''}`);
    return false;
  }

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

  /** @type {OutputHandle} */
  const handle = {
    win,
    sender: null,
    framerate,
    sourceName,
    width,
    height,
    invalidateTimer: null,
    closing: false,
    framesSent: 0,
    framesDropped: 0,
    ndiSendFailures: 0,
    lastPaintTs: 0,
    frameTimes: new Array(FRAME_TIME_BUFFER_SIZE).fill(0),
    frameTimeIdx: 0,
    prevPaintTs: 0,
    paintCount: 0,
    sendTimes: new Array(FRAME_TIME_BUFFER_SIZE).fill(0),
    sendTimeIdx: 0,
    prevSendTs: 0,
    sendCount: 0,
  };

  handle.sender = createNdiSender(sourceName, width, height, framerate, {
    onSendFailure: (err) => {
      handle.ndiSendFailures++;
      if (handle.ndiSendFailures <= 3) {
        console.error(`[OutputManager] NDI async send error (${outputKey}):`, err.message);
      }
    },
    onSendComplete: () => {
      const now = performance.now();
      if (handle.prevSendTs > 0) {
        const delta = now - handle.prevSendTs;
        handle.sendTimes[handle.sendTimeIdx % FRAME_TIME_BUFFER_SIZE] = delta;
        handle.sendTimeIdx++;
      }
      handle.prevSendTs = now;
      handle.sendCount++;
    },
  });

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
      const accepted = handle.sender.sendFrame(image.toBitmap(), size.width, size.height);
      if (accepted) {
        handle.framesSent++;
        handle.lastPaintTs = Date.now();
      } else {
        handle.framesDropped++;
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
  return true;
}

export function disableOutput(outputKey) {
  return queueOutputOperation(outputKey, () => disableOutputNow(outputKey));
}

async function disableOutputNow(outputKey) {
  const handle = outputs.get(outputKey);
  if (!handle) return false;

  if (handle.closing) return false;
  handle.closing = true;

  console.log(`[OutputManager] Disabling ${outputKey}`);

  if (handle.invalidateTimer) {
    clearInterval(handle.invalidateTimer);
    handle.invalidateTimer = null;
  }

  try {
    handle.win.webContents.removeAllListeners('paint');
  } catch { /* already destroyed */ }

  outputs.delete(outputKey);

  const teardown = destroyNdiSender(handle.sender, { timeoutMs: 1500, label: outputKey });
  await Promise.resolve(teardown).finally(() => {
    try {
      if (!handle.win.isDestroyed()) {
        handle.win.destroy();
      }
    } catch { /* already destroyed */ }
    handle.sender = null;
  });
  return true;
}

export function updateOutputConfig(outputKey, config) {
  return queueOutputOperation(outputKey, () => updateOutputConfigNow(outputKey, config));
}

async function updateOutputConfigNow(outputKey, config) {
  const handle = outputs.get(outputKey);
  if (!handle) return false;

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
    await enableOutputNow(outputKey, { resolution, customWidth, customHeight, framerate, sourceName });
  }
  return true;
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

function computeSendStats(handle) {
  const count = Math.min(handle.sendTimeIdx, FRAME_TIME_BUFFER_SIZE);
  if (count === 0) {
    return { send_fps: 0 };
  }

  const samples = [];
  const start = handle.sendTimeIdx >= FRAME_TIME_BUFFER_SIZE
    ? handle.sendTimeIdx - FRAME_TIME_BUFFER_SIZE
    : 0;
  for (let i = start; i < handle.sendTimeIdx; i++) {
    samples.push(handle.sendTimes[i % FRAME_TIME_BUFFER_SIZE]);
  }

  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { send_fps: avg > 0 ? 1000 / avg : 0 };
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
  let weightedSendFps = 0;
  let totalPaintCount = 0;
  let totalSendCount = 0;

  const perOutput = {};
  const backendState = getNdiBackendState();
  const warningFlags = [];

  if (!backendState.available) {
    warningFlags.push('ndi_backend_unavailable');
  }

  for (const [key, handle] of outputs) {
    const frameStats = computeFrameStats(handle);
    const sendStats = computeSendStats(handle);

    totalFramesSent += handle.framesSent;
    totalFramesDropped += handle.framesDropped;
    totalNdiSendFailures += handle.ndiSendFailures;
    totalPaintCount += handle.paintCount;
    totalSendCount += handle.sendCount;

    weightedAvgFrameMs += frameStats.avg_frame_ms * handle.paintCount;
    weightedRenderFps += frameStats.render_fps * handle.paintCount;
    weightedSendFps += sendStats.send_fps * handle.sendCount;
    if (frameStats.p95_frame_ms > maxP95FrameMs) {
      maxP95FrameMs = frameStats.p95_frame_ms;
    }

    if (!handle.sender?.ready) {
      warningFlags.push(`${key}:sender_not_ready`);
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
      ...sendStats,
    };
  }

  const avgFrameMs = totalPaintCount > 0 ? weightedAvgFrameMs / totalPaintCount : 0;
  const renderFps = totalPaintCount > 0 ? weightedRenderFps / totalPaintCount : 0;

  const sendFps = totalSendCount > 0 ? weightedSendFps / totalSendCount : 0;

  return {
    render_fps: renderFps,
    send_fps: sendFps,
    dropped_frames: totalFramesDropped,
    ndi_send_failures: totalNdiSendFailures,
    avg_frame_ms: avgFrameMs,
    p95_frame_ms: maxP95FrameMs,
    outputs: perOutput,
    health: {
      ndi_backend: backendState.backend,
      warning_flags: warningFlags,
      backend_error: backendState.error,
    },
  };
}

export function isOutputEnabled(outputKey) {
  return outputs.has(outputKey);
}
