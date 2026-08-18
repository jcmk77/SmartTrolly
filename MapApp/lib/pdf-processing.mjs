export const PDF_SUPPORTED_SCALE_DENOMINATORS = Object.freeze([250, 400]);
export const PDF_DEFAULT_SCALE_DENOMINATOR = 250;
export const PDF_DESIRED_RESOLUTION = 0.05;
export const PDF_MAX_PIXELS = 25_000_000;
export const PDF_MAX_DIMENSION = 6_500;

/**
 * Convert a printed architectural scale into the raster DPI needed for a ROS
 * map resolution. One paper inch represents `denominator * 0.0254` metres.
 */
export function calculatePdfRenderDpi(
  scaleDenominator,
  resolution = PDF_DESIRED_RESOLUTION,
) {
  if (!PDF_SUPPORTED_SCALE_DENOMINATORS.includes(scaleDenominator)) {
    throw new RangeError(
      `Scale denominator must be one of: ${PDF_SUPPORTED_SCALE_DENOMINATORS.join(", ")}.`,
    );
  }
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new TypeError("Desired resolution must be a positive number.");
  }
  // Normalize decimal conversion noise (for example, 1:250 at 0.05 m/px is
  // exactly 127 DPI, not 126.99999999999999) before pixel rounding.
  return Number(
    ((scaleDenominator * 0.0254) / resolution).toPrecision(12),
  );
}

export const PDF_TARGET_DPI = calculatePdfRenderDpi(
  PDF_DEFAULT_SCALE_DENOMINATOR,
);

export class PdfRenderLimitError extends RangeError {
  constructor(width, height, dpi, maxPixels, maxDimension) {
    const pixelCount = width * height;
    super(
      `The required ${width.toLocaleString("en-US")} × ${height.toLocaleString("en-US")} ` +
        `render at ${dpi.toLocaleString("en-US", { maximumFractionDigits: 3 })} DPI ` +
        `exceeds the browser limit (${maxDimension.toLocaleString("en-US")} px per side, ` +
        `${maxPixels.toLocaleString("en-US")} total pixels). ` +
        "Use a smaller sheet or choose a coarser map resolution.",
    );
    this.name = "PdfRenderLimitError";
    this.width = width;
    this.height = height;
    this.dpi = dpi;
    this.pixelCount = pixelCount;
    this.maxPixels = maxPixels;
    this.maxDimension = maxDimension;
  }
}

export function isPdfFile(file) {
  const type = String(file?.type ?? "").toLowerCase();
  const name = String(file?.name ?? "").toLowerCase();
  return type === "application/pdf" || name.endsWith(".pdf");
}

export function isSupportedMapFile(file) {
  const type = String(file?.type ?? "").toLowerCase();
  const name = String(file?.name ?? "").toLowerCase();

  return (
    isPdfFile(file) ||
    type === "image/png" ||
    type === "image/jpeg" ||
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg")
  );
}

export function calculatePdfRenderPlan(
  widthAt72Dpi,
  heightAt72Dpi,
  options = {},
) {
  const {
    targetDpi,
    scaleDenominator = PDF_DEFAULT_SCALE_DENOMINATOR,
    resolution = PDF_DESIRED_RESOLUTION,
    maxPixels = PDF_MAX_PIXELS,
    maxDimension = PDF_MAX_DIMENSION,
  } = options;
  const requiredDpi =
    targetDpi === undefined
      ? calculatePdfRenderDpi(scaleDenominator, resolution)
      : targetDpi;
  const values = [
    widthAt72Dpi,
    heightAt72Dpi,
    requiredDpi,
    maxPixels,
    maxDimension,
  ];

  if (!values.every((value) => Number.isFinite(value) && value > 0)) {
    throw new TypeError("PDF render dimensions and limits must be positive numbers.");
  }

  const scale = requiredDpi / 72;
  // PDF.js page dimensions are expressed at 72 DPI. Round to the nearest
  // output pixel so half-pixel sheet dimensions do not introduce a bias.
  const width = Math.max(1, Math.round(widthAt72Dpi * scale));
  const height = Math.max(1, Math.round(heightAt72Dpi * scale));
  if (
    width > maxDimension ||
    height > maxDimension ||
    width * height > maxPixels
  ) {
    throw new PdfRenderLimitError(
      width,
      height,
      requiredDpi,
      maxPixels,
      maxDimension,
    );
  }

  return {
    scale,
    width,
    height,
    dpi: requiredDpi,
    wasLimited: false,
  };
}

export function pdfErrorMessage(error) {
  const name = String(error?.name ?? "");

  if (name === "PdfRenderLimitError") {
    return error instanceof Error
      ? error.message
      : "This PDF sheet exceeds the browser render limit.";
  }

  if (name === "PasswordException") {
    return "This PDF is password-protected. Save an unlocked copy and try again.";
  }

  if (
    name === "InvalidPDFException" ||
    name === "FormatError" ||
    name === "MissingPDFException"
  ) {
    return "This PDF could not be read. Try exporting it again as a standard PDF.";
  }

  if (
    name === "RenderingCancelledException" ||
    name === "AbortException" ||
    name === "AbortError"
  ) {
    return "";
  }

  return "This PDF page could not be rendered. Export it as PNG or choose another PDF.";
}
