import assert from 'node:assert/strict';
import test from 'node:test';
import { createLatestFramePump } from '../src/latestFramePump.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

const waitFor = async (predicate, message) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await flushPromises();
  }
  assert.fail(message);
};

test('keeps the newest paint while a clocked send is in flight', async () => {
  const sends = [];
  const completions = [];
  const firstSend = deferred();
  const secondSend = deferred();
  const pump = createLatestFramePump({
    send: (frame) => {
      sends.push(frame.id);
      return sends.length === 1 ? firstSend.promise : secondSend.promise;
    },
    onSendComplete: (details) => completions.push(details),
  });

  pump.push({ id: 'frame-1', data: Buffer.alloc(1) });
  pump.start();
  await waitFor(() => sends.length === 1, 'first frame was not sent');
  assert.deepEqual(sends, ['frame-1']);

  pump.push({ id: 'frame-2', data: Buffer.alloc(1) });
  pump.push({ id: 'frame-3', data: Buffer.alloc(1) });
  firstSend.resolve();
  await waitFor(() => sends.length === 2, 'latest replacement frame was not sent');

  assert.deepEqual(sends, ['frame-1', 'frame-3']);
  assert.equal(completions[0].coalesced, 0);

  pump.stop();
  secondSend.resolve();
  await flushPromises();
  assert.equal(completions[1].coalesced, 1);
});

test('does not re-encode a settled static frame', async () => {
  const sends = [];
  const completions = [];
  const firstSend = deferred();
  const pump = createLatestFramePump({
    send: (frame) => {
      sends.push(frame.id);
      return firstSend.promise;
    },
    onSendComplete: (details) => completions.push(details),
  });

  pump.push({ id: 'static-frame', data: Buffer.alloc(1) });
  pump.start();
  await waitFor(() => sends.length === 1, 'initial static frame was not sent');
  firstSend.resolve();
  await flushPromises();
  await flushPromises();

  assert.deepEqual(sends, ['static-frame']);
  assert.equal(completions[0].repeated, false);

  pump.stop();
});
