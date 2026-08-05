import assert from 'node:assert/strict';
import { app, BrowserWindow } from 'electron';

const WIDTH = 1920;
const HEIGHT = 1080;
const TIMEOUT_MS = 10_000;

app.disableHardwareAcceleration();

let finished = false;
let timeout = null;

function finish(error = null) {
  if (finished) return;
  finished = true;
  if (timeout) clearTimeout(timeout);

  if (error) {
    console.error(error);
    app.exit(1);
  } else {
    console.log(`Offscreen frame size: ${WIDTH}x${HEIGHT}`);
    app.exit(0);
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: {
      offscreen: {
        useSharedTexture: false,
        deviceScaleFactor: 1,
      },
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setContentSize(WIDTH, HEIGHT);
  win.webContents.setFrameRate(30);
  win.webContents.on('paint', (_event, _dirty, image) => {
    try {
      const size = image.getSize();
      if (size.width === 0 || size.height === 0) return;
      assert.deepEqual(size, { width: WIDTH, height: HEIGHT });
      finish();
    } catch (error) {
      finish(error);
    }
  });

  timeout = setTimeout(() => finish(new Error('Timed out waiting for an offscreen paint frame')), TIMEOUT_MS);

  try {
    await win.loadURL('data:text/html,<style>html,body{margin:0;background:transparent}</style>NDI');
    win.webContents.invalidate();
  } catch (error) {
    finish(error);
  }
}).catch(finish);
