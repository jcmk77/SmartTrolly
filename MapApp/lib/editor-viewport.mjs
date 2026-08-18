function finiteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
  return value;
}

function positiveNumber(value, label) {
  const number = finiteNumber(value, label);
  if (number <= 0) {
    throw new RangeError(`${label} must be greater than zero.`);
  }
  return number;
}

function sourceDimension(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer.`);
  }
  return value;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Convert a browser client point to a full-resolution source pixel. The canvas
 * rectangle may be CSS-scaled, zoomed, or shifted by a scrolling viewport.
 */
export function clientPointToSource(
  clientX,
  clientY,
  canvasRect,
  sourceWidth,
  sourceHeight,
) {
  const x = finiteNumber(clientX, "Client x");
  const y = finiteNumber(clientY, "Client y");
  if (!canvasRect || typeof canvasRect !== "object") {
    throw new TypeError("Canvas rectangle must be an object.");
  }
  const left = finiteNumber(canvasRect.left, "Canvas left");
  const top = finiteNumber(canvasRect.top, "Canvas top");
  const displayWidth = positiveNumber(canvasRect.width, "Canvas width");
  const displayHeight = positiveNumber(canvasRect.height, "Canvas height");
  const width = sourceDimension(sourceWidth, "Source width");
  const height = sourceDimension(sourceHeight, "Source height");

  return {
    x: clamp(Math.floor(((x - left) / displayWidth) * width), 0, width - 1),
    y: clamp(Math.floor(((y - top) / displayHeight) * height), 0, height - 1),
  };
}

/**
 * Return the percentage that fits content inside the usable viewport.
 * Small content is not enlarged above 100% unless a higher `maxPercent` is
 * explicitly provided.
 */
export function fitZoomPercent(
  contentWidth,
  contentHeight,
  viewportWidth,
  viewportHeight,
  { maxPercent = 100 } = {},
) {
  const contentW = positiveNumber(contentWidth, "Content width");
  const contentH = positiveNumber(contentHeight, "Content height");
  const viewportW = positiveNumber(viewportWidth, "Viewport width");
  const viewportH = positiveNumber(viewportHeight, "Viewport height");
  const maximum = positiveNumber(maxPercent, "Maximum zoom percent");

  return Math.min(
    maximum,
    (viewportW / contentW) * 100,
    (viewportH / contentH) * 100,
  );
}

/**
 * Calculate the scroll delta needed to keep one viewport-relative cursor point
 * over the same content point while zoom changes. The browser can clamp the
 * resulting scroll position to its own valid range.
 */
export function zoomAnchorScrollDelta(
  scrollLeft,
  scrollTop,
  anchorX,
  anchorY,
  previousZoomPercent,
  nextZoomPercent,
) {
  const left = finiteNumber(scrollLeft, "Scroll left");
  const top = finiteNumber(scrollTop, "Scroll top");
  const x = finiteNumber(anchorX, "Anchor x");
  const y = finiteNumber(anchorY, "Anchor y");
  const previousZoom = positiveNumber(
    previousZoomPercent,
    "Previous zoom percent",
  );
  const nextZoom = positiveNumber(nextZoomPercent, "Next zoom percent");
  const ratio = nextZoom / previousZoom;

  if (ratio === 1) return { x: 0, y: 0 };
  return {
    x: (left + x) * (ratio - 1),
    y: (top + y) * (ratio - 1),
  };
}
