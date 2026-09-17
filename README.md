# Camera Defense: Overdrive

A 3D survival shooter played over a procedural hologrid. You defend a core crystal
at the centre of the arena, and between waves you draft upgrades that turn a pulse
repeater into a build. Every enemy carries a glowing floor ring so targets are
always easy to locate, and spawn points burn a light pillar before anything
appears.

Vanilla ES modules + Three.js from a pinned CDN import map. **No build step, no
bundler, no asset files, no camera** — clone, serve, play.

```
node tools/dev-server.mjs        # then open http://127.0.0.1:8099/
```

---

## Controls

| Input | Action |
| --- | --- |
| Move mouse / drag on touch | Aim at the arena; the scope ring is your real hit radius |
| Hold left button / Space / tap | Fire (weapons fire at their own rate) |
| Mouse + touch auto-detect | Touch drags aim above the finger, and gets aim assist |
| `1` `2` `3` | Pick a draft card |
| `Esc` | Pause (or leave the results screen) |
| `P` | Pause toggle |
| `R` | Restart the run (pause / results) |
| `M` | Mute |
| `F3` or `\`` | Debug / practice panel (`?debug=1`) |
| `Q` | Cycle quality tier (`?debug=1`) |

---

## The scope

Aiming shows a reticle whose ring is the **actual hit radius** of the current
weapon, measured through the arena projection each frame (not a fixed circle), so
it stays honest at the screen edges and when a card changes the radius. The plate
beside it names what is under the sight:

| State | Ring | Meaning |
| --- | --- | --- |
| `NO TARGET` | dim cyan | Nothing within search range |
| `LOCKED` | solid green | A shot at the crosshair connects **now** |
| `OFF TARGET` | orange | Body under the sight, outside the ring — the readout says by how much |
| `ASSIST` | magenta | The shot would miss, but aim assist will pull the volley on |
| `INCOMING` | gold | Spawn telegraph: visible, not yet shootable |

It also reports the target's name, `hp/maxHp`, tags (`ELITE`, `BOSS`), and the
number of volleys left to kill it with the current weapon. Everything is derived
from the same `readScope` result `Weapons.resolveShot` resolves against, so the
readout cannot claim a hit the shot would not make — the contract is asserted by
a test that sweeps the aim across a body and compares the scope's verdict with
the real shot at every step.

---

## Locating targets

Everything that matters is marked on the floor, so a glance — not a search — finds
it.

**The core** (the thing you defend) carries three cues that work from any angle
and any distance:

- a **ground disc** at its feet, breathing slowly, flaring when the core is hit;
- a **vertical beacon** of light, so the core reads even in peripheral vision or
  behind a crowd of enemies; it dims as integrity drops, a faltering light that
  signals trouble;
- a **sonar halo** expanding outward once every ~2.4 s, drawing the eye inward.

**Enemies** each own two pooled cues (allocated once per view, zero cost per
spawn):

- **Floor ring** — a glowing ring on the ground directly beneath each enemy,
  tinted with the enemy's own colour, pulsing and brightening as it takes damage.
  Its size encodes threat: normal < elite < boss, so the floor alone tells you
  what is coming.
- **Spawn pillar** — before an enemy materialises, a hot amber pillar of light
  burns from the floor to the sky at its spawn point, dimming as the body forms.
  The floor ring is already there during the telegraph, growing seamlessly into
  its live size so arrival never pops.

Aiming and hit detection remain pure geometry on the combat plane — every cue
here is presentation only.

---

## How a run works

1. **Waves** are built by a director that spends a *budget*, not a spawn count:
   composition gets more expensive, elites appear from wave 3, Void Mines from
   wave 3, and a Warden every 5th wave.
2. **Kills charge Hyper Mode**; damaging the core cashes it out early. Hyper slows
   the *world* (enemies, spawn timers, hazards) while the player's fire rate,
   damage and crit go up. It is a risk/reward window, not a visual filter.
3. **Clear a wave → draft a card.** Two maxed cards can fuse into a build-defining
   evolution (Split Barrel + Piercing Rounds → RAILGUN).
4. **Powerup pods are collected by shooting them**; Void Mines are defused by
   shooting them before their fuse ends, and their blast shoves enemies around.
5. **Cores** earned in a run buy permanent Arsenal tracks; contracts unlock
   weapons and arena skins; the weapon you used gains mastery XP.
6. **Daily Challenge** is seeded from the *UTC* calendar date, so every player
   worldwide gets the same waves, the same modifiers and the same drafts. The
   streak bonus is deliberately capped at +20%.

Progress is stored as one versioned JSON blob with migrations. **Practice runs
(`?debug=1`) never write progression**: no cores, contracts, mastery, unlocks,
personal bests, skins or streak — they return the same summary shape flagged
`practice: true`, so the UI can say "practice run, no rewards" without
special-casing.

---

## URL parameters

| Parameter | Effect |
| --- | --- |
| `?demo=1` | Skip the menu and drop straight into a run |
| `?debug=1` | Practice mode: debug panel, hotkeys, and **no progression writes** |
| `?rewards=1` | With `?debug=1`: allow writes (deliberate progression testing) |
| `?practice=1` | Practice fenced without the panel |
| `?infinite=1` | Core cannot be destroyed (also a checkbox in the panel) |
| `?seed=12345` | Deterministic run: same spawns, same drafts |
| `?quality=ULTRA` | Pin a tier (governor disabled) |
| `?record=1` | Record the run; `window.CD3D.debug.exportRecord()` copies the JSON |
| `?replay=<json>` | Replay a record and report the first divergent tick |

The console surface is `window.CD3D`: `stats()`, `debug.*` (spawn, jumpToWave,
grantPowerup, killAll, freezeWorld, exportRecord, replay), and the engine itself.

---

## Architecture

```
src/
  main.js              composition root: builds every system, owns the fatal path
  core/
    Engine.js          renderer, fixed-step loop, quality governor, lifecycle,
                       and the event→FX/audio wiring
    Clock.js           fixed 60 Hz accumulator, clamped stalls, never spirals
    Pool.js            generic pool: activate/deactivate, FIFO recycling at cap
    Quality.js         six-tier data table + hysteresis governor (EMERGENCY)
    State.js           screen/mode machine (no gameplay values in it)
    Events.js          event bus (facts only, no state store)
    Lifecycle.js       visibility/blur/focus/freeze, suspend↔restore pairing
    Rng.js             mulberry32 streams, forked by label, never Math.random
  util/                Math, Storage (versioned + migrations), CamMath
  audio/Audio.js       synthesised SFX + adaptive 3-layer music, no sample files
  world/
    ArenaSpec.js       arena/spawn data, shared by renderer + simulation
    Arena.js           hologrid backdrop, ground grid, core crystal, ripples
    SpatialHash.js     uniform hash for hit queries (no per-shot raycasting)
    Director.js        wave budget, elites, hazards, bosses, time dilation
    Enemies.js         pooled enemy views, telegraphs, damage, death
    Hazards.js         Void Mines: fuse, defuse, knockback detonation
    Powerups.js        pods, collection, timed effects
    Weapons.js         weapons + deterministic shot resolution
  fx/                  GPU particle field, instanced debris, post-processing
  game/
    Run.js             run orchestration: waves, firing, hyper, drafts, scoring
    Aim.js             scope/aim readout: what is under the crosshair, and whether
                       a shot there connects (pure; shares the hit maths)
    Upgrades.js        cards, rarities, evolutions, modifier bag
    Hyper.js           charge/activate/end, world dilation, modifiers
    Progression.js     cores, Arsenal tracks, contracts, mastery, skins
    Daily.js           UTC daily seed + modifiers, streak state machine
    Recorder.js        deterministic run recording, checksums, replayer
  ui/                  Screens, HUD, Input, DebugPanel (all DOM, no gameplay)
tools/dev-server.mjs   zero-dependency static server, Cache-Control: no-store
tests/                 node:test suites for every pure module
```

Rules the code follows:

- **The simulation is pure.** `Rng`, `Clock`, `Pool`, `SpatialHash`, `Weapons`,
  `Director`, `Upgrades`, `Hyper`, `Daily`, `Progression` and `Recorder` import no
  Three.js and no DOM, which is why they are unit-testable in plain Node and why
  a seed reproduces a run.
- **One owner per thing.** The engine owns the renderer, the run owns gameplay
  state, the bus carries facts. Systems emit; only `main.js` wires.
- **Nothing allocates during play.** Enemies, hazards, pods, tracers, particles and
  debris all come from pools; the aim path allocates no vectors.
- **Frame-rate independence.** Gameplay only ever sees a constant 1/60 dt; render
  interpolates between the last two ticks (`alpha`).

---

## Verification

```
npm test         # 75 tests, no browser required
```

The suite covers the fixed-step clock's stall handling, pool recycling, storage
migrations, RNG stream independence, the quality governor (degrade, EMERGENCY,
recovery, ceilings, manual freeze), screen↔world round-trip projection, the
spatial hash (verified against a brute-force scan, including bodies wider than a
cell), shot resolution (pierce, spread, crits, aim assist, seeding), director
budget/boss/hazard pacing and seeded reproducibility, draft offers and
evolutions, Hyper charge/activation/dilation, the UTC daily and streak machine
(including a backwards clock), progression and its practice fences, and the
recorder/replayer round trip with divergence detection.

In a browser (see the notes in `docs/verification.md`) the menu→run flow, the
locator cues, the scope, the practice fences, every screen, the results settlement
and the quality governor's EMERGENCY path were all exercised, with zero console
errors.

---

## Privacy

There is nothing to make private: the game never opens a camera, microphone or
any device sensor, makes no network requests beyond loading Three.js from its CDN
once, and stores progress in `localStorage` only.
