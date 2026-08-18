import assert from "node:assert/strict";
import test from "node:test";

import {
  adjustOriginForCrop,
  applyRemovalMask,
  buildCleanupSuggestion,
  cropPixels,
  floodFillReachable,
  normalizeCropBounds,
  paintCircle,
  resolutionFromCalibration,
  validateCropBounds,
} from "../lib/preprocessing.mjs";

function image(width, height, value = 255) {
  const pixels = new Uint8Array(width * height);
  pixels.fill(value);
  return pixels;
}

test("normalizes reverse-drag, fractional, clamped, and edge-based crops", () => {
  assert.deepEqual(
    normalizeCropBounds(
      { x: 4.8, y: 3.2, width: -3.1, height: -2.4 },
      10,
      8,
    ),
    { x: 1, y: 0, width: 4, height: 4 },
  );

  assert.deepEqual(
    normalizeCropBounds(
      { left: -4, top: 2, right: 12, bottom: 20 },
      10,
      8,
    ),
    { x: 0, y: 2, width: 10, height: 6 },
  );

  assert.equal(
    validateCropBounds({ x: 1, y: 1, width: 2, height: 2 }, 5, 5),
    true,
  );
  assert.equal(
    validateCropBounds({ x: 8, y: 8, width: 2, height: 2 }, 5, 5),
    false,
  );
  assert.equal(
    validateCropBounds({ x: 1, y: 1, width: 0, height: 2 }, 5, 5),
    false,
  );
  assert.equal(
    validateCropBounds({ x: Number.NaN, y: 0, width: 2, height: 2 }, 5, 5),
    false,
  );
});

test("crops row-major pixels without mutating the source", () => {
  const source = Uint8Array.from({ length: 20 }, (_, index) => index);
  const original = source.slice();
  const result = cropPixels(source, 5, 4, {
    x: 1,
    y: 1,
    width: 3,
    height: 2,
  });

  assert.deepEqual(result.crop, { x: 1, y: 1, width: 3, height: 2 });
  assert.equal(result.width, 3);
  assert.equal(result.height, 2);
  assert.deepEqual([...result.pixels], [6, 7, 8, 11, 12, 13]);
  assert.deepEqual(source, original);

  assert.throws(
    () => cropPixels(Uint8Array.of(1, 2), 2, 2, result.crop),
    /length.*width × height/i,
  );
});

test("suggests light occupied pixels but leaves white and dark pixels alone", () => {
  const grayscale = Uint8Array.of(255, 254, 245, 244, 0);
  const mask = buildCleanupSuggestion(grayscale, 5, 1, {
    whiteCutoff: 255,
    lightCutoff: 245,
    minLineLength: 99,
    maxLineThickness: 1,
    maxSmallComponentArea: 0,
  });

  assert.deepEqual([...mask], [0, 1, 1, 0, 0]);
  assert.deepEqual([...grayscale], [255, 254, 245, 244, 0]);
});

test("detects long one-pixel horizontal and vertical lines", () => {
  const width = 12;
  const height = 11;
  const grayscale = image(width, height);

  for (let x = 1; x <= 9; x += 1) grayscale[2 * width + x] = 0;
  for (let y = 3; y <= 9; y += 1) grayscale[y * width + 10] = 0;

  const mask = buildCleanupSuggestion(grayscale, width, height, {
    whiteCutoff: 255,
    lightCutoff: 255,
    minLineLength: 6,
    maxLineThickness: 1,
    maxSmallComponentArea: 0,
  });

  for (let x = 1; x <= 9; x += 1) assert.equal(mask[2 * width + x], 1);
  for (let y = 3; y <= 9; y += 1) assert.equal(mask[y * width + 10], 1);
  assert.equal(mask[0], 0);
});

test("does not classify a run thicker than the configured maximum as a line", () => {
  const width = 12;
  const height = 6;
  const grayscale = image(width, height);
  for (let y = 2; y <= 3; y += 1) {
    for (let x = 1; x <= 10; x += 1) grayscale[y * width + x] = 0;
  }

  const mask = buildCleanupSuggestion(grayscale, width, height, {
    whiteCutoff: 255,
    lightCutoff: 255,
    minLineLength: 6,
    maxLineThickness: 1,
    maxSmallComponentArea: 0,
  });

  assert.equal(mask.reduce((sum, value) => sum + value, 0), 0);
});

test("suggests only dark connected components within the area limit", () => {
  const width = 9;
  const height = 6;
  const grayscale = image(width, height);

  // Two-pixel component.
  grayscale[1 * width + 1] = 0;
  grayscale[1 * width + 2] = 0;

  // Four-pixel component.
  grayscale[3 * width + 5] = 0;
  grayscale[3 * width + 6] = 0;
  grayscale[4 * width + 5] = 0;
  grayscale[4 * width + 6] = 0;

  const mask = buildCleanupSuggestion(grayscale, width, height, {
    whiteCutoff: 255,
    lightCutoff: 128,
    minLineLength: 99,
    maxLineThickness: 1,
    maxSmallComponentArea: 2,
  });

  assert.equal(mask[1 * width + 1], 1);
  assert.equal(mask[1 * width + 2], 1);
  assert.equal(mask[3 * width + 5], 0);
  assert.equal(mask[4 * width + 6], 0);
  assert.ok(mask.every((value) => value === 0 || value === 1));
});

test("validates cleanup settings", () => {
  const pixels = Uint8Array.of(255);
  assert.throws(
    () =>
      buildCleanupSuggestion(pixels, 1, 1, {
        whiteCutoff: 240,
        lightCutoff: 241,
      }),
    /lightCutoff cannot be greater/i,
  );
  assert.throws(
    () => buildCleanupSuggestion(pixels, 1, 1, { minLineLength: 0 }),
    /minLineLength/i,
  );
});

test("applies removal masks to a copy using 255 as free", () => {
  const binary = Uint8Array.of(0, 0, 255, 0);
  const mask = Uint8Array.of(0, 1, 0, 2);
  const result = applyRemovalMask(binary, mask);

  assert.deepEqual([...result], [0, 255, 255, 255]);
  assert.deepEqual([...binary], [0, 0, 255, 0]);
  assert.notEqual(result, binary);
  assert.throws(
    () => applyRemovalMask(binary, Uint8Array.of(0)),
    /equal length/i,
  );
});

test("paints clipped circular brushes in place", () => {
  const pixels = image(5, 5, 0);
  const returned = paintCircle(pixels, 5, 5, 2, 2, 1, 255);
  assert.equal(returned, pixels);

  const painted = [];
  for (let index = 0; index < pixels.length; index += 1) {
    if (pixels[index] === 255) painted.push(index);
  }
  assert.deepEqual(painted, [7, 11, 12, 13, 17]);

  paintCircle(pixels, 5, 5, 0, 0, 2, 100);
  assert.equal(pixels[0], 100);
  assert.equal(pixels[1], 100);
  assert.equal(pixels[5], 100);
  assert.throws(() => paintCircle(pixels, 5, 5, 0, 0, -1, 0), /negative/);
});

test("flood fill reports only the selected four-connected free region", () => {
  const width = 5;
  const height = 4;
  const binary = Uint8Array.of(
    255, 255, 0, 255, 255,
    255, 255, 0, 255, 255,
    0, 0, 0, 255, 0,
    255, 255, 255, 255, 0,
  );

  const left = floodFillReachable(binary, width, height, 0, 0);
  assert.equal(left.count, 4);
  assert.deepEqual([...left.mask], [
    1, 1, 0, 0, 0,
    1, 1, 0, 0, 0,
    0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ]);

  const right = floodFillReachable(binary, width, height, 3, 0);
  assert.equal(right.count, 9);
  const wall = floodFillReachable(binary, width, height, 2, 0);
  assert.equal(wall.count, 0);
  assert.ok(wall.mask.every((value) => value === 0));
});

test("flood fill handles a large open region without a per-pixel queue", () => {
  const width = 512;
  const height = 384;
  const result = floodFillReachable(image(width, height), width, height, 0, 0);
  assert.equal(result.count, width * height);
});

test("derives map resolution from a known pixel distance", () => {
  assert.equal(resolutionFromCalibration(1, 2, 4, 6, 10), 2);
  assert.throws(
    () => resolutionFromCalibration(1, 1, 1, 1, 5),
    /must be different/i,
  );
  assert.throws(
    () => resolutionFromCalibration(0, 0, 1, 0, 0),
    /greater than zero/i,
  );
});

test("adjusts cropped ROS origins in the yaw-rotated bottom-left frame", () => {
  assert.deepEqual(adjustOriginForCrop(1, 2, 0, 10, 4, 0.05), {
    x: 1.5,
    y: 2.2,
  });

  const rotated = adjustOriginForCrop(1, 2, Math.PI / 2, 10, 4, 0.05);
  assert.ok(Math.abs(rotated.x - 0.8) < 1e-12);
  assert.ok(Math.abs(rotated.y - 2.5) < 1e-12);

  assert.throws(
    () => adjustOriginForCrop(0, 0, 0, -1, 0, 0.05),
    /Left crop/i,
  );
  assert.throws(
    () => adjustOriginForCrop(0, 0, 0, 0, 0, -0.05),
    /Resolution/i,
  );
});

test("processes megapixel suggestions with fixed-size output buffers", () => {
  const width = 1250;
  const height = 800;
  const grayscale = image(width, height);
  grayscale.fill(245, 100_000, 100_100);

  const mask = buildCleanupSuggestion(grayscale, width, height, {
    whiteCutoff: 255,
    lightCutoff: 240,
    minLineLength: width + 1,
    maxLineThickness: 2,
    maxSmallComponentArea: 0,
  });

  assert.equal(mask.length, width * height);
  assert.equal(mask[100_000], 1);
  assert.equal(mask[99_999], 0);
});
