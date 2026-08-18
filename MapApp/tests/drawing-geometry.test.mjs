import assert from "node:assert/strict";
import test from "node:test";

import {
  rasterizeRectangle,
  rasterizeThickLine,
} from "../lib/drawing-geometry.mjs";

function coordinates(indices, width) {
  return [...indices].map((index) => [index % width, Math.floor(index / width)]);
}

function assertUniqueAndSorted(indices) {
  assert.ok(indices instanceof Uint32Array);
  assert.deepEqual([...indices], [...new Set(indices)].sort((a, b) => a - b));
}

test("rasterizes inclusive horizontal, vertical, and diagonal one-pixel lines", () => {
  assert.deepEqual(
    coordinates(rasterizeThickLine(5, 5, 0, 2, 4, 2), 5),
    [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]],
  );
  assert.deepEqual(
    coordinates(rasterizeThickLine(5, 5, 2, 0, 2, 4), 5),
    [[2, 0], [2, 1], [2, 2], [2, 3], [2, 4]],
  );
  assert.deepEqual(
    coordinates(rasterizeThickLine(5, 5, 0, 0, 4, 4), 5),
    [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]],
  );
});

test("sloped lines are gap-free and independent of drag direction", () => {
  const forward = rasterizeThickLine(8, 6, 0, 0, 7, 3);
  const reverse = rasterizeThickLine(8, 6, 7, 3, 0, 0);
  const points = coordinates(forward, 8);

  assert.deepEqual(reverse, forward);
  assert.deepEqual(points[0], [0, 0]);
  assert.deepEqual(points.at(-1), [7, 3]);
  for (let index = 1; index < points.length; index += 1) {
    assert.ok(Math.abs(points[index][0] - points[index - 1][0]) <= 1);
    assert.ok(Math.abs(points[index][1] - points[index - 1][1]) <= 1);
  }
});

test("thick lines include rounded caps and return unique row-major indices", () => {
  const indices = rasterizeThickLine(7, 7, 2, 3, 4, 3, 2);

  assertUniqueAndSorted(indices);
  assert.deepEqual(coordinates(indices, 7), [
    [2, 2], [3, 2], [4, 2],
    [1, 3], [2, 3], [3, 3], [4, 3], [5, 3],
    [2, 4], [3, 4], [4, 4],
  ]);
});

test("clips lines at raster edges and returns empty results off canvas", () => {
  assert.deepEqual(
    coordinates(rasterizeThickLine(5, 4, -3, 1, 2, 1), 5),
    [[0, 1], [1, 1], [2, 1]],
  );
  assert.deepEqual(
    [...rasterizeThickLine(5, 4, -8, -8, -3, -3)],
    [],
  );
});

test("outline rectangles include four edges and leave the interior untouched", () => {
  const indices = rasterizeRectangle(6, 5, 1, 1, 4, 3);

  assertUniqueAndSorted(indices);
  assert.deepEqual(coordinates(indices, 6), [
    [1, 1], [2, 1], [3, 1], [4, 1],
    [1, 2], [4, 2],
    [1, 3], [2, 3], [3, 3], [4, 3],
  ]);
  assert.equal(indices.includes(2 * 6 + 2), false);
  assert.equal(indices.includes(2 * 6 + 3), false);
});

test("filled rectangles use inclusive bounds and normalize reverse drags", () => {
  const forward = rasterizeRectangle(6, 5, 1, 1, 3, 2, { filled: true });
  const reverse = rasterizeRectangle(6, 5, 3, 2, 1, 1, { filled: true });

  assert.deepEqual(coordinates(forward, 6), [
    [1, 1], [2, 1], [3, 1],
    [1, 2], [2, 2], [3, 2],
  ]);
  assert.deepEqual(reverse, forward);
  assertUniqueAndSorted(forward);
});

test("rectangle outlines normalize reverse drags and clip off-canvas edges", () => {
  const forward = rasterizeRectangle(5, 4, -2, -1, 2, 2);
  const reverse = rasterizeRectangle(5, 4, 2, 2, -2, -1);

  assert.deepEqual(reverse, forward);
  assertUniqueAndSorted(forward);
  assert.ok([...forward].every((index) => index < 20));
});

test("rounds finite coordinates and rejects unsafe geometry inputs", () => {
  assert.deepEqual(
    [...rasterizeThickLine(4, 4, 0.4, 0.4, 2.4, 0.4)],
    [0, 1, 2],
  );
  assert.throws(
    () => rasterizeThickLine(0, 4, 0, 0, 1, 1),
    /width.*positive integer/i,
  );
  assert.throws(
    () => rasterizeThickLine(4, 4, Number.NaN, 0, 1, 1),
    /finite number/i,
  );
  assert.throws(
    () => rasterizeRectangle(4, 4, 0, 0, 1, 1, { thickness: 0 }),
    /thickness.*greater than zero/i,
  );
});
