"use client";

import {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  rasterizeRectangle,
  rasterizeThickLine,
} from "../lib/drawing-geometry.mjs";
import {
  applyMaskedPixelEdit,
  applyPixelPatch,
  applyUniformPixelEdit,
  createPixelPatch,
} from "../lib/editor-history.mjs";
import {
  clientPointToSource,
  fitZoomPercent,
  zoomAnchorScrollDelta,
} from "../lib/editor-viewport.mjs";
import { binarizePixels } from "../lib/map-processing.mjs";
import {
  buildCleanupSuggestion,
  cropPixels,
  floodFillReachable,
  paintCircle,
  resolutionFromCalibration,
} from "../lib/preprocessing.mjs";
import { isMaskPixelSet } from "../lib/map-preview.mjs";

type CropBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type CleanupResult = {
  pixels: Uint8Array;
  width: number;
  height: number;
  crop: CropBounds;
};

type CleanupEditorProps = {
  grayscalePixels: Uint8Array;
  width: number;
  height: number;
  whiteCutoff: number;
  currentResolution: number;
  resolutionLocked?: boolean;
  onResultChange: (result: CleanupResult) => void;
  onResolutionChange: (resolution: number) => void;
};

type Tool = "erase" | "wall" | "pan" | "reachability" | "calibration";
type DrawingShape = "freehand" | "line" | "rectangle" | "filledRectangle";
type Point = { x: number; y: number };
type HistoryPatch = {
  indices: Uint32Array;
  before: Uint8Array;
  after: Uint8Array;
};
type ShapePreview = {
  start: Point;
  end: Point;
  shape: Exclude<DrawingShape, "freehand">;
  value: 0 | 255;
  thickness: number;
};
type ActiveGesture =
  | {
      kind: "freehand";
      pointerId: number;
      value: 0 | 255;
      thickness: number;
      lastPoint: Point;
      previous: Map<number, number>;
    }
  | ({ kind: "shape"; pointerId: number } & ShapePreview)
  | {
      kind: "pan";
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startScrollLeft: number;
      startScrollTop: number;
    };

type CropInputs = Record<keyof CropBounds, string>;

const MAX_RENDER_PIXELS = 2_000_000;
const MAX_UNDO_STEPS = 30;
const MAX_HISTORY_BYTES = 96 * 1024 * 1024;
const MIN_ZOOM = 10;
const MAX_ZOOM = 800;
const ZOOM_FACTOR = 1.25;

function fullCrop(width: number, height: number): CropBounds {
  return { left: 0, top: 0, right: width, bottom: height };
}

function cropToInputs(crop: CropBounds): CropInputs {
  return {
    left: String(crop.left),
    top: String(crop.top),
    right: String(crop.right),
    bottom: String(crop.bottom),
  };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function countValue(pixels: Uint8Array, value: number) {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 1) {
    if (pixels[index] === value) count += 1;
  }
  return count;
}

function renderDimensions(width: number, height: number) {
  const scale = Math.min(1, Math.sqrt(MAX_RENDER_PIXELS / (width * height)));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function downsampleMask(
  mask: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
) {
  const targetSize = renderDimensions(sourceWidth, sourceHeight);
  if (
    targetSize.width === sourceWidth &&
    targetSize.height === sourceHeight
  ) {
    return { mask, ...targetSize };
  }

  // "Any" aggregation keeps one-pixel suggestions visible when a large map's
  // interactive preview has to be downsampled.
  const result = new Uint8Array(targetSize.width * targetSize.height);
  for (let y = 0; y < sourceHeight; y += 1) {
    const targetY = Math.min(
      targetSize.height - 1,
      Math.floor((y * targetSize.height) / sourceHeight),
    );
    for (let x = 0; x < sourceWidth; x += 1) {
      const sourceIndex = y * sourceWidth + x;
      if (!mask[sourceIndex]) continue;
      const targetX = Math.min(
        targetSize.width - 1,
        Math.floor((x * targetSize.width) / sourceWidth),
      );
      result[targetY * targetSize.width + targetX] = 1;
    }
  }
  return { mask: result, ...targetSize };
}

export default function CleanupEditor({
  grayscalePixels,
  width,
  height,
  whiteCutoff,
  currentResolution,
  resolutionLocked = false,
  onResultChange,
  onResolutionChange,
}: CleanupEditorProps) {
  const editorRef = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);
  const canvasStageRef = useRef<HTMLDivElement | null>(null);
  const grayscaleRef = useRef<Uint8Array | null>(null);
  const baselineRef = useRef<Uint8Array | null>(null);
  const pixelsRef = useRef<Uint8Array | null>(null);
  const cropRef = useRef<CropBounds>(fullCrop(width, height));
  const sizeRef = useRef({ width, height });
  const sourceRef = useRef<{
    pixels: Uint8Array;
    width: number;
    height: number;
  } | null>(null);
  const suggestionRef = useRef<Uint8Array | null>(null);
  const suggestionPreviewRef = useRef<{
    mask: Uint8Array;
    width: number;
    height: number;
  } | null>(null);
  const reachableRef = useRef<Uint8Array | null>(null);
  const historyRef = useRef<HistoryPatch[]>([]);
  const redoRef = useRef<HistoryPatch[]>([]);
  const activeGestureRef = useRef<ActiveGesture | null>(null);
  const spaceHeldRef = useRef(false);
  const zoomRef = useRef(100);
  const workspaceRevisionRef = useRef(0);
  const onResultChangeRef = useRef(onResultChange);

  const [cropInputs, setCropInputs] = useState<CropInputs>(() =>
    cropToInputs(fullCrop(width, height)),
  );
  const [workSize, setWorkSize] = useState({ width, height });
  const [tool, setTool] = useState<Tool>("erase");
  const [drawingShape, setDrawingShape] = useState<DrawingShape>("freehand");
  const [shapePreview, setShapePreview] = useState<ShapePreview | null>(null);
  const [brushSize, setBrushSize] = useState(12);
  const [zoom, setZoom] = useState(100);
  const [isPanning, setIsPanning] = useState(false);
  const [lightCutoff, setLightCutoff] = useState(210);
  const [minimumLineLength, setMinimumLineLength] = useState(80);
  const [maximumLineThickness, setMaximumLineThickness] = useState(2);
  const [maximumSmallArea, setMaximumSmallArea] = useState(64);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [reachableStats, setReachableStats] = useState<{
    count: number;
    totalFree: number;
    start: Point;
  } | null>(null);
  const [calibrationPoints, setCalibrationPoints] = useState<Point[]>([]);
  const [calibrationDistance, setCalibrationDistance] = useState("10");
  const [status, setStatus] = useState(
    "Crop the sheet first, then scan for conservative cleanup suggestions.",
  );
  const [isScanning, setIsScanning] = useState(false);
  const [revision, setRevision] = useState(0);
  const [undoCount, setUndoCount] = useState(0);
  const [redoCount, setRedoCount] = useState(0);

  useEffect(() => {
    onResultChangeRef.current = onResultChange;
  }, [onResultChange]);

  const publishResult = useCallback(() => {
    const pixels = pixelsRef.current;
    if (!pixels) return;
    onResultChangeRef.current({
      pixels: pixels.slice(),
      width: sizeRef.current.width,
      height: sizeRef.current.height,
      crop: cropRef.current,
    });
  }, []);

  const clearTransientOverlays = useCallback(() => {
    suggestionRef.current = null;
    suggestionPreviewRef.current = null;
    reachableRef.current = null;
    activeGestureRef.current = null;
    setSuggestionCount(0);
    setReachableStats(null);
    setCalibrationPoints([]);
    setShapePreview(null);
    setIsPanning(false);
  }, []);

  const replaceWorkspace = useCallback(
    (
      requestedCrop: CropBounds,
      message: string,
      preserveEdits = false,
    ) => {
      try {
        const previousPixels = pixelsRef.current;
        const previousBaseline = baselineRef.current;
        const isFullImage =
          requestedCrop.left === 0 &&
          requestedCrop.top === 0 &&
          requestedCrop.right === width &&
          requestedCrop.bottom === height;
        const result = isFullImage
          ? {
              pixels: grayscalePixels,
              width,
              height,
              crop: { x: 0, y: 0, width, height },
            }
          : cropPixels(grayscalePixels, width, height, {
              x: requestedCrop.left,
              y: requestedCrop.top,
              width: requestedCrop.right - requestedCrop.left,
              height: requestedCrop.bottom - requestedCrop.top,
            });
        const binary = binarizePixels(result.pixels, whiteCutoff);
        const resultCrop: CropBounds = {
          left: result.crop.x,
          top: result.crop.y,
          right: result.crop.x + result.crop.width,
          bottom: result.crop.y + result.crop.height,
        };
        const nextPixels = binary.slice();
        if (
          preserveEdits &&
          previousPixels?.length === nextPixels.length &&
          previousBaseline?.length === nextPixels.length
        ) {
          for (let index = 0; index < nextPixels.length; index += 1) {
            if (previousPixels[index] !== previousBaseline[index]) {
              nextPixels[index] = previousPixels[index];
            }
          }
        }

        grayscaleRef.current = result.pixels;
        baselineRef.current = binary;
        pixelsRef.current = nextPixels;
        cropRef.current = resultCrop;
        sizeRef.current = { width: result.width, height: result.height };
        historyRef.current = [];
        redoRef.current = [];
        workspaceRevisionRef.current += 1;
        setUndoCount(0);
        setRedoCount(0);
        clearTransientOverlays();
        setCropInputs(cropToInputs(resultCrop));
        setWorkSize({ width: result.width, height: result.height });
        setStatus(message);
        setRevision((current) => current + 1);

        onResultChangeRef.current({
          pixels: pixelsRef.current.slice(),
          width: result.width,
          height: result.height,
          crop: resultCrop,
        });
      } catch (error) {
        setStatus(
          error instanceof Error ? error.message : "The crop could not be applied.",
        );
      }
    },
    [clearTransientOverlays, grayscalePixels, height, whiteCutoff, width],
  );

  useEffect(() => {
    const sourceChanged =
      sourceRef.current?.pixels !== grayscalePixels ||
      sourceRef.current?.width !== width ||
      sourceRef.current?.height !== height;

    sourceRef.current = { pixels: grayscalePixels, width, height };
    const nextCrop = sourceChanged
      ? fullCrop(width, height)
      : cropRef.current;
    replaceWorkspace(
      nextCrop,
      sourceChanged
        ? "Image ready. Crop away borders and title blocks before cleanup."
        : "White cutoff changed. Manual edits were preserved; undo history was reset.",
      !sourceChanged,
    );
  }, [grayscalePixels, height, replaceWorkspace, width]);

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const pixels = pixelsRef.current;
    if (!canvas || !pixels || workSize.width < 1 || workSize.height < 1) return;

    const renderSize = renderDimensions(workSize.width, workSize.height);
    const renderWidth = renderSize.width;
    const renderHeight = renderSize.height;
    if (canvas.width !== renderWidth) canvas.width = renderWidth;
    if (canvas.height !== renderHeight) canvas.height = renderHeight;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;
    const imageData = context.createImageData(renderWidth, renderHeight);
    const suggestion = suggestionRef.current;
    const suggestionPreview = suggestionPreviewRef.current;
    const reachable = reachableRef.current;

    for (let displayY = 0; displayY < renderHeight; displayY += 1) {
      const sourceY = Math.min(
        workSize.height - 1,
        Math.floor(((displayY + 0.5) * workSize.height) / renderHeight),
      );
      for (let displayX = 0; displayX < renderWidth; displayX += 1) {
        const sourceX = Math.min(
          workSize.width - 1,
          Math.floor(((displayX + 0.5) * workSize.width) / renderWidth),
        );
        const sourceIndex = sourceY * workSize.width + sourceX;
        const targetIndex = (displayY * renderWidth + displayX) * 4;
        const value = pixels[sourceIndex];

        const isSuggested =
          suggestionPreview?.width === renderWidth &&
          suggestionPreview.height === renderHeight
            ? isMaskPixelSet(
                suggestionPreview.mask,
                displayY * renderWidth + displayX,
              )
            : isMaskPixelSet(suggestion, sourceIndex);

        if (isSuggested && value !== 255) {
          imageData.data[targetIndex] = 230;
          imageData.data[targetIndex + 1] = 63;
          imageData.data[targetIndex + 2] = 54;
        } else if (reachable?.[sourceIndex]) {
          imageData.data[targetIndex] = value === 255 ? 125 : 41;
          imageData.data[targetIndex + 1] = value === 255 ? 205 : 86;
          imageData.data[targetIndex + 2] = value === 255 ? 166 : 79;
        } else {
          imageData.data[targetIndex] = value;
          imageData.data[targetIndex + 1] = value;
          imageData.data[targetIndex + 2] = value;
        }
        imageData.data[targetIndex + 3] = 255;
      }
    }

    context.putImageData(imageData, 0, 0);
  }, [workSize.height, workSize.width]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(renderCanvas);
    return () => window.cancelAnimationFrame(frame);
  }, [renderCanvas, revision]);

  const renderPreviewCanvas = useCallback(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || workSize.width < 1 || workSize.height < 1) return;

    const renderSize = renderDimensions(workSize.width, workSize.height);
    if (canvas.width !== renderSize.width) canvas.width = renderSize.width;
    if (canvas.height !== renderSize.height) canvas.height = renderSize.height;

    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const scaleX = renderSize.width / workSize.width;
    const scaleY = renderSize.height / workSize.height;

    if (shapePreview) {
      const { start, end, shape, thickness, value } = shapePreview;
      const startX = (start.x + 0.5) * scaleX;
      const startY = (start.y + 0.5) * scaleY;
      const endX = (end.x + 0.5) * scaleX;
      const endY = (end.y + 0.5) * scaleY;
      const previewWidth = Math.max(
        1,
        thickness * ((scaleX + scaleY) / 2),
      );

      context.save();
      context.lineCap = "round";
      context.lineJoin = "round";
      context.lineWidth = previewWidth;
      context.strokeStyle =
        value === 255 ? "rgba(66, 171, 137, 0.78)" : "rgba(16, 37, 45, 0.76)";
      context.fillStyle =
        value === 255 ? "rgba(125, 205, 166, 0.44)" : "rgba(16, 37, 45, 0.46)";

      if (shape === "line") {
        context.beginPath();
        context.moveTo(startX, startY);
        context.lineTo(endX, endY);
        context.stroke();
      } else if (shape === "filledRectangle") {
        const left = Math.min(start.x, end.x) * scaleX;
        const top = Math.min(start.y, end.y) * scaleY;
        const rectangleWidth = (Math.abs(end.x - start.x) + 1) * scaleX;
        const rectangleHeight = (Math.abs(end.y - start.y) + 1) * scaleY;
        context.fillRect(left, top, rectangleWidth, rectangleHeight);
      } else {
        const left = Math.min(startX, endX);
        const top = Math.min(startY, endY);
        const rectangleWidth = Math.max(scaleX, Math.abs(endX - startX));
        const rectangleHeight = Math.max(scaleY, Math.abs(endY - startY));
        context.strokeRect(left, top, rectangleWidth, rectangleHeight);
      }
      context.restore();
    }

    if (calibrationPoints.length > 0) {
      context.save();
      context.strokeStyle = "#ff9f43";
      context.fillStyle = "#ff9f43";
      context.lineWidth = 3;
      context.setLineDash([8, 6]);
      if (calibrationPoints.length === 2) {
        context.beginPath();
        context.moveTo(
          (calibrationPoints[0].x + 0.5) * scaleX,
          (calibrationPoints[0].y + 0.5) * scaleY,
        );
        context.lineTo(
          (calibrationPoints[1].x + 0.5) * scaleX,
          (calibrationPoints[1].y + 0.5) * scaleY,
        );
        context.stroke();
      }
      context.setLineDash([]);
      for (const point of calibrationPoints) {
        context.beginPath();
        context.arc(
          (point.x + 0.5) * scaleX,
          (point.y + 0.5) * scaleY,
          6,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
      context.restore();
    }
  }, [calibrationPoints, shapePreview, workSize.height, workSize.width]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(renderPreviewCanvas);
    return () => window.cancelAnimationFrame(frame);
  }, [renderPreviewCanvas]);

  const pushHistory = useCallback((patch: HistoryPatch) => {
    if (patch.indices.length === 0) return;
    historyRef.current.push(patch);
    redoRef.current = [];
    const historyBytes = () =>
      historyRef.current.reduce(
        (total, entry) =>
          total +
          entry.indices.byteLength +
          entry.before.byteLength +
          entry.after.byteLength,
        0,
      );
    while (
      historyRef.current.length > 1 &&
      (historyRef.current.length > MAX_UNDO_STEPS ||
        historyBytes() > MAX_HISTORY_BYTES)
    ) {
      historyRef.current.shift();
    }
    setUndoCount(historyRef.current.length);
    setRedoCount(0);
  }, []);

  const pointFromEvent = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): Point =>
    clientPointToSource(
      event.clientX,
      event.clientY,
      event.currentTarget.getBoundingClientRect(),
      workSize.width,
      workSize.height,
    );

  const recordPaintAt = useCallback(
    (
      point: Point,
      value: 0 | 255,
      thickness: number,
      previous: Map<number, number>,
    ) => {
      const pixels = pixelsRef.current;
      if (!pixels) return;

      const radius = Math.max(0.5, thickness / 2);
      const xStart = Math.max(0, Math.floor(point.x - radius));
      const xEnd = Math.min(workSize.width - 1, Math.ceil(point.x + radius));
      const yStart = Math.max(0, Math.floor(point.y - radius));
      const yEnd = Math.min(workSize.height - 1, Math.ceil(point.y + radius));
      const radiusSquared = radius * radius;

      for (let y = yStart; y <= yEnd; y += 1) {
        for (let x = xStart; x <= xEnd; x += 1) {
          const deltaX = x - point.x;
          const deltaY = y - point.y;
          if (deltaX * deltaX + deltaY * deltaY > radiusSquared) continue;
          const index = y * workSize.width + x;
          if (pixels[index] !== value && !previous.has(index)) {
            previous.set(index, pixels[index]);
          }
        }
      }

      paintCircle(
        pixels,
        workSize.width,
        workSize.height,
        point.x,
        point.y,
        radius,
        value,
      );
    },
    [workSize.height, workSize.width],
  );

  const paintSegment = useCallback(
    (
      from: Point,
      to: Point,
      value: 0 | 255,
      thickness: number,
      previous: Map<number, number>,
    ) => {
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const spacing = Math.max(1, thickness * 0.3);
      const steps = Math.max(1, Math.ceil(distance / spacing));
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        recordPaintAt(
          {
            x: Math.round(from.x + (to.x - from.x) * progress),
            y: Math.round(from.y + (to.y - from.y) * progress),
          },
          value,
          thickness,
          previous,
        );
      }
    },
    [recordPaintAt],
  );

  const commitPreviousValues = useCallback(
    (previous: Map<number, number>, description: (count: number) => string) => {
      const pixels = pixelsRef.current;
      if (!pixels) return false;
      const patch = createPixelPatch(pixels, previous) as HistoryPatch;
      if (patch.indices.length === 0) return false;

      pushHistory(patch);
      reachableRef.current = null;
      setReachableStats(null);
      setStatus(description(patch.indices.length));
      setRevision((current) => current + 1);
      publishResult();
      return true;
    },
    [publishResult, pushHistory],
  );

  const commitPatch = useCallback(
    (patch: HistoryPatch, description: (count: number) => string) => {
      if (patch.indices.length === 0) return false;
      pushHistory(patch);
      reachableRef.current = null;
      setReachableStats(null);
      setStatus(description(patch.indices.length));
      setRevision((current) => current + 1);
      publishResult();
      return true;
    },
    [publishResult, pushHistory],
  );

  const commitShape = useCallback(
    (gesture: Extract<ActiveGesture, { kind: "shape" }>) => {
      const pixels = pixelsRef.current;
      if (!pixels) return;

      const indices =
        gesture.shape === "line"
          ? rasterizeThickLine(
              workSize.width,
              workSize.height,
              gesture.start.x,
              gesture.start.y,
              gesture.end.x,
              gesture.end.y,
              gesture.thickness,
            )
          : rasterizeRectangle(
              workSize.width,
              workSize.height,
              gesture.start.x,
              gesture.start.y,
              gesture.end.x,
              gesture.end.y,
              {
                filled: gesture.shape === "filledRectangle",
                thickness: gesture.thickness,
              },
            );
      const patch = applyUniformPixelEdit(
        pixels,
        indices,
        gesture.value,
      ) as HistoryPatch;

      const shapeName =
        gesture.shape === "line"
          ? "line"
          : gesture.shape === "filledRectangle"
            ? "filled rectangle"
            : "rectangle";
      commitPatch(patch, (count) =>
        gesture.value === 255
          ? `Erased ${count.toLocaleString()} pixels with a ${shapeName}.`
          : `Drew ${count.toLocaleString()} wall pixels with a ${shapeName}.`,
      );
    },
    [commitPatch, workSize.height, workSize.width],
  );

  const cancelActiveGesture = useCallback(() => {
    const gesture = activeGestureRef.current;
    const pixels = pixelsRef.current;
    if (gesture?.kind === "freehand" && pixels) {
      for (const [index, value] of gesture.previous) pixels[index] = value;
      if (gesture.previous.size > 0) {
        setRevision((current) => current + 1);
      }
    }
    activeGestureRef.current = null;
    setShapePreview(null);
    setIsPanning(false);
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      !pixelsRef.current ||
      activeGestureRef.current ||
      (event.pointerType === "mouse" && event.button !== 0)
    ) {
      return;
    }
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });

    if (tool === "pan" || spaceHeldRef.current) {
      const viewport = canvasScrollRef.current;
      if (!viewport) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      activeGestureRef.current = {
        kind: "pan",
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: viewport.scrollLeft,
        startScrollTop: viewport.scrollTop,
      };
      setIsPanning(true);
      return;
    }

    const point = pointFromEvent(event);

    if (tool === "reachability") {
      const result = floodFillReachable(
        pixelsRef.current,
        workSize.width,
        workSize.height,
        point.x,
        point.y,
      );
      reachableRef.current = result.mask;
      const totalFree = countValue(pixelsRef.current, 255);
      setReachableStats({ count: result.count, totalFree, start: point });
      setStatus(
        result.count > 0
          ? `Highlighted ${result.count.toLocaleString()} reachable free pixels.`
          : "That point is a wall. Select a white pixel to test connectivity.",
      );
      setRevision((current) => current + 1);
      return;
    }

    if (tool === "calibration") {
      setCalibrationPoints((current) =>
        current.length >= 2 ? [point] : [...current, point],
      );
      setStatus(
        calibrationPoints.length === 1
          ? "Two calibration points selected. Enter their real distance."
          : "Select the second endpoint of a known distance.",
      );
      return;
    }

    if (tool !== "erase" && tool !== "wall") return;

    event.currentTarget.setPointerCapture(event.pointerId);
    const value: 0 | 255 = tool === "erase" ? 255 : 0;
    if (drawingShape === "freehand") {
      const previous = new Map<number, number>();
      activeGestureRef.current = {
        kind: "freehand",
        pointerId: event.pointerId,
        value,
        thickness: brushSize,
        lastPoint: point,
        previous,
      };
      recordPaintAt(point, value, brushSize, previous);
      setRevision((current) => current + 1);
      return;
    }

    const preview: ShapePreview = {
      start: point,
      end: point,
      shape: drawingShape,
      value,
      thickness: brushSize,
    };
    activeGestureRef.current = {
      kind: "shape",
      pointerId: event.pointerId,
      ...preview,
    };
    setShapePreview(preview);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = activeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();

    if (gesture.kind === "pan") {
      const viewport = canvasScrollRef.current;
      if (!viewport) return;
      viewport.scrollLeft =
        gesture.startScrollLeft - (event.clientX - gesture.startClientX);
      viewport.scrollTop =
        gesture.startScrollTop - (event.clientY - gesture.startClientY);
      return;
    }

    const point = pointFromEvent(event);
    if (gesture.kind === "freehand") {
      paintSegment(
        gesture.lastPoint,
        point,
        gesture.value,
        gesture.thickness,
        gesture.previous,
      );
      gesture.lastPoint = point;
      setRevision((current) => current + 1);
      return;
    }

    gesture.end = point;
    setShapePreview({
      start: gesture.start,
      end: point,
      shape: gesture.shape,
      value: gesture.value,
      thickness: gesture.thickness,
    });
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = activeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    activeGestureRef.current = null;

    if (gesture.kind === "pan") {
      setIsPanning(false);
      return;
    }

    if (gesture.kind === "freehand") {
      commitPreviousValues(gesture.previous, (count) =>
        gesture.value === 255
          ? `Erased ${count.toLocaleString()} source pixels.`
          : `Drew ${count.toLocaleString()} wall pixels.`,
      );
      return;
    }

    const completedGesture = {
      ...gesture,
      end: pointFromEvent(event),
    };
    setShapePreview(null);
    commitShape(completedGesture);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = activeGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    cancelActiveGesture();
    setStatus("Pending map edit cancelled without changing the saved map.");
  };

  const applyCrop = () => {
    const parsed: CropBounds = {
      left: Number(cropInputs.left),
      top: Number(cropInputs.top),
      right: Number(cropInputs.right),
      bottom: Number(cropInputs.bottom),
    };
    if (!Object.values(parsed).every(Number.isInteger)) {
      setStatus("Crop bounds must be whole pixel coordinates.");
      return;
    }
    replaceWorkspace(parsed, "Crop applied. Manual edits and overlays were reset.");
  };

  const scanForCleanup = () => {
    const grayscale = grayscaleRef.current;
    if (!grayscale) return;
    if (
      !Number.isInteger(lightCutoff) ||
      lightCutoff < 0 ||
      lightCutoff >= whiteCutoff ||
      !Number.isInteger(minimumLineLength) ||
      minimumLineLength < 2 ||
      !Number.isInteger(maximumLineThickness) ||
      maximumLineThickness < 1 ||
      !Number.isInteger(maximumSmallArea) ||
      maximumSmallArea < 0
    ) {
      setStatus(
        "Scan values must be whole numbers; light cutoff must be below the white cutoff.",
      );
      return;
    }

    const scanWorkspaceRevision = workspaceRevisionRef.current;
    setIsScanning(true);
    setStatus("Scanning light marks, thin lines, and small components…");
    window.requestAnimationFrame(() => {
      try {
        const mask = buildCleanupSuggestion(
          grayscale,
          workSize.width,
          workSize.height,
          {
            whiteCutoff,
            lightCutoff,
            minLineLength: minimumLineLength,
            maxLineThickness: maximumLineThickness,
            maxSmallComponentArea: maximumSmallArea,
          },
        );
        if (workspaceRevisionRef.current !== scanWorkspaceRevision) return;
        const count = countValue(mask, 1);
        suggestionRef.current = mask;
        suggestionPreviewRef.current = downsampleMask(
          mask,
          workSize.width,
          workSize.height,
        );
        setSuggestionCount(count);
        setStatus(
          count > 0
            ? `${count.toLocaleString()} pixels are suggested in red. Review before applying.`
            : "No removable marks were found with these conservative settings.",
        );
        setRevision((current) => current + 1);
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Cleanup scan failed.");
      } finally {
        setIsScanning(false);
      }
    });
  };

  const applySuggestions = () => {
    if (activeGestureRef.current) cancelActiveGesture();
    const pixels = pixelsRef.current;
    const mask = suggestionRef.current;
    if (!pixels || !mask || suggestionCount === 0) return;

    const patch = applyMaskedPixelEdit(pixels, mask, 255) as HistoryPatch;
    if (patch.indices.length > 0) pushHistory(patch);
    suggestionRef.current = null;
    suggestionPreviewRef.current = null;
    reachableRef.current = null;
    setSuggestionCount(0);
    setReachableStats(null);
    setStatus(
      `Applied cleanup to ${patch.indices.length.toLocaleString()} wall pixels.`,
    );
    setRevision((current) => current + 1);
    if (patch.indices.length > 0) publishResult();
  };

  const clearSuggestions = () => {
    suggestionRef.current = null;
    suggestionPreviewRef.current = null;
    setSuggestionCount(0);
    setStatus("Cleanup suggestions cleared without changing the map.");
    setRevision((current) => current + 1);
  };

  const undo = useCallback(() => {
    if (activeGestureRef.current) cancelActiveGesture();
    const pixels = pixelsRef.current;
    const patch = historyRef.current.pop();
    if (!pixels || !patch) return;
    applyPixelPatch(pixels, patch, "undo");
    redoRef.current.push(patch);
    if (redoRef.current.length > MAX_UNDO_STEPS) redoRef.current.shift();
    reachableRef.current = null;
    setReachableStats(null);
    setUndoCount(historyRef.current.length);
    setRedoCount(redoRef.current.length);
    setStatus("Last cleanup edit undone.");
    setRevision((current) => current + 1);
    publishResult();
  }, [cancelActiveGesture, publishResult]);

  const redo = useCallback(() => {
    if (activeGestureRef.current) cancelActiveGesture();
    const pixels = pixelsRef.current;
    const patch = redoRef.current.pop();
    if (!pixels || !patch) return;
    applyPixelPatch(pixels, patch, "redo");
    historyRef.current.push(patch);
    if (historyRef.current.length > MAX_UNDO_STEPS) historyRef.current.shift();
    reachableRef.current = null;
    setReachableStats(null);
    setUndoCount(historyRef.current.length);
    setRedoCount(redoRef.current.length);
    setStatus("Last undone map edit restored.");
    setRevision((current) => current + 1);
    publishResult();
  }, [cancelActiveGesture, publishResult]);

  const resetEdits = () => {
    const baseline = baselineRef.current;
    if (!baseline) return;
    pixelsRef.current = baseline.slice();
    historyRef.current = [];
    redoRef.current = [];
    setUndoCount(0);
    setRedoCount(0);
    clearTransientOverlays();
    setStatus("All edits in the current crop were reset.");
    setRevision((current) => current + 1);
    publishResult();
  };

  const applyCalibration = () => {
    const distance = Number(calibrationDistance);
    if (calibrationPoints.length !== 2) {
      setStatus("Select two calibration endpoints on the map first.");
      return;
    }
    if (!Number.isFinite(distance) || distance <= 0) {
      setStatus("Known distance must be a number greater than zero.");
      return;
    }
    try {
      const [first, second] = calibrationPoints;
      const resolution = resolutionFromCalibration(
        first.x,
        first.y,
        second.x,
        second.y,
        distance,
      );
      onResolutionChange(resolution);
      setStatus(`Resolution calibrated to ${resolution.toPrecision(8)} m/pixel.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Calibration failed.");
    }
  };

  const changeZoom = useCallback(
    (requestedZoom: number, anchor?: { clientX: number; clientY: number }) => {
      const previousZoom = zoomRef.current;
      const nextZoom = clamp(
        Math.round(requestedZoom),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      if (nextZoom === previousZoom) return;

      const viewport = canvasScrollRef.current;
      const stage = canvasStageRef.current;
      let scrollDelta: { x: number; y: number } | null = null;
      if (viewport && stage) {
        const viewportRect = viewport.getBoundingClientRect();
        const anchorX = anchor
          ? anchor.clientX - viewportRect.left
          : viewport.clientWidth / 2;
        const anchorY = anchor
          ? anchor.clientY - viewportRect.top
          : viewport.clientHeight / 2;
        scrollDelta = zoomAnchorScrollDelta(
          viewport.scrollLeft - stage.offsetLeft,
          viewport.scrollTop - stage.offsetTop,
          anchorX,
          anchorY,
          previousZoom,
          nextZoom,
        );
      }

      zoomRef.current = nextZoom;
      setZoom(nextZoom);
      if (viewport && scrollDelta) {
        window.requestAnimationFrame(() => {
          viewport.scrollLeft += scrollDelta.x;
          viewport.scrollTop += scrollDelta.y;
        });
      }
    },
    [],
  );

  const zoomBy = useCallback(
    (factor: number, anchor?: { clientX: number; clientY: number }) => {
      const requested = Math.round((zoomRef.current * factor) / 5) * 5;
      changeZoom(requested, anchor);
    },
    [changeZoom],
  );

  const fitToView = useCallback(() => {
    const viewport = canvasScrollRef.current;
    if (!viewport) return;
    const renderSize = renderDimensions(workSize.width, workSize.height);
    const usableWidth = Math.max(1, viewport.clientWidth - 28);
    const usableHeight = Math.max(1, viewport.clientHeight - 28);
    const fitted = fitZoomPercent(
      renderSize.width,
      renderSize.height,
      usableWidth,
      usableHeight,
      { maxPercent: 100 },
    );
    const nextZoom = clamp(Math.floor(fitted), MIN_ZOOM, 100);
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
    window.requestAnimationFrame(() => {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
    });
  }, [workSize.height, workSize.width]);

  useEffect(() => {
    const viewport = canvasScrollRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.deltaY === 0) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR, {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    };

    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [zoomBy]);

  const handleStageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const viewport = canvasScrollRef.current;
    if (event.code === "Space") {
      event.preventDefault();
      spaceHeldRef.current = true;
      return;
    }
    if (event.key === "Escape" && activeGestureRef.current) {
      event.preventDefault();
      cancelActiveGesture();
      setStatus("Pending map edit cancelled without changing the saved map.");
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(ZOOM_FACTOR);
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      zoomBy(1 / ZOOM_FACTOR);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      fitToView();
      return;
    }
    if (!viewport) return;

    const scrollStep = event.shiftKey ? 120 : 40;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      viewport.scrollLeft += event.key === "ArrowLeft" ? -scrollStep : scrollStep;
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      viewport.scrollTop += event.key === "ArrowUp" ? -scrollStep : scrollStep;
    }
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(fitToView);
    return () => window.cancelAnimationFrame(frame);
  }, [fitToView]);

  useEffect(() => {
    if (activeGestureRef.current) cancelActiveGesture();
  }, [cancelActiveGesture, drawingShape, tool]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : null;
      return Boolean(
        element?.isContentEditable ||
          element?.closest("input, textarea, select, [contenteditable='true']"),
      );
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.code === "Space") {
        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLElement &&
          editorRef.current?.contains(activeElement)
        ) {
          event.preventDefault();
          spaceHeldRef.current = true;
        }
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (activeGestureRef.current) {
          cancelActiveGesture();
        } else if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if (key === "y") {
        event.preventDefault();
        if (activeGestureRef.current) {
          cancelActiveGesture();
        } else {
          redo();
        }
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceHeldRef.current = false;
    };
    const handleBlur = () => {
      spaceHeldRef.current = false;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, [cancelActiveGesture, redo, undo]);

  const calibrationPixelDistance =
    calibrationPoints.length === 2
      ? Math.hypot(
          calibrationPoints[1].x - calibrationPoints[0].x,
          calibrationPoints[1].y - calibrationPoints[0].y,
        )
      : null;

  const previewSize = renderDimensions(workSize.width, workSize.height);
  const stageWidth = Math.max(1, Math.round((previewSize.width * zoom) / 100));
  const stageHeight = Math.max(
    1,
    Math.round((previewSize.height * zoom) / 100),
  );

  return (
    <section
      ref={editorRef}
      className="cleanup-editor"
      aria-labelledby="cleanup-title"
    >
      <div className="cleanup-heading">
        <div>
          <span className="cleanup-step">02 · CLEAN &amp; CALIBRATE</span>
          <h2 id="cleanup-title">Clean the navigation map</h2>
        </div>
        <p>
          Suggestions never change the map until you apply them. Red marks are
          candidates—not confirmed annotations.
        </p>
      </div>

      <fieldset className="cleanup-section cleanup-crop-controls">
        <legend>1. Crop the sheet</legend>
        <p className="cleanup-help">
          Coordinates use the original image. Right and bottom are exclusive.
          Keep only the building area when possible.
        </p>
        <div className="cleanup-field-grid">
          {(["left", "top", "right", "bottom"] as const).map((edge) => (
            <label className="cleanup-field" key={edge}>
              <span>{edge[0].toUpperCase() + edge.slice(1)} (px)</span>
              <input
                type="number"
                min={0}
                max={edge === "left" || edge === "right" ? width : height}
                step={1}
                value={cropInputs[edge]}
                onChange={(event) =>
                  setCropInputs((current) => ({
                    ...current,
                    [edge]: event.target.value,
                  }))
                }
              />
            </label>
          ))}
        </div>
        <div className="cleanup-actions">
          <button type="button" onClick={applyCrop} className="cleanup-primary">
            Apply crop
          </button>
          <button
            type="button"
            onClick={() =>
              replaceWorkspace(
                fullCrop(width, height),
                "Full image restored. Manual edits and overlays were reset.",
              )
            }
            className="cleanup-secondary"
          >
            Reset crop
          </button>
          <span className="cleanup-dimensions">
            Working area: {workSize.width.toLocaleString()} ×{" "}
            {workSize.height.toLocaleString()} px
          </span>
        </div>
      </fieldset>

      <fieldset className="cleanup-section cleanup-scan-controls">
        <legend>2. Review automatic suggestions</legend>
        <p className="cleanup-help">
          This conservative scan targets light annotations, thin horizontal or
          vertical lines, and small isolated components. It cannot understand
          architectural meaning.
        </p>
        <div className="cleanup-field-grid">
          <label className="cleanup-field">
            <span>Light cutoff</span>
            <input
              type="number"
              min={0}
              max={Math.max(0, whiteCutoff - 1)}
              step={1}
              value={lightCutoff}
              onChange={(event) => setLightCutoff(Number(event.target.value))}
            />
          </label>
          <label className="cleanup-field">
            <span>Minimum line length (px)</span>
            <input
              type="number"
              min={2}
              step={1}
              value={minimumLineLength}
              onChange={(event) =>
                setMinimumLineLength(Number(event.target.value))
              }
            />
          </label>
          <label className="cleanup-field">
            <span>Maximum line thickness (px)</span>
            <input
              type="number"
              min={1}
              step={1}
              value={maximumLineThickness}
              onChange={(event) =>
                setMaximumLineThickness(Number(event.target.value))
              }
            />
          </label>
          <label className="cleanup-field">
            <span>Maximum small area (px²)</span>
            <input
              type="number"
              min={0}
              step={1}
              value={maximumSmallArea}
              onChange={(event) => setMaximumSmallArea(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="cleanup-actions">
          <button
            type="button"
            onClick={scanForCleanup}
            disabled={isScanning}
            className="cleanup-primary"
          >
            {isScanning ? "Scanning…" : "Scan and preview"}
          </button>
          <button
            type="button"
            onClick={applySuggestions}
            disabled={suggestionCount === 0 || isScanning}
            className="cleanup-danger"
          >
            Apply red removals
          </button>
          <button
            type="button"
            onClick={clearSuggestions}
            disabled={suggestionCount === 0}
            className="cleanup-secondary"
          >
            Clear preview
          </button>
          {suggestionCount > 0 && (
            <span className="cleanup-suggestion-count">
              {suggestionCount.toLocaleString()} suggested pixels
            </span>
          )}
        </div>
      </fieldset>

      <div className="cleanup-section cleanup-manual-section">
        <div className="cleanup-tool-heading">
          <div>
            <h3>3. Correct and validate manually</h3>
            <p className="cleanup-help" id="cleanup-canvas-help">
              White erases obstacles; black restores walls. Use Brush for
              freehand edits or drag a Line or Rectangle for straight geometry.
              Pan with the Pan tool or hold Space. Connectivity is only a
              topology check; it does not include robot footprint or inflation.
            </p>
          </div>
          <div className="cleanup-zoom-control">
            <label htmlFor="cleanup-zoom">Zoom</label>
            <input
              id="cleanup-zoom"
              type="range"
              min={MIN_ZOOM}
              max={MAX_ZOOM}
              step={10}
              value={zoom}
              onChange={(event) => changeZoom(Number(event.target.value))}
            />
            <output htmlFor="cleanup-zoom">{zoom}%</output>
            <div className="cleanup-zoom-buttons" aria-label="Zoom controls">
              <button
                type="button"
                className="cleanup-zoom-button"
                aria-label="Zoom out"
                onClick={() => zoomBy(1 / ZOOM_FACTOR)}
              >
                −
              </button>
              <button
                type="button"
                className="cleanup-zoom-button"
                aria-label="Zoom in"
                onClick={() => zoomBy(ZOOM_FACTOR)}
              >
                +
              </button>
              <button
                type="button"
                className="cleanup-zoom-button"
                onClick={fitToView}
              >
                Fit
              </button>
            </div>
          </div>
        </div>

        <div className="cleanup-toolbar" role="toolbar" aria-label="Map editing tools">
          <button
            type="button"
            aria-pressed={tool === "erase"}
            className={tool === "erase" ? "cleanup-tool-active" : ""}
            onClick={() => setTool("erase")}
          >
            White eraser
          </button>
          <button
            type="button"
            aria-pressed={tool === "wall"}
            className={tool === "wall" ? "cleanup-tool-active" : ""}
            onClick={() => setTool("wall")}
          >
            Black wall
          </button>
          <button
            type="button"
            aria-pressed={tool === "pan"}
            className={tool === "pan" ? "cleanup-tool-active" : ""}
            onClick={() => setTool("pan")}
          >
            Pan
          </button>
          <button
            type="button"
            aria-pressed={tool === "reachability"}
            className={tool === "reachability" ? "cleanup-tool-active" : ""}
            onClick={() => setTool("reachability")}
          >
            Reachability start
          </button>
          <button
            type="button"
            aria-pressed={tool === "calibration"}
            className={tool === "calibration" ? "cleanup-tool-active" : ""}
            onClick={() => setTool("calibration")}
            disabled={resolutionLocked}
            title={
              resolutionLocked
                ? "PDF resolution is determined by the confirmed printed scale."
                : undefined
            }
          >
            Scale endpoints
          </button>
          <div className="cleanup-shape-group" role="group" aria-label="Drawing shape">
            <span className="cleanup-shape-label">Shape</span>
            {(
              [
                ["freehand", "Brush"],
                ["line", "Line"],
                ["rectangle", "Rectangle"],
                ["filledRectangle", "Filled rectangle"],
              ] as const
            ).map(([shape, label]) => (
              <button
                type="button"
                key={shape}
                aria-pressed={drawingShape === shape}
                className={drawingShape === shape ? "cleanup-tool-active" : ""}
                disabled={tool !== "erase" && tool !== "wall"}
                onClick={() => setDrawingShape(shape)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="cleanup-brush-field">
            Width
            <input
              type="number"
              min={1}
              max={500}
              step={1}
              value={brushSize}
              disabled={
                (tool !== "erase" && tool !== "wall") ||
                drawingShape === "filledRectangle"
              }
              onChange={(event) =>
                setBrushSize(clamp(Number(event.target.value) || 1, 1, 500))
              }
            />
            px
          </label>
          <button
            type="button"
            onClick={undo}
            disabled={undoCount === 0}
            className="cleanup-secondary"
            aria-keyshortcuts="Control+Z Meta+Z"
          >
            Undo{undoCount > 0 ? ` (${undoCount})` : ""}
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={redoCount === 0}
            className="cleanup-secondary"
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y"
          >
            Redo{redoCount > 0 ? ` (${redoCount})` : ""}
          </button>
          <button
            type="button"
            onClick={resetEdits}
            className="cleanup-secondary"
          >
            Reset edits
          </button>
        </div>

        <div ref={canvasScrollRef} className="cleanup-canvas-scroll">
          {/* The labeled application surface intentionally owns pointer and keyboard map editing. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
          <div tabIndex={0}
            ref={canvasStageRef}
            className={`cleanup-canvas-stage cleanup-canvas-tool-${tool}${
              isPanning ? " cleanup-canvas-is-panning" : ""
            }`}
            style={{ width: stageWidth, height: stageHeight }}
            role="application"
            aria-label="Editable binary navigation map"
            aria-describedby="cleanup-canvas-help"
            aria-keyshortcuts="Space ArrowUp ArrowDown ArrowLeft ArrowRight + - 0 Escape"
            onKeyDown={handleStageKeyDown}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerCancel}
            onContextMenu={(event) => event.preventDefault()}
          >
            <canvas ref={canvasRef} className="cleanup-canvas" aria-hidden="true" />
            <canvas
              ref={previewCanvasRef}
              className="cleanup-preview-canvas"
              aria-hidden="true"
            />
          </div>
        </div>
        <p className="cleanup-render-note">
          Large-image preview is downsampled for speed; painting and export use
          the full {workSize.width.toLocaleString()} ×{" "}
          {workSize.height.toLocaleString()} source pixels. Ctrl/Cmd + wheel
          zooms at the pointer; Ctrl/Cmd + Z undoes and Shift + Z redoes.
        </p>

        {reachableStats && (
          <div className="cleanup-reachability-result" aria-live="polite">
            <strong>Reachable free space</strong>
            <span>
              {reachableStats.count.toLocaleString()} of{" "}
              {reachableStats.totalFree.toLocaleString()} free pixels (
              {reachableStats.totalFree > 0
                ? ((reachableStats.count / reachableStats.totalFree) * 100).toFixed(1)
                : "0.0"}
              %), starting at {reachableStats.start.x}, {reachableStats.start.y}.
            </span>
            <button
              type="button"
              className="cleanup-secondary"
              onClick={() => {
                reachableRef.current = null;
                setReachableStats(null);
                setRevision((current) => current + 1);
              }}
            >
              Clear highlight
            </button>
          </div>
        )}

        {resolutionLocked ? (
          <div className="cleanup-calibration-controls cleanup-calibration-locked">
            <div>
              <strong>PDF scale controls resolution</strong>
              <span>
                Current: {currentResolution.toPrecision(6)} m/pixel. Change and
                confirm the printed 1:250 or 1:400 scale above to rerender.
              </span>
            </div>
          </div>
        ) : (
          <div className="cleanup-calibration-controls">
            <div>
              <strong>Scale calibration</strong>
              <span>
                Current: {Number.isFinite(currentResolution)
                  ? currentResolution.toPrecision(6)
                  : "—"}{" "}
                m/pixel
                {calibrationPixelDistance !== null &&
                  ` · Selected: ${calibrationPixelDistance.toFixed(1)} px`}
              </span>
            </div>
            <label className="cleanup-field">
              <span>Known distance (m)</span>
              <input
                type="number"
                min="0.000001"
                step="any"
                value={calibrationDistance}
                onChange={(event) => setCalibrationDistance(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="cleanup-primary"
              onClick={applyCalibration}
              disabled={calibrationPoints.length !== 2}
            >
              Apply resolution
            </button>
            <button
              type="button"
              className="cleanup-secondary"
              onClick={() => setCalibrationPoints([])}
              disabled={calibrationPoints.length === 0}
            >
              Clear points
            </button>
          </div>
        )}
      </div>

      <p className="cleanup-status" role="status" aria-live="polite">
        {status}
      </p>
      <aside className="cleanup-warning">
        Automatic cleanup can remove real walls or doors. Inspect every red
        suggestion and validate connectivity in RViz against the real building
        before navigation.
      </aside>
    </section>
  );
}
