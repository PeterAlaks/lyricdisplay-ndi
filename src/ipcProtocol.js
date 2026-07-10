import { timingSafeEqual } from 'node:crypto';

export const IPC_PROTOCOL_VERSION = 2;
export const MAX_IPC_MESSAGE_BYTES = 256 * 1024;

export function isValidIpcMessage(message) {
  return Boolean(
    message
    && typeof message === 'object'
    && !Array.isArray(message)
    && typeof message.type === 'string'
    && message.type.length > 0
    && message.type.length <= 64
  );
}

export function authTokensMatch(receivedToken, requiredToken) {
  if (!requiredToken) return true;
  if (typeof receivedToken !== 'string') return false;

  const received = Buffer.from(receivedToken, 'utf8');
  const required = Buffer.from(requiredToken, 'utf8');
  return received.length === required.length && timingSafeEqual(received, required);
}
