/**
 * Pure occupancy-map helpers for converting a cleaned binary floor plan into
 * ROS trinary pixel values.
 *
 * Input pixels are one byte per pixel in row-major, top-to-bottom order:
 *   0   = occupied
 *   255 = free candidate
 *
 * Output pixels additionally use:
 *   127 = unknown exterior
 */

export const TRINARY_OCCUPIED = 0;
export const TRINARY_UNKNOWN = 127;
export const TRINARY_FREE = 255;

const MAX_UINT32_PIXEL_COUNT = 0x1_0000_0000;

function assertBinaryRaster(binaryPixels, width, height) {
  if (!(binaryPixels instanceof Uint8Array)) {
    throw new TypeError("Binary pixels must be a Uint8Array.");
  }
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new RangeError("Raster width must be a positive integer.");
  }
  if (!Number.isSafeInteger(height) || height <= 0) {
    throw new RangeError("Raster height must be a positive integer.");
  }

  const pixelCount = width * height;
  if (
    !Number.isSafeInteger(pixelCount) ||
    pixelCount > MAX_UINT32_PIXEL_COUNT
  ) {
    throw new RangeError("Raster dimensions are too large for Uint32 indices.");
  }
  if (binaryPixels.length !== pixelCount) {
    throw new RangeError(
      `Binary pixel length (${binaryPixels.length}) must equal width × height (${pixelCount}).`,
    );
  }

  for (let index = 0; index < binaryPixels.length; index += 1) {
    const value = binaryPixels[index];
    if (value !== TRINARY_OCCUPIED && value !== TRINARY_FREE) {
      throw new RangeError(
        `Binary pixels may contain only 0 or 255; found ${value} at index ${index}.`,
      );
    }
  }
}

/**
 * A compact, reusable Uint32 stack. It starts proportional to the image
 * perimeter and grows only if a fragmented component needs more scanline
 * seeds. Unlike a per-pixel JavaScript queue, it does not allocate objects for
 * every visited pixel.
 */
function createSeedStack(pixelCount, width, height) {
  const initialCapacity = Math.min(
    pixelCount,
    Math.max(64, Math.min(MAX_UINT32_PIXEL_COUNT, 2 * (width + height))),
  );
  let values = new Uint32Array(initialCapacity);
  let length = 0;

  return {
    clear() {
      length = 0;
    },
    push(value) {
      if (length === values.length) {
        const nextCapacity = Math.min(
          pixelCount,
          Math.max(length + 1, Math.min(pixelCount, values.length * 2)),
        );
        const expanded = new Uint32Array(nextCapacity);
        expanded.set(values);
        values = expanded;
      }
      values[length] = value;
      length += 1;
    },
    pop() {
      length -= 1;
      return values[length];
    },
    get length() {
      return length;
    },
  };
}

/**
 * Mark one 4-connected white component with the unknown value using scanline
 * flood fill. The output buffer itself is the visited marker.
 */
function markExteriorComponent(pixels, width, height, initial, stack) {
  if (pixels[initial] !== TRINARY_FREE) return;

  stack.clear();
  stack.push(initial);

  while (stack.length > 0) {
    const seed = stack.pop();
    if (pixels[seed] !== TRINARY_FREE) continue;

    const row = Math.floor(seed / width);
    const rowStart = row * width;
    let left = seed - rowStart;
    let right = left;

    while (
      left > 0 &&
      pixels[rowStart + left - 1] === TRINARY_FREE
    ) {
      left -= 1;
    }
    while (
      right + 1 < width &&
      pixels[rowStart + right + 1] === TRINARY_FREE
    ) {
      right += 1;
    }

    pixels.fill(TRINARY_UNKNOWN, rowStart + left, rowStart + right + 1);

    for (const adjacentRow of [row - 1, row + 1]) {
      if (adjacentRow < 0 || adjacentRow >= height) continue;
      const adjacentStart = adjacentRow * width;
      let column = left;

      while (column <= right) {
        while (
          column <= right &&
          pixels[adjacentStart + column] !== TRINARY_FREE
        ) {
          column += 1;
        }
        if (column > right) break;

        stack.push(adjacentStart + column);
        while (
          column <= right &&
          pixels[adjacentStart + column] === TRINARY_FREE
        ) {
          column += 1;
        }
      }
    }
  }
}

/**
 * Convert a cleaned binary floor-plan raster to trinary occupancy pixels.
 *
 * Every 4-connected white region touching any image edge is classified as
 * unknown exterior (127). Enclosed white regions remain free (255), and black
 * pixels remain occupied (0). The input is validated and never mutated.
 *
 * This classifier deliberately uses raster topology rather than architectural
 * semantics: a gap in the exterior wall can cause connected interior space to
 * become unknown, while a dark page frame can enclose page background and keep
 * it free. Crop and repair the building boundary before applying it.
 *
 * @param {Uint8Array} binaryPixels
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function classifyExteriorUnknown(binaryPixels, width, height) {
  assertBinaryRaster(binaryPixels, width, height);

  const output = binaryPixels.slice();
  const stack = createSeedStack(output.length, width, height);

  for (let x = 0; x < width; x += 1) {
    markExteriorComponent(output, width, height, x, stack);
    if (height > 1) {
      markExteriorComponent(
        output,
        width,
        height,
        (height - 1) * width + x,
        stack,
      );
    }
  }

  for (let y = 1; y + 1 < height; y += 1) {
    markExteriorComponent(output, width, height, y * width, stack);
    if (width > 1) {
      markExteriorComponent(output, width, height, y * width + width - 1, stack);
    }
  }

  return output;
}
