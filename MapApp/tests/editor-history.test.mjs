import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMaskedPixelEdit,
  applyPixelPatch,
  applyUniformPixelEdit,
  createPixelPatch,
} from "../lib/editor-history.mjs";

test("captures sorted before and after values while omitting no-op touches", () => {
  const current = Uint8Array.of(0, 255, 255, 0);
  const previous = new Map([
    [2, 0],
    [1, 255],
    [0, 255],
  ]);
  const patch = createPixelPatch(current, previous);

  assert.deepEqual([...patch.indices], [0, 2]);
  assert.deepEqual([...patch.before], [255, 0]);
  assert.deepEqual([...patch.after], [0, 255]);

  current[0] = 255;
  current[2] = 0;
  assert.deepEqual([...patch.after], [0, 255]);
});

test("undo and redo restore the exact pixel snapshots in place", () => {
  const pixels = Uint8Array.of(0, 255, 255, 0);
  const patch = createPixelPatch(
    pixels,
    new Map([
      [0, 255],
      [2, 0],
    ]),
  );

  assert.equal(applyPixelPatch(pixels, patch, "undo"), pixels);
  assert.deepEqual([...pixels], [255, 255, 0, 0]);
  applyPixelPatch(pixels, patch, "redo");
  assert.deepEqual([...pixels], [0, 255, 255, 0]);
});

test("empty and entirely unchanged edits create empty patches", () => {
  const pixels = Uint8Array.of(0, 255);

  for (const previous of [new Map(), new Map([[0, 0], [1, 255]])]) {
    const patch = createPixelPatch(pixels, previous);
    assert.equal(patch.indices.length, 0);
    assert.equal(patch.before.length, 0);
    assert.equal(patch.after.length, 0);
    assert.equal(applyPixelPatch(pixels, patch, "undo"), pixels);
  }
});

test("rejects malformed patches before changing any pixel", () => {
  const pixels = Uint8Array.of(0, 0);
  const outOfBounds = {
    indices: Uint32Array.of(0, 3),
    before: Uint8Array.of(255, 255),
    after: Uint8Array.of(0, 0),
  };

  assert.throws(
    () => applyPixelPatch(pixels, outOfBounds, "undo"),
    /outside the pixel buffer/i,
  );
  assert.deepEqual([...pixels], [0, 0]);

  assert.throws(
    () =>
      applyPixelPatch(
        pixels,
        {
          indices: Uint32Array.of(1, 1),
          before: Uint8Array.of(0, 0),
          after: Uint8Array.of(255, 255),
        },
        "redo",
      ),
    /unique and strictly increasing/i,
  );
  assert.throws(
    () =>
      applyPixelPatch(
        pixels,
        {
          indices: Uint32Array.of(0),
          before: Uint8Array.of(0),
          after: new Uint8Array(),
        },
        "redo",
      ),
    /equal lengths/i,
  );
});

test("validates history inputs and the requested direction", () => {
  const pixels = Uint8Array.of(0);
  const patch = createPixelPatch(pixels, new Map([[0, 255]]));

  assert.throws(() => createPixelPatch([], new Map()), /Uint8Array/i);
  assert.throws(() => createPixelPatch(pixels, {}), /must be a Map/i);
  assert.throws(
    () => createPixelPatch(pixels, new Map([[2, 0]])),
    /outside the pixel buffer/i,
  );
  assert.throws(
    () => createPixelPatch(pixels, new Map([[0, 300]])),
    /integer from 0 to 255/i,
  );
  assert.throws(
    () => applyPixelPatch(pixels, patch, "forward"),
    /undo.*redo/i,
  );
});

test("applies large uniform selections without a per-pixel Map", () => {
  const pixels = Uint8Array.of(0, 255, 0, 255, 0);
  const patch = applyUniformPixelEdit(
    pixels,
    Uint32Array.of(0, 1, 2, 4),
    255,
  );

  assert.deepEqual([...pixels], [255, 255, 255, 255, 255]);
  assert.deepEqual([...patch.indices], [0, 2, 4]);
  assert.deepEqual([...patch.before], [0, 0, 0]);
  assert.deepEqual([...patch.after], [255, 255, 255]);
  applyPixelPatch(pixels, patch, "undo");
  assert.deepEqual([...pixels], [0, 255, 0, 255, 0]);
});

test("applies masks as reversible uniform edits", () => {
  const pixels = Uint8Array.of(0, 0, 255, 0);
  const patch = applyMaskedPixelEdit(pixels, Uint8Array.of(1, 0, 1, 1), 255);

  assert.deepEqual([...pixels], [255, 0, 255, 255]);
  assert.deepEqual([...patch.indices], [0, 3]);
  applyPixelPatch(pixels, patch, "undo");
  assert.deepEqual([...pixels], [0, 0, 255, 0]);
  assert.throws(
    () => applyMaskedPixelEdit(pixels, Uint8Array.of(1), 255),
    /same-sized/,
  );
});
