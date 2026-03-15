/**
 * NDI Sender – wraps the `grandi` native module.
 *
 * Each sender represents one NDI source on the network.
 * Frames are submitted as raw BGRA buffers from the offscreen paint event.
 */

let grandi = null;

try {
  const mod = await import('grandi');
  grandi = mod.default || mod;
} catch (err) {
  console.error('[NdiSender] Failed to load grandi:', err.message);
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
export function createNdiSender(name, width, height, framerate) {
  if (!grandi) {
    console.warn(`[NdiSender] grandi not available – "${name}" will not broadcast.`);
    return null;
  }

  const FOURCC_BGRA = grandi.FOURCC_BGRA ?? grandi.FourCC?.BGRA;
  const FORMAT_PROGRESSIVE = grandi.FORMAT_TYPE_PROGRESSIVE ?? grandi.FrameType?.Progressive ?? 1;

  if (FOURCC_BGRA == null) {
    console.error('[NdiSender] Could not resolve FOURCC_BGRA from grandi – NDI output unavailable.');
    return null;
  }

  /** @type {NdiSenderHandle} */
  const handle = {
    sender: null,
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
      if (!handle.ready || !handle.sender || handle.closing) return;
      if (handle.sending) return;

      handle.sending = true;
      handle.inflight += 1;

      const sendPromise = handle.sender.video({
        xres: w,
        yres: h,
        frameRateN: framerate,
        frameRateD: 1,
        pictureAspectRatio: w / h,
        fourCC: FOURCC_BGRA,
        frameFormatType: FORMAT_PROGRESSIVE,
        lineStrideBytes: w * 4,
        data: bgraBuffer,
      });

      Promise.resolve(sendPromise)
        .catch((err) => {
          console.error(`[NdiSender] video() error on "${name}":`, err.message);
        })
        .finally(() => {
          handle.sending = false;
          handle.inflight = Math.max(0, handle.inflight - 1);
        });
    },

    destroy() {
      if (handle.closed) return;
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
          if (!handle.sender || handle.inflight === 0) {
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
  };

  grandi.send({ name, clockVideo: true, clockAudio: false })
    .then((sender) => {
      handle.sender = sender;
      handle.ready = true;
      const srcName = typeof sender.sourcename === 'function' ? sender.sourcename() : name;
      console.log(`[NdiSender] Sender ready: "${srcName}" (${width}x${height} @ ${framerate}fps)`);
    })
    .catch((err) => {
      console.error(`[NdiSender] Failed to create sender "${name}":`, err.message);
    });

  return handle;
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