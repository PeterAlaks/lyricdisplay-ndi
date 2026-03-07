/**
 * IPC Server
 *
 * Lightweight TCP JSON-line protocol that the main LyricDisplay app
 * uses to control the companion (enable/disable outputs, update settings,
 * request stats, shutdown).
 *
 * Protocol: newline-delimited JSON.  Each message is a single JSON object
 * terminated by '\n'.  The companion replies with one or more JSON lines.
 */

import net from 'net';
import {
  enableOutput,
  disableOutput,
  updateOutputConfig,
  getOutputStats,
  isOutputEnabled,
  destroyOutputManager,
} from './outputManager.js';

let server = null;

export function startIpcServer(host, port) {
  server = net.createServer((socket) => {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);

        if (line) {
          handleMessage(line, socket);
        }

        idx = buffer.indexOf('\n');
      }
    });

    socket.on('error', () => { /* client disconnected */ });
  });

  server.listen(port, host, () => {
    console.log(`[IPC] Listening on ${host}:${port}`);
  });

  server.on('error', (err) => {
    console.error('[IPC] Server error:', err.message);
  });
}

export function stopIpcServer() {
  if (server) {
    try { server.close(); } catch { /* ignore */ }
    server = null;
  }
}

function reply(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch { /* socket may be gone */ }
}

function handleMessage(raw, socket) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    reply(socket, { type: 'error', payload: { message: 'invalid JSON' } });
    return;
  }

  const { type, payload, seq, output } = msg;

  switch (type) {
    case 'hello': {
      reply(socket, {
        type: 'hello',
        seq,
        payload: {
          companion: 'lyricdisplay-ndi',
          version: process.env.npm_package_version || '0.2.0',
          engine: 'electron-offscreen',
        },
      });
      break;
    }

    case 'set_outputs': {
      // payload.outputs = { output1: {...}, output2: {...}, stage: {...} }
      const outputs = payload?.outputs || {};
      for (const [key, config] of Object.entries(outputs)) {
        if (config?.enabled) {
          if (isOutputEnabled(key)) {
            updateOutputConfig(key, config);
          } else {
            enableOutput(key, config);
          }
        } else {
          disableOutput(key);
        }
      }
      reply(socket, { type: 'ack', seq, payload: { ok: true } });
      break;
    }

    case 'enable_output': {
      const key = output || payload?.outputKey;
      enableOutput(key, payload);
      reply(socket, { type: 'ack', seq, payload: { ok: true } });
      break;
    }

    case 'disable_output': {
      const key = output || payload?.outputKey;
      disableOutput(key);
      reply(socket, { type: 'ack', seq, payload: { ok: true } });
      break;
    }

    case 'update_output': {
      const key = output || payload?.outputKey;
      updateOutputConfig(key, payload);
      reply(socket, { type: 'ack', seq, payload: { ok: true } });
      break;
    }

    case 'request_stats': {
      const stats = getOutputStats();
      reply(socket, { type: 'stats', seq, payload: stats });
      break;
    }

    case 'shutdown': {
      reply(socket, { type: 'ack', seq, payload: { ok: true } });
      console.log('[IPC] Shutdown requested by main app');
      setTimeout(() => {
        destroyOutputManager();
        process.exit(0);
      }, 200);
      break;
    }

    default: {
      reply(socket, {
        type: 'error',
        seq,
        payload: { message: `unknown command: ${type}` },
      });
    }
  }
}
