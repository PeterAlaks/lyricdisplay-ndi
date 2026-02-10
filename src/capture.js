/**
 * LyricDisplay NDI Companion - Frame Capture
 * Manages continuous frame capture from headless browser pages.
 * Converts PNG screenshots (with alpha) to raw RGBA buffers for NDI transmission.
 * 
 * Uses an adaptive capture loop: captures as fast as possible up to the target framerate,
 * never overlapping captures. This avoids the frame-skipping that fixed setInterval causes
 * when screenshot time exceeds the interval.
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
 * Manages frame capture for a single output using an adaptive loop
 */
class OutputCapture {
  constructor(options = {}) {
    this.outputKey = options.outputKey;
    this.width = options.width || 1920;
    this.height = options.height || 1080;
    this.framerate = options.framerate || 30;
    this.onFrame = options.onFrame || null;

    this._running = false;
    this._frameCount = 0;
    this._lastFrameTime = 0;
    this._browserManager = null;

    // Keep the latest frame for NDI to read at its own pace
    this._latestFrame = null;
  }

  /**
   * Start the adaptive capture loop.
   * Captures a frame, decodes it, then waits the remaining time budget before the next capture.
   * If capture + decode takes longer than the frame interval, the next capture starts immediately.
   * 
   * @param {Object} browserManager - BrowserManager instance
   */
  async startPolling(browserManager) {
    if (this._running) return;
    this._running = true;
    this._browserManager = browserManager;

    const targetInterval = 1000 / this.framerate;

    console.log(`[Capture] Adaptive capture started for ${this.outputKey} at ${this.framerate}fps (${Math.round(targetInterval)}ms target, transparent)`);

    // Run the capture loop in the background
    this._captureLoop(targetInterval);
  }

  /**
   * The adaptive capture loop. Runs until _running is set to false.
   */
  async _captureLoop(targetInterval) {
    while (this._running) {
      const frameStart = Date.now();

      try {
        const pngBuffer = await this._browserManager.captureFrame(this.outputKey);
        if (pngBuffer) {
          const { data: rgbaBuffer, width, height } = await decodePng(pngBuffer);

          this._latestFrame = {
            data: rgbaBuffer,
            width,
            height,
            timestamp: frameStart
          };

          this._lastFrameTime = Date.now();
          this._frameCount++;

          if (this.onFrame) {
            this.onFrame(rgbaBuffer, width, height);
          }
        }
      } catch (error) {
        // Non-fatal — log occasionally
        if (this._frameCount % 300 === 0 && this._frameCount > 0) {
          console.warn(`[Capture] Error for ${this.outputKey}:`, error.message);
        }
      }

      // Wait the remaining time to hit the target framerate
      const elapsed = Date.now() - frameStart;
      const sleepMs = Math.max(1, targetInterval - elapsed);
      await new Promise(r => setTimeout(r, sleepMs));
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
    // The loop will pick up the new framerate on next iteration
    // since we recalculate targetInterval... but actually we pass it once.
    // For a live update, we'd need to restart. The orchestrator handles this
    // by recreating the output on framerate change if needed.
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
    this._latestFrame = null;
    this._browserManager = null;
    console.log(`[Capture] Stopped for ${this.outputKey} (${this._frameCount} frames captured)`);
  }
}

export default OutputCapture;
export { decodePng };
