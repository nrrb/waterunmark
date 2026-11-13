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

1. **Open image**, or **Try demo** for a generated scene with exact masks and differently padded search boxes.
2. Add a pattern. **Mark an instance** stays active so you can draw one box around each copy of the same text, one at a time. Start with the clearest copy. Keep the complete text inside each box; the padding and box dimensions can differ.
3. Every newly marked box is selected and displays **eight resize handles**. Drag an edge or corner to resize it. Choose **Edit boxes** and drag inside a box to move it; click a box or its instance-list entry to select it. X, Y, Width, and Height fields also allow exact edits. Geometry is measured in original image pixels, independent of zoom.
4. Once all copies are marked, press **Done marking instances → Find text**. The Worker estimates a text mask from the first box, trims excess blank padding, and searches independently for the best translation inside every box. It keeps the text mask at one size instead of stretching it to box dimensions. Solid outlines are your bounds; dashed outlines show the detected text position.
5. Review the fit percentage and offsets for each instance. Low-confidence fits stay unapplied; use **Use fit** to approve a visible candidate or enlarge/refine the box and **Find text again**. Boxes smaller than the mask show an explicit message. **Skip** disables a fit. Overlapping bounds that find the same text are identified and are not applied twice. Changing the confidence threshold takes effect on the next text search.
6. Inspect **Show mask & boxes**. The colored mask should cover letter strokes only. **Paint strokes** and **Erase mask** edit the first detected text outline, and those edits apply to every aligned copy. Brush size is in image pixels. Hold Shift to erase while painting; **Undo mask** restores up to ten edits. **Re-estimate & align all boxes** replaces brush edits with a fresh estimate from the first box.
7. Adjust **Text opacity** with its slider or 0.5% buttons. **Compare 5 opacity iterations** shows the first matched text crop at the current opacity and ±2 and ±4 percentage points. Click a card to apply it. Add another pattern for a different text style; its opacity, mask, blend mode, and text color are independent.
8. **Mark more / adjust boxes** returns to marking. Resizing or moving a box also returns to marking; press **Done marking instances** again to recompute offsets. The affected pattern is not corrected while its geometry is pending, and PNG export is disabled until enabled patterns with marked boxes are ready. Optional **Suggest more boxes** searches the whole image; review the candidates and finish marking to align them.
9. Compare **Before / after**, **Result**, or **Original**. Hold O to peek at the original. Wheel zoom anchors at the pointer. Pan with Pan selected, a middle drag, or Space + drag. Fit and 1:1 are available. Patterns are listed bottom to top in overlay application order and removed in reverse order; white overlays commute.
10. **Export PNG** creates a full-resolution result without guides. **Save project** includes the original, masks, search boxes, detected offsets, and settings. Previous projects still open with their saved placements; **Find text again** upgrades their fits to independent offsets. Removing the first instance clears the template so the new first box can supply it.

## Masks and recovery limits

A box is a search boundary. Correction uses the detected text position and its stroke mask, rather than the entire rectangle. Correction is applied only where its stroke mask is nonzero. The initial mask is a heuristic based on local brightness above an estimated background. It cannot reliably separate arbitrary white letters from bright scene details in one image. Brush refinement or an exact mask is often needed.

For a known mask, use **Import mask PNG** after finding the text. Its dimensions must exactly match the cropped mask dimensions shown in any size-mismatch message, rather than the outer search box. Transparent PNGs use the alpha channel; opaque PNGs use grayscale brightness (white = full stroke, black = background). **Export mask** produces a transparent white mask PNG. Antialiased mask edges represent partial coverage.

The demo uses exact synthetic masks and intentionally different padding around repeated instances. Its target strengths are **24% for Pattern 1** and **15% for Pattern 2**. Real-image results depend on mask accuracy and the original blend operation; the demo is not a claim of automatic recovery.

For normal blending, the worker evaluates:

```text
effective_alpha = opacity × mask_coverage
original = (observed - effective_alpha × text_color) / (1 - effective_alpha)
```

Screen blending is also supported. Both models operate on the stored RGB channel values. Linear-light compositing, multiply/overlay blends, embedded invisible watermarks, rotated/warped text, opaque marks, and automatic font reconstruction are outside this version's scope. Brightness clipping, JPEG artifacts, and unknown letter edges may prevent exact recovery. The clipped-pixel counter identifies pixels the current correction pushes outside the valid RGB range.

Every iteration starts from immutable original pixels. Alpha transparency is retained. Export is PNG in browser canvas RGB; original EXIF, ICC profiles, and other file metadata are not retained. Browser image decoding may apply orientation/color conversions.

## Architecture and persistence

- `src/app.js`: UI, pointer coordinates, viewport, mask painting, project I/O, and worker request coordination.
- `src/core.js`: pure box filtering, mask estimation/cropping, per-box offset searches, inverse blending, and repeat matching.
- `src/geometry.js`: handle positions, hit testing, resizing, and image-bound constraints.
- `src/worker.js`: image pixels held in a dedicated module Worker; extraction, matching, preview and export rendering run off the main thread.
- `server.mjs`: dependency-free development static server.
- `tests/core.test.js`: synthetic recovery, overlaps, screen inversion, unchanged pixels, clipping, mask extraction, and repeated-pattern matching.
- `tests/alignment.test.js`: independently offset text in differently padded boxes, fresh extraction, unmatched boxes, duplicate suppression, and all eight resize handles.

Small settings are saved in **localStorage**. The original image and mask arrays are saved in **IndexedDB**, avoiding localStorage's small quota and large synchronous writes. A previous session restores on reload. Storage is scoped to this browser and origin, can be evicted, and may be unavailable in restricted/private modes; a visible status reports save failures. Use the project export for durable backups. **Forget saved session** removes this app's saved state while leaving the current edit open; later edits save a new session.

Image decoding and canvas display happen on the main thread; computational image operations happen in the Worker. Per-box alignment uses local background-subtracted brightness and coarse-to-fine normalized correlation at the original pixel scale. It searches translation only; use separate patterns for text at different sizes or rotations. Whole-image repeat matching uses a reduced-resolution brightness feature map and sparse normalized correlation, supports the same size and orientation, and returns suggestions rather than silently applying corrections. Cancellation terminates and reinitializes the Worker.

Limits: images under 40 MB and 32 megapixels; template masks up to 4 million pixels; project imports up to 80 MB, 50 patterns, and 300 placements per pattern. High-resolution previews still need memory for several full-image buffers. No external libraries, fonts, analytics, or network processing are used by the app.
