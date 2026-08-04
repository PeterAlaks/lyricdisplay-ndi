/**
 * Software offscreen rendering produces one bitmap pixel for each content
 * pixel requested here. OS monitor scaling must not reduce the NDI frame.
 */
export function resolveSoftwareOffscreenDimensions(width, height) {
  const resolvedWidth = Math.round(Number(width));
  const resolvedHeight = Math.round(Number(height));

  if (resolvedWidth <= 0 || resolvedHeight <= 0) {
    throw new RangeError('Offscreen output dimensions must be positive');
  }

  return { width: resolvedWidth, height: resolvedHeight };
}
