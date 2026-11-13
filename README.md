# Waterunmark

A browser-local JavaScript workbench for reversing light, translucent text overlays. Upload an image, select a text pattern, refine its mask, and compare opacity settings. No image uploads, API keys, dependencies, or build step.

## Run

Requires Node.js 20 or later.

```sh
npm start
```

Open **http://localhost:5173**. A local HTTP server is required for ES modules and Web Workers; opening `index.html` as a `file://` URL will not work. Set `PORT` to change the port. Any static HTTP host can serve the app unchanged.

```sh
npm test
npm run check
```

## Workflow

1. **Open image**, or **Try demo** to experiment with a generated scene and known masks.
2. Add a pattern and choose **Select template**. Drag a tight box around one complete text instance, leaving a little background padding. A starter mask is estimated in a worker.
3. Inspect **Show mask & boxes**. The colored mask should cover letter strokes only. Use **Paint strokes** and **Erase mask** in the first template box. Brush size is measured in image pixels. Hold Shift while painting to erase. **Undo mask** restores up to ten mask edits.
4. For more instances of the same text, use **Add placement** and drag matching boxes. The same mask is scaled to each box. Or open **Repeated placements**, choose **Find repeats**, review the blue candidate boxes, uncheck false matches, and add checked copies. Remove a misplaced copy using its × button and draw it again.
5. Adjust **Text opacity** with its slider or 0.5% buttons. **Compare 5 opacity iterations** shows the first template crop at the current opacity and ±2 and ±4 percentage points. Click a card to apply it.
6. Add another pattern for a second text style. Each pattern has independent opacity, mask, blend mode, and text color. Patterns are listed in the order overlays were applied, bottom to top. Removal reverses that order. For overlapping colored patterns, define them in that order; white overlays commute.
7. Compare **Before / after**, **Result**, or **Original**. Hold O to see the original temporarily. Wheel zoom anchors at the pointer. Pan by dragging with Pan selected, middle-dragging, or holding Space while dragging. Fit and 1:1 are available.
8. **Export PNG** produces a full-resolution result without selection boxes or mask guides. **Save project** exports the original image plus all masks and settings in a portable JSON file.

## Masks and recovery limits

A box is a placement boundary, **not** a solid correction rectangle. Correction is applied only where its stroke mask is nonzero. The initial mask is a heuristic based on local brightness above an estimated background. It cannot reliably separate arbitrary white letters from bright scene details in one image. Brush refinement or an exact mask is often needed.

For a known mask, use **Import mask PNG** after selecting a template. Its dimensions must exactly match the template box. Transparent PNGs use the alpha channel; opaque PNGs use grayscale brightness (white = full stroke, black = background). **Export mask** produces a transparent white mask PNG. Antialiased mask edges represent partial coverage.

The demo uses exact synthetic masks. Its target strengths are **24% for Pattern 1** and **15% for Pattern 2**. Real-image results depend on mask accuracy and the original blend operation; the demo is not a claim of automatic recovery.

For normal blending, the worker evaluates:

```text
effective_alpha = opacity × mask_coverage
original = (observed - effective_alpha × text_color) / (1 - effective_alpha)
```

Screen blending is also supported. Both models operate on the stored RGB channel values. Linear-light compositing, multiply/overlay blends, embedded invisible watermarks, rotated/warped text, opaque marks, and automatic font reconstruction are outside this version's scope. Brightness clipping, JPEG artifacts, and unknown letter edges may prevent exact recovery. The clipped-pixel counter identifies pixels the current correction pushes outside the valid RGB range.

Every iteration starts from immutable original pixels. Alpha transparency is retained. Export is PNG in browser canvas RGB; original EXIF, ICC profiles, and other file metadata are not retained. Browser image decoding may apply orientation/color conversions.

## Architecture and persistence

- `src/app.js`: UI, pointer coordinates, viewport, mask painting, project I/O, and worker request coordination.
- `src/core.js`: pure box filtering, mask estimation, inverse blending, and repeat matching.
- `src/worker.js`: image pixels held in a dedicated module Worker; extraction, matching, preview and export rendering run off the main thread.
- `server.mjs`: dependency-free development static server.
- `tests/core.test.js`: synthetic recovery, overlaps, screen inversion, unchanged pixels, clipping, mask extraction, and repeated-pattern matching.

Small settings are saved in **localStorage**. The original image and mask arrays are saved in **IndexedDB**, avoiding localStorage's small quota and large synchronous writes. A previous session restores on reload. Storage is scoped to this browser and origin, can be evicted, and may be unavailable in restricted/private modes; a visible status reports save failures. Use the project export for durable backups. **Forget saved session** removes this app's saved state while leaving the current edit open; later edits save a new session.

Image decoding and canvas display happen on the main thread; computational image operations happen in the Worker. Repeat matching uses a reduced-resolution brightness feature map and sparse normalized correlation, supports the same size and orientation, and returns suggestions rather than silently applying corrections. Cancellation terminates and reinitializes the Worker.

Limits: images under 40 MB and 32 megapixels; template masks up to 4 million pixels; project imports up to 80 MB, 50 patterns, and 300 placements per pattern. High-resolution previews still need memory for several full-image buffers. No external libraries, fonts, analytics, or network processing are used by the app.
