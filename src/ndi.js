/**
 * LyricDisplay NDI Companion - NDI Sender Wrapper
 * Wraps the grandi NDI SDK to send video frames.
 * Reads the latest frame from the capture pipeline and sends it at the configured framerate.
 * 
 * Uses grandi (https://github.com/tux-tn/grandi) which ships prebuilt binaries
 * for all platforms — no native compilation or NDI SDK install required.
 */

import grandi, { FourCC, FrameType } from 'grandi';

// Initialize NDI library once at module load
let ndiInitialized = false;
try {
  ndiInitialized = grandi.initialize();
  if (ndiInitialized) {
    console.log(`[NDI] Library initialized (${grandi.version()})`);
  } else {
    console.error('[NDI] Failed to initialize NDI library');
  }
} catch (error) {
  console.error('[NDI] Failed to initialize NDI library:', error.message);
}

class NdiSender {
  constructor(options = {}) {
    this.sourceName = options.sourceName || 'LyricDisplay';
    this.sender = null;
    this.width = options.width || 1920;
    this.height = options.height || 1080;
    this.framerate = options.framerate || 30;
    this.frameInterval = null;
    this.frameCount = 0;
    this.isRunning = false;
    this.getFrameFn = null;
  }

  /**
   * Initialize the NDI sender
   */
  async initialize() {
    if (!ndiInitialized) {
      console.error('[NDI] NDI library not initialized — NDI output disabled');
      return false;
    }

    try {
      this.sender = await grandi.send({
        name: this.sourceName,
        clockVideo: true,
        clockAudio: false
      });

      console.log(`[NDI] Sender initialized: "${this.sourceName}" (${this.width}x${this.height} @ ${this.framerate}fps)`);
      return true;
    } catch (error) {
      console.error('[NDI] Failed to initialize sender:', error.message);
      return false;
    }
  }

  /**
   * Start sending frames at the configured framerate.
   * @param {Function} getFrame - Function that returns { data: Buffer, width: number, height: number } or null
   */
  startSending(getFrame) {
    if (this.isRunning) {
      console.warn('[NDI] Already sending');
      return;
    }

    if (!this.sender) {
      console.error('[NDI] Sender not initialized');
      return;
    }

    this.isRunning = true;
    this.getFrameFn = getFrame;
    const intervalMs = Math.round(1000 / this.framerate);

    console.log(`[NDI] Starting frame output at ${this.framerate}fps (${intervalMs}ms interval)`);

    this.frameInterval = setInterval(() => {
      this._sendFrame();
    }, intervalMs);
  }

  /**
   * Send a single frame
   */
  _sendFrame() {
    if (!this.sender || !this.getFrameFn) return;

    try {
      const frame = this.getFrameFn();
      if (!frame || !frame.data) return;

      const rgbaBuffer = frame.data;
      const frameWidth = frame.width || this.width;
      const frameHeight = frame.height || this.height;

      // Create NDI video frame using grandi's typed interface
      const ndiFrame = {
        xres: frameWidth,
        yres: frameHeight,
        fourCC: FourCC.RGBA,
        frameRateN: this.framerate * 1000,
        frameRateD: 1000,
        frameFormatType: FrameType.Progressive,
        pictureAspectRatio: frameWidth / frameHeight,
        lineStrideBytes: frameWidth * 4,
        data: rgbaBuffer
      };

      // sender.video() is async but we fire-and-forget for throughput
      // clockVideo: true handles timing on the NDI side
      this.sender.video(ndiFrame).catch((err) => {
        if (this.frameCount % 300 === 0) {
          console.error('[NDI] Frame send error:', err.message);
        }
      });

      this.frameCount++;
    } catch (error) {
      if (this.frameCount % 300 === 0) {
        console.error('[NDI] Frame send error:', error.message);
      }
    }
  }

  /**
   * Stop sending frames
   */
  stopSending() {
    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = null;
    }
    this.isRunning = false;
    console.log(`[NDI] Stopped sending (${this.frameCount} frames sent)`);
  }

  /**
   * Update the source name (requires re-initialization)
   */
  async setSourceName(name) {
    if (name === this.sourceName) return;

    const wasRunning = this.isRunning;
    const getFrame = this.getFrameFn;

    this.stopSending();
    this._destroySender();

    this.sourceName = name;
    await this.initialize();

    if (wasRunning && getFrame) {
      this.startSending(getFrame);
    }
  }

  /**
   * Update resolution
   */
  setResolution(width, height) {
    this.width = width;
    this.height = height;
  }

  /**
   * Update framerate
   */
  setFramerate(fps) {
    if (fps === this.framerate) return;

    this.framerate = fps;

    if (this.isRunning) {
      const getFrame = this.getFrameFn;
      this.stopSending();
      this.startSending(getFrame);
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      sourceName: this.sourceName,
      width: this.width,
      height: this.height,
      framerate: this.framerate,
      frameCount: this.frameCount,
      isRunning: this.isRunning
    };
  }

  /**
   * Destroy just the sender (internal)
   */
  _destroySender() {
    if (this.sender) {
      try {
        this.sender.destroy();
      } catch (error) {
        console.warn('[NDI] Error destroying sender:', error.message);
      }
      this.sender = null;
    }
  }

  /**
   * Clean up the NDI sender
   */
  destroy() {
    this.stopSending();
    this._destroySender();
    this.frameCount = 0;
    console.log(`[NDI] Sender "${this.sourceName}" destroyed`);
  }
}

export default NdiSender;
