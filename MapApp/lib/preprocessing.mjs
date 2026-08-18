/**
 * Browser-safe image preprocessing helpers for MapForge.
 *
 * Pixel buffers are one byte per pixel in row-major, top-to-bottom order.
 * Binary maps use ROS conventions: 0 is occupied (wall), 255 is free.
 */

const DEFAULT_CLEANUP_OPTIONS = Object.freeze({
  whiteCutoff: 255,
  lightCutoff: 245,
  minLineLength: 80,
  maxLineThickness: 2,
  maxSmallComponentArea: 24,
});

function assertImageDimensions(width, height) {
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError("Image width must be a positive integer.");
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("Image height must be a positive integer.");
  }

  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount)) {
    throw new RangeError("Image dimensions are too large.");
  }

  return pixelCount;
}

function assertPixelBuffer(pixels, width, height, name = "Pixel buffer") {
  const pixelCount = assertImageDimensions(width, height);
  if (!(pixels instanceof Uint8Array)) {
    throw new TypeError(`${name} must be a Uint8Array.`);
  }
  if (pixels.length !== pixelCount) {
    throw new RangeError(
      `${name} length (${pixels.length}) must equal width × height (${pixelCount}).`,
    );
  }
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${name} must be a finite number.`);
  }
  return number;
}

/**
 * Normalize a crop to an integer, in-bounds rectangle.
 *
 * The input may use {x, y, width, height}, including negative width/height
 * from a reverse drag, or {left, top, right, bottom}. Fractional bounds are
 * expanded to include every touched pixel. The return shape is always
 * {x, y, width, height} in top-left image coordinates.
 */
export function normalizeCropBounds(crop, width, height) {
  assertImageDimensions(width, height);
  if (!crop || typeof crop !== "object") {
    throw new TypeError("Crop bounds must be an object.");
  }

  let firstX;
  let firstY;
  let secondX;
  let secondY;

  if (
    Object.hasOwn(crop, "x") ||
    Object.hasOwn(crop, "y") ||
    Object.hasOwn(crop, "width") ||
    Object.hasOwn(crop, "height")
  ) {
    firstX = finiteNumber(crop.x, "Crop x");
    firstY = finiteNumber(crop.y, "Crop y");
    secondX = firstX + finiteNumber(crop.width, "Crop width");
    secondY = firstY + finiteNumber(crop.height, "Crop height");
  } else {
    firstX = finiteNumber(crop.left, "Crop left");
    firstY = finiteNumber(crop.top, "Crop top");
    secondX = finiteNumber(crop.right, "Crop right");
    secondY = finiteNumber(crop.bottom, "Crop bottom");
  }

  if (firstX === secondX || firstY === secondY) {
    throw new RangeError("Crop width and height must both be non-zero.");
  }

  const left = Math.max(0, Math.floor(Math.min(firstX, secondX)));
  const top = Math.max(0, Math.floor(Math.min(firstY, secondY)));
  const right = Math.min(width, Math.ceil(Math.max(firstX, secondX)));
  const bottom = Math.min(height, Math.ceil(Math.max(firstY, secondY)));

  if (right <= left || bottom <= top) {
    throw new RangeError("Crop bounds must overlap at least one image pixel.");
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

/** Return whether crop bounds can be normalized to a non-empty rectangle. */
export function validateCropBounds(crop, width, height) {
  try {
    normalizeCropBounds(crop, width, height);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a crop out of a one-byte-per-pixel image.
 *
 * @returns {{pixels: Uint8Array, width: number, height: number,
 *   crop: {x: number, y: number, width: number, height: number}}}
 */
export function cropPixels(pixels, width, height, crop) {
  assertPixelBuffer(pixels, width, height);
  const normalized = normalizeCropBounds(crop, width, height);
  const output = new Uint8Array(normalized.width * normalized.height);

  for (let row = 0; row < normalized.height; row += 1) {
    const sourceStart = (normalized.y + row) * width + normalized.x;
    const targetStart = row * normalized.width;
    output.set(
      pixels.subarray(sourceStart, sourceStart + normalized.width),
      targetStart,
    );
  }

  return {
    pixels: output,
    width: normalized.width,
    height: normalized.height,
    crop: normalized,
  };
}

function cleanupOptions(options) {
  const merged = { ...DEFAULT_CLEANUP_OPTIONS, ...options };
  const integerOptions = [
    ["whiteCutoff", 1, 255],
    ["lightCutoff", 0, 255],
    ["minLineLength", 1, Number.MAX_SAFE_INTEGER],
    ["maxLineThickness", 1, Number.MAX_SAFE_INTEGER],
    ["maxSmallComponentArea", 0, Number.MAX_SAFE_INTEGER],
  ];

  for (const [name, minimum, maximum] of integerOptions) {
    const value = merged[name];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new RangeError(
        `${name} must be an integer from ${minimum} to ${maximum}.`,
      );
    }
  }

  if (merged.lightCutoff > merged.whiteCutoff) {
    throw new RangeError("lightCutoff cannot be greater than whiteCutoff.");
  }

  return merged;
}

/**
 * Mark small, isolated dark connected components without allocating a
 * full-size queue. A scanline flood fill uses mask value 2 as temporary
 * visited state; only components within maxArea become removal suggestions.
 */
function markSmallDarkComponents(
  grayscale,
  width,
  height,
  darkCutoff,
  maxArea,
  mask,
) {
  if (maxArea === 0 || darkCutoff === 0) return;

  const stack = [];
  const componentPixels = [];

  for (let initial = 0; initial < grayscale.length; initial += 1) {
    if (mask[initial] !== 0 || grayscale[initial] >= darkCutoff) continue;

    stack.push(initial);
    componentPixels.length = 0;
    let componentSize = 0;
    let isSmall = true;

    while (stack.length > 0) {
      const seed = stack.pop();
      if (mask[seed] !== 0 || grayscale[seed] >= darkCutoff) continue;

      const y = Math.floor(seed / width);
      const rowStart = y * width;
      let left = seed - rowStart;
      let right = left;

      while (
        left > 0 &&
        mask[rowStart + left - 1] === 0 &&
        grayscale[rowStart + left - 1] < darkCutoff
      ) {
        left -= 1;
      }
      while (
        right + 1 < width &&
        mask[rowStart + right + 1] === 0 &&
        grayscale[rowStart + right + 1] < darkCutoff
      ) {
        right += 1;
      }

      let openAbove = false;
      let openBelow = false;
      for (let x = left; x <= right; x += 1) {
        const index = rowStart + x;
        mask[index] = 2;
        componentSize += 1;

        if (isSmall) {
          if (componentSize <= maxArea) {
            componentPixels.push(index);
          } else {
            componentPixels.length = 0;
            isSmall = false;
          }
        }

        if (y > 0) {
          const above = index - width;
          const available =
            mask[above] === 0 && grayscale[above] < darkCutoff;
          if (available && !openAbove) stack.push(above);
          openAbove = available;
        }

        if (y + 1 < height) {
          const below = index + width;
          const available =
            mask[below] === 0 && grayscale[below] < darkCutoff;
          if (available && !openBelow) stack.push(below);
          openBelow = available;
        }
      }
    }

    if (isSmall) {
      for (const index of componentPixels) mask[index] = 1;
    }
  }

  // Clear temporary visited markers while retaining removal suggestions.
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 2) mask[index] = 0;
  }
}

function horizontalThickness(
  grayscale,
  width,
  height,
  x,
  y,
  cutoff,
  maximum,
) {
  let thickness = 1;

  for (let row = y - 1; row >= 0; row -= 1) {
    if (grayscale[row * width + x] >= cutoff) break;
    thickness += 1;
    if (thickness > maximum) return thickness;
  }
  for (let row = y + 1; row < height; row += 1) {
    if (grayscale[row * width + x] >= cutoff) break;
    thickness += 1;
    if (thickness > maximum) return thickness;
  }

  return thickness;
}

function verticalThickness(
  grayscale,
  width,
  height,
  x,
  y,
  cutoff,
  maximum,
) {
  let thickness = 1;

  for (let column = x - 1; column >= 0; column -= 1) {
    if (grayscale[y * width + column] >= cutoff) break;
    thickness += 1;
    if (thickness > maximum) return thickness;
  }
  for (let column = x + 1; column < width; column += 1) {
    if (grayscale[y * width + column] >= cutoff) break;
    thickness += 1;
    if (thickness > maximum) return thickness;
  }

  return thickness;
}

function isThinHorizontalRun(
  grayscale,
  width,
  height,
  start,
  end,
  y,
  cutoff,
  maximum,
) {
  const length = end - start + 1;
  const sampleCount = Math.min(7, length);
  let thinSamples = 0;

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const x = Math.min(
      end,
      start + Math.floor(((sample + 0.5) * length) / sampleCount),
    );
    if (
      horizontalThickness(
        grayscale,
        width,
        height,
        x,
        y,
        cutoff,
        maximum,
      ) <= maximum
    ) {
      thinSamples += 1;
    }
  }

  return thinSamples >= Math.ceil(sampleCount * 0.75);
}

function isThinVerticalRun(
  grayscale,
  width,
  height,
  x,
  start,
  end,
  cutoff,
  maximum,
) {
  const length = end - start + 1;
  const sampleCount = Math.min(7, length);
  let thinSamples = 0;

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const y = Math.min(
      end,
      start + Math.floor(((sample + 0.5) * length) / sampleCount),
    );
    if (
      verticalThickness(
        grayscale,
        width,
        height,
        x,
        y,
        cutoff,
        maximum,
      ) <= maximum
    ) {
      thinSamples += 1;
    }
  }

  return thinSamples >= Math.ceil(sampleCount * 0.75);
}

function markLongThinLines(
  grayscale,
  width,
  height,
  cutoff,
  minimumLength,
  maximumThickness,
  mask,
) {
  // Horizontal runs. The <= width sentinel closes a run at the row edge.
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width;
    let runStart = -1;
    for (let x = 0; x <= width; x += 1) {
      const foreground =
        x < width && grayscale[rowStart + x] < cutoff;
      if (foreground) {
        if (runStart < 0) runStart = x;
      } else if (runStart >= 0) {
        const runEnd = x - 1;
        if (
          runEnd - runStart + 1 >= minimumLength &&
          isThinHorizontalRun(
            grayscale,
            width,
            height,
            runStart,
            runEnd,
            y,
            cutoff,
            maximumThickness,
          )
        ) {
          mask.fill(1, rowStart + runStart, rowStart + runEnd + 1);
        }
        runStart = -1;
      }
    }
  }

  // Vertical runs. This is cache-unfriendly but still linear and avoids the
  // extra 4 bytes/pixel that a transposed or run-length image would require.
  for (let x = 0; x < width; x += 1) {
    let runStart = -1;
    for (let y = 0; y <= height; y += 1) {
      const foreground = y < height && grayscale[y * width + x] < cutoff;
      if (foreground) {
        if (runStart < 0) runStart = y;
      } else if (runStart >= 0) {
        const runEnd = y - 1;
        if (
          runEnd - runStart + 1 >= minimumLength &&
          isThinVerticalRun(
            grayscale,
            width,
            height,
            x,
            runStart,
            runEnd,
            cutoff,
            maximumThickness,
          )
        ) {
          for (let row = runStart; row <= runEnd; row += 1) {
            mask[row * width + x] = 1;
          }
        }
        runStart = -1;
      }
    }
  }
}

/**
 * Suggest pixels to erase before binarization.
 *
 * The returned Uint8Array contains 1 for suggested removal and 0 for keep.
 * Suggestions combine:
 *   - light occupied pixels in [lightCutoff, whiteCutoff),
 *   - long, axis-aligned runs no thicker than maxLineThickness, and
 *   - isolated dark 4-connected components up to maxSmallComponentArea.
 *
 * This is intentionally a suggestion mask: walls and drawing annotations can
 * share identical geometry, so callers should preview and allow corrections.
 */
export function buildCleanupSuggestion(
  grayscale,
  width,
  height,
  options = {},
) {
  assertPixelBuffer(grayscale, width, height, "Grayscale pixel buffer");
  const settings = cleanupOptions(options);
  const mask = new Uint8Array(grayscale.length);

  // Analyze genuinely dark components before light pixels are masked out, so
  // anti-aliased edges do not get mistaken for separate tiny components.
  markSmallDarkComponents(
    grayscale,
    width,
    height,
    settings.lightCutoff,
    settings.maxSmallComponentArea,
    mask,
  );

  for (let index = 0; index < grayscale.length; index += 1) {
    const value = grayscale[index];
    if (value >= settings.lightCutoff && value < settings.whiteCutoff) {
      mask[index] = 1;
    }
  }

  markLongThinLines(
    grayscale,
    width,
    height,
    settings.whiteCutoff,
    settings.minLineLength,
    settings.maxLineThickness,
    mask,
  );

  return mask;
}

/** Return a copy of a binary map with every non-zero mask pixel made free. */
export function applyRemovalMask(binary, mask) {
  if (!(binary instanceof Uint8Array)) {
    throw new TypeError("Binary pixels must be a Uint8Array.");
  }
  if (!(mask instanceof Uint8Array)) {
    throw new TypeError("Removal mask must be a Uint8Array.");
  }
  if (binary.length !== mask.length) {
    throw new RangeError("Binary pixels and removal mask must have equal length.");
  }

  const output = binary.slice();
  for (let index = 0; index < output.length; index += 1) {
    if (mask[index] !== 0) output[index] = 255;
  }
  return output;
}

/** Paint a clipped, filled circle into a pixel buffer in place. */
export function paintCircle(pixels, width, height, x, y, radius, value) {
  assertPixelBuffer(pixels, width, height);
  const centerX = Math.round(finiteNumber(x, "Brush x"));
  const centerY = Math.round(finiteNumber(y, "Brush y"));
  const normalizedRadius = Math.round(finiteNumber(radius, "Brush radius"));
  if (normalizedRadius < 0) {
    throw new RangeError("Brush radius cannot be negative.");
  }
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError("Paint value must be an integer from 0 to 255.");
  }

  const firstY = Math.max(0, centerY - normalizedRadius);
  const lastY = Math.min(height - 1, centerY + normalizedRadius);
  const radiusSquared = normalizedRadius * normalizedRadius;

  for (let row = firstY; row <= lastY; row += 1) {
    const deltaY = row - centerY;
    const halfWidth = Math.floor(
      Math.sqrt(Math.max(0, radiusSquared - deltaY * deltaY)),
    );
    const firstX = Math.max(0, centerX - halfWidth);
    const lastX = Math.min(width - 1, centerX + halfWidth);
    if (firstX <= lastX) {
      pixels.fill(value, row * width + firstX, row * width + lastX + 1);
    }
  }

  return pixels;
}

/**
 * Find the 4-connected free-space region containing the selected pixel.
 * A start on a wall returns an empty mask.
 */
export function floodFillReachable(binary, width, height, startX, startY) {
  assertPixelBuffer(binary, width, height, "Binary pixel buffer");
  const x = Math.round(finiteNumber(startX, "Start x"));
  const y = Math.round(finiteNumber(startY, "Start y"));
  if (x < 0 || x >= width || y < 0 || y >= height) {
    throw new RangeError("Flood-fill start must be inside the image.");
  }

  const mask = new Uint8Array(binary.length);
  const initial = y * width + x;
  if (binary[initial] !== 255) return { mask, count: 0 };

  const stack = [initial];
  let count = 0;

  while (stack.length > 0) {
    const seed = stack.pop();
    if (mask[seed] !== 0 || binary[seed] !== 255) continue;

    const row = Math.floor(seed / width);
    const rowStart = row * width;
    let left = seed - rowStart;
    let right = left;

    while (
      left > 0 &&
      mask[rowStart + left - 1] === 0 &&
      binary[rowStart + left - 1] === 255
    ) {
      left -= 1;
    }
    while (
      right + 1 < width &&
      mask[rowStart + right + 1] === 0 &&
      binary[rowStart + right + 1] === 255
    ) {
      right += 1;
    }

    let openAbove = false;
    let openBelow = false;
    for (let column = left; column <= right; column += 1) {
      const index = rowStart + column;
      mask[index] = 1;
      count += 1;

      if (row > 0) {
        const above = index - width;
        const available = mask[above] === 0 && binary[above] === 255;
        if (available && !openAbove) stack.push(above);
        openAbove = available;
      }

      if (row + 1 < height) {
        const below = index + width;
        const available = mask[below] === 0 && binary[below] === 255;
        if (available && !openBelow) stack.push(below);
        openBelow = available;
      }
    }
  }

  return { mask, count };
}

/** Calculate metres per pixel from two image points and a known distance. */
export function resolutionFromCalibration(
  x1,
  y1,
  x2,
  y2,
  distanceMeters,
) {
  const firstX = finiteNumber(x1, "First x");
  const firstY = finiteNumber(y1, "First y");
  const secondX = finiteNumber(x2, "Second x");
  const secondY = finiteNumber(y2, "Second y");
  const metres = finiteNumber(distanceMeters, "Calibration distance");
  if (metres <= 0) {
    throw new RangeError("Calibration distance must be greater than zero.");
  }

  const pixelDistance = Math.hypot(secondX - firstX, secondY - firstY);
  if (pixelDistance === 0) {
    throw new RangeError("Calibration points must be different.");
  }

  return metres / pixelDistance;
}

/**
 * Shift a ROS map origin after cropping pixels from the left and bottom.
 * The pixel offset is rotated by the map origin yaw before being added in the
 * world frame. Callers with a top-left crop can calculate bottomPixels as
 * originalHeight - crop.y - crop.height.
 */
export function adjustOriginForCrop(
  originX,
  originY,
  yaw,
  leftPixels,
  bottomPixels,
  resolution,
) {
  const x = finiteNumber(originX, "Origin x");
  const y = finiteNumber(originY, "Origin y");
  const angle = finiteNumber(yaw, "Origin yaw");
  const metresPerPixel = finiteNumber(resolution, "Resolution");

  if (!Number.isSafeInteger(leftPixels) || leftPixels < 0) {
    throw new RangeError("Left crop must be a non-negative pixel count.");
  }
  if (!Number.isSafeInteger(bottomPixels) || bottomPixels < 0) {
    throw new RangeError("Bottom crop must be a non-negative pixel count.");
  }
  if (metresPerPixel <= 0) {
    throw new RangeError("Resolution must be greater than zero.");
  }

  const localX = leftPixels * metresPerPixel;
  const localY = bottomPixels * metresPerPixel;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);

  return {
    x: x + localX * cosine - localY * sine,
    y: y + localX * sine + localY * cosine,
  };
}
