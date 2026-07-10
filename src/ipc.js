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
import { app } from 'electron';
import {
  IPC_PROTOCOL_VERSION,
  MAX_IPC_MESSAGE_BYTES,
  authTokensMatch,
  isValidIpcMessage,
} from './ipcProtocol.js';
import {
  enableOutput,
  disableOutput,
  updateOutputConfig,
  getOutputStats,
  isOutputEnabled,
  destroyOutputManager,
} from './outputManager.js';

let server = null;
let requiredAuthToken = '';
const clients = new Set();

export function startIpcServer(host, port, options = {}) {
  if (server) throw new Error('IPC server is already running');
  requiredAuthToken = String(options.authToken || '');
  server = net.createServer((socket) => {
    let buffer = '';
    clients.add(socket);
    socket.setNoDelay(true);
    socket.setTimeout(60_000, () => socket.destroy());

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > MAX_IPC_MESSAGE_BYTES) {
        reply(socket, { type: 'error', payload: { message: 'message too large' } });
        socket.end();
        return;
      }

      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);

        if (line) {
          handleMessage(line, socket).catch((error) => {
            let seq = null;
            try { seq = JSON.parse(line)?.seq ?? null; } catch { /* ignore */ }
            reply(socket, {
              type: 'error',
              seq,
              payload: { message: error?.message || 'Command failed' },
            });
          });
        }

        idx = buffer.indexOf('\n');
      }
    });

    socket.on('error', () => { /* client disconnected */ });
    socket.on('close', () => clients.delete(socket));
  });

  server.listen(port, host, () => {
    console.log(`[IPC] Listening on ${host}:${port}`);
  });

  server.on('error', (err) => {
    console.error('[IPC] Server error:', err.message);
  });
}

export function stopIpcServer() {
  for (const socket of clients) {
    try { socket.destroy(); } catch { /* ignore */ }
  }
  clients.clear();
  if (server) {
    try { server.close(); } catch { /* ignore */ }
    server = null;
  }
  requiredAuthToken = '';
}

function reply(socket, obj) {
  try {
    socket.write(JSON.stringify(obj) + '\n');
  } catch { /* socket may be gone */ }
}

async function handleMessage(raw, socket) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    reply(socket, { type: 'error', payload: { message: 'invalid JSON' } });
    return;
  }

  if (!isValidIpcMessage(msg)) {
    reply(socket, { type: 'error', payload: { message: 'invalid message' } });
    return;
  }

  const { type, payload, seq, output } = msg;

  if (!authTokensMatch(msg.token, requiredAuthToken)) {
    reply(socket, {
      type: 'error',
      seq,
      payload: { message: 'unauthorized' },
    });
    socket.end();
    return;
  }

  switch (type) {
    case 'hello': {
      reply(socket, {
        type: 'hello',
        seq,
        payload: {
          companion: 'lyricdisplay-ndi',
          version: app.getVersion(),
          protocolVersion: IPC_PROTOCOL_VERSION,
          engine: 'electron-offscreen',
          capabilities: ['custom-outputs', 'per-output-stats', 'sha256-artifacts'],
        },
      });
      break;
    }

    case 'set_outputs': {
      // payload.outputs = { output1: {...}, output2: {...}, stage: {...} }
      const outputs = payload?.outputs || {};
      const failedOutputs = [];
      for (const [key, config] of Object.entries(outputs)) {
        if (config?.enabled) {
          if (isOutputEnabled(key)) {
            const updated = await updateOutputConfig(key, config);
            if (!updated) failedOutputs.push(key);
          } else {
            const enabled = await enableOutput(key, config);
            if (!enabled) failedOutputs.push(key);
          }
        } else {
          await disableOutput(key);
        }
      }
      if (failedOutputs.length > 0) {
        reply(socket, { type: 'error', seq, payload: { message: `failed to enable outputs: ${failedOutputs.join(', ')}` } });
      } else {
        reply(socket, { type: 'ack', seq, payload: { ok: true } });
      }
      break;
    }

    case 'enable_output': {
      const key = output || payload?.outputKey;
      const enabled = await enableOutput(key, payload);
      if (enabled) {
        reply(socket, { type: 'ack', seq, payload: { ok: true } });
      } else {
        reply(socket, { type: 'error', seq, payload: { message: `failed to enable output: ${key}` } });
      }
      break;
    }

    case 'disable_output': {
      const key = output || payload?.outputKey;
      await disableOutput(key);
      reply(socket, { type: 'ack', seq, payload: { ok: true } });
      break;
    }

    case 'update_output': {
      const key = output || payload?.outputKey;
      await updateOutputConfig(key, payload);
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
        stopIpcServer();
        Promise.resolve(destroyOutputManager()).finally(() => app.quit());
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
