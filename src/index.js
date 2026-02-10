/**
 * LyricDisplay NDI Companion - Entry Point
 * Orchestrates settings, headless browser rendering, frame capture, and NDI output.
 * 
 * Usage: node src/index.js --port 4000
 * 
 * Architecture:
 * - Reads NDI settings from electron-store's ndi-settings.json
 * - For each enabled output, launches a headless Chromium page at the output's URL
 * - The page renders identically to the real browser output (same HTML/CSS/JS)
 * - Output pages authenticate themselves (no admin key or join code needed)
 * - Captures frames via CDP screencast and sends them over NDI via grandiose
 */

import SettingsManager from './settings.js';
import BrowserManager from './browser.js';
import OutputCapture from './capture.js';
import NdiSender from './ndi.js';

// ============ Parse CLI Arguments ============

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    port: 4000,
    host: '127.0.0.1'
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
        parsed.port = parseInt(args[++i], 10) || 4000;
        break;
      case '--host':
        parsed.host = args[++i] || '127.0.0.1';
        break;
    }
  }

  return parsed;
}

// ============ State ============

const cliArgs = parseArgs();
const settings = new SettingsManager();
let browserManager = null;

// Per-output state: { capture, ndiSender, config }
const outputs = {};

// ============ Output Management ============

async function createOutput(outputKey, config) {
  const { width, height } = config;

  console.log(`[Main] Creating output "${outputKey}": ${config.sourceName} (${width}x${height} @ ${config.framerate}fps)`);

  // Create NDI sender
  const ndiSender = new NdiSender({
    sourceName: config.sourceName || `LyricDisplay ${outputKey}`,
    width,
    height,
    framerate: config.framerate || 30
  });

  const ndiInitialized = await ndiSender.initialize();
  if (!ndiInitialized) {
    console.error(`[Main] Failed to initialize NDI sender for ${outputKey}`);
    return null;
  }

  // Create headless browser page for this output
  try {
    await browserManager.createOutputPage(outputKey, width, height);
  } catch (error) {
    console.error(`[Main] Failed to create browser page for ${outputKey}:`, error.message);
    ndiSender.destroy();
    return null;
  }

  // Create frame capture
  const capture = new OutputCapture({
    outputKey,
    width,
    height,
    framerate: config.framerate || 30
  });

  // Start capturing frames from the browser page
  await capture.startScreencast(browserManager);

  // Start NDI sender - reads latest frame from capture
  ndiSender.startSending(() => capture.getLatestFrame());

  const output = {
    key: outputKey,
    capture,
    ndiSender,
    config: { ...config, width, height }
  };

  console.log(`[Main] Output "${outputKey}" active`);
  return output;
}

async function destroyOutput(outputKey) {
  const output = outputs[outputKey];
  if (!output) return;

  output.ndiSender.destroy();
  await output.capture.stop();
  await browserManager.destroyOutputPage(outputKey);

  delete outputs[outputKey];
  console.log(`[Main] Output "${outputKey}" destroyed`);
}

async function syncOutputs() {
  const enabledOutputs = settings.getEnabledOutputs();
  const enabledKeys = new Set(enabledOutputs.map(o => o.key));

  // Remove outputs that are no longer enabled
  for (const key of Object.keys(outputs)) {
    if (!enabledKeys.has(key)) {
      await destroyOutput(key);
    }
  }

  // Create or update enabled outputs
  for (const outputConfig of enabledOutputs) {
    const existing = outputs[outputConfig.key];

    if (existing) {
      const oldConfig = existing.config;
      let needsRecreate = false;

      // Check if resolution changed
      if (oldConfig.width !== outputConfig.width || oldConfig.height !== outputConfig.height) {
        needsRecreate = true;
      }

      // Check if framerate changed
      if (oldConfig.framerate !== outputConfig.framerate) {
        existing.ndiSender.setFramerate(outputConfig.framerate);
        existing.capture.setFramerate(outputConfig.framerate);
        existing.config.framerate = outputConfig.framerate;
      }

      // Check if source name changed
      if (oldConfig.sourceName !== outputConfig.sourceName) {
        await existing.ndiSender.setSourceName(outputConfig.sourceName);
        existing.config.sourceName = outputConfig.sourceName;
      }

      if (needsRecreate) {
        console.log(`[Main] Resolution changed for ${outputConfig.key}, recreating...`);
        await destroyOutput(outputConfig.key);
        const output = await createOutput(outputConfig.key, outputConfig);
        if (output) {
          outputs[outputConfig.key] = output;
        }
      }
    } else {
      const output = await createOutput(outputConfig.key, outputConfig);
      if (output) {
        outputs[outputConfig.key] = output;
      }
    }
  }
}

// ============ Settings Change Handler ============

async function onSettingsChanged(newSettings, oldSettings) {
  console.log('[Main] Settings changed, syncing outputs...');
  await syncOutputs();
}

// ============ Status Logging ============

function logStatus() {
  const outputCount = Object.keys(outputs).length;
  let totalFramesCaptured = 0;
  let totalFramesSent = 0;

  for (const output of Object.values(outputs)) {
    totalFramesCaptured += output.capture.getStats().frameCount;
    totalFramesSent += output.ndiSender.getStats().frameCount;
  }

  console.log(`[Status] Active outputs: ${outputCount} | Frames captured: ${totalFramesCaptured} | Frames sent: ${totalFramesSent}`);
}

// ============ Graceful Shutdown ============

let statusInterval = null;
let isShuttingDown = false;

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log('[Main] Shutting down...');

  if (statusInterval) {
    clearInterval(statusInterval);
  }

  for (const key of Object.keys(outputs)) {
    await destroyOutput(key);
  }

  if (browserManager) {
    await browserManager.destroy();
  }

  settings.destroy();

  console.log('[Main] Shutdown complete');
  process.exit(0);
}

// ============ Main ============

async function main() {
  console.log('===========================================');
  console.log('  LyricDisplay NDI Companion v1.0.0');
  console.log('===========================================');
  console.log(`  Backend: http://${cliArgs.host}:${cliArgs.port}`);
  console.log('');

  // Load settings
  settings.load();
  settings.startWatching();
  settings.on('changed', onSettingsChanged);

  // Launch headless browser
  browserManager = new BrowserManager({
    port: cliArgs.port,
    host: cliArgs.host
  });

  try {
    await browserManager.launch();
  } catch (error) {
    console.error('[Main] Failed to launch browser:', error.message);
    process.exit(1);
  }

  // Initialize outputs based on settings
  await syncOutputs();

  // Log status periodically
  statusInterval = setInterval(logStatus, 30000);

  // Handle shutdown signals
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (process.platform !== 'win32') {
    process.on('SIGHUP', shutdown);
  }

  process.on('uncaughtException', (error) => {
    console.error('[Main] Uncaught exception:', error);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Main] Unhandled rejection:', reason);
  });

  const enabledCount = settings.getEnabledOutputs().length;
  console.log(`[Main] Started with ${enabledCount} enabled output(s)`);
  if (enabledCount === 0) {
    console.log('[Main] No outputs enabled. Enable outputs in LyricDisplay NDI settings.');
    console.log('[Main] Watching for settings changes...');
  }
}

main().catch((error) => {
  console.error('[Main] Fatal error:', error);
  process.exit(1);
});
