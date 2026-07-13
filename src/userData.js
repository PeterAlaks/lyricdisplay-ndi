import path from 'path';

export const COMPANION_USER_DATA_ENV = 'LYRICDISPLAY_NDI_USER_DATA_DIR';

export function getDefaultCompanionUserDataDir(appDataDir) {
  const normalizedAppDataDir = String(appDataDir || '').trim();
  if (!normalizedAppDataDir) {
    throw new Error('Electron app-data path is unavailable');
  }
  return path.join(normalizedAppDataDir, 'LyricDisplay', 'NDI', 'User Data');
}

export function resolveCompanionUserDataDir(cliValue, env = process.env, defaultPath = '') {
  const requestedPath = String(
    cliValue || env?.[COMPANION_USER_DATA_ENV] || defaultPath || ''
  ).trim();
  return requestedPath ? path.resolve(requestedPath) : '';
}

export function configureCompanionUserData({ app, fs, userDataDir }) {
  if (!userDataDir) return null;

  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
  app.setPath('sessionData', userDataDir);
  return userDataDir;
}
