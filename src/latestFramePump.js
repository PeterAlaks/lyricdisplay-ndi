/**
 * Keep an asynchronous video sender supplied with the newest rendered frame.
 * The sender's own clock remains the cadence authority.
 *
 * A paint callback and a clocked NDI send complete on independent schedules.
 * Holding only the latest paint avoids rejecting a frame merely because the
 * previous NDI call is still in flight, while bounding memory to two full
 * frame buffers (the in-flight frame and the latest replacement). A settled
 * frame is not submitted again: NDI receivers retain the most recent image,
 * and repeatedly encoding an unchanged BGRA frame competes with Chromium's
 * software renderer.
 */
export function createLatestFramePump({
  send,
  onSendComplete = () => {},
  onSendFailure = () => {},
  now = () => performance.now(),
} = {}) {
  if (typeof send !== 'function') {
    throw new TypeError('createLatestFramePump requires a send function');
  }

  let running = false;
  let inFlight = false;
  let latestFrame = null;
  let latestRevision = 0;
  let lastAttemptedRevision = 0;
  let lastSettledRevision = 0;
  let lastSentRevision = 0;

  const schedulePump = () => {
    if (!running || inFlight || !latestFrame) return;
    if (latestRevision <= lastAttemptedRevision) return;
    queueMicrotask(pump);
  };

  const pump = () => {
    if (!running || inFlight || !latestFrame) return;
    if (latestRevision <= lastAttemptedRevision) return;

    const frame = latestFrame;
    const revision = latestRevision;
    const startedAt = now();
    inFlight = true;
    lastAttemptedRevision = revision;

    Promise.resolve()
      .then(() => send(frame))
      .then(() => {
        const coalesced = Math.max(0, revision - lastSettledRevision - 1);
        lastSentRevision = revision;
        lastSettledRevision = revision;
        onSendComplete({
          repeated: false,
          coalesced,
          revision,
          durationMs: Math.max(0, now() - startedAt),
        });
      })
      .catch((error) => {
        lastSettledRevision = revision;
        onSendFailure(error);
      })
      .finally(() => {
        inFlight = false;
        if (!running) return;
        schedulePump();
      });
  };

  return {
    push(frame) {
      if (!frame || !frame.data) return false;
      latestFrame = frame;
      latestRevision += 1;
      schedulePump(0);
      return true;
    },

    start() {
      if (running) return;
      running = true;
      schedulePump(0);
    },

    stop() {
      running = false;
      latestFrame = null;
    },

    getState() {
      return {
        running,
        inFlight,
        hasFrame: Boolean(latestFrame),
        latestRevision,
        lastAttemptedRevision,
        lastSentRevision,
      };
    },
  };
}
