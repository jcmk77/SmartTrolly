# MapForge ROS

MapForge is a single-page browser application that turns a PDF, PNG, or JPEG
floor plan into a reviewed ROS 2 map pair:

- a trinary `P5` PGM occupancy image (`0` black/occupied, `127`
  gray/unknown, and `255` white/free);
- a YAML configuration file for `nav2_map_server`.

All processing happens locally in the browser. Files are not uploaded to a
server. PDF uploads are decoded with PDF.js, respect the PDF page rotation, and
render the selected page at the DPI required for a `0.05 m/pixel` map. Choose
the printed title-block scale before confirming it: `1:250` renders at
`127 DPI`, while `1:400` renders at `203.2 DPI`. A required render over 25 million
pixels or 6,500 pixels on either side is rejected with an explanation; MapForge
does not silently lower the DPI and produce a map with the wrong scale.

For multi-page PDFs, previous and next controls select the page to process.
Changing pages resets crop, cleanup, brush, reachability, and calibration state.
PDF support is page rasterization, not semantic wall recognition or OCR; every
rendered page must still be reviewed before it becomes a navigation map.

PDF resolution is locked to `0.05 m/pixel` because the selected printed scale
determines its render DPI. PNG and JPEG inputs instead use two known points for
resolution calibration. ROS export is deliberately locked to `mode: trinary`,
`negate: 0`, `occupied_thresh: 0.65`, and `free_thresh: 0.25` so gray value
`127` remains unknown in `nav2_map_server`.

The hybrid cleanup workflow keeps the source image immutable and lets the user:

- crop away borders, title blocks, and unused drawing space;
- review conservative removal suggestions for light annotations, long thin
  drafting lines, and small isolated marks;
- erase false obstacles or draw missing walls with brush, line, outline
  rectangle, and filled rectangle tools;
- check which white cells are connected to a selected starting point;
- calibrate metres per pixel from two points with a known distance.

Suggestions are never exported until the user applies them. Automatic cleanup
is intentionally conservative because a flattened raster can make walls,
dimensions, door arcs, and grid lines look identical.

## Scale and final-map review

Export has two explicit revision gates:

1. Confirm that the successfully rendered PDF raster matches its `1:250` or
   `1:400` title block, or confirm a raster image against a known distance.
2. Prepare the final occupancy preview. Border-connected white page exterior
   becomes gray/unknown; enclosed white space remains free and black walls stay
   occupied. Confirm the preview only after checking all three classes.

The downloaded PGM uses the exact full-resolution trinary snapshot shown at the
second gate; export never falls back to the raw upload or an unreviewed cleanup
buffer. Changing the source, PDF page or scale, crop, cleanup pixels, threshold,
resolution, origin, or ROS output setting clears the affected confirmations and
removes any previous downloads. View-only pan and zoom do not change the map.

## Cleanup editor controls

Line and rectangle edits appear on a transparent preview layer and change the
map only when the pointer is released. Press `Escape` to cancel a pending
shape. Use `Undo`/`Redo`, `Ctrl/Cmd+Z`, and `Ctrl/Cmd+Shift+Z` (or `Ctrl+Y`) to
move through committed edits.

Use `Pan` or hold `Space` while dragging to move around a large map. `Fit`
frames the complete map, and `Ctrl/Cmd+wheel` zooms around the cursor so the
point being inspected stays in place.

## Requirements covered

The application implements the documented map-generator requirements,
including supported image upload, source and occupancy previews, configurable
map metadata, validation, matching filenames, valid YAML, and downloadable
PGM/YAML output. The cleanup editor extends those requirements without changing
the PGM/YAML format. PDF upload and page selection are additional capabilities.

It also includes the ROS map fields used by the reference `Trolly`
project: `mode` and the third `origin` value (`yaw`). Defaults match the current
navigation maps:

```yaml
mode: trinary
resolution: 0.05
origin: [0.0, 0.0, 0.0]
negate: 0
occupied_thresh: 0.65
free_thresh: 0.25
```

## Local development

Node.js 22.13 or newer is required.

```bash
npm install
npm run dev
```

Open the local address printed by the development server.

## Validation

```bash
npm run build
npm test
```

Crop bounds use source-image coordinates whose origin is at the top left. The
origin entered in the form is the uncropped source map's lower-left pose. On
export, MapForge converts the crop to ROS's lower-left convention: the removed
left pixels and `source height - crop bottom` pixels are multiplied by the map
resolution, rotated by the configured yaw, and added to X/Y. The form values
remain unchanged, so generating twice cannot apply the crop offset twice.

The connectivity overlay is a topology check, not a robot-footprint or costmap
simulation. Before using an exported map on a robot, load the PGM/YAML pair with
the ROS 2 map server and verify its scale, orientation, origin, wall alignment,
and inflated traversability in RViz. Successful file generation proves format
compatibility, not physical map accuracy.
