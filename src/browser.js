/**
 * LyricDisplay NDI Companion - Browser Manager
 * Manages headless Chromium via Puppeteer to render output pages identically to the real outputs.
 * Each enabled NDI output gets its own headless page at the correct viewport resolution.
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
    this.frontendUrl = options.frontendUrl || null; // If set, use this instead of host:port for page URLs
    this.browser = null;
    this.pages = new Map(); // outputKey -> { page, width, height, route }
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
    // Wait for backend
    const backendReady = await this._waitForBackend();
    if (!backendReady) {
      throw new Error('Backend is not available');
    }

    // Launch Puppeteer
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
      ]
    });

    console.log('[Browser] Headless browser launched');
  }

  /**
   * Create a page for a specific output at the given resolution.
   * The page loads the same output URL the real Electron output windows use.
   * Authentication happens automatically — output client types (output1, output2, stage)
   * get tokens from the server without needing an admin key or join code.
   * 
   * @param {string} outputKey - 'output1', 'output2', or 'stage'
   * @param {number} width - Viewport width
   * @param {number} height - Viewport height
   * @returns {Object} Page handle with capture capabilities
   */
  async createOutputPage(outputKey, width, height) {
    if (!this.browser) {
      throw new Error('Browser not launched');
    }

    // Close existing page for this output if any
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

    // Set viewport to the NDI output resolution
    await page.setViewport({ width, height, deviceScaleFactor: 1 });

    // Navigate to the output page
    // In dev mode (frontendUrl provided): http://localhost:5173/output1 (Vite dev server, path routing)
    // In production: http://127.0.0.1:4000/#/output1 (Express serves built app, hash routing)
    let outputUrl;
    if (this.frontendUrl) {
      // Dev mode: Vite uses path-based routing
      outputUrl = `${this.frontendUrl.replace(/\/$/, '')}${route}`;
    } else {
      // Production: Express serves the built app with hash routing
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

    this.pages.set(outputKey, { page, width, height, route });

    console.log(`[Browser] Page ready for ${outputKey}`);
    return { page, width, height };
  }

  /**
   * Capture a screenshot from an output page as a PNG buffer
   * @param {string} outputKey - The output to capture
   * @returns {Buffer|null} PNG buffer or null if page doesn't exist
   */
  async captureFrame(outputKey) {
    const entry = this.pages.get(outputKey);
    if (!entry || !entry.page) return null;

    try {
      const screenshotBuffer = await entry.page.screenshot({
        type: 'png',
        omitBackground: true,
        encoding: 'binary'
      });

      return screenshotBuffer;
    } catch (error) {
      if (!error.message.includes('Target closed') && !error.message.includes('Session closed')) {
        console.error(`[Browser] Frame capture error for ${outputKey}:`, error.message);
      }
      return null;
    }
  }

  /**
   * Set up CDP-based screencast for efficient continuous frame capture.
   * Screencast delivers frames as they are painted — more efficient than polling screenshots.
   * 
   * @param {string} outputKey - The output to capture
   * @param {number} maxFps - Maximum frames per second
   * @param {Function} onFrame - Callback receiving (pngBuffer, metadata) for each frame
   * @returns {Function} Stop function to end the screencast
   */
  async startScreencast(outputKey, maxFps, onFrame) {
    const entry = this.pages.get(outputKey);
    if (!entry || !entry.page) {
      throw new Error(`No page for output: ${outputKey}`);
    }

    const cdpSession = await entry.page.createCDPSession();

    cdpSession.on('Page.screencastFrame', async (params) => {
      try {
        // Acknowledge the frame to keep receiving
        await cdpSession.send('Page.screencastFrameAck', {
          sessionId: params.sessionId
        });

        // params.data is a base64-encoded image
        const imageBuffer = Buffer.from(params.data, 'base64');
        onFrame(imageBuffer, params.metadata);
      } catch (error) {
        if (!error.message.includes('Session closed') && !error.message.includes('Target closed')) {
          console.error(`[Browser] Screencast frame error for ${outputKey}:`, error.message);
        }
      }
    });

    await cdpSession.send('Page.startScreencast', {
      format: 'png',
      quality: 100,
      maxWidth: entry.width,
      maxHeight: entry.height,
      everyNthFrame: 1
    });

    console.log(`[Browser] Screencast started for ${outputKey} (max ${maxFps}fps)`);

    // Return a stop function
    return async () => {
      try {
        await cdpSession.send('Page.stopScreencast');
        await cdpSession.detach();
        console.log(`[Browser] Screencast stopped for ${outputKey}`);
      } catch {
        // Session may already be closed
      }
    };
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
   * Destroy a specific output page
   */
  async destroyOutputPage(outputKey) {
    const entry = this.pages.get(outputKey);
    if (!entry) return;

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
