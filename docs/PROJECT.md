# FPV Blackbox Analysis Platform — Project Status

Static, client-side-only website for analyzing Betaflight `.bbl` blackbox
logs. No backend, no build step, plain HTML/CSS/JS. Hosted on GitHub Pages.

Read this file first in any new session — it reflects the current state so
you don't need prior conversation history.

## Confirmed facts about the owner's hardware/logs (don't re-derive)

- Firmware: Betaflight 2025.12.5, board HGLRC F405 V2, **8kHz loop time**
  (125us loop time in header).
- Fields present in real logs: `loopIteration`, `time`, `axisP/I/D/F[0-2]`
  (PID terms), `rcCommand[0-3]`, `setpoint[0-3]`, `vbatLatest`,
  `amperageLatest`, `baroAlt`, `rssi`, `gyroADC[0-2]`, `gyroUnfilt[0-2]`,
  `accSmooth[0-2]`, `imuQuaternion[0-2]`, `motor[0-3]`.
- **No GPS fields, ever, for this setup.** No G/H frame types in the log.
  Never build or imply spatial position tracking. Orientation via
  `imuQuaternion` is fine (the FC logs fused orientation directly — no need
  to integrate raw gyro, which would drift).
- Baseline PID header values: rollPID 45/80/30, pitchPID 47/84/34,
  yawPID 45/80/0 (verified against real log header — see below).
- Sample logs are safe to include in a public repo (no location data).

## Phase status

- [x] **Phase 0 — Foundation + Decoder**: DONE, verified against a real
  log (see "Decoder verification" below).
- [ ] Phase 1 — Flight Replay Dashboard: not started.
- [ ] Phase 2 — Vibration Spectrum Analyzer: not started.
- [ ] Phase 3 — PID Tuning Analyzer: not started.
- [ ] Phase 4 — Automatic Crash Detector: not started.
- [ ] Phase 5 — Attitude Reconstruction: not started.
- [ ] Phase 6 — AI Flight Coach (exploratory, not committed): not started.
- [ ] Phase 7 — Integrated Platform: not started, not designed.

## Decoder verification

Verified against `logs/btfl_007.bbl` (real flight log from the owner's
drone, "Flight 3, 7.19"). Parsed output matched all confirmed facts:

- Firmware/board strings matched.
- Looptime 125us = 8kHz. Matched.
- rollPID/pitchPID/yawPID header values matched exactly.
- All expected fields present in the I/P frame definition, in the expected
  order, no GPS fields.
- 0 corrupt frames across the whole file (2,426 I-frames, 152,812 P-frames,
  11 S-frames, 4 E-frames) — the self-resyncing frame parser never desynced.

To re-run this check: open `index.html` in a browser (just double-click
it, no server needed — everything is plain `<script>` tags, no ES
modules), choose a `.bbl` file, and read the printed header/frame dump.
This page (`index.html` + `src/app.js`) is a **throwaway verification
harness**, not the real dashboard — Phase 1 replaces it with actual charts.

## Decoder architecture & licensing (important — read before touching src/)

`src/tools.js`, `src/datastream.js`, `src/decoders.js`, `src/decoder.js`
are **adapted from the real Betaflight `blackbox-log-viewer` source**
(https://github.com/betaflight/blackbox-log-viewer), not reverse-engineered
from scratch, per the project's original hard rule to use it "as a
starting point." Each file has a header comment listing exactly what was
changed in the port. Summary of changes:

- Converted from ES modules (`import`/`export`) to plain global `<script>`
  files — no build step, so no bundler to resolve module imports.
- Removed the `semver` npm dependency; replaced with a small inline
  `BBLTools.versionGte()` numeric version comparator.
- **Removed GPS (G) and GPS-home (H) frame support entirely.** This
  hardware never logs GPS data, so that code path was dead weight and a
  potential source of "why is this here" confusion later.
- Removed `flightlog_fields_presenter.js` (unit/display formatting, ~3100
  lines, not needed for Phase 0 — Phase 1 will need some display
  formatting but will be written fresh, tailored to just this hardware's
  fields, rather than porting the full upstream presenter).
- Removed `adjustFieldDefsList()` (legacy firmware field-renaming for very
  old Betaflight/Cleanflight versions) since this project only targets
  modern Betaflight.
- Frame/predictor/encoding parsing logic and the frame-stream resync logic
  are otherwise a faithful, unmodified port.

**Licensing consequence**: because this repo incorporates GPL-3.0 code,
the whole repo is licensed GPL-3.0 (see `LICENSE` at repo root and
`NOTICE.md` for the attribution details). This was an explicit choice
(discussed with the owner in the Phase 0 session) — for a personal hobby
project with no commercial angle, GPL-3.0 has no practical downside.

## Repo structure

```
/index.html       Phase 0 test harness (temporary, see above)
/src/              JS, no build step, plain <script> tags in load order:
  tools.js         byte/number helpers (ported)
  datastream.js    ArrayDataStream — the binary reader (ported)
  decoders.js      "tag group" field decoders (ported)
  decoder.js       FlightLogParser — the main decoder (ported, trimmed)
  app.js           Phase 0 test harness logic (original, not ported)
/logs/             Sample .bbl files (safe, no location data)
  btfl_007.bbl     Real sample log, used for decoder verification
/docs/             This file
LICENSE            GPL-3.0 (see licensing note above)
NOTICE.md          Attribution details for the ported code
```

## Open issues / things to know for next session

- `index.html` currently only handles a **single flight segment** cleanly
  in its display (it detects multiple segments via the log start marker
  and reports the count, but only dumps the first one). A `.bbl` file
  can contain multiple concatenated flights if the FC was armed/disarmed
  multiple times in one session. Not a decoder limitation — just the test
  harness only showing segment 1. Phase 1's real dashboard will need a
  flight/segment picker.
- GitHub repo + Pages setup: [fill in after walkthrough — see next
  session's git log / this file's edit history for whether this happened
  yet].
- No display/unit formatting layer yet (e.g. `vbatLatest` is a raw ADC-ish
  number, not converted to volts; `gyroADC` is raw counts, not deg/s).
  Phase 1 needs to figure out the right scale factors from `sysConfig`
  (e.g. `gyroScale`, `acc_1G`, `vbatscale`) — same approach upstream uses,
  just needs porting/writing fresh since the presenter was dropped.
