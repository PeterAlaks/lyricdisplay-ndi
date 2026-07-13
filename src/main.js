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
import fs from 'fs';
import { parseArgs } from './cli.js';
import { startIpcServer, stopIpcServer } from './ipc.js';
import { initOutputManager, destroyOutputManager } from './outputManager.js';
import { initSettings } from './settings.js';
import {
  configureCompanionUserData,
  getDefaultCompanionUserDataDir,
  resolveCompanionUserDataDir,
} from './userData.js';

// Offscreen rendering requires disabling hardware acceleration.
app.disableHardwareAcceleration();

// Prevent the default Electron window from appearing.
app.on('window-all-closed', (e) => e.preventDefault?.());

const args = parseArgs(process.argv);
const requestedUserDataDir = resolveCompanionUserDataDir(
  args.userDataDir,
  process.env,
  getDefaultCompanionUserDataDir(app.getPath('appData'))
);
let userDataConfigurationError = null;

try {
  configureCompanionUserData({ app, fs, userDataDir: requestedUserDataDir });
} catch (error) {
  userDataConfigurationError = error;
  console.error('[Companion] Could not configure the managed user-data directory:', error.message);
}

const startCompanion = async () => {
  console.log('=============================================');
  console.log('  LyricDisplay NDI Companion v' + app.getVersion());
  console.log('=============================================');
  console.log(`  IPC : tcp://${args.host}:${args.port}`);
  console.log(`  App : ${args.appUrl}`);
  if (requestedUserDataDir) console.log(`  Data: ${requestedUserDataDir}`);
  console.log('');

  initSettings();
  initOutputManager(args.appUrl, { hashRouting: args.hashRouting });
  startIpcServer(args.host, args.port, { authToken: args.authToken });
};

if (userDataConfigurationError) {
  app.whenReady().then(() => app.exit(1));
} else {
  app.whenReady().then(startCompanion);
}

let shutdownPromise = null;
const shutdown = () => {
  if (shutdownPromise) return shutdownPromise;
  console.log('[Companion] Shutting down…');
  stopIpcServer();
  shutdownPromise = Promise.resolve(destroyOutputManager()).finally(() => app.quit());
  return shutdownPromise;
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
