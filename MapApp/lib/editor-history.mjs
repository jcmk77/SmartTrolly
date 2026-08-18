const MAX_UINT32_LENGTH = 0x1_0000_0000;

function assertPixels(pixels, label) {
  if (!(pixels instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array.`);
  }
  if (pixels.length > MAX_UINT32_LENGTH) {
    throw new RangeError(`${label} is too large for Uint32 pixel indices.`);
  }
}

function assertByte(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`${label} must be an integer from 0 to 255.`);
  }
}

function assertPatch(pixels, patch) {
  if (!patch || typeof patch !== "object") {
    throw new TypeError("Pixel patch must be an object.");
  }
  if (!(patch.indices instanceof Uint32Array)) {
    throw new TypeError("Pixel patch indices must be a Uint32Array.");
  }
  if (!(patch.before instanceof Uint8Array)) {
    throw new TypeError("Pixel patch before values must be a Uint8Array.");
  }
  if (!(patch.after instanceof Uint8Array)) {
    throw new TypeError("Pixel patch after values must be a Uint8Array.");
  }
  if (
    patch.before.length !== patch.indices.length ||
    patch.after.length !== patch.indices.length
  ) {
    throw new RangeError("Pixel patch arrays must have equal lengths.");
  }

  let previousIndex = -1;
  for (const index of patch.indices) {
    if (index >= pixels.length) {
      throw new RangeError("Pixel patch index is outside the pixel buffer.");
    }
    if (index <= previousIndex) {
      throw new RangeError(
        "Pixel patch indices must be unique and strictly increasing.",
      );
    }
    previousIndex = index;
  }
}

/**
 * Snapshot one committed edit as a compact, deterministic history patch.
 *
 * `currentPixels` contains the post-edit values. `previousValues` records the
 * first value seen at each touched index before the edit. Entries whose value
 * did not ultimately change are omitted, and the returned indices are sorted.
 *
 * @returns {{indices: Uint32Array, before: Uint8Array, after: Uint8Array}}
 */
export function createPixelPatch(currentPixels, previousValues) {
  assertPixels(currentPixels, "Current pixels");
  if (!(previousValues instanceof Map)) {
    throw new TypeError("Previous pixel values must be a Map.");
  }

  const changes = [];
  for (const [index, before] of previousValues) {
    if (!Number.isInteger(index) || index < 0 || index >= currentPixels.length) {
      throw new RangeError("Previous pixel index is outside the pixel buffer.");
    }
    assertByte(before, "Previous pixel value");
    const after = currentPixels[index];
    if (before !== after) changes.push({ index, before, after });
  }
  changes.sort((first, second) => first.index - second.index);

  const indices = new Uint32Array(changes.length);
  const before = new Uint8Array(changes.length);
  const after = new Uint8Array(changes.length);
  for (let target = 0; target < changes.length; target += 1) {
    const change = changes[target];
    indices[target] = change.index;
    before[target] = change.before;
    after[target] = change.after;
  }

  return { indices, before, after };
}

/**
 * Apply one uniform value to sorted candidate indices while building a compact
 * reversible patch. This avoids a per-pixel JavaScript Map for large shapes.
 */
export function applyUniformPixelEdit(pixels, candidateIndices, afterValue) {
  assertPixels(pixels, "Pixels");
  if (!(candidateIndices instanceof Uint32Array)) {
    throw new TypeError("Candidate indices must be a Uint32Array.");
  }
  assertByte(afterValue, "After pixel value");

  let changeCount = 0;
  let previousIndex = -1;
  for (const index of candidateIndices) {
    if (index >= pixels.length) {
      throw new RangeError("Candidate pixel index is outside the pixel buffer.");
    }
    if (index <= previousIndex) {
      throw new RangeError(
        "Candidate pixel indices must be unique and strictly increasing.",
      );
    }
    previousIndex = index;
    if (pixels[index] !== afterValue) changeCount += 1;
  }

  const indices = new Uint32Array(changeCount);
  const before = new Uint8Array(changeCount);
  const after = new Uint8Array(changeCount);
  after.fill(afterValue);
  let target = 0;
  for (const index of candidateIndices) {
    if (pixels[index] === afterValue) continue;
    indices[target] = index;
    before[target] = pixels[index];
    pixels[index] = afterValue;
    target += 1;
  }
  return { indices, before, after };
}

/**
 * Apply one uniform value wherever a same-sized byte mask is non-zero while
 * building a compact reversible patch without intermediate object allocation.
 */
export function applyMaskedPixelEdit(pixels, mask, afterValue) {
  assertPixels(pixels, "Pixels");
  if (!(mask instanceof Uint8Array) || mask.length !== pixels.length) {
    throw new RangeError("Pixel mask must be a same-sized Uint8Array.");
  }
  assertByte(afterValue, "After pixel value");

  let changeCount = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    if (mask[index] && pixels[index] !== afterValue) changeCount += 1;
  }

  const indices = new Uint32Array(changeCount);
  const before = new Uint8Array(changeCount);
  const after = new Uint8Array(changeCount);
  after.fill(afterValue);
  let target = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    if (!mask[index] || pixels[index] === afterValue) continue;
    indices[target] = index;
    before[target] = pixels[index];
    pixels[index] = afterValue;
    target += 1;
  }
  return { indices, before, after };
}

/**
 * Apply a history patch in place. Undo writes its `before` snapshot; redo
 * writes its `after` snapshot. The input buffer is returned for convenience.
 */
export function applyPixelPatch(pixels, patch, direction) {
  assertPixels(pixels, "Pixels");
  assertPatch(pixels, patch);
  if (direction !== "undo" && direction !== "redo") {
    throw new RangeError('Patch direction must be either "undo" or "redo".');
  }

  const values = direction === "undo" ? patch.before : patch.after;
  for (let source = 0; source < patch.indices.length; source += 1) {
    pixels[patch.indices[source]] = values[source];
  }
  return pixels;
}
