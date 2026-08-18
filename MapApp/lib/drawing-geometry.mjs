const MAX_UINT32_PIXEL_COUNT = 0x1_0000_0000;

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
  return value;
}

function rasterSize(width, height) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError("Raster width must be a positive integer.");
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new RangeError("Raster height must be a positive integer.");
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_UINT32_PIXEL_COUNT) {
    throw new RangeError("Raster pixels must fit in Uint32 indices.");
  }
  return { width, height };
}

function pixelCoordinate(value, label) {
  return Math.round(finiteNumber(value, label));
}

function brushRadius(thickness) {
  const normalized = finiteNumber(thickness, "Thickness");
  if (normalized <= 0) {
    throw new RangeError("Thickness must be greater than zero.");
  }
  return Math.max(0.5, normalized / 2);
}

function squaredDistanceToSegment(x, y, startX, startY, endX, endY) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  if (lengthSquared === 0) {
    return (x - startX) ** 2 + (y - startY) ** 2;
  }

  const projection = Math.max(
    0,
    Math.min(
      1,
      ((x - startX) * deltaX + (y - startY) * deltaY) / lengthSquared,
    ),
  );
  const nearestX = startX + projection * deltaX;
  const nearestY = startY + projection * deltaY;
  return (x - nearestX) ** 2 + (y - nearestY) ** 2;
}

function mergeUniqueSorted(first, second) {
  const merged = new Uint32Array(first.length + second.length);
  let firstIndex = 0;
  let secondIndex = 0;
  let target = 0;
  let last = -1;

  while (firstIndex < first.length || secondIndex < second.length) {
    let value;
    if (
      secondIndex >= second.length ||
      (firstIndex < first.length && first[firstIndex] <= second[secondIndex])
    ) {
      value = first[firstIndex];
      firstIndex += 1;
    } else {
      value = second[secondIndex];
      secondIndex += 1;
    }
    if (value !== last) {
      merged[target] = value;
      target += 1;
      last = value;
    }
  }

  return merged.slice(0, target);
}

/**
 * Return the unique row-major pixel indices covered by a clipped thick line.
 * Coordinates are rounded to pixel centers; thickness is measured in source
 * pixels. The returned Uint32Array is sorted, so it can be applied directly to
 * the editor's full-resolution pixel buffer and captured as one history patch.
 */
export function rasterizeThickLine(
  width,
  height,
  startX,
  startY,
  endX,
  endY,
  thickness = 1,
) {
  rasterSize(width, height);
  const x1 = pixelCoordinate(startX, "Line start x");
  const y1 = pixelCoordinate(startY, "Line start y");
  const x2 = pixelCoordinate(endX, "Line end x");
  const y2 = pixelCoordinate(endY, "Line end y");
  const radius = brushRadius(thickness);
  const radiusSquared = radius * radius;

  const firstY = Math.max(0, Math.floor(Math.min(y1, y2) - radius));
  const lastY = Math.min(height - 1, Math.ceil(Math.max(y1, y2) + radius));
  if (firstY > lastY) return new Uint32Array();

  const deltaX = x2 - x1;
  const deltaY = y2 - y1;
  const indices = [];

  for (let y = firstY; y <= lastY; y += 1) {
    let candidateFirstX;
    let candidateLastX;
    if (deltaY === 0) {
      if (Math.abs(y - y1) > radius) continue;
      candidateFirstX = Math.floor(Math.min(x1, x2) - radius);
      candidateLastX = Math.ceil(Math.max(x1, x2) + radius);
    } else {
      // Only inspect a conservative horizontal slice around the line. This
      // avoids scanning a diagonal line's entire bounding rectangle.
      const projection = Math.max(0, Math.min(1, (y - y1) / deltaY));
      const centerX = x1 + projection * deltaX;
      const halfSpan = radius * (1 + Math.abs(deltaX / deltaY)) + 1;
      candidateFirstX = Math.floor(centerX - halfSpan);
      candidateLastX = Math.ceil(centerX + halfSpan);
    }

    const firstX = Math.max(0, candidateFirstX);
    const lastX = Math.min(width - 1, candidateLastX);
    for (let x = firstX; x <= lastX; x += 1) {
      if (
        squaredDistanceToSegment(x, y, x1, y1, x2, y2) <=
        radiusSquared + Number.EPSILON
      ) {
        indices.push(y * width + x);
      }
    }
  }

  return Uint32Array.from(indices);
}

/**
 * Return unique row-major indices for an inclusive rectangle drag.
 * Reversed endpoints are normalized. Filled rectangles include every pixel in
 * the clipped bounds; outlines use the same source-pixel thickness as lines.
 */
export function rasterizeRectangle(
  width,
  height,
  startX,
  startY,
  endX,
  endY,
  { filled = false, thickness = 1 } = {},
) {
  rasterSize(width, height);
  const x1 = pixelCoordinate(startX, "Rectangle start x");
  const y1 = pixelCoordinate(startY, "Rectangle start y");
  const x2 = pixelCoordinate(endX, "Rectangle end x");
  const y2 = pixelCoordinate(endY, "Rectangle end y");
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);

  if (filled) {
    // Validate thickness too when supplied, so callers get consistent errors
    // when switching between outline and filled modes with shared settings.
    brushRadius(thickness);
    const firstX = Math.max(0, left);
    const lastX = Math.min(width - 1, right);
    const firstY = Math.max(0, top);
    const lastY = Math.min(height - 1, bottom);
    if (firstX > lastX || firstY > lastY) return new Uint32Array();

    const result = new Uint32Array(
      (lastX - firstX + 1) * (lastY - firstY + 1),
    );
    let target = 0;
    for (let y = firstY; y <= lastY; y += 1) {
      for (let x = firstX; x <= lastX; x += 1) {
        result[target] = y * width + x;
        target += 1;
      }
    }
    return result;
  }

  let result = rasterizeThickLine(
    width,
    height,
    left,
    top,
    right,
    top,
    thickness,
  );
  result = mergeUniqueSorted(
    result,
    rasterizeThickLine(
      width,
      height,
      right,
      top,
      right,
      bottom,
      thickness,
    ),
  );
  result = mergeUniqueSorted(
    result,
    rasterizeThickLine(
      width,
      height,
      right,
      bottom,
      left,
      bottom,
      thickness,
    ),
  );
  return mergeUniqueSorted(
    result,
    rasterizeThickLine(
      width,
      height,
      left,
      bottom,
      left,
      top,
      thickness,
    ),
  );
}
