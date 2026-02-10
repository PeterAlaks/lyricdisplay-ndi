/**
 * LyricDisplay NDI Companion - Frame Capture
 * Manages continuous frame capture from headless browser pages.
 * Converts PNG screenshots (with alpha) to raw RGBA buffers for NDI transmission.
 * 
 * Uses polling page.screenshot({ omitBackground: true }) to preserve transparency.
 * CDP screencast does NOT support alpha channels, so we poll instead.
 */

import { PNG } from 'pngjs';

/**
 * Decode a PNG buffer to raw RGBA pixel data
 * @param {Buffer} pngBuffer - PNG image data (may include alpha channel)
 * @returns {Promise<{data: Buffer, width: number, height: number}>}
 */
function decodePng(pngBuffer) {
  return new Promise((resolve, reject) => {
    const png = new PNG();
    png.parse(pngBuffer, (error, data) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        data: Buffer.from(data.data),
        width: data.width,
        height: data.height
      });
    });
  });
}

/**
 * Manages frame capture for a single output via polling screenshots
 */
class OutputCapture {
  constructor(options = {}) {
    this.outputKey = options.outputKey;
    this.width = options.width || 1920;
    this.height = options.height || 1080;
    this.framerate = options.framerate || 30;
    this.onFrame = options.onFrame || null;

    this._pollInterval = null;
    this._running = false;
    this._capturing = false; // guard against overlapping captures
    this._frameCount = 0;
    this._lastFrameTime = 0;

    // Keep the latest frame for NDI to read at its own pace
    this._latestFrame = null;
  }

  /**
   * Start capturing frames by polling screenshots from the browser page.
   * Each screenshot uses omitBackground: true to preserve transparency.
   * 
   * @param {Object} browserManager - BrowserManager instance
   */
  async startPolling(browserManager) {
    if (this._running) return;
    this._running = true;

    const intervalMs = Math.round(1000 / this.framerate);

    this._pollInterval = setInterval(async () => {
      if (!this._running || this._capturing) return;

      this._capturing = true;
      try {
        const pngBuffer = await browserManager.captureFrame(this.outputKey);
        if (pngBuffer) {
          await this._processFrame(pngBuffer);
        }
      } catch (error) {
        // Silently handle capture errors during polling
      } finally {
        this._capturing = false;
      }
    }, intervalMs);

    console.log(`[Capture] Polling capture started for ${this.outputKey} at ${this.framerate}fps (${intervalMs}ms interval, transparent)`);
  }

  /**
   * Process a captured PNG frame into RGBA and deliver it
   */
  async _processFrame(pngBuffer) {
    try {
      const { data: rgbaBuffer, width, height } = await decodePng(pngBuffer);
      const now = Date.now();

      this._latestFrame = {
        data: rgbaBuffer,
        width,
        height,
        timestamp: now
      };

      this._lastFrameTime = now;
      this._frameCount++;

      if (this.onFrame) {
        this.onFrame(rgbaBuffer, width, height);
      }
    } catch (error) {
      // PNG decode errors are non-fatal
      if (this._frameCount % 100 === 0) {
        console.warn(`[Capture] PNG decode error for ${this.outputKey}:`, error.message);
      }
    }
  }

  /**
   * Get the latest captured frame (for NDI sender to read)
   * @returns {{ data: Buffer, width: number, height: number } | null}
   */
  getLatestFrame() {
    return this._latestFrame;
  }

  /**
   * Update framerate (restarts polling if running)
   */
  setFramerate(fps) {
    this.framerate = fps;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      outputKey: this.outputKey,
      frameCount: this._frameCount,
      running: this._running,
      hasFrame: this._latestFrame !== null,
      lastFrameAge: this._lastFrameTime ? Date.now() - this._lastFrameTime : null
    };
  }

  /**
   * Stop capturing
   */
  async stop() {
    this._running = false;

    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }

    this._latestFrame = null;
    console.log(`[Capture] Stopped for ${this.outputKey} (${this._frameCount} frames captured)`);
  }
}

export default OutputCapture;
export { decodePng };
