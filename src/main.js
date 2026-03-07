/**
 * LyricDisplay NDI™ Companion – main process
 *
 * Headless Electron application that:
 *  1. Listens for TCP commands from the main LyricDisplay app.
 *  2. Manages offscreen BrowserWindows that load the output pages
 *     served by the main app's backend.
 *  3. Captures rendered frames via Chromium's offscreen paint event.
 *  4. Pushes BGRA frames to NDI using the `grandi` native module.
 *
 * NDI® is a registered trademark of Vizrt NDI AB. https://ndi.video
 */

import { app } from 'electron';
import { parseArgs } from './cli.js';
import { startIpcServer, stopIpcServer } from './ipc.js';
import { initOutputManager, destroyOutputManager } from './outputManager.js';
import { initSettings } from './settings.js';

// Offscreen rendering requires disabling hardware acceleration.
app.disableHardwareAcceleration();

// Prevent the default Electron window from appearing.
app.on('window-all-closed', (e) => e.preventDefault?.());

const args = parseArgs(process.argv);

app.whenReady().then(async () => {
  console.log('=============================================');
  console.log('  LyricDisplay NDI Companion v' + app.getVersion());
  console.log('=============================================');
  console.log(`  IPC : tcp://${args.host}:${args.port}`);
  console.log(`  App : ${args.appUrl}`);
  console.log('');

  initSettings();
  initOutputManager(args.appUrl, { hashRouting: args.hashRouting });
  startIpcServer(args.host, args.port);
});

const shutdown = () => {
  console.log('[Companion] Shutting down…');
  stopIpcServer();
  destroyOutputManager();
  app.quit();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
