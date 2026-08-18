import assert from "node:assert/strict";
import test from "node:test";

import {
  clientPointToSource,
  fitZoomPercent,
  zoomAnchorScrollDelta,
} from "../lib/editor-viewport.mjs";

test("maps a CSS-scaled client point to the full-resolution source", () => {
  assert.deepEqual(
    clientPointToSource(
      500,
      250,
      { left: 100, top: 50, width: 800, height: 400 },
      1600,
      800,
    ),
    { x: 800, y: 400 },
  );
});

test("maps the same normalized point at 50, 100, and 400 percent display sizes", () => {
  const sourceWidth = 1600;
  const sourceHeight = 800;
  for (const scale of [0.5, 1, 4]) {
    const width = 800 * scale;
    const height = 400 * scale;
    assert.deepEqual(
      clientPointToSource(
        25 + width / 2,
        30 + height / 2,
        { left: 25, top: 30, width, height },
        sourceWidth,
        sourceHeight,
      ),
      { x: 800, y: 400 },
    );
  }
});

test("accounts for scrolled canvas offsets and clamps outside points", () => {
  const rect = { left: -300, top: -150, width: 1600, height: 800 };
  assert.deepEqual(clientPointToSource(500, 250, rect, 1600, 800), {
    x: 800,
    y: 400,
  });
  assert.deepEqual(clientPointToSource(-999, -999, rect, 1600, 800), {
    x: 0,
    y: 0,
  });
  assert.deepEqual(clientPointToSource(9999, 9999, rect, 1600, 800), {
    x: 1599,
    y: 799,
  });
});

test("fits large content without upscaling small content by default", () => {
  assert.equal(fitZoomPercent(1800, 1100, 900, 600), 50);
  assert.equal(fitZoomPercent(400, 300, 900, 600), 100);
  assert.equal(
    fitZoomPercent(400, 300, 900, 600, { maxPercent: 400 }),
    200,
  );
});

test("returns scroll deltas that preserve the content point under the cursor", () => {
  const scrollLeft = 100;
  const scrollTop = 50;
  const anchorX = 300;
  const anchorY = 200;
  const delta = zoomAnchorScrollDelta(
    scrollLeft,
    scrollTop,
    anchorX,
    anchorY,
    100,
    200,
  );
  const newScrollLeft = scrollLeft + delta.x;
  const newScrollTop = scrollTop + delta.y;

  assert.deepEqual(delta, { x: 400, y: 250 });
  assert.equal((scrollLeft + anchorX) / 1, (newScrollLeft + anchorX) / 2);
  assert.equal((scrollTop + anchorY) / 1, (newScrollTop + anchorY) / 2);

  const reverse = zoomAnchorScrollDelta(
    newScrollLeft,
    newScrollTop,
    anchorX,
    anchorY,
    200,
    100,
  );
  assert.equal(newScrollLeft + reverse.x, scrollLeft);
  assert.equal(newScrollTop + reverse.y, scrollTop);
  assert.deepEqual(
    zoomAnchorScrollDelta(10, 20, 30, 40, 100, 100),
    { x: 0, y: 0 },
  );
});

test("rejects invalid source, viewport, and zoom dimensions", () => {
  assert.throws(
    () =>
      clientPointToSource(
        0,
        0,
        { left: 0, top: 0, width: 0, height: 10 },
        10,
        10,
      ),
    /canvas width.*greater than zero/i,
  );
  assert.throws(
    () => fitZoomPercent(0, 10, 10, 10),
    /content width.*greater than zero/i,
  );
  assert.throws(
    () => zoomAnchorScrollDelta(0, 0, 0, 0, 0, 100),
    /previous zoom.*greater than zero/i,
  );
});
