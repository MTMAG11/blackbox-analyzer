# FPV Blackbox Analysis Platform — Project Status

Static, client-side-only website for analyzing Betaflight `.bbl` blackbox
logs. No backend, no build step, plain HTML/CSS/JS. Hosted on GitHub Pages.

Read this file first in any new session — it reflects the current state so
you don't need prior conversation history.

## Confirmed facts about the owner's hardware/logs (don't re-derive)

- Firmware: Betaflight 2025.12.5, board HGLRC F405 V2, **8kHz loop time**
  (125us loop time in header).
- Fields present in real logs: `loopIteration`, `time`, `axisP/I/D/F[0-2]`
  (PID terms — note `axisF[2]`/yaw feedforward is absent in the sample log,
  code handles missing fields gracefully), `rcCommand[0-3]`, `setpoint[0-3]`,
  `vbatLatest`, `amperageLatest`, `baroAlt`, `rssi`, `gyroADC[0-2]`,
  `gyroUnfilt[0-2]`, `accSmooth[0-2]`, `imuQuaternion[0-2]`, `motor[0-3]`.
- **No GPS fields, ever, for this setup.** No G/H frame types in the log.
  Never build or imply spatial position tracking. Orientation via
  `imuQuaternion` is fine (the FC logs fused orientation directly — no need
  to integrate raw gyro, which would drift).
- Baseline PID header values: rollPID 45/80/30, pitchPID 47/84/34,
  yawPID 45/80/0 (verified against real log header).
- Sample logs are safe to include in a public repo (no location data).

## Phase status

- [x] **Phase 0 — Foundation + Decoder**: DONE, verified against a real
  log. GitHub repo created and pushed
  (https://github.com/MTMAG11/blackbox-analyzer). One lingering open item:
  GitHub Pages live URL not yet confirmed loading end-to-end — GitHub had
  a platform-wide Actions/Pages outage on 2026-07-19 that caused the first
  few build attempts to fail (not a repo config issue). Check
  `https://mtmag11.github.io/blackbox-analyzer/` next session.
- [x] **Phase 1 — Flight Replay Dashboard**: DONE, confirmed working by
  owner against the real sample log. See "Phase 1 details" below.
- [ ] Phase 2 — Vibration Spectrum Analyzer: not started.
- [ ] Phase 3 — PID Tuning Analyzer: not started.
- [ ] Phase 4 — Automatic Crash Detector: not started.
- [ ] Phase 5 — Attitude Reconstruction: not started.
- [ ] Phase 6 — AI Flight Coach (exploratory, not committed): not started.
- [ ] Phase 7 — Integrated Platform: not started, not designed.

## Decoder verification (Phase 0)

Verified against `logs/btfl_007.bbl` (real flight log from the owner's
drone, "Flight 3, 7.19"). Parsed output matched all confirmed facts:
firmware/board strings, 125us loop time = 8kHz, rollPID/pitchPID/yawPID
header values, all expected fields present in the expected order with no
GPS fields, and 0 corrupt frames across the whole file (2,426 I-frames,
152,812 P-frames, 11 S-frames, 4 E-frames) — the self-resyncing frame
parser never desynced.

## Phase 1 details

`index.html` is now the real flight replay dashboard (it replaced the
Phase 0 throwaway test harness). Owner loads a `.bbl` file, picks a flight
segment if the file has more than one (detected via the log start
marker), and gets synced/zoomable charts:

- Stick & throttle inputs (`rcCommand[0-3]`, raw units)
- Gyro filtered vs. unfiltered, one chart per axis (deg/s, converted via
  `BBLUnits.gyroRawToDegreesPerSecond`)
- PID terms (P/I/D/F), one chart per axis, raw units (terms that are
  entirely absent for an axis, e.g. yaw F, are just skipped)
- Battery voltage, converted to volts (`BBLUnits.vbatLatestToVolts`,
  Betaflight >=4.0.0 branch only — see confidence note below)
- Motor outputs (`motor[0-3]`, raw units)
- Attitude (`imuQuaternion` -> roll/pitch/heading in degrees, see
  confidence note below), always labeled "orientation shown, not
  position — no GPS in this log" per the hard rule

Charting library: **uPlot** (CDN, pinned to 1.6.32) — chosen over Chart.js
because the sample log has ~155k data points per flight (8kHz) and uPlot
is built for exactly that density without extra decimation work. All
charts share a cursor sync key (`bbl-sync`) so zoom/pan on one chart moves
all of them together.

Colors follow a fixed categorical order (never reassigned per-chart) from
the project's validated dataviz reference palette — e.g. slot 1 (blue)
always means "first" series (roll, or P-term), slot 2 (green) always
"second" (pitch, I-term), etc. Filtered vs. unfiltered gyro use the *same*
hue with a dashed line for the unfiltered variant (secondary encoding,
since it's the same signal, not a new identity). Light/dark mode both
supported via `prefers-color-scheme`.

### Confidence notes (Phase 1)

- **Unit conversions** (volts, amps-if-added-later, gyro deg/s, quaternion
  Euler angles) are ported directly from Betaflight's own formulas
  (`src/units.js` header comment cites the exact upstream functions), not
  guessed. Only the modern-firmware branches were ported (this hardware is
  confirmed Betaflight 2025.12.5); if a much older log is ever loaded, the
  code detects that and falls back to labeling values as raw instead of
  silently showing a wrong number (see `vbatIsVolts` flag in `app.js`).
- **rcCommand (stick inputs) and PID terms are shown in raw log units,
  not deg/s or real-world units.** Upstream's rcCommand-to-deg/s
  conversion is version-dependent and nontrivial; rather than risk a
  subtly wrong conversion, Phase 1 shows raw values. Fine for spotting
  *shape* (when did the stick move, how sharp was the PID response) but
  don't read absolute numbers off these two charts as real-world units.
- **Attitude (roll/pitch/heading) reconstruction is a direct port of
  upstream's quaternion math** (`computeAttitude` in `flightlog.js`),
  including its reconstruction of the unlogged `w` component from the
  unit-quaternion constraint. This is the same method the official
  Betaflight viewer uses, not a novel derivation, so should be reliable.

## Decoder architecture & licensing (important — read before touching src/)

`src/tools.js`, `src/datastream.js`, `src/decoders.js`, `src/decoder.js`,
`src/units.js` are **adapted from the real Betaflight `blackbox-log-viewer`
source** (https://github.com/betaflight/blackbox-log-viewer), not
reverse-engineered from scratch, per the project's original hard rule to
use it "as a starting point." Each file has a header comment listing
exactly what was changed in the port. Summary of changes:

- Converted from ES modules (`import`/`export`) to plain global `<script>`
  files — no build step, so no bundler to resolve module imports.
- Removed the `semver` npm dependency; replaced with a small inline
  `BBLTools.versionGte()` numeric version comparator.
- **Removed GPS (G) and GPS-home (H) frame support entirely.** This
  hardware never logs GPS data, so that code path was dead weight.
- Removed `flightlog_fields_presenter.js` wholesale (~3100 lines of
  display/unit formatting for every possible field/firmware combo).
  `src/units.js` instead ports just the handful of specific formulas this
  project actually needs (see Phase 1 details above).
- Removed `adjustFieldDefsList()` (legacy firmware field-renaming for very
  old Betaflight/Cleanflight versions) since this project only targets
  modern Betaflight.
- Frame/predictor/encoding parsing logic and the frame-stream resync logic
  are otherwise a faithful, unmodified port.

`src/charts.js` and `src/app.js` are original code (not ported), written
for this project.

**Licensing consequence**: because this repo incorporates GPL-3.0 code,
the whole repo is licensed GPL-3.0 (see `LICENSE` at repo root and
`NOTICE.md` for the attribution details). This was an explicit choice
(discussed with the owner in the Phase 0 session) — for a personal hobby
project with no commercial angle, GPL-3.0 has no practical downside.

## Repo structure

```
/index.html        The real flight replay dashboard (Phase 1)
/src/
  tools.js          byte/number helpers (ported)
  datastream.js     ArrayDataStream - the binary reader (ported)
  decoders.js       "tag group" field decoders (ported)
  decoder.js        FlightLogParser - the main decoder (ported, trimmed)
  units.js          unit conversion formulas (ported, trimmed - see above)
  charts.js         uPlot chart-creation helper (original)
  app.js            dataset builder + dashboard orchestration (original)
/logs/              Sample .bbl files (safe, no location data)
  btfl_007.bbl      Real sample log, used for decoder verification
/docs/              This file
LICENSE             GPL-3.0 (see licensing note above)
NOTICE.md           Attribution details for the ported code
```

Load order in `index.html` matters: uPlot CDN -> tools.js -> datastream.js
-> decoders.js -> decoder.js -> units.js -> charts.js -> app.js (each
later file depends on globals defined by the ones before it).

## Open issues / things to know for next session

- **Confirm GitHub Pages live URL loads** (`https://mtmag11.github.io/
  blackbox-analyzer/`) - blocked on a GitHub platform outage during Phase
  0, should be resolved by now but wasn't re-checked after Phase 1 work
  started.
- rcCommand and PID terms are raw units, not real-world units (see
  confidence notes above) - fine for now, revisit if Phase 3 (PID tuning
  analyzer) needs real units for its symptom descriptions.
- No performance profiling done yet on very long flights (this sample was
  ~19 seconds of active flight data across 155k frames and rendered fine;
  haven't tested a 5+ minute flight).
