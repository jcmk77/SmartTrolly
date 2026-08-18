import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyExteriorUnknown,
  TRINARY_FREE,
  TRINARY_OCCUPIED,
  TRINARY_UNKNOWN,
} from "../lib/trinary-occupancy.mjs";

function raster(rows) {
  const height = rows.length;
  const width = rows[0].length;
  return {
    pixels: Uint8Array.from(rows.flat()),
    width,
    height,
  };
}

function referenceExteriorUnknown(binaryPixels, width, height) {
  const result = binaryPixels.slice();
  const queue = [];
  let next = 0;

  const enqueue = (index) => {
    if (result[index] !== 255) return;
    result[index] = 127;
    queue.push(index);
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (next < queue.length) {
    const index = queue[next];
    next += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }

  return result;
}

test("marks page exterior unknown while preserving enclosed rooms and walls", () => {
  const source = raster([
    [255, 255, 255, 255, 255, 255, 255],
    [255,   0,   0,   0,   0,   0, 255],
    [255,   0, 255, 255, 255,   0, 255],
    [255,   0, 255, 255, 255,   0, 255],
    [255,   0, 255, 255, 255,   0, 255],
    [255,   0,   0,   0,   0,   0, 255],
    [255, 255, 255, 255, 255, 255, 255],
  ]);
  const original = source.pixels.slice();

  const result = classifyExteriorUnknown(
    source.pixels,
    source.width,
    source.height,
  );

  assert.deepEqual(source.pixels, original, "input must not be mutated");
  assert.equal(result[0], TRINARY_UNKNOWN);
  assert.equal(result[3 * source.width], TRINARY_UNKNOWN);
  assert.equal(result[1 * source.width + 1], TRINARY_OCCUPIED);
  assert.equal(result[3 * source.width + 3], TRINARY_FREE);
  assert.deepEqual(new Set(result), new Set([0, 127, 255]));
});

test("classifies interior white as unknown when a wall opening reaches the border", () => {
  const source = raster([
    [0, 0, 255, 0, 0],
    [0, 0, 255, 0, 0],
    [0, 255, 255, 255, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ]);

  const result = classifyExteriorUnknown(
    source.pixels,
    source.width,
    source.height,
  );

  assert.equal(result[2], TRINARY_UNKNOWN);
  assert.equal(result[2 * source.width + 2], TRINARY_UNKNOWN);
  assert.equal(result[2 * source.width + 1], TRINARY_UNKNOWN);
  assert.ok(result.every((value) => value === 0 || value === 127));
});

test("uses four-connectivity so diagonal contact does not leak through a corner", () => {
  const source = raster([
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 0],
  ]);

  const result = classifyExteriorUnknown(
    source.pixels,
    source.width,
    source.height,
  );

  assert.deepEqual([...result], [127, 0, 0, 0, 255, 0, 0, 0, 0]);
});

test("handles all-white, all-occupied, and one-dimensional rasters", () => {
  assert.deepEqual(
    [...classifyExteriorUnknown(new Uint8Array(12).fill(255), 4, 3)],
    new Array(12).fill(127),
  );
  assert.deepEqual(
    [...classifyExteriorUnknown(new Uint8Array(12), 4, 3)],
    new Array(12).fill(0),
  );
  assert.deepEqual(
    [...classifyExteriorUnknown(Uint8Array.of(255, 0, 255), 1, 3)],
    [127, 0, 127],
  );
  assert.deepEqual(
    [...classifyExteriorUnknown(Uint8Array.of(255, 0, 255), 3, 1)],
    [127, 0, 127],
  );
});

test("is deterministic and emits only occupied, unknown, or free values", () => {
  const source = raster([
    [255, 255, 0, 255],
    [255,   0, 0, 255],
    [0,     0, 255, 0],
    [255, 255, 0, 0],
  ]);
  const first = classifyExteriorUnknown(
    source.pixels,
    source.width,
    source.height,
  );
  const second = classifyExteriorUnknown(
    source.pixels,
    source.width,
    source.height,
  );

  assert.deepEqual(first, second);
  assert.ok(
    first.every(
      (value) =>
        value === TRINARY_OCCUPIED ||
        value === TRINARY_UNKNOWN ||
        value === TRINARY_FREE,
    ),
  );
});

test("matches a reference boundary BFS for every 3 by 3 binary topology", () => {
  const width = 3;
  const height = 3;
  const pixelCount = width * height;

  for (let topology = 0; topology < 2 ** pixelCount; topology += 1) {
    const pixels = Uint8Array.from(
      { length: pixelCount },
      (_, index) => ((topology >> index) & 1) === 1 ? 255 : 0,
    );
    assert.deepEqual(
      classifyExteriorUnknown(pixels, width, height),
      referenceExteriorUnknown(pixels, width, height),
      `topology ${topology.toString(2).padStart(pixelCount, "0")}`,
    );
  }
});

test("validates dimensions, length, type, and strictly binary input", () => {
  assert.throws(
    () => classifyExteriorUnknown([0, 255], 2, 1),
    /Uint8Array/,
  );
  assert.throws(
    () => classifyExteriorUnknown(Uint8Array.of(0), 0, 1),
    /width.*positive integer/i,
  );
  assert.throws(
    () => classifyExteriorUnknown(Uint8Array.of(0), 1, 1.5),
    /height.*positive integer/i,
  );
  assert.throws(
    () => classifyExteriorUnknown(Uint8Array.of(0), 2, 1),
    /length.*width × height/i,
  );
  assert.throws(
    () => classifyExteriorUnknown(Uint8Array.of(127), 1, 1),
    /only 0 or 255.*127.*index 0/i,
  );
  assert.throws(
    () =>
      classifyExteriorUnknown(
        new Uint8Array(),
        Number.MAX_SAFE_INTEGER,
        2,
      ),
    /dimensions are too large/i,
  );
});

test("processes a megapixel floor plan with exterior, walls, and enclosed free space", () => {
  const width = 1200;
  const height = 900;
  const pixels = new Uint8Array(width * height).fill(255);
  const left = 200;
  const right = 999;
  const top = 150;
  const bottom = 749;

  pixels.fill(0, top * width + left, top * width + right + 1);
  pixels.fill(0, bottom * width + left, bottom * width + right + 1);
  for (let y = top + 1; y < bottom; y += 1) {
    pixels[y * width + left] = 0;
    pixels[y * width + right] = 0;
  }

  const result = classifyExteriorUnknown(pixels, width, height);
  let occupied = 0;
  let unknown = 0;
  let free = 0;
  for (const value of result) {
    if (value === 0) occupied += 1;
    else if (value === 127) unknown += 1;
    else if (value === 255) free += 1;
    else assert.fail(`unexpected trinary value ${value}`);
  }

  const expectedWalls = (right - left + 1) * 2 + (bottom - top - 1) * 2;
  const expectedInterior = (right - left - 1) * (bottom - top - 1);
  assert.equal(occupied, expectedWalls);
  assert.equal(free, expectedInterior);
  assert.equal(unknown, width * height - expectedWalls - expectedInterior);
  assert.equal(result[0], 127);
  assert.equal(result[(top + 1) * width + left + 1], 255);
});
