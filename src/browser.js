/**
 * LyricDisplay NDI Companion - Browser Manager
 * Manages headless Chromium via Puppeteer to render output pages identically to the real outputs.
 * Each enabled NDI output gets its own headless page at the correct viewport resolution.
 * 
 * Uses a persistent CDP session with Page.captureScreenshot for fast transparent frame capture.
 * The default background is set to transparent via Emulation.setDefaultBackgroundColorOverride.
 * 
 * The output pages (output1, output2, stage) authenticate themselves automatically —
 * they don't need an admin key or join code. The server issues tokens freely to output client types.
 */

import puppeteer from 'puppeteer';
import http from 'http';

class BrowserManager {
  constructor(options = {}) {
    this.port = options.port || 4000;
    this.host = options.host || '127.0.0.1';
    this.frontendUrl = options.frontendUrl || null;
    this.browser = null;
    this.pages = new Map(); // outputKey -> { page, cdpSession, width, height, route }
  }

  /**
   * Wait for the backend to be ready
   */
  async _waitForBackend(maxAttempts = 30, intervalMs = 2000) {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const response = await new Promise((resolve, reject) => {
          const req = http.get(`http://${this.host}:${this.port}/api/health`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, data }));
          });
          req.on('error', reject);
          req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
        });

        if (response.status === 200) {
          console.log(`[Browser] Backend is ready (attempt ${i + 1})`);
          return true;
        }
      } catch {
        // Backend not ready yet
      }

      if (i < maxAttempts - 1) {
        await new Promise(r => setTimeout(r, intervalMs));
      }
    }

    console.error('[Browser] Backend did not become ready');
    return false;
  }

  /**
   * Launch the headless browser
   */
  async launch() {
    const backendReady = await this._waitForBackend();
    if (!backendReady) {
      throw new Error('Backend is not available');
    }

    console.log('[Browser] Launching headless browser...');
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--mute-audio',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--high-dpi-support=1',
      ]
    });

    console.log('[Browser] Headless browser launched');
  }

  /**
   * Create a page for a specific output at the given resolution.
   * Sets the default background to transparent and creates a persistent CDP session
   * for fast frame capture.
   */
  async createOutputPage(outputKey, width, height) {
    if (!this.browser) {
      throw new Error('Browser not launched');
    }

    await this.destroyOutputPage(outputKey);

    const routeMap = {
      output1: '/output1',
      output2: '/output2',
      stage: '/stage'
    };

    const route = routeMap[outputKey];
    if (!route) {
      throw new Error(`Unknown output key: ${outputKey}`);
    }

    console.log(`[Browser] Creating page for ${outputKey} at ${width}x${height}...`);

    const page = await this.browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // Create a persistent CDP session for this page.
    // Reusing the same session avoids the overhead of creating one per screenshot.
    const cdpSession = await page.createCDPSession();

    // Set the default background color to transparent.
    // This makes Page.captureScreenshot produce PNGs with alpha where the page has no background.
    await cdpSession.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 }
    });

    // Build the output URL
    let outputUrl;
    if (this.frontendUrl) {
      outputUrl = `${this.frontendUrl.replace(/\/$/, '')}${route}`;
    } else {
      const baseUrl = `http://${this.host}:${this.port}`;
      outputUrl = `${baseUrl}/#${route}`;
    }
    console.log(`[Browser] Navigating to ${outputUrl}`);

    await page.goto(outputUrl, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    // Wait for React to hydrate and socket to connect
    await new Promise(r => setTimeout(r, 3000));

    this.pages.set(outputKey, { page, cdpSession, width, height, route });

    console.log(`[Browser] Page ready for ${outputKey}`);
    return { page, width, height };
  }

  /**
   * Capture a frame using the persistent CDP session.
   * Uses Page.captureScreenshot with optimizeForSpeed for minimal latency.
   * Returns a raw PNG Buffer with alpha channel.
   * 
   * @param {string} outputKey - The output to capture
   * @returns {Buffer|null} PNG buffer (with alpha) or null
   */
  async captureFrame(outputKey) {
    const entry = this.pages.get(outputKey);
    if (!entry || !entry.cdpSession) return null;

    try {
      const result = await entry.cdpSession.send('Page.captureScreenshot', {
        format: 'png',
        optimizeForSpeed: true
      });

      return Buffer.from(result.data, 'base64');
    } catch (error) {
      if (!error.message.includes('Target closed') &&
          !error.message.includes('Session closed') &&
          !error.message.includes('detached')) {
        console.error(`[Browser] Frame capture error for ${outputKey}:`, error.message);
      }
      return null;
    }
  }

  /**
   * Update viewport size for an output page
   */
  async updateViewport(outputKey, width, height) {
    const entry = this.pages.get(outputKey);
    if (!entry || !entry.page) return;

    await entry.page.setViewport({ width, height, deviceScaleFactor: 1 });
    entry.width = width;
    entry.height = height;
    console.log(`[Browser] Updated viewport for ${outputKey}: ${width}x${height}`);
  }

  /**
   * Destroy a specific output page and its CDP session
   */
  async destroyOutputPage(outputKey) {
    const entry = this.pages.get(outputKey);
    if (!entry) return;

    try {
      if (entry.cdpSession) {
        await entry.cdpSession.detach();
      }
    } catch {
      // Session may already be closed
    }

    try {
      if (entry.page && !entry.page.isClosed()) {
        await entry.page.close();
      }
    } catch (error) {
      console.warn(`[Browser] Error closing page for ${outputKey}:`, error.message);
    }

    this.pages.delete(outputKey);
    console.log(`[Browser] Page destroyed for ${outputKey}`);
  }

  /**
   * Shut down the browser and all pages
   */
  async destroy() {
    for (const outputKey of [...this.pages.keys()]) {
      await this.destroyOutputPage(outputKey);
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch (error) {
        console.warn('[Browser] Error closing browser:', error.message);
      }
      this.browser = null;
    }

    console.log('[Browser] Browser manager destroyed');
  }
}

export default BrowserManager;
