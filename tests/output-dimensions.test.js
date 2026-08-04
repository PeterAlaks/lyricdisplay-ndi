import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSoftwareOffscreenDimensions } from '../src/outputDimensions.js';

test('software offscreen dimensions preserve the configured NDI pixel size', () => {
  assert.deepEqual(resolveSoftwareOffscreenDimensions(1920, 1080), {
    width: 1920,
    height: 1080,
  });
});

test('software offscreen dimensions reject invalid custom sizes', () => {
  assert.throws(
    () => resolveSoftwareOffscreenDimensions(0, 1080),
    /must be positive/,
  );
});
