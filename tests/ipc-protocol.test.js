import assert from 'node:assert/strict';
import test from 'node:test';
import { authTokensMatch, isValidIpcMessage } from '../src/ipcProtocol.js';

test('IPC authentication compares exact tokens', () => {
  assert.equal(authTokensMatch('secret', 'secret'), true);
  assert.equal(authTokensMatch('secret2', 'secret'), false);
  assert.equal(authTokensMatch(null, 'secret'), false);
  assert.equal(authTokensMatch(undefined, ''), true);
});

test('IPC message validation requires a bounded command type', () => {
  assert.equal(isValidIpcMessage({ type: 'hello' }), true);
  assert.equal(isValidIpcMessage({}), false);
  assert.equal(isValidIpcMessage([]), false);
  assert.equal(isValidIpcMessage({ type: 'x'.repeat(65) }), false);
});
