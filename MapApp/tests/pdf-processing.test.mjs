import assert from "node:assert/strict";
import test from "node:test";
import {
  PDF_DEFAULT_SCALE_DENOMINATOR,
  PDF_DESIRED_RESOLUTION,
  PDF_MAX_DIMENSION,
  PDF_MAX_PIXELS,
  PDF_SUPPORTED_SCALE_DENOMINATORS,
  PDF_TARGET_DPI,
  PdfRenderLimitError,
  calculatePdfRenderDpi,
  calculatePdfRenderPlan,
  isPdfFile,
  isSupportedMapFile,
  pdfErrorMessage,
} from "../lib/pdf-processing.mjs";

test("recognizes PDFs and preserves supported image formats", () => {
  assert.equal(isPdfFile({ name: "plan.pdf", type: "" }), true);
  assert.equal(isPdfFile({ name: "plan.bin", type: "application/pdf" }), true);
  assert.equal(isPdfFile({ name: "plan.jpg", type: "image/jpeg" }), false);

  for (const file of [
    { name: "plan.png", type: "image/png" },
    { name: "plan.jpg", type: "image/jpeg" },
    { name: "plan.JPEG", type: "" },
    { name: "plan.PDF", type: "" },
  ]) {
    assert.equal(isSupportedMapFile(file), true);
  }
  assert.equal(
    isSupportedMapFile({ name: "plan.svg", type: "image/svg+xml" }),
    false,
  );
});

test("derives render DPI from supported architectural scales", () => {
  assert.deepEqual(PDF_SUPPORTED_SCALE_DENOMINATORS, [250, 400]);
  assert.equal(PDF_DEFAULT_SCALE_DENOMINATOR, 250);
  assert.equal(PDF_DESIRED_RESOLUTION, 0.05);
  assert.equal(calculatePdfRenderDpi(250), 127);
  assert.equal(calculatePdfRenderDpi(400), 203.2);
  assert.equal(calculatePdfRenderDpi(250, 0.025), 254);
  assert.equal(PDF_TARGET_DPI, 127);

  assert.throws(() => calculatePdfRenderDpi(300), /one of: 250, 400/i);
  assert.throws(() => calculatePdfRenderDpi(250, 0), /positive number/i);
});

test("renders a 29 × 17.5 inch 1:250 sheet at 0.05 metres per pixel", () => {
  const plan = calculatePdfRenderPlan(2088, 1260);

  // Output dimensions use nearest-pixel rounding: 29 × 127 = 3683 and
  // 17.5 × 127 = 2222.5, which rounds to 2223.
  assert.equal(plan.width, 3683);
  assert.equal(plan.height, 2223);
  assert.equal(plan.dpi, 127);
  assert.equal(plan.wasLimited, false);
});

test("renders the required 1:400 large sheet without silently coarsening", () => {
  const plan = calculatePdfRenderPlan(2088, 1260, {
    scaleDenominator: 400,
  });

  assert.ok(PDF_MAX_PIXELS >= 25_000_000);
  assert.equal(plan.width, 5893);
  assert.equal(plan.height, 3556);
  assert.equal(plan.dpi, 203.2);
  assert.equal(plan.scale, 203.2 / 72);
  assert.equal(plan.wasLimited, false);
  assert.ok(plan.width <= PDF_MAX_DIMENSION);
  assert.ok(plan.height <= PDF_MAX_DIMENSION);
  assert.ok(plan.width * plan.height <= PDF_MAX_PIXELS);
});

test("throws an explicit render-limit error instead of silently coarsening", () => {
  assert.throws(
    () => calculatePdfRenderPlan(20_000, 12_000),
    (error) => {
      assert.ok(error instanceof PdfRenderLimitError);
      assert.equal(error.name, "PdfRenderLimitError");
      assert.ok(error.width > PDF_MAX_DIMENSION);
      assert.ok(error.pixelCount > PDF_MAX_PIXELS);
      assert.match(error.message, /required.*render/i);
      assert.match(error.message, /exceeds the browser limit/i);
      return true;
    },
  );

  assert.throws(
    () =>
      calculatePdfRenderPlan(3, 3, {
        targetDpi: 72,
        maxPixels: 8,
        maxDimension: 100,
      }),
    PdfRenderLimitError,
  );
});

test("rejects invalid PDF render dimensions", () => {
  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => calculatePdfRenderPlan(value, 100),
      /positive numbers/,
    );
  }
});

test("maps PDF.js failures to clear user-facing messages", () => {
  assert.match(
    pdfErrorMessage({ name: "PasswordException" }),
    /password-protected/i,
  );
  assert.match(
    pdfErrorMessage({ name: "InvalidPDFException" }),
    /could not be read/i,
  );
  assert.match(
    pdfErrorMessage({ name: "FormatError" }),
    /could not be read/i,
  );
  assert.match(
    pdfErrorMessage(
      new PdfRenderLimitError(7000, 5000, 203.2, 25_000_000, 6500),
    ),
    /exceeds the browser limit/i,
  );
  assert.match(pdfErrorMessage(new Error("unknown")), /could not be rendered/i);

  for (const name of [
    "RenderingCancelledException",
    "AbortException",
    "AbortError",
  ]) {
    assert.equal(pdfErrorMessage({ name }), "");
  }
});
