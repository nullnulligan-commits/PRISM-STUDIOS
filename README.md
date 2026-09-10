# Luma Studio

A static Blender-inspired browser scene editor.

## Run locally

Use a static web server. Do not open index.html directly with file://.

With Python:

    python -m http.server 3000

Then open:

    http://localhost:3000

Alternatively, use VS Code Live Server or any static website host.

No Node.js backend, AI service, API key, or build step is required.

## Files

- index.html — application interface and import map
- styles.css — layout, themes, responsive styles
- app.js — Three.js editor, imports/exports, path tracing, preferences
- README.md — setup and usage

## Requirements

- A current browser with WebGL2, ES modules, import maps, and dialog support.
- Hardware acceleration enabled.
- An internet connection for CDN dependencies, Draco decoding, and Suzanne.
- Desktop/laptop hardware is recommended.

This is a static website, not a fully offline bundle.

## Controls

- Left drag: orbit
- Right drag: pan
- Mouse wheel: zoom
- Click a mesh: select
- G: move gizmo
- R: rotate gizmo
- S: scale gizmo
- F: frame selected, or frame the scene if nothing is selected
- Shift A: add menu
- Shift D: duplicate
- Delete / Backspace: delete selected
- Ctrl/Cmd Z: undo
- Ctrl/Cmd Shift Z: redo
- Ctrl/Cmd K: command palette

These select transform gizmos; they do not implement Blender's complete
modal transform workflow.

## Scene editing

Expand a collection in the outliner to select individual meshes or lights.

Selecting a collection applies transforms to the collection. Surface edits
on a collection apply to its descendant meshes.

The editor uses Y-up coordinates.

## Rendering modes

Solid:
Neutral material preview.

Shaded:
Rasterized materials and lighting.

Wire:
Wireframe display.

Rendered:
Progressive GPU path tracing, with HTML viewport information visible.

Output:
Progressive GPU path tracing with viewport information hidden.

Editor grids and transform gizmos are excluded from path-traced images.

## Path tracing and light bounce

Recommended starting points:

- Draft: 32 samples, 3 bounces, 50% resolution
- Balanced: 128 samples, 6 bounces, 75% resolution
- Final: 512 samples, 10 bounces, 100% resolution

Higher samples reduce Monte Carlo noise.
Higher bounce counts allow longer indirect illumination paths.

Use "Add Light-Bounce Demo" to compare low and high bounce counts.
The demo contains colored walls, a diffuse block, a metal sphere, and
ceiling lighting.

The environment slider affects ambient illumination. Lower it when
evaluating illumination from lights inside an enclosed room.

Pause stops accumulation. Changes made while paused appear after Resume.
Restart clears the accumulated image.
Moving the camera or changing scene data restarts accumulation.

No denoiser or advanced path-guiding algorithm is included.
Raster previews and path-traced output will not look identical.

## Materials

- Roughness controls reflection blur.
- Metallic controls metal-like reflection.
- Transmission creates glass-like materials.
- Emission uses the surface color and can illuminate nearby objects in
  path-traced modes.

Use low roughness, nonmetallic surfaces, and higher bounce counts for glass.

## Import

Supported:
- GLB
- GLTF
- OBJ, optionally with MTL

GLB is the simplest format.

For GLTF and OBJ, select companion BIN, MTL, and texture files together.
Avoid duplicate companion filenames from different folders.

Draco-compressed GLTF geometry is supported using downloaded decoder files.
KTX2/Basis textures and every possible GLTF extension are not supported.

Imported animation playback, rig editing, and Blender .blend files are
not supported.

Large models can use substantial browser/GPU memory.

## Suzanne

Suzanne is downloaded from the Three.js example asset repository.
If unavailable, the editor adds a clearly named procedural monkey proxy.
The proxy is not the actual Suzanne mesh.

## Export

GLB:
Exports visible scene objects and supported materials/lights.

GLB does not preserve:
- UI preferences
- The procedural environment
- Render settings
- Rectangular area lights
- Undo history

PNG:
Saves the current WebGL canvas.

Path-traced PNGs contain the accumulated image at the moment of saving.
Saving before the sample target is reached may produce a noisy image.

PNG dimensions depend on viewport size and the viewport pixel-ratio setting.
Path-tracing resolution controls the internal tracing resolution.

## Preferences and saving

Appearance and performance preferences are stored in browser localStorage.

Scene edits are not automatically saved across reloads.
Export a GLB before closing the page, keeping the export limitations above
in mind.

Undo history is limited to 15 operations and is held in memory.

## Deployment

Upload index.html, styles.css, and app.js to a static host.

Keep the three files in the same directory.

The host must allow JavaScript modules and the application must be able
to access its CDN dependencies.

For a fully offline deployment, vendor the dependency graph and Suzanne
asset locally and update the module URLs.

## Libraries

- Three.js and its example utilities
- three-gpu-pathtracer

Retain their applicable license notices if redistributing bundled copies.
