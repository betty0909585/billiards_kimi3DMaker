# CLUB No.9 — First-Person Physics Billiards

An interactive first-person 3D billiards game set in a warm, wood-paneled club. Built with Three.js and Rapier, with real ball collisions, cushion rebounds, pockets, spin, and shot replays.

The game includes Simplified Chinese and English interfaces and runs entirely in the browser. No account, backend, or database is required.

## Features

- First-person movement, mouse aiming, and cue-ball view
- Physics-driven ball collisions, cushion rebounds, and pocket drops
- High-contrast aim line, contact marker, and predicted ball paths
- Charged cue shots with adjustable power
- Side spin, follow, and draw controls
- Local two-player simplified eight-ball and free-practice modes
- Shot-by-shot replay with timeline scrubbing and variable playback speed
- Optional pocket close-ups, sound controls, and persistent aim-guide settings
- Additional bar games, including darts and dice
- Desktop keyboard-and-mouse gameplay; touch devices use spectator mode

## Quick Start

### Requirements

- Node.js 20 or later
- A desktop browser with WebGL and Pointer Lock support

### Install and Run

```bash
npm ci
npm run serve
```

Open [http://localhost:8017](http://localhost:8017).

The project uses ES modules and an import map, so it must be served over HTTP or HTTPS. Do not open `index.html` directly with `file://`.

To use another port:

```bash
PORT=8080 npm run serve
```

## Controls

| Action | Control |
| --- | --- |
| Move / look around | `WASD` / mouse |
| Enter aiming mode / interact | `E` |
| Adjust shot direction | Mouse |
| Charge and shoot | Hold and release the left mouse button |
| Adjust power | Mouse wheel |
| Shoot with the selected power | `Space` |
| Apply side spin | `A` / `D` while aiming |
| Apply follow / draw | `W` / `S` while aiming |
| Reset cue-tip offset | `R` |
| Leave aiming or a bar game | `E` or `Q` |
| Place the cue ball when ball-in-hand is available | `F`, then `WASD`; confirm with `F`, `E`, or left click |
| Re-rack | `T` |
| Switch match / practice mode | `G` |
| Enter or leave replay | `V` |
| Toggle pocket close-ups | `O` |
| Mute / unmute | `M` |
| Release the mouse / return to the menu | `Esc` |

Aim guides are enabled by default and can be changed under **Settings → Aim guides**.

## Tests

```bash
npm test
```

The test suite covers billiards physics, spin, cushion rebounds, break behavior, darts scoring and trajectories, and bar-game logic.

## Project Structure

```text
index.html              Game entry point, HUD, menus, and import map
style.css               Interface styling
serve.mjs               Local static development server
src/main.js             Game loop, input, modes, rules, replays, and aiming
src/sim.js              Rapier physics and billiards state
src/world.js            Three.js scene, table, balls, cue, and aim graphics
src/textures.js         Procedural cloth, wood, ball, and environmental textures
src/audio.js            Music and sound effects
src/darts*.js           Darts logic and 3D presentation
src/bar*.js             Bar-game logic and interactions
assets/                 Models, textures, environment map, audio, and icons
test/                   Automated physics and game-logic tests
```

## Static Hosting

After running `npm ci`, deploy the complete project directory to a static host, including the installed `node_modules` dependencies referenced by the import map. Keep all asset and module paths relative to the project root.

Settings and some game records are stored only in the browser's `localStorage`; they do not sync between devices.

## Asset and License Notices

Third-party models, textures, environment maps, audio, fonts, icons, and libraries retain their original licenses and attribution requirements.

See:

- [assets/LICENSES.md](assets/LICENSES.md)
- [素材版权与出处.md](素材版权与出处.md)
- [info.md](info.md) for additional implementation and template notes
