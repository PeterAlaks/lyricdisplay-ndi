/**
 * NDI Sender – wraps the `grandi` native module.
 *
 * Each sender represents one NDI source on the network.
 * Frames are submitted as raw BGRA buffers from the offscreen paint event.
 */

let grandi = null;
let loadError = null;
let backendInitialized = false;
let sdkVersion = null;

function describeError(error) {
  if (!error) return null;

  const messages = [];
  const visited = new Set();
  const visit = (candidate) => {
    if (!candidate || visited.has(candidate)) return;
    visited.add(candidate);

    if (candidate.message && !messages.includes(candidate.message)) {
      messages.push(candidate.message);
    }
    if (Array.isArray(candidate.errors)) {
      candidate.errors.forEach(visit);
    }
    visit(candidate.cause);
  };

  visit(error);
  return messages.join(' | ') || String(error);
}

try {
  const mod = await import('grandi');
  const candidate = mod.default || mod;
  if (typeof candidate.initialize !== 'function' || !candidate.initialize()) {
    throw new Error('The NDI runtime could not initialize on this CPU');
  }

  grandi = candidate;
  backendInitialized = true;
  sdkVersion = typeof grandi.version === 'function' ? grandi.version() : null;
  console.log(`[NdiSender] Grandi initialized${sdkVersion ? ` (${sdkVersion})` : ''}`);
} catch (err) {
  loadError = err;
  console.error('[NdiSender] Failed to load or initialize grandi:', err);
  console.error('[NdiSender] NDI output will be unavailable.');
}

/**
 * @typedef {Object} NdiSenderHandle
 * @property {object} sender       – grandi Sender instance
 * @property {string} name
 * @property {number} width
 * @property {number} height
 * @property {number} framerate
 * @property {boolean} ready       – true once the async sender is created
 * @property {boolean} sending     – true while a video() call is in flight
 * @property {Function} sendFrame
 * @property {Function} destroy
 */

/**
 * Create an NDI sender for a given source name and resolution.
 *
 * @param {string} name      NDI source name visible on the network
 * @param {number} width     Frame width in pixels
 * @param {number} height    Frame height in pixels
 * @param {number} framerate Target framerate (used for NDI timing metadata)
 * @returns {NdiSenderHandle|null}
 */
export function createNdiSender(name, width, height, framerate, callbacks = {}) {
  if (!grandi) {
    console.warn(`[NdiSender] grandi not available – "${name}" will not broadcast.`);
    return null;
  }

  const FOURCC_BGRA = grandi.FourCC?.BGRA;
  const FORMAT_PROGRESSIVE = grandi.FrameType?.Progressive;

  if (FOURCC_BGRA == null || FORMAT_PROGRESSIVE == null) {
    console.error('[NdiSender] Could not resolve Grandi v2 video enums – NDI output unavailable.');
    return null;
  }

  /** @type {NdiSenderHandle} */
  const handle = {
    sender: null,
    creating: true,
    createPromise: null,
    name,
    width,
    height,
    framerate,
    ready: false,
    sending: false,
    inflight: 0,
    closing: false,
    closed: false,
    destroyPromise: null,

    /**
     * Submit a single BGRA frame.
     *
     * @param {Buffer} bgraBuffer  Raw pixel data (width * height * 4 bytes)
     * @param {number} w           Actual frame width
     * @param {number} h           Actual frame height
     */
    sendFrame(bgraBuffer, w, h) {
      if (!handle.ready || !handle.sender || handle.closing) return false;
      if (handle.sending) return false;

      handle.sending = true;
      handle.inflight += 1;

      let sendPromise;
      try {
        sendPromise = handle.sender.video({
          type: 'video',
          xres: w,
          yres: h,
          frameRateN: framerate,
          frameRateD: 1,
          pictureAspectRatio: w / h,
          fourCC: FOURCC_BGRA,
          frameFormatType: FORMAT_PROGRESSIVE,
          lineStrideBytes: w * 4,
          data: bgraBuffer,
          timecode: grandi.TIMECODE_SYNTHESIZE,
        });
      } catch (err) {
        handle.sending = false;
        handle.inflight = Math.max(0, handle.inflight - 1);
        throw err;
      }

      Promise.resolve(sendPromise)
        .then(() => {
          callbacks.onSendComplete?.();
        })
        .catch((err) => {
          console.error(`[NdiSender] video() error on "${name}":`, err.message);
          callbacks.onSendFailure?.(err);
        })
        .finally(() => {
          handle.sending = false;
          handle.inflight = Math.max(0, handle.inflight - 1);
        });

      return true;
    },

    destroy() {
      if (handle.closed) return;
      handle.closing = true;
      if (handle.sender) {
        try {
          console.log(`[NdiSender] Destroying sender "${name}"`);
          handle.sender.destroy();
        } catch { /* ignore */ }
        handle.sender = null;
        handle.ready = false;
      }
      handle.closed = true;
    },

    destroyGracefully({ timeoutMs = 1500, label = name } = {}) {
      if (handle.closed) return Promise.resolve({ forced: false });
      if (handle.destroyPromise) return handle.destroyPromise;

      handle.closing = true;
      handle.destroyPromise = new Promise((resolve) => {
        const start = Date.now();

        const check = () => {
          if (!handle.creating && (!handle.sender || handle.inflight === 0)) {
            handle.destroy();
            resolve({ forced: false });
            return;
          }

          if (Date.now() - start >= timeoutMs) {
            console.warn(`[NdiSender] Graceful destroy timeout for "${label}" after ${timeoutMs}ms`);
            handle.destroy();
            resolve({ forced: true });
            return;
          }

          setTimeout(check, 20);
        };

        setTimeout(check, 0);
      });

      return handle.destroyPromise;
    },

    getRuntimeState() {
      if (!handle.ready || !handle.sender || handle.closing) {
        return {
          connections: 0,
          sourceName: name,
          tally: { onProgram: false, onPreview: false },
        };
      }

      try {
        const tally = handle.sender.tally();
        return {
          connections: handle.sender.connections(),
          sourceName: handle.sender.sourceName(),
          tally: {
            onProgram: Boolean(tally?.onProgram),
            onPreview: Boolean(tally?.onPreview),
          },
        };
      } catch (err) {
        console.warn(`[NdiSender] Could not read sender state for "${name}":`, err.message);
        return {
          connections: 0,
          sourceName: name,
          tally: { onProgram: false, onPreview: false },
        };
      }
    },
  };

  handle.createPromise = grandi.send({ name, clockVideo: true, clockAudio: false })
    .then((sender) => {
      if (handle.closing || handle.closed) {
        sender.destroy();
        return;
      }
      handle.sender = sender;
      handle.ready = true;
      const srcName = sender.sourceName();
      console.log(`[NdiSender] Sender ready: "${srcName}" (${width}x${height} @ ${framerate}fps)`);
    })
    .catch((err) => {
      console.error(`[NdiSender] Failed to create sender "${name}":`, err.message);
    })
    .finally(() => {
      handle.creating = false;
    });

  return handle;
}

export function getNdiBackendState() {
  return {
    available: Boolean(grandi),
    backend: grandi ? 'grandi' : 'unavailable',
    initialized: backendInitialized,
    sdkVersion,
    error: describeError(loadError),
  };
}

export function destroyNdiBackend() {
  if (!grandi || !backendInitialized) return false;

  try {
    return grandi.destroy() !== false;
  } catch (err) {
    console.error('[NdiSender] Failed to shut down Grandi:', err);
    return false;
  } finally {
    backendInitialized = false;
    grandi = null;
  }
}

/**
 * Destroy an NDI sender handle.
 * @param {NdiSenderHandle|null} handle
 */
export function destroyNdiSender(handle, options = {}) {
  if (!handle) return;
  if (typeof handle.destroyGracefully === 'function') {
    return handle.destroyGracefully(options);
  }
  handle.destroy();
  return Promise.resolve({ forced: false });
}
