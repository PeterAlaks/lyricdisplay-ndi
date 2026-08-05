import assert from 'node:assert/strict';
import test from 'node:test';
import grandi from 'grandi';

test('Grandi exposes the version 2 sender contract used by the companion', () => {
  assert.equal(typeof grandi.initialize, 'function');
  assert.equal(typeof grandi.destroy, 'function');
  assert.equal(typeof grandi.send, 'function');
  assert.equal(typeof grandi.FourCC?.BGRA, 'number');
  assert.equal(typeof grandi.FrameType?.Progressive, 'number');
  assert.equal(typeof grandi.TIMECODE_SYNTHESIZE, 'bigint');
});
