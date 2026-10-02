# MarbleForge v0.1.1

A mobile-first procedural 3D marble racing league built for static hosting (including GitHub Pages).

## What is already playable

- 3D marble racing rendered with Three.js and simulated with cannon-es.
- 16 physically identical marbles with editable name, number, color, and uploaded logo.
- 20 procedural module archetypes assembled from a seeded track plan.
- Classic, Sprint, Chaos, Endurance, and multi-heat Elimination formats.
- Elimination runs 16 → 12 → 8 → 4 before the final.
- Auto, leader, overview, and tap-to-follow cameras.
- 1× / 2× / 4× simulation speed.
- Season standings, scoring, form, career records, race history, and replayable seeds.
- Automatic local save after completed races and marble edits.
- JSON export/import backup.
- PWA manifest and service worker; designed to be added to the iPhone Home Screen.
- No backend and no build step required.
- v0.1.1 anti-trap pass: low side-gapped bump bars, wall-connected deflectors, one-shot nudges, and faster forward rescues.
- Race-history cards open the full race classification and the championship table as it stood after that round.

## GitHub Pages deployment

1. Create a new GitHub repository, for example `marbleforge`.
2. Upload **the contents of this folder** to the repository root. `index.html` must stay at the root.
3. In GitHub open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select your main branch and `/ (root)`, then save.
6. Open the GitHub Pages URL on iPhone Safari.
7. Optional: Share → **Add to Home Screen** for the standalone app experience.

The app imports pinned versions of Three.js (`0.186.1`) and cannon-es (`0.20.0`) from jsDelivr. The first visit therefore needs a network connection. The service worker caches fetched resources for later use.

## Local development

Do **not** double-click `index.html`: browser ES modules should be served over HTTP.

From this folder, use any simple local server, for example:

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080`.

## Tests

The deterministic game logic has Node tests and the browser files can be syntax-checked without installing dependencies:

```bash
npm test
npm run check
```

## Architecture

- `index.html` — app shell and pinned import map.
- `styles.css` — mobile-first/iPhone UI.
- `src/logic.js` — seeds, schedules, track plans, scoring, seasons, standings, save import/export.
- `src/engine.js` — Three.js scene, cannon-es physics, procedural module construction, cameras, rescue logic.
- `src/app.js` — UI, race flow, elimination heats, customization, persistence.
- `manifest.webmanifest` / `sw.js` — installable PWA shell.
- `tests/logic.test.mjs` — deterministic logic tests.

## Design notes

All marbles use the same radius, mass, material, damping, and collision rules. Identity comes from visuals and history rather than hidden performance stats. Track generation is seeded, and physics-side rescue/nudge randomness is also seeded so a race setup is reproducible as far as the browser physics engine allows. Floating-point physics can still vary slightly between browsers/devices, so exact finishing order should not be treated as cryptographically deterministic across different hardware.

## Current v0.1.1 boundaries

This is a complete first playable build, not the final content ceiling. The 20 module archetypes reuse a compact set of reliable physical primitives (pins, gates, spinners, bump bars, dividers, moving punchers, etc.) so races remain stable on phones. Future versions can add bespoke meshes, sound, championships with custom rules, track editor tools, more camera cuts, and true replay files without changing the save/season core.
