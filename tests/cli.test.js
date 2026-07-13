import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs } from '../src/cli.js';
import {
  COMPANION_USER_DATA_ENV,
  configureCompanionUserData,
  getDefaultCompanionUserDataDir,
  resolveCompanionUserDataDir,
} from '../src/userData.js';

test('parses managed user-data paths in both Electron argument forms', () => {
  assert.equal(parseArgs(['electron', '.', '--user-data-dir', 'C:/managed/data']).userDataDir, 'C:/managed/data');
  assert.equal(parseArgs(['companion', '--user-data-dir=C:/managed/data']).userDataDir, 'C:/managed/data');
});

test('uses the managed environment path when Electron omits its command-line switch', () => {
  const requestedPath = path.join(os.tmpdir(), 'lyricdisplay-managed-ndi-data');
  assert.equal(
    resolveCompanionUserDataDir('', { [COMPANION_USER_DATA_ENV]: requestedPath }),
    path.resolve(requestedPath)
  );
});

test('defaults standalone launches to the main LyricDisplay NDI user-data directory', () => {
  const appDataPath = path.join(os.tmpdir(), 'lyricdisplay-app-data');
  const managedPath = getDefaultCompanionUserDataDir(appDataPath);

  assert.equal(managedPath, path.join(appDataPath, 'LyricDisplay', 'NDI', 'User Data'));
  assert.equal(resolveCompanionUserDataDir('', {}, managedPath), path.resolve(managedPath));
});

test('configures both persistent and Chromium session data before startup', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyricdisplay-ndi-user-data-'));
  const configuredPaths = new Map();
  const app = { setPath: (name, value) => configuredPaths.set(name, value) };

  try {
    assert.equal(configureCompanionUserData({ app, fs, userDataDir }), userDataDir);
    assert.equal(configuredPaths.get('userData'), userDataDir);
    assert.equal(configuredPaths.get('sessionData'), userDataDir);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
