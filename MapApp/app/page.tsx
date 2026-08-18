"use client";

import {
  ChangeEvent,
  DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import CleanupEditor from "./CleanupEditor";
import {
  PDF_DEFAULT_SCALE_DENOMINATOR,
  PDF_DESIRED_RESOLUTION,
  PDF_SUPPORTED_SCALE_DENOMINATORS,
  calculatePdfRenderDpi,
  calculatePdfRenderPlan,
  isPdfFile,
  isSupportedMapFile,
  pdfErrorMessage,
} from "../lib/pdf-processing.mjs";
import { adjustOriginForCrop } from "../lib/preprocessing.mjs";
import {
  TRINARY_FREE,
  TRINARY_OCCUPIED,
  TRINARY_UNKNOWN,
  classifyExteriorUnknown,
} from "../lib/trinary-occupancy.mjs";

type ImageMeta = {
  width: number;
  height: number;
  size: number;
  name: string;
  revision: number;
};

type GeneratedFiles = {
  pgmUrl: string;
  yamlUrl: string;
  pgmName: string;
  yamlName: string;
  yamlText: string;
};

type CropBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type ProcessedMap = {
  pixels: Uint8Array;
  width: number;
  height: number;
  crop: CropBounds;
};

type PdfMeta = {
  pageCount: number;
  pageNumber: number;
  dpi: number;
  wasLimited: boolean;
  scaleDenominator: number;
  resolution: number;
};

type FinalMap = ProcessedMap & {
  revision: number;
  previewUrl: string;
  occupiedCount: number;
  unknownCount: number;
  freeCount: number;
};

type PdfSource = {
  name: string;
  size: number;
};

const DEFAULTS = {
  baseName: "ros_map",
  resolution: "0.05",
  originX: "0.0",
  originY: "0.0",
  originYaw: "0.0",
  mode: "trinary",
  negate: "0",
  occupiedThreshold: "0.65",
  freeThreshold: "0.25",
  whiteCutoff: "255",
};

const MAX_IMAGE_FILE_SIZE = 25 * 1024 * 1024;
const MAX_PDF_FILE_SIZE = 50 * 1024 * 1024;
const MAX_PREVIEW_PIXELS = 2_000_000;

function cleanBaseName(value: string) {
  return value
    .trim()
    .replace(/\.(pgm|ya?ml)$/i, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function yamlNumber(value: number) {
  if (Object.is(value, -0)) return "0.0";
  if (Number.isInteger(value)) return value.toFixed(1);
  return String(Number(value.toPrecision(12)));
}

function downloadFile(url: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function grayscaleFromCanvas(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || canvas.width === 0 || canvas.height === 0) {
    throw new Error("CanvasUnavailable");
  }

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const grayscalePixels = new Uint8Array(canvas.width * canvas.height);

  for (
    let source = 0, target = 0;
    source < imageData.data.length;
    source += 4, target += 1
  ) {
    const alpha = imageData.data[source + 3] / 255;
    const red = imageData.data[source] * alpha + 255 * (1 - alpha);
    const green = imageData.data[source + 1] * alpha + 255 * (1 - alpha);
    const blue = imageData.data[source + 2] * alpha + 255 * (1 - alpha);
    grayscalePixels[target] = Math.round(
      0.299 * red + 0.587 * green + 0.114 * blue,
    );
  }

  return grayscalePixels;
}

function canvasPreviewUrl(canvas: HTMLCanvasElement) {
  return new Promise<string>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("PreviewUnavailable"));
        return;
      }
      resolve(URL.createObjectURL(blob));
    }, "image/png");
  });
}

function previewDimensions(width: number, height: number) {
  const scale = Math.min(1, Math.sqrt(MAX_PREVIEW_PIXELS / (width * height)));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function pixelPreviewUrl(
  pixels: Uint8Array,
  width: number,
  height: number,
  transform: (value: number) => number = (value) => value,
) {
  const target = previewDimensions(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = target.width;
  canvas.height = target.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("PreviewUnavailable");

  const imageData = context.createImageData(target.width, target.height);
  for (let y = 0; y < target.height; y += 1) {
    const sourceY = Math.min(
      height - 1,
      Math.floor(((y + 0.5) * height) / target.height),
    );
    for (let x = 0; x < target.width; x += 1) {
      const sourceX = Math.min(
        width - 1,
        Math.floor(((x + 0.5) * width) / target.width),
      );
      const value = transform(pixels[sourceY * width + sourceX]);
      const targetIndex = (y * target.width + x) * 4;
      imageData.data[targetIndex] = value;
      imageData.data[targetIndex + 1] = value;
      imageData.data[targetIndex + 2] = value;
      imageData.data[targetIndex + 3] = 255;
    }
  }
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

function countTrinaryPixels(pixels: Uint8Array) {
  let occupiedCount = 0;
  let unknownCount = 0;
  let freeCount = 0;
  for (const value of pixels) {
    if (value === TRINARY_OCCUPIED) occupiedCount += 1;
    else if (value === TRINARY_UNKNOWN) unknownCount += 1;
    else if (value === TRINARY_FREE) freeCount += 1;
  }
  return { occupiedCount, unknownCount, freeCount };
}

export default function Home() {
  const [settings, setSettings] = useState(DEFAULTS);
  const [previewUrl, setPreviewUrl] = useState("");
  const [occupancyPreview, setOccupancyPreview] = useState("");
  const [previewMode, setPreviewMode] = useState<"original" | "occupancy">(
    "original",
  );
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const [editorPixels, setEditorPixels] = useState<Uint8Array | null>(null);
  const [processedMeta, setProcessedMeta] = useState<Omit<
    ProcessedMap,
    "pixels"
  > | null>(null);
  const [pdfMeta, setPdfMeta] = useState<PdfMeta | null>(null);
  const [scaleDenominator, setScaleDenominator] = useState<number>(
    PDF_DEFAULT_SCALE_DENOMINATOR,
  );
  const [confirmedScaleRevision, setConfirmedScaleRevision] = useState<
    number | null
  >(null);
  const [confirmedMapRevision, setConfirmedMapRevision] = useState<
    number | null
  >(null);
  const [finalMap, setFinalMap] = useState<FinalMap | null>(null);
  const [isPreparingFinalMap, setIsPreparingFinalMap] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [uploadRevision, setUploadRevision] = useState(0);
  const [generated, setGenerated] = useState<GeneratedFiles | null>(null);
  const [message, setMessage] = useState<{
    type: "error" | "success";
    text: string;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const grayscalePixelsRef = useRef<Uint8Array | null>(null);
  const processedMapRef = useRef<ProcessedMap | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const generatedRef = useRef<GeneratedFiles | null>(null);
  const finalMapRef = useRef<FinalMap | null>(null);
  const pdfDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const pdfLoadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const pdfRenderTaskRef = useRef<RenderTask | null>(null);
  const pdfSourceRef = useRef<PdfSource | null>(null);
  const scaleDenominatorRef = useRef(PDF_DEFAULT_SCALE_DENOMINATOR);
  const sourceRevisionRef = useRef(0);
  const renderRevisionRef = useRef(0);
  const rasterRevisionRef = useRef(0);
  const mapRevisionRef = useRef(0);

  const releaseGeneratedFiles = useCallback(() => {
    const files = generatedRef.current;
    if (files) {
      URL.revokeObjectURL(files.pgmUrl);
      URL.revokeObjectURL(files.yamlUrl);
    }
    generatedRef.current = null;
    setGenerated(null);
  }, []);

  const releaseFinalMap = useCallback(() => {
    finalMapRef.current = null;
    setFinalMap(null);
    setConfirmedMapRevision(null);
  }, []);

  const invalidateMapReview = useCallback(() => {
    mapRevisionRef.current += 1;
    releaseFinalMap();
  }, [releaseFinalMap]);

  const disposePdfDocument = useCallback(() => {
    renderRevisionRef.current += 1;
    try {
      pdfRenderTaskRef.current?.cancel();
    } catch {
      // A completed render task may already have released its worker resources.
    }
    pdfRenderTaskRef.current = null;

    const loadingTask = pdfLoadingTaskRef.current;
    const document = pdfDocumentRef.current;
    pdfLoadingTaskRef.current = null;
    pdfDocumentRef.current = null;
    pdfSourceRef.current = null;

    if (loadingTask) {
      void loadingTask.destroy().catch(() => undefined);
    } else if (document) {
      void document.cleanup().catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    return () => {
      const files = generatedRef.current;
      if (files) {
        URL.revokeObjectURL(files.pgmUrl);
        URL.revokeObjectURL(files.yamlUrl);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      sourceRevisionRef.current += 1;
      disposePdfDocument();
    };
  }, [disposePdfDocument]);

  useEffect(() => {
    const grayscalePixels = grayscalePixelsRef.current;
    const whiteCutoff = Number(settings.whiteCutoff);

    if (
      !imageMeta ||
      !grayscalePixels ||
      !Number.isInteger(whiteCutoff) ||
      whiteCutoff < 1 ||
      whiteCutoff > 255
    ) {
      setOccupancyPreview("");
      return;
    }

    const timer = window.setTimeout(() => {
      setOccupancyPreview(
        pixelPreviewUrl(
          grayscalePixels,
          imageMeta.width,
          imageMeta.height,
          (value) => (value >= whiteCutoff ? 255 : 0),
        ),
      );
    }, 150);

    return () => window.clearTimeout(timer);
  }, [imageMeta, settings.whiteCutoff]);

  const updateSetting = (key: keyof typeof DEFAULTS, value: string) => {
    setSettings((current) => ({ ...current, [key]: value }));
    if (key === "whiteCutoff") {
      processedMapRef.current = null;
      setProcessedMeta(null);
    }
    if (key === "resolution") {
      setConfirmedScaleRevision(null);
    }
    invalidateMapReview();
    releaseGeneratedFiles();
    setMessage(null);
  };

  const handleCleanupResult = useCallback(
    (result: ProcessedMap) => {
      invalidateMapReview();
      processedMapRef.current = result;
      setProcessedMeta({
        width: result.width,
        height: result.height,
        crop: result.crop,
      });
      releaseGeneratedFiles();
      setMessage(null);
    },
    [invalidateMapReview, releaseGeneratedFiles],
  );

  const handleCalibratedResolution = useCallback(
    (resolution: number) => {
      if (pdfDocumentRef.current) {
        setMessage({
          type: "error",
          text: "PDF resolution is fixed at 0.05 m/pixel. Choose the printed 1:250 or 1:400 scale instead.",
        });
        return;
      }
      setSettings((current) => ({
        ...current,
        resolution: String(Number(resolution.toPrecision(12))),
      }));
      setConfirmedScaleRevision(null);
      invalidateMapReview();
      releaseGeneratedFiles();
      setMessage(null);
    },
    [invalidateMapReview, releaseGeneratedFiles],
  );

  const commitRaster = useCallback(
    ({
      grayscalePixels,
      width,
      height,
      previewObjectUrl,
      source,
      revision,
      nextPdfMeta,
    }: {
      grayscalePixels: Uint8Array;
      width: number;
      height: number;
      previewObjectUrl: string;
      source: PdfSource;
      revision: number;
      nextPdfMeta: PdfMeta | null;
    }) => {
      if (revision !== sourceRevisionRef.current) {
        URL.revokeObjectURL(previewObjectUrl);
        return false;
      }

      releaseGeneratedFiles();
      invalidateMapReview();
      setConfirmedScaleRevision(null);
      const rasterRevision = ++rasterRevisionRef.current;
      grayscalePixelsRef.current = grayscalePixels;
      processedMapRef.current = null;
      setProcessedMeta(null);
      setEditorPixels(grayscalePixels);
      setUploadRevision((current) => current + 1);
      setPreviewUrl(previewObjectUrl);
      setPreviewMode("original");
      setPdfMeta(nextPdfMeta);
      setImageMeta({
        width,
        height,
        size: source.size,
        name: source.name,
        revision: rasterRevision,
      });

      const pageSuffix =
        nextPdfMeta && nextPdfMeta.pageCount > 1
          ? `_page_${nextPdfMeta.pageNumber}`
          : "";
      const suggestedName = cleanBaseName(
        `${source.name.replace(/\.[^.]+$/, "")}${pageSuffix}`,
      );
      setSettings((current) => ({
        ...current,
        baseName: suggestedName || current.baseName,
        // A different page or file can use a different drawing scale.
        resolution: DEFAULTS.resolution,
      }));
      return true;
    },
    [invalidateMapReview, releaseGeneratedFiles],
  );

  const renderPdfPage = useCallback(
    async (
      pdfDocument: PDFDocumentProxy,
      pageNumber: number,
      source: PdfSource,
      sourceRevision: number,
      requestedScaleDenominator: number,
    ) => {
      if (
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > pdfDocument.numPages
      ) {
        setMessage({ type: "error", text: "Choose a valid PDF page." });
        return;
      }

      const renderRevision = ++renderRevisionRef.current;
      try {
        pdfRenderTaskRef.current?.cancel();
      } catch {
        // Ignore cancellation after a render has already completed.
      }
      pdfRenderTaskRef.current = null;
      releaseGeneratedFiles();
      setConfirmedScaleRevision(null);
      invalidateMapReview();
      setMessage(null);
      setOccupancyPreview("");
      setIsLoadingFile(true);

      let page: Awaited<ReturnType<PDFDocumentProxy["getPage"]>> | null = null;
      let currentRenderTask: RenderTask | null = null;
      let previewObjectUrl = "";

      try {
        page = await pdfDocument.getPage(pageNumber);
        if (
          sourceRevision !== sourceRevisionRef.current ||
          renderRevision !== renderRevisionRef.current
        ) {
          return;
        }

        const viewportAt72Dpi = page.getViewport({ scale: 1 });
        const renderPlan = calculatePdfRenderPlan(
          viewportAt72Dpi.width,
          viewportAt72Dpi.height,
          {
            scaleDenominator: requestedScaleDenominator,
            resolution: PDF_DESIRED_RESOLUTION,
          },
        );
        const viewport = page.getViewport({ scale: renderPlan.scale });
        const canvas = document.createElement("canvas");
        canvas.width = renderPlan.width;
        canvas.height = renderPlan.height;

        const renderTask = page.render({
          canvas,
          viewport,
          background: "rgb(255, 255, 255)",
        });
        currentRenderTask = renderTask;
        pdfRenderTaskRef.current = renderTask;
        await renderTask.promise;

        if (
          sourceRevision !== sourceRevisionRef.current ||
          renderRevision !== renderRevisionRef.current
        ) {
          return;
        }

        const grayscalePixels = grayscaleFromCanvas(canvas);
        previewObjectUrl = await canvasPreviewUrl(canvas);
        if (
          sourceRevision !== sourceRevisionRef.current ||
          renderRevision !== renderRevisionRef.current
        ) {
          return;
        }
        const nextPdfMeta = {
          pageCount: pdfDocument.numPages,
          pageNumber,
          dpi: renderPlan.dpi,
          wasLimited: renderPlan.wasLimited,
          scaleDenominator: requestedScaleDenominator,
          resolution: PDF_DESIRED_RESOLUTION,
        };
        const committed = commitRaster({
          grayscalePixels,
          width: canvas.width,
          height: canvas.height,
          previewObjectUrl,
          source,
          revision: sourceRevision,
          nextPdfMeta,
        });

        if (committed) {
          previewObjectUrl = "";
          const dpiLabel = renderPlan.dpi.toLocaleString("en-US", {
            maximumFractionDigits: 3,
          });
          setMessage({
            type: "success",
            text: `PDF page ${pageNumber} of ${pdfDocument.numPages} rendered locally at ${dpiLabel} DPI for 1:${requestedScaleDenominator} and 0.05 m/pixel. Confirm the printed scale before export.`,
          });
        }
      } catch (error) {
        const errorText = pdfErrorMessage(error);
        if (
          errorText &&
          sourceRevision === sourceRevisionRef.current &&
          renderRevision === renderRevisionRef.current
        ) {
          setMessage({ type: "error", text: errorText });
        }
      } finally {
        if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
        page?.cleanup();
        if (pdfRenderTaskRef.current === currentRenderTask) {
          pdfRenderTaskRef.current = null;
        }
        if (
          sourceRevision === sourceRevisionRef.current &&
          renderRevision === renderRevisionRef.current
        ) {
          setIsLoadingFile(false);
        }
      }
    },
    [commitRaster, invalidateMapReview, releaseGeneratedFiles],
  );

  const loadPdf = async (file: File) => {
    const sourceRevision = ++sourceRevisionRef.current;
    disposePdfDocument();
    releaseGeneratedFiles();
    setConfirmedScaleRevision(null);
    invalidateMapReview();
    grayscalePixelsRef.current = null;
    processedMapRef.current = null;
    setImageMeta(null);
    setEditorPixels(null);
    setProcessedMeta(null);
    setPreviewUrl("");
    setPdfMeta(null);
    setMessage(null);
    setOccupancyPreview("");
    setIsLoadingFile(true);

    const source = { name: file.name, size: file.size };

    try {
      const [pdfjs, buffer] = await Promise.all([
        import("pdfjs-dist"),
        file.arrayBuffer(),
      ]);
      if (sourceRevision !== sourceRevisionRef.current) return;

      pdfjs.GlobalWorkerOptions.workerPort = null;
      pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
      const loadingTask = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
      });
      pdfLoadingTaskRef.current = loadingTask;
      const pdfDocument = await loadingTask.promise;

      if (sourceRevision !== sourceRevisionRef.current) {
        await loadingTask.destroy().catch(() => undefined);
        return;
      }

      if (pdfDocument.numPages < 1) {
        throw Object.assign(new Error("The PDF contains no pages."), {
          name: "InvalidPDFException",
        });
      }

      pdfDocumentRef.current = pdfDocument;
      pdfSourceRef.current = source;
      await renderPdfPage(
        pdfDocument,
        1,
        source,
        sourceRevision,
        scaleDenominatorRef.current,
      );
    } catch (error) {
      const errorText = pdfErrorMessage(error);
      if (sourceRevision === sourceRevisionRef.current) {
        const failedTask = pdfLoadingTaskRef.current;
        pdfLoadingTaskRef.current = null;
        pdfDocumentRef.current = null;
        pdfSourceRef.current = null;
        if (failedTask) {
          void failedTask.destroy().catch(() => undefined);
        }
        if (errorText) setMessage({ type: "error", text: errorText });
        setIsLoadingFile(false);
      }
    }
  };

  const loadImage = (file: File) => {
    const sourceRevision = ++sourceRevisionRef.current;
    disposePdfDocument();
    releaseGeneratedFiles();
    setConfirmedScaleRevision(null);
    invalidateMapReview();
    grayscalePixelsRef.current = null;
    processedMapRef.current = null;
    setImageMeta(null);
    setEditorPixels(null);
    setProcessedMeta(null);
    setPreviewUrl("");
    setPdfMeta(null);
    setMessage(null);
    setOccupancyPreview("");
    setIsLoadingFile(true);

    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      if (sourceRevision !== sourceRevisionRef.current) {
        URL.revokeObjectURL(objectUrl);
        return;
      }

      try {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d", { willReadFrequently: true });

        if (!context || canvas.width === 0 || canvas.height === 0) {
          throw new Error("CanvasUnavailable");
        }

        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0);
        const grayscalePixels = grayscaleFromCanvas(canvas);
        const committed = commitRaster({
          grayscalePixels,
          width: canvas.width,
          height: canvas.height,
          previewObjectUrl: objectUrl,
          source: { name: file.name, size: file.size },
          revision: sourceRevision,
          nextPdfMeta: null,
        });
        if (!committed) return;
      } catch {
        URL.revokeObjectURL(objectUrl);
        setMessage({
          type: "error",
          text: "This image could not be read. Try exporting it again.",
        });
      } finally {
        if (sourceRevision === sourceRevisionRef.current) {
          setIsLoadingFile(false);
        }
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      if (sourceRevision === sourceRevisionRef.current) {
        setIsLoadingFile(false);
        setMessage({
          type: "error",
          text: "This image could not be decoded. Choose another PNG or JPEG.",
        });
      }
    };

    image.src = objectUrl;
  };

  const loadFile = (file: File) => {
    if (!isSupportedMapFile(file)) {
      setMessage({
        type: "error",
        text: "Choose a PDF, PNG, JPG, or JPEG floor plan.",
      });
      return;
    }

    const pdf = isPdfFile(file);
    const maximumSize = pdf ? MAX_PDF_FILE_SIZE : MAX_IMAGE_FILE_SIZE;
    if (file.size > maximumSize) {
      setMessage({
        type: "error",
        text: pdf
          ? "The PDF is larger than 50 MB. Choose a smaller file."
          : "The image is larger than 25 MB. Choose a smaller file.",
      });
      return;
    }

    if (pdf) {
      void loadPdf(file);
    } else {
      loadImage(file);
    }
  };

  const selectPdfPage = (pageNumber: number) => {
    const pdfDocument = pdfDocumentRef.current;
    const source = pdfSourceRef.current;
    if (!pdfDocument || !source) return;
    setConfirmedScaleRevision(null);
    void renderPdfPage(
      pdfDocument,
      pageNumber,
      source,
      sourceRevisionRef.current,
      scaleDenominatorRef.current,
    );
  };

  const selectPrintedScale = (value: string) => {
    const nextScale = Number(value);
    if (!PDF_SUPPORTED_SCALE_DENOMINATORS.includes(nextScale)) return;
    scaleDenominatorRef.current = nextScale;
    setScaleDenominator(nextScale);
    setConfirmedScaleRevision(null);
    releaseGeneratedFiles();
    invalidateMapReview();
    setMessage(null);

    const pdfDocument = pdfDocumentRef.current;
    const source = pdfSourceRef.current;
    if (!pdfDocument || !source) return;
    void renderPdfPage(
      pdfDocument,
      pdfMeta?.pageNumber ?? 1,
      source,
      sourceRevisionRef.current,
      nextScale,
    );
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) loadFile(file);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) loadFile(file);
  };

  const prepareFinalMap = async () => {
    if (!imageMeta || confirmedScaleRevision !== imageMeta.revision) {
      setMessage({
        type: "error",
        text: pdfMeta
          ? "Confirm the selected printed PDF scale before preparing the final map."
          : "Confirm the calibrated image resolution before preparing the final map.",
      });
      return;
    }
    const processedMap = processedMapRef.current;
    if (!processedMap) {
      setMessage({
        type: "error",
        text: "Finish loading the cleanup editor before preparing the final map.",
      });
      return;
    }

    const requestedRevision = mapRevisionRef.current;
    releaseFinalMap();
    releaseGeneratedFiles();
    setIsPreparingFinalMap(true);
    setMessage(null);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    try {
      const pixels = classifyExteriorUnknown(
        processedMap.pixels,
        processedMap.width,
        processedMap.height,
      );
      const previewUrl = pixelPreviewUrl(
        pixels,
        processedMap.width,
        processedMap.height,
      );
      if (
        requestedRevision !== mapRevisionRef.current ||
        processedMapRef.current !== processedMap
      ) {
        return;
      }

      const counts = countTrinaryPixels(pixels);
      const snapshot: FinalMap = {
        pixels,
        width: processedMap.width,
        height: processedMap.height,
        crop: processedMap.crop,
        revision: requestedRevision,
        previewUrl,
        ...counts,
      };
      finalMapRef.current = snapshot;
      setFinalMap(snapshot);
      setConfirmedMapRevision(null);
      setMessage({
        type: "success",
        text: "Final black, gray, and white preview is ready. Review it before enabling export.",
      });
    } catch (error) {
      setMessage({
        type: "error",
        text:
          error instanceof Error
            ? error.message
            : "The final occupancy map could not be prepared.",
      });
    } finally {
      setIsPreparingFinalMap(false);
    }
  };

  const generateFiles = () => {
    setMessage(null);

    if (isLoadingFile) {
      setMessage({
        type: "error",
        text: "Wait for the selected floor-plan page to finish rendering.",
      });
      return;
    }

    if (!imageMeta || !grayscalePixelsRef.current) {
      setMessage({
        type: "error",
        text: "Upload a floor plan before generating files.",
      });
      return;
    }

    if (confirmedScaleRevision !== imageMeta.revision) {
      setMessage({
        type: "error",
        text: pdfMeta
          ? "Confirm that the selected printed PDF scale matches the title block."
          : "Confirm that the current image resolution matches a known distance.",
      });
      return;
    }

    const finalSnapshot = finalMapRef.current;
    if (
      !finalSnapshot ||
      finalSnapshot.revision !== mapRevisionRef.current ||
      confirmedMapRevision !== finalSnapshot.revision
    ) {
      setMessage({
        type: "error",
        text: "Prepare and confirm the current final occupancy preview before export.",
      });
      return;
    }

    const resolution = Number(settings.resolution);
    const originX = Number(settings.originX);
    const originY = Number(settings.originY);
    const originYaw = Number(settings.originYaw);
    const occupiedThreshold = Number(DEFAULTS.occupiedThreshold);
    const freeThreshold = Number(DEFAULTS.freeThreshold);
    const whiteCutoff = Number(settings.whiteCutoff);
    const baseName = cleanBaseName(settings.baseName);

    if (!Number.isFinite(resolution) || resolution <= 0) {
      setMessage({
        type: "error",
        text: "Resolution must be a number greater than zero.",
      });
      return;
    }

    if (![originX, originY, originYaw].every(Number.isFinite)) {
      setMessage({
        type: "error",
        text: "Origin X, Y, and yaw must be valid numbers.",
      });
      return;
    }

    if (
      !Number.isFinite(occupiedThreshold) ||
      !Number.isFinite(freeThreshold) ||
      occupiedThreshold < 0 ||
      occupiedThreshold > 1 ||
      freeThreshold < 0 ||
      freeThreshold > 1 ||
      freeThreshold >= occupiedThreshold
    ) {
      setMessage({
        type: "error",
        text: "Thresholds must be between 0 and 1, with free lower than occupied.",
      });
      return;
    }

    if (
      !Number.isInteger(whiteCutoff) ||
      whiteCutoff < 1 ||
      whiteCutoff > 255
    ) {
      setMessage({
        type: "error",
        text: "White cutoff must be a whole number from 1 to 255.",
      });
      return;
    }

    if (!baseName) {
      setMessage({
        type: "error",
        text: "Enter a filename using letters, numbers, dashes, or underscores.",
      });
      return;
    }

    const pgmName = `${baseName}.pgm`;
    const yamlName = `${baseName}.yaml`;
    const outputPixels = finalSnapshot.pixels;
    const outputWidth = finalSnapshot.width;
    const outputHeight = finalSnapshot.height;
    const adjustedOrigin = adjustOriginForCrop(
      originX,
      originY,
      originYaw,
      finalSnapshot.crop.left,
      imageMeta.height - finalSnapshot.crop.bottom,
      resolution,
    );
    const header = new TextEncoder().encode(
      `P5\n# Generated by MapForge ROS\n${outputWidth} ${outputHeight}\n255\n`,
    );
    const pgmBuffer = new ArrayBuffer(header.length + outputPixels.length);
    const pgmBytes = new Uint8Array(pgmBuffer);
    pgmBytes.set(header, 0);
    pgmBytes.set(outputPixels, header.length);
    const pgmBlob = new Blob([pgmBuffer], {
      type: "image/x-portable-graymap",
    });
    const yamlText = [
      `image: ${pgmName}`,
      "mode: trinary",
      `resolution: ${yamlNumber(resolution)}`,
      `origin: [${yamlNumber(adjustedOrigin.x)}, ${yamlNumber(adjustedOrigin.y)}, ${yamlNumber(originYaw)}]`,
      "negate: 0",
      `occupied_thresh: ${yamlNumber(occupiedThreshold)}`,
      `free_thresh: ${yamlNumber(freeThreshold)}`,
      "",
    ].join("\n");
    const yamlBlob = new Blob([yamlText], {
      type: "application/yaml;charset=utf-8",
    });

    releaseGeneratedFiles();
    const files = {
      pgmUrl: URL.createObjectURL(pgmBlob),
      yamlUrl: URL.createObjectURL(yamlBlob),
      pgmName,
      yamlName,
      yamlText,
    };
    generatedRef.current = files;
    setGenerated(files);
    setSettings((current) => ({ ...current, baseName }));
    setMessage({
      type: "success",
      text: "Your ROS map pair is ready to download.",
    });
  };

  const resolutionNumber = Number(settings.resolution);
  const mapWidth = processedMeta?.width ?? imageMeta?.width ?? null;
  const mapHeight = processedMeta?.height ?? imageMeta?.height ?? null;
  const physicalWidth =
    mapWidth !== null && Number.isFinite(resolutionNumber) && resolutionNumber > 0
      ? mapWidth * resolutionNumber
      : null;
  const physicalHeight =
    mapHeight !== null && Number.isFinite(resolutionNumber) && resolutionNumber > 0
      ? mapHeight * resolutionNumber
      : null;
  const selectedRenderDpi = calculatePdfRenderDpi(
    scaleDenominator,
    PDF_DESIRED_RESOLUTION,
  );
  const scaleSelectionMatchesRaster = Boolean(
    imageMeta &&
      (!pdfMeta ||
        (pdfMeta.scaleDenominator === scaleDenominator &&
          pdfMeta.resolution === PDF_DESIRED_RESOLUTION)),
  );
  const scaleIsConfirmed = Boolean(
    imageMeta &&
      scaleSelectionMatchesRaster &&
      confirmedScaleRevision === imageMeta.revision,
  );
  const mapIsConfirmed = Boolean(
    finalMap &&
      confirmedMapRevision === finalMap.revision,
  );
  const reviewReadyForExport =
    scaleIsConfirmed && mapIsConfirmed && !isLoadingFile && !isPreparingFinalMap;

  let displayedOutputOrigin: { x: number; y: number } | null = null;
  const displayedCrop = finalMap?.crop ?? processedMeta?.crop;
  if (imageMeta && displayedCrop) {
    try {
      displayedOutputOrigin = adjustOriginForCrop(
        Number(settings.originX),
        Number(settings.originY),
        Number(settings.originYaw),
        displayedCrop.left,
        imageMeta.height - displayedCrop.bottom,
        resolutionNumber,
      );
    } catch {
      displayedOutputOrigin = null;
    }
  }

  return (
    <main className="shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="MapForge ROS home">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>MapForge</span>
        </a>
        <div className="header-meta">
          <span className="status-dot" />
          ROS 2 map utility
        </div>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow">PGM + YAML GENERATOR</div>
        <h1>
          Turn a floor plan into a <em>ROS map pair.</em>
        </h1>
        <p>
          Upload an image or PDF floor plan, crop and clean drafting artifacts,
          calibrate its scale, then export a reviewed occupancy PGM with
          matching ROS 2 YAML.
        </p>
        <div className="hero-notes" aria-label="Application highlights">
          <span>Runs locally in your browser</span>
          <span>No upload to a server</span>
          <span>Nav2-style defaults</span>
        </div>
      </section>

      <section className="workspace" aria-label="Map generation workspace">
        <article className="panel preview-panel">
          <div className="panel-heading">
            <div>
              <span className="step-number">01</span>
              <h2>Map image</h2>
            </div>
            <span className="panel-kicker">PDF / PNG / JPG / JPEG</span>
          </div>

          {!imageMeta ? (
            <div
              className={`drop-zone ${isDragging ? "is-dragging" : ""} ${isLoadingFile ? "is-loading" : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              role="button"
              tabIndex={0}
              aria-busy={isLoadingFile}
            >
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                onChange={handleFileInput}
                aria-label="Upload floor plan PDF or image"
              />
              <div className="upload-glyph" aria-hidden="true">
                <span />
              </div>
              <h3>
                {isLoadingFile ? "Reading your floor plan…" : "Drop your floor plan here"}
              </h3>
              <p>PDF up to 50 MB, or PNG / JPG up to 25 MB</p>
              <button type="button" className="secondary-button" tabIndex={-1}>
                Choose file
              </button>
            </div>
          ) : (
            <div className="loaded-preview">
              <div className="preview-toolbar">
                <div className="segmented-control" aria-label="Preview mode">
                  <button
                    type="button"
                    className={previewMode === "original" ? "active" : ""}
                    onClick={() => setPreviewMode("original")}
                    aria-pressed={previewMode === "original"}
                  >
                    Original
                  </button>
                  <button
                    type="button"
                    className={previewMode === "occupancy" ? "active" : ""}
                    onClick={() => setPreviewMode("occupancy")}
                    aria-pressed={previewMode === "occupancy"}
                  >
                    Raw threshold
                  </button>
                </div>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Replace
                </button>
                <input
                  ref={fileInputRef}
                  className="visually-hidden"
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                  onChange={handleFileInput}
                  aria-label="Replace floor plan PDF or image"
                />
              </div>
              {pdfMeta && (
                <div className="pdf-page-bar" aria-label="PDF page controls">
                  <div>
                    <button
                      type="button"
                      onClick={() => selectPdfPage(pdfMeta.pageNumber - 1)}
                      disabled={isLoadingFile || pdfMeta.pageNumber <= 1}
                      aria-label="Previous PDF page"
                    >
                      ←
                    </button>
                    <strong>
                      PDF page {pdfMeta.pageNumber} of {pdfMeta.pageCount}
                    </strong>
                    <button
                      type="button"
                      onClick={() => selectPdfPage(pdfMeta.pageNumber + 1)}
                      disabled={
                        isLoadingFile || pdfMeta.pageNumber >= pdfMeta.pageCount
                      }
                      aria-label="Next PDF page"
                    >
                      →
                    </button>
                  </div>
                  <span>
                    {pdfMeta.dpi.toLocaleString("en-US", {
                      maximumFractionDigits: 3,
                    })}{" "}
                    DPI · 0.05 m/pixel
                  </span>
                </div>
              )}
              <div className="scale-review-card">
                {pdfMeta ? (
                  <>
                    <label className="scale-selector">
                      <span>Printed PDF scale</span>
                      <select
                        value={scaleDenominator}
                        onChange={(event) => selectPrintedScale(event.target.value)}
                        disabled={isLoadingFile}
                      >
                        {PDF_SUPPORTED_SCALE_DENOMINATORS.map((denominator) => (
                          <option key={denominator} value={denominator}>
                            1:{denominator}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="scale-result">
                      <span>Required render</span>
                      <strong>{selectedRenderDpi} DPI</strong>
                      <small>for 0.05 metres per pixel</small>
                    </div>
                  </>
                ) : (
                  <div className="scale-result">
                    <span>Raster image resolution</span>
                    <strong>{settings.resolution} m/pixel</strong>
                    <small>Use two known points in the editor to calibrate it.</small>
                  </div>
                )}
                <label className="review-checkbox scale-confirmation">
                  <input
                    type="checkbox"
                    checked={scaleIsConfirmed}
                    disabled={isLoadingFile || !scaleSelectionMatchesRaster}
                    onChange={(event) => {
                      setConfirmedScaleRevision(
                        event.target.checked && imageMeta
                          ? imageMeta.revision
                          : null,
                      );
                      releaseGeneratedFiles();
                      setMessage(null);
                    }}
                  />
                  <span>
                    {pdfMeta
                      ? `I checked the title block and confirm this PDF is 1:${scaleDenominator}.`
                      : "I checked a known distance and confirm this image resolution."}
                  </span>
                </label>
              </div>
              <div className={`image-stage ${isLoadingFile ? "is-rendering" : ""}`}>
                {/* A local object URL is safe here and preserves the source image exactly. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={
                    previewMode === "original"
                      ? previewUrl
                      : occupancyPreview || previewUrl
                  }
                  alt={`${previewMode === "original" ? "Original" : "Binary occupancy"} preview of ${imageMeta.name}`}
                />
                {isLoadingFile && (
                  <div className="rendering-badge" role="status">
                    Rendering PDF page…
                  </div>
                )}
              </div>
              <div className={`image-facts ${pdfMeta ? "has-pdf" : ""}`}>
                <div>
                  <span>File</span>
                  <strong title={imageMeta.name}>{imageMeta.name}</strong>
                </div>
                <div>
                  <span>Pixels</span>
                  <strong>
                    {imageMeta.width} × {imageMeta.height}
                  </strong>
                </div>
                {pdfMeta && (
                  <div>
                    <span>Source</span>
                    <strong>PDF page {pdfMeta.pageNumber}</strong>
                  </div>
                )}
                <div>
                  <span>Size</span>
                  <strong>{formatBytes(imageMeta.size)}</strong>
                </div>
              </div>
            </div>
          )}

          <div className="map-guidance">
            <span className="guidance-icon" aria-hidden="true">i</span>
            <p>
              This first preview is only the raw threshold. Use the cleanup
              editor below to review suggested removals, correct walls, test
              connectivity, and calibrate scale before export. PDF pages are
              rendered locally first; the app does not assume every PDF is a
              navigable floor plan.
            </p>
          </div>
        </article>

        {imageMeta && editorPixels && (
          <CleanupEditor
            key={uploadRevision}
            grayscalePixels={editorPixels}
            width={imageMeta.width}
            height={imageMeta.height}
            whiteCutoff={Number(settings.whiteCutoff)}
            currentResolution={resolutionNumber}
            resolutionLocked={Boolean(pdfMeta)}
            onResultChange={handleCleanupResult}
            onResolutionChange={handleCalibratedResolution}
          />
        )}

        <article className="panel settings-panel">
          <div className="panel-heading">
            <div>
              <span className="step-number">03</span>
              <h2>ROS settings</h2>
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSettings(DEFAULTS);
                setConfirmedScaleRevision(null);
                invalidateMapReview();
                releaseGeneratedFiles();
                setMessage(null);
              }}
            >
              Reset defaults
            </button>
          </div>

          <div className="form-grid">
            <label className="field field-wide">
              <span>Base filename</span>
              <div className="input-with-suffix">
                <input
                  value={settings.baseName}
                  onChange={(event) =>
                    updateSetting("baseName", event.target.value)
                  }
                  placeholder="ros_map"
                  autoComplete="off"
                />
                <span>.pgm / .yaml</span>
              </div>
            </label>

            <label className="field field-wide">
              <span>Resolution</span>
              <div className="input-with-suffix compact-suffix">
                <input
                  type="number"
                  min="0.000001"
                  step="0.01"
                  value={settings.resolution}
                  disabled={Boolean(pdfMeta)}
                  onChange={(event) =>
                    updateSetting("resolution", event.target.value)
                  }
                  inputMode="decimal"
                />
                <span>metres / pixel</span>
              </div>
              <small>
                {pdfMeta
                  ? "PDF maps are locked to the required 0.05 m/pixel; the selected printed scale controls DPI."
                  : "Use two known points in the editor to calibrate this raster image."}
              </small>
            </label>

            <fieldset className="field-group field-wide">
              <legend>Full-sheet map origin</legend>
              <div className="coordinate-grid">
                <label className="field">
                  <span>X</span>
                  <input
                    type="number"
                    step="0.1"
                    value={settings.originX}
                    onChange={(event) =>
                      updateSetting("originX", event.target.value)
                    }
                    inputMode="decimal"
                  />
                </label>
                <label className="field">
                  <span>Y</span>
                  <input
                    type="number"
                    step="0.1"
                    value={settings.originY}
                    onChange={(event) =>
                      updateSetting("originY", event.target.value)
                    }
                    inputMode="decimal"
                  />
                </label>
                <label className="field">
                  <span>Yaw</span>
                  <input
                    type="number"
                    step="0.1"
                    value={settings.originYaw}
                    onChange={(event) =>
                      updateSetting("originYaw", event.target.value)
                    }
                    inputMode="decimal"
                  />
                </label>
              </div>
              <p className="field-group-help">
                Enter the uncropped source map&apos;s lower-left pose. Export
                automatically shifts X and Y when left or bottom pixels are cropped.
              </p>
            </fieldset>

            <label className="field">
              <span>Map mode</span>
              <select
                value={settings.mode}
                disabled
                onChange={(event) => updateSetting("mode", event.target.value)}
              >
                <option value="trinary">trinary</option>
                <option value="scale">scale</option>
                <option value="raw">raw</option>
              </select>
            </label>

            <label className="field">
              <span>Negate</span>
              <select
                value={settings.negate}
                disabled
                onChange={(event) =>
                  updateSetting("negate", event.target.value)
                }
              >
                <option value="0">0 — black occupied</option>
                <option value="1">1 — white occupied</option>
              </select>
            </label>

            <label className="field field-wide">
              <span>White / free cutoff</span>
              <div className="input-with-suffix compact-suffix">
                <input
                  type="number"
                  min="1"
                  max="255"
                  step="1"
                  value={settings.whiteCutoff}
                  onChange={(event) =>
                    updateSetting("whiteCutoff", event.target.value)
                  }
                  inputMode="numeric"
                />
                <span>pixel value</span>
              </div>
              <small>
                255 keeps only pure white free. Lower it to ignore near-white
                JPEG compression noise.
              </small>
            </label>

            <label className="field">
              <span>Occupied threshold</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={settings.occupiedThreshold}
                disabled
                onChange={(event) =>
                  updateSetting("occupiedThreshold", event.target.value)
                }
                inputMode="decimal"
              />
            </label>

            <label className="field">
              <span>Free threshold</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={settings.freeThreshold}
                disabled
                onChange={(event) =>
                  updateSetting("freeThreshold", event.target.value)
                }
                inputMode="decimal"
              />
            </label>
          </div>

          {imageMeta && physicalWidth !== null && physicalHeight !== null && (
            <div className="computed-size">
              <div>
                <span>Calculated map size</span>
                <strong>
                  {physicalWidth.toFixed(2)} m × {physicalHeight.toFixed(2)} m
                </strong>
              </div>
              {displayedOutputOrigin && (
                <div>
                  <span>Output origin after crop</span>
                  <strong>
                    [{yamlNumber(displayedOutputOrigin.x)}, {yamlNumber(displayedOutputOrigin.y)}, {yamlNumber(Number(settings.originYaw))}]
                  </strong>
                </div>
              )}
            </div>
          )}

          {imageMeta && (
            <section className="final-review" aria-labelledby="final-review-title">
              <div className="final-review-heading">
                <div>
                  <span className="step-number">04</span>
                  <h3 id="final-review-title">Final navigation map</h3>
                </div>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void prepareFinalMap()}
                  disabled={
                    isLoadingFile ||
                    isPreparingFinalMap ||
                    !processedMeta ||
                    !scaleIsConfirmed
                  }
                >
                  {isPreparingFinalMap ? "Preparing…" : "Prepare final preview"}
                </button>
              </div>
              {!scaleIsConfirmed ? (
                <p>Confirm the map scale above before preparing the final map.</p>
              ) : !finalMap ? (
                <p>
                  This step turns border-connected exterior space gray. Crop close
                  to the building and repair gaps in its outer wall first.
                </p>
              ) : (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={finalMap.previewUrl}
                    alt="Final trinary occupancy preview"
                    className="final-map-preview"
                  />
                  <div className="occupancy-legend" aria-label="Occupancy colors">
                    <span><i className="occupied" />Black · occupied ({finalMap.occupiedCount.toLocaleString()})</span>
                    <span><i className="unknown" />Gray · unknown ({finalMap.unknownCount.toLocaleString()})</span>
                    <span><i className="free" />White · free ({finalMap.freeCount.toLocaleString()})</span>
                  </div>
                  <label className="review-checkbox final-confirmation">
                    <input
                      type="checkbox"
                      checked={mapIsConfirmed}
                      onChange={(event) => {
                        setConfirmedMapRevision(
                          event.target.checked ? finalMap.revision : null,
                        );
                        releaseGeneratedFiles();
                        setMessage(null);
                      }}
                    />
                    <span>
                      I reviewed this exact preview: walls are black, safe paths are
                      white, and exterior or uncertain space is gray.
                    </span>
                  </label>
                  <small>
                    Any crop, cleanup, threshold, scale, origin, or ROS setting
                    change clears this confirmation.
                  </small>
                </>
              )}
            </section>
          )}

          {message && (
            <div
              className={`notice ${message.type}`}
              role={message.type === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              <span aria-hidden="true">{message.type === "error" ? "!" : "✓"}</span>
              {message.text}
            </div>
          )}

          <button
            type="button"
            className="primary-button"
            onClick={generateFiles}
            disabled={!reviewReadyForExport}
          >
            <span>
              {isLoadingFile
                ? "Rendering floor plan…"
                : reviewReadyForExport
                  ? "Generate reviewed map files"
                  : "Complete both confirmations to export"}
            </span>
            <span aria-hidden="true">→</span>
          </button>

          {generated && (
            <div className="output-card">
              <div className="output-header">
                <div>
                  <span className="step-number">05</span>
                  <h3>Files ready</h3>
                </div>
                <span className="ready-badge">ROS pair</span>
              </div>
              <div className="download-row">
                <div>
                  <span className="file-tag">PGM</span>
                  <p>{generated.pgmName}</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    downloadFile(generated.pgmUrl, generated.pgmName)
                  }
                  aria-label={`Download ${generated.pgmName}`}
                >
                  Download
                </button>
              </div>
              <div className="download-row">
                <div>
                  <span className="file-tag yaml">YAML</span>
                  <p>{generated.yamlName}</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    downloadFile(generated.yamlUrl, generated.yamlName)
                  }
                  aria-label={`Download ${generated.yamlName}`}
                >
                  Download
                </button>
              </div>
              <details>
                <summary>Preview YAML</summary>
                <pre>{generated.yamlText}</pre>
              </details>
            </div>
          )}
        </article>
      </section>

      <section className="how-it-works" aria-labelledby="how-heading">
        <div>
          <span className="eyebrow">BEFORE YOU DRIVE</span>
          <h2 id="how-heading">Review the geometry before the robot drives.</h2>
        </div>
        <div className="checkpoints">
          <article>
            <span>1</span>
            <h3>Crop</h3>
            <p>Exclude borders, title blocks, and unused drawing space.</p>
          </article>
          <article>
            <span>2</span>
            <h3>Clean</h3>
            <p>Review red suggestions and correct false obstacles manually.</p>
          </article>
          <article>
            <span>3</span>
            <h3>Calibrate</h3>
            <p>Use two known points to calculate the real metres per pixel.</p>
          </article>
          <article>
            <span>4</span>
            <h3>Verify</h3>
            <p>Check reachability, then confirm the map and inflation in RViz.</p>
          </article>
        </div>
      </section>

      <footer>
        <span>MapForge ROS</span>
        <p>Files are generated on this device and never leave your browser.</p>
      </footer>
    </main>
  );
}
