import assert from "node:assert/strict";
import test from "node:test";

import { isMaskPixelSet } from "../lib/map-preview.mjs";

test("treats absent, clear, and out-of-range suggestion pixels as unmarked", () => {
  assert.equal(isMaskPixelSet(null, 0), false);
  assert.equal(isMaskPixelSet(undefined, 0), false);
  assert.equal(isMaskPixelSet(Uint8Array.of(0), 0), false);
  assert.equal(isMaskPixelSet(Uint8Array.of(1), 1), false);
});

test("marks only explicit non-zero suggestion pixels", () => {
  const mask = Uint8Array.of(0, 1, 0, 255);

  assert.deepEqual(
    [...mask].map((_, index) => isMaskPixelSet(mask, index)),
    [false, true, false, true],
  );
});
