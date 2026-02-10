/**
 * LyricDisplay NDI Companion - Frame Capture
 * Manages continuous frame capture from headless browser pages.
 * Converts PNG screenshots to raw RGBA buffers for NDI transmission.
 * 
 * Uses CDP screencast as primary method (efficient, event-driven).
 * Falls back to polling screenshot if screencast is unavailable.
 */

import { PNG } from 'pngjs';

/**
 * Decode a PNG buffer to raw RGBA pixel data
 * @param {Buffer} pngBuffer - PNG image data
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
 * Manages frame capture for a single output
 */
class OutputCapture {
  constructor(options = {}) {
    this.outputKey = options.outputKey;
    this.width = options.width || 1920;
    this.height = options.height || 1080;
    this.framerate = options.framerate || 30;
    this.onFrame = options.onFrame || null; // callback(rgbaBuffer, width, height)

    this._stopScreencast = null;
    this._pollInterval = null;
    this._running = false;
    this._frameCount = 0;
    this._lastFrameTime = 0;
    this._minFrameInterval = 1000 / this.framerate;

    // Keep the latest frame for NDI to read at its own pace
    this._latestFrame = null;
  }

  /**
   * Start capturing frames using CDP screencast
   * @param {Object} browserManager - BrowserManager instance
   */
  async startScreencast(browserManager) {
    if (this._running) return;
    this._running = true;

    try {
      this._stopScreencast = await browserManager.startScreencast(
        this.outputKey,
        this.framerate,
        async (pngBuffer, metadata) => {
          await this._processFrame(pngBuffer);
        }
      );

      console.log(`[Capture] Screencast capture started for ${this.outputKey}`);
    } catch (error) {
      console.warn(`[Capture] Screencast failed for ${this.outputKey}, falling back to polling:`, error.message);
      this._startPolling(browserManager);
    }
  }

  /**
   * Fallback: poll screenshots at the configured framerate
   */
  _startPolling(browserManager) {
    const intervalMs = Math.round(1000 / this.framerate);

    this._pollInterval = setInterval(async () => {
      if (!this._running) return;

      try {
        const pngBuffer = await browserManager.captureFrame(this.outputKey);
        if (pngBuffer) {
          await this._processFrame(pngBuffer);
        }
      } catch (error) {
        // Silently handle capture errors during polling
      }
    }, intervalMs);

    console.log(`[Capture] Polling capture started for ${this.outputKey} at ${this.framerate}fps`);
  }

  /**
   * Process a captured PNG frame into RGBA and deliver it
   */
  async _processFrame(pngBuffer) {
    // Rate limit
    const now = Date.now();
    if (now - this._lastFrameTime < this._minFrameInterval * 0.8) {
      return; // Skip frame if too soon
    }

    try {
      const { data: rgbaBuffer, width, height } = await decodePng(pngBuffer);

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
   * Update framerate
   */
  setFramerate(fps) {
    this.framerate = fps;
    this._minFrameInterval = 1000 / fps;

    // If polling, restart with new interval
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      // We'd need the browserManager reference to restart polling
      // This is handled by the orchestrator restarting the capture
    }
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

    if (this._stopScreencast) {
      try {
        await this._stopScreencast();
      } catch {
        // Already stopped
      }
      this._stopScreencast = null;
    }

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
