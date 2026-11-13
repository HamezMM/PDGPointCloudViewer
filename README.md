# PDG Point Cloud Viewer

Browser viewer for large ASCII point clouds (`.xyz`) shown together with three.js JSON geometry.
Everything runs locally in the browser. Files are never uploaded anywhere.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (deploy anywhere: Vercel, GitHub Pages, a file share)
```

Drop a `.xyz` and/or a `.json` onto the page, or use **Files → Load…** in the panel.

## What it does (v1)

| Feature | Notes |
|---|---|
| **Large .xyz streaming** | Parsed in a Web Worker straight from disk with no full read into memory. A 1.3 GB / 25M-point file loads in about 11 s and uses about 210 MB at the default 10M budget. |
| **Point budget** | Keeps a uniform random sample (reservoir sampling) of up to *N* million points (default 10, max 30). Change it and press *Re-read scan*. |
| **Column auto-detect** | Detects `x y z`, intensity, RGB (0–255, 0–65535 or 0–1) and normals (ignored), with space, tab, comma or `;` delimiters. Header and comment lines are skipped. Check *Detected columns*. If it says *(guessed)* or looks wrong, type an override such as `x y z i r g b` (`_` = ignore a column) and re-read. |
| **Survey coordinates** | Points are stored relative to the first point, so millimetre precision holds at survey scale (e.g. 512000, 5650000). Picked coordinates are shown in the original file coordinates. |
| **Units & up axis** | Set per layer: scan default metres / Z up, model default feet / Y up. Everything is converted to metres internally. |
| **Model placement** | *Model → Model origin at scan coordinate*: type the scan coordinate where the model's (0,0,0) goes, or press *Pick point in view…* and click it. *Rotation about up* handles true north vs project north. |
| **Layer styling** | Scan: RGB / height ramp / intensity / single colour, point size (pixels or world cm), round points. Model: opacity, wireframe, double-sided. Bounding boxes to spot misalignment. |
| **Section box** | Clips scan and model together. Click a coloured face handle, then drag its arrow, or type exact limits. |
| **Pick & measure** | Click to read coordinates (scan and model frames). In *Measure mode*, click two points to get the distance plus horizontal and vertical components, in ft-in (1/16"), ft, in, m or mm. Esc cancels. |

### Model JSON format
Use the output of three.js `Object3D.toJSON()` (ObjectLoader format, `metadata.type: "Object"`) or a bare `BufferGeometry` JSON.

Keep model coordinates **local** (internal origin / project base point), then place the model with the origin fields. Very large coordinates baked into the JSON vertices lose precision in the GPU's 32-bit floats and render with visible jitter.

## Known limits
- **Decimation drops detail** on big scans: the display is a uniform sample, not every point. The proper fix is a level-of-detail octree (Potree/COPC) built offline and streamed in tiles. That is planned, not built.
- Changing the budget or column override re-reads the whole file.
- Desktop browsers only. A GPU with WebGL2 is needed, and 16 GB RAM is recommended for 20M+ point budgets.
- ASCII only. LAS/LAZ/E57 are not supported (yet).

## Planar geometry from the scan (orthogonal plane fitting)

**Planes → Fit planes in section box.** This turns the scan into flat, trimmed faces, snapped to the building's three axes.

1. **Isolate an area** with the section box (a room, a floor). With the box off, the whole loaded scan is used, up to 4M points.
2. **Fit.** It finds the building's rotation automatically and then fits the planes:
   - floors and ceilings are exactly level
   - walls are exactly plumb and at 90° to each other
3. **Tolerance (default 1").**
   - Surfaces that are parallel and less than 1" apart are **merged** into one plane.
   - Surfaces more than 1" apart become **separate** planes, e.g. a wall that steps out 2".
   - Points more than 1" off their plane are **flagged**.
4. **Review.** The plane list shows each region's position, area, RMS, max deviation and % of points over tolerance. Click a row or a plane to select it, and press **Del** to remove false planes such as furniture or clutter.
   - **Position** is the elevation for horizontal planes. For walls, it's the distance from the first wall on the same axis, so wall-to-wall spacing reads directly.
   - **Deviation view** colours the points: grey = on plane, blue/red = inside/outside up to the tolerance, cyan/magenta = beyond it, dark = not on any plane.
5. **Export planes (three.js JSON).** Each region is a mesh, an outline with holes for openings, in **real-world scan coordinates** (the same as the `.xyz`, in its units and up axis).
   - The vertices are stored relative to the scan origin and the group's matrix carries the origin, so there's no precision loss.
   - Each mesh's `userData` holds the axis, normal, offset, area, RMS, max deviation and % over tolerance.
   - Loading the export back as a model puts it exactly on the scan.

*Advanced* has settings for the normal voxel size, the axis angle tolerance, the assignment band, the minimum region area, the hole-fill size and the outline cell size.

**Known limits of the plane fitting**
- Surfaces hidden behind furniture come out as **holes**. Holes under *Fill holes under (m²)* are filled, but a large occluded patch looks like an opening.
- Only planes on the 3 building axes are found. Sloped, curved and off-axis surfaces are ignored and show as dark in the deviation view.
- The output is **faces, not wall solids**. Each side of a wall is its own region.
- Statistics come from the displayed sample, so the maximum deviation can be slightly understated on heavily decimated scans.
- Revit cannot import three.js JSON natively. It needs a small pyRevit/C# importer or a different export format (not built yet).

## Development

```bash
npm test                                             # parser / sampler / units unit tests (vitest)
node scripts/gen-sample.mjs --points 300000          # synthetic room scan + feet model in samples/
npm run build && npx vite preview --port 4173 &
npm run e2e                                          # Playwright smoke test (load, align, section, measure)
node scripts/gen-sample.mjs --points 1500000 --out samples-planes --rotate 17 --window --step --offset-half --bulge
npm run e2e:planes                                   # plane fitting: detect, select, delete, export, reload
```

The e2e test uses the globally installed `playwright` package (`NODE_PATH` may need to point at your global `node_modules`).

```
src/
  main.ts, app.ts          bootstrap, app state, loading, click handling
  io/xyzParse.ts           byte-level line scanner, column detection, reservoir sampler (pure, tested)
  io/xyzWorker.ts          streaming loader worker
  io/units.ts              units and length formatting
  viewer/Viewer.ts         renderer, camera, controls, on-demand rendering, unclipped helper pass
  viewer/PointLayer.ts     point shader (colour modes, clipping, depth-pick mode)
  viewer/ModelLayer.ts     three.js JSON loading, placement, styling
  viewer/SectionBox.ts     clipping box + drag handles
  viewer/Picker.ts         GPU depth picking + measurements
  ui/Panel.ts              lil-gui control panel
  ui/PlanePanel.ts         fitted plane list
  analysis/planeFit.ts     orthogonal plane fitting (pure, tested)
  analysis/grid2d.ts       occupancy grid, hole filling, outline tracing, simplification
  analysis/planeWorker.ts  runs plane fitting off the main thread
  analysis/exportPlanes.ts three.js JSON export in real-world coordinates
  viewer/PlaneLayer.ts     plane meshes and deviation view
```
