# Verification notes

What was actually exercised, what broke, and what is still unverified.

## Automated

```
npm test        # node --test, 75 tests, ~0.2s, no browser required
```

Covers every module that does not touch Three.js or the DOM: fixed-step clock
(stall clamping, capped substeps, discarded debt), pool lifecycle/recycling/
resize, versioned storage (migrations, corrupt payload, practice sandbox),
seeded RNG (determinism, fork independence, clone), the quality governor
(degrade / EMERGENCY / recovery / platform ceiling / manual freeze / apply),
screen↔world projection round trip, spatial hash against a brute-force scan,
shot resolution (pierce, spread, crits, aim assist, seed reproducibility),
director budget + boss cadence + hazards + dilation + seeded reproducibility,
draft offers and evolutions, Hyper, the UTC daily and streak machine, progression
and its practice fences, and the recorder/replayer round trip.

## Browser

Driven through the Preview tab against `tools/dev-server.mjs`.

> Historical note: entries below marked *camera-era* were verified when the game
> still used a webcam feed as its backdrop. The camera has since been removed
> entirely (it was atmosphere-only, and the request was to stop spending device
> battery/GPU on it); the camera-specific lines are kept only to date what was
> checked then versus now.

Verified working (current build):

- boot: module graph loads, WebGL2 initialises, `three@0.186.0` and the
  addons/postprocessing tree resolve from the CDN, no console errors.
- camera removal: no `<video>` element, no `getUserMedia`/`mediaDevices`
  reference anywhere in `src/`, no camera screen/chip/setting in the DOM,
  menu reads `PLAY` and starts the run directly (`MENU → PLAYING` on click),
  zero console errors on boot and into a run.
- locators: every live enemy has a visible floor marker (y = 0.02, tinted with
  the archetype glow, opacity 0.55, brightening as hp drops, sized normal <
  elite < boss — measured 0.95 for a Drone vs 1.45 for a Bulwark); a telegraphing
  spawn shows the amber pillar standing on the floor (bottom at y = 0, top at
  ~6.8, opacity 0.78 while forming) with its ring growing seamlessly into its
  live size, and on arrival the pillar is gone and the marker is at full
  strength; through death the marker fades and shrinks with the corpse.
- core traceability kit: ground disc (y = 0.03, breathing with integrity,
  flaring on hit), vertical beacon (top at y = 15, opacity 0.5 at full
  integrity, dimming as the core weakens) and a sonar halo verified expanding
  in live render frames (scale 6.33 → 6.89 over 9 frames with opacity decay,
  restarting each ~2.4 s cycle).
- combat unchanged by the locator work: a spawned Bulwark died to the real fire
  path in 22 ticks, awarding score, with pools and hash untouched.
- simulation: 53 s of scripted play through 4 waves — enemies spawn behind
  telegraphs, shots resolve, kills/drafts/hazards/powerups/hyper all fire, the
  core is breached, `endRun('core-destroyed')` settles, and the results screen
  shows correct score, wave, combo, accuracy, kills, rating, build chips,
  "nearly there" progress and the daily line.
- practice fences: a `?debug=1` run reports `+0 (practice)` and leaves the menu
  at 0 cores / 0 best / 0 kills.
- every screen renders with real data: menu, pause, results,
  draft (3 cards, rarities, labels), arsenal (8 tracks, 3 weapons, 4 skins),
  contracts (18 rows), how-to, settings (quality options, volumes,
  aim assist), debug panel (badge, groups, live stats).
- quality governor: pinned tiers, manual freeze, and a live EMERGENCY downgrade
  when the main thread was blocked.
- determinism: the same `?seed=` produces the same spawn sequence, and different
  seeds diverge (asserted in the director tests).

Not verified here, and why:

- **No arena screenshot.** The preview webview in this environment does not
  composite, so `requestAnimationFrame` does not fire and frame captures come
  back stale (the menus did capture). Rendering was therefore verified
  indirectly: the scene graph builds (75 children, 76 visible meshes), the
  renderer accepts a full `postfx.render()` pass with bloom/chromatic/distortion
  enabled, and particles/debris/tracers report live pools. Worth a look on a real
  display.
- **Device rotation / mobile layout.** The resize path is exercised
  (`RESIZED` events, renderer + camera + arena all react), but the narrow-layout
  CSS and touch aim offset were reviewed, not played.
- **Sound.** `AudioContext` starts suspended without a gesture in this
  environment; SFX/music code paths ran without throwing but were not heard.

## Bugs found and fixed while verifying

1. **Every kill threw a TypeError.** `Enemies.applyDamage` emitted
   `view.archetype.color` in the death event, but the view stores `archetypeId`.
   The throw escaped through `Run.tick` into the fixed-step loop, so the failing
   tick was retried forever: waves froze while the tick counter stopped. Fixed by
   using the view's own colour, and by making the engine's step guard an error
   counter (after 30 faults it ends the run instead of looping).
2. **Corpses stayed shootable.** Nothing removed an enemy at 0 hp. A dead enemy
   kept absorbing shots (wasting pierce), kept awarding score/combo/hyper charge
   and could still breach the core — 121 "kills" were logged from 19 spawns in one
   session. A kill now clears `alive`, leaves the spatial hash immediately, and
   the view fades out over 0.24 s before its pool slot is recycled.
3. **The world ran permanently at Hyper speed.** `Run.worldTimeFactor()` used
   `hyper.worldTimeScale` (the dilated value, 0.62) instead of `hyper.timeScale`
   (1 unless Hyper is live), so enemies, spawn timers and hazards were always at
   62% and activating Hyper changed nothing. Fixed; wave 2 now arrives in ~5 s
   instead of ~15 s, and Hyper measures 0.62× live, 1.0× idle.
4. **Cross-kind hash queries.** The spatial hash is shared by enemies, hazards and
   pods, but `within`/`nearest` filtered only on `damageable`, so chain lightning
   and nukes routed pods through the enemy damage path (crash #1's second cause).
   All three managers now prove ownership via `view.__pool`.
5. **Large targets could be missed.** Hash cell scanning padded only by the query
   radius, so a Warden (radius 1.85) could be missed by a shot that overlapped it
   when its centre sat in an unscanned cell. Queries now pad by the largest
   tracked radius, verified against a brute-force scan.
6. **Aim assist did nothing.** The snapped target was used only for the
   `aimError` metric; the rays kept using the raw aim point. The snap is now
   resolved before the ray maths.
7. **Governor recovery was dead on desktop.** The climb-back guard was inverted
   (`index - 1 <= ceiling`), so only HIGH→ULTRA ever recovered. Fixed to a lower
   bound; mobile still cannot climb above its ceiling.
8. **Spurious pause at boot.** `pageshow` fires on first load, so the lifecycle's
   "restore" handler paused the run the moment it started. Restores now require a
   real preceding suspend, plus a short grace period after a run starts.
9. **The recorder dropped its end marker.** `stop()` cleared the recording flag
   before writing `RUN_END`, so records had no terminal event.
10. **Missing wiring.** `engine.screens` was never exposed (mute/quality toasts
    silently no-op'd) and the debug panel was never `bind()`-ed, so `?debug=1`
    showed no panel until F3 was pressed. The results screen also always said
    "stopped", because `endRun` never stored `finishReason`.
11. **Practice mode implied immortality.** `infiniteLives` was forced on for any
    debug run, which made practice runs unable to end. Core invulnerability is now
    opt-in (`?infinite=1` or the panel checkbox), while the progression fences
    stay in force.
12. **Draft cards read `Lv NaN/3`.** `offerDraft` returns static card definitions,
    which carry no `level` (only the `DRAFT_OFFERED` event payload added one), but
    the draft screen renders `card.level + 1`. `openDraft` now decorates each
    offered card with the player's held level, and the screen falls back to 0, so
    the card cannot print NaN again. Caught by reading a real screenshot.
13. **Instant spawns were unkillable phantoms.** An enemy spawned with
    `telegraphSeconds: 0` (the debug panel's spawn button) never entered the
    telegraph branch, so it was never marked `alive` — yet `hash.update` still
    inserted it. The result was a body that absorbed shots, awarded nothing and
    could not be killed. Materialising is now one shared step used both by the
    telegraph-complete path and by no-telegraph spawns.
14. **Aim assist outranked a real lock.** Dead-centre aim reported `ASSIST`
    instead of `LOCKED`, because the assist flag was tested before `inside`. The
    precedence is now locked-before-assist; assist is reported as a state only
    when it rescues a shot that would otherwise miss (its flag still rides along
    on a locked target).

## Scope / aim readout

Added after the first pass, verified in the browser rather than by screenshots
(the preview webview composites intermittently here):

- aiming by pointer position at a converged enemy (arena `x = 12.5`, well off
  centre) produced state `locked`, name `DRONE`, `1/1 HP`, `1 SHOT`, distance
  `0.00`, and the HUD printed `LOCKED / A shot here connects`;
- the ring the HUD drew was `110px` wide against an independently projected hit
  radius of 57px along x and 53px along y (mean 55px) — i.e. the ring is the real
  projected radius, and a fixed pixels-per-unit scale would have been ~7% wrong at
  that off-centre position;
- walking the aim outward from a body flipped the HUD through `locked` →
  `near` (`OFF TARGET`, ring visible, `+0.0u OUT`) → `searching`, and a telegraphing
  body reported `incoming` with `hittable: false`;
- the plate's card flips side near the right edge and rises near the bottom, and
  hides entirely when nothing is under the sight;
- 75 tests pass, including a new sweep asserting the scope's verdict matches
  `resolveShot` at 0.1-unit aim steps across a body.

## Open item

Balance: with no input at all, a couple of fast enemies can end a wave-1 run in
~8 seconds. That is a legitimate skill check but a harsh first encounter; a short
grace period on the first wave (or a slower first spawn ring) would be worth a
deliberate pass. Not changed here, because it is a design call rather than a bug.
