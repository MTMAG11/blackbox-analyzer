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
- [x] **Phase 2 — Vibration Spectrum Analyzer**: DONE. FFT correctness
  validated via `BBLFFT.selfTest()` against synthetic known-frequency
  signals; owner tested the whole dashboard in their own browser and
  reported 3 issues (chart sizing, motor numbering, legend flicker), all
  fixed - see "Phase 2 UI fixes" below.
- [x] **Phase 3 — PID Tuning Analyzer**: DONE. Step-response detection
  validated via `BBLPidAnalysis.selfTest()` against a synthetic
  underdamped 2nd-order response with analytically known overshoot % and
  settling time; owner confirmed it looks right in their own browser
  against the real sample log. See "Phase 3 details" below.
- [x] **Phase 4 — Automatic Crash Detector**: built and self-verified
  (detectors validated via `BBLCrashDetect.selfTest()` against synthetic
  data with known spike/dropout events; full pipeline also run against
  the real sample log - correctly found zero false positives on what was
  a normal flight, just one "SWITCH" disarm classified as informational,
  not concerning - see "Phase 4 details" below), but not yet manually
  confirmed by the owner in their own browser.
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
- Heading is unwrapped for display only (`unwrapDegrees()` in `app.js`) so
  a genuine 360/0 crossing doesn't draw as a fake vertical spike. Verified
  against the real log that a ~170deg heading change mid-flight renders as
  a smooth ramp, not a jump - the unwrap function correctly left it alone
  since it wasn't a wrap in that case.

## Phase 2 details

Added below the Phase 1 charts, one FFT-based "Vibration Spectrum" chart
per gyro axis (Roll/Pitch/Yaw), using **`gyroUnfilt`** (not `gyroADC` -
the FC's own filters already suppress the high-frequency content vibration
analysis cares about, so the filtered signal would hide it).

- `src/fft.js`: original code (not ported), a standard iterative
  radix-2 Cooley-Tukey FFT + Welch's-method averaged power spectrum
  (overlapping 2048-sample Hann-windowed segments, 50% overlap) + simple
  local-maxima peak picking (must be >=6dB above the local median to
  count as a peak).
- Correctness is validated by `BBLFFT.selfTest()`: builds a synthetic
  signal from two known frequencies (100Hz, 450Hz), runs it through the
  whole pipeline, and asserts the detected peaks land within one FFT bin
  of the true frequency. Passed. Not wired into the UI (it's a dev-time
  correctness check, not a user feature) - call it from the browser
  console if `src/fft.js` is ever modified.
- Full pipeline (decode -> `gyroUnfilt` -> FFT -> peak-pick) also run
  against the real sample log programmatically: sane output (8000Hz
  sample rate matching the 125us looptime, 150 averaged windows, a broad
  ~700-1000Hz hump on all three axes consistent with real prop/motor
  noise, one low-frequency (~8-12Hz) peak per axis consistent with normal
  flight dynamics).

### Confidence notes (Phase 2)

- **Peak frequency labels are general FPV-community heuristic ranges,
  explicitly hedged, not a diagnosis.** This log has no motor RPM/eRPM
  telemetry field, so a peak can't be attributed to a specific motor or
  harmonic with any confidence - `BBLFFT.describeFrequencyRange()` says
  so in its own output text (e.g. "unconfirmed - no RPM telemetry in this
  log"). If a future log ever has bidirectional DShot RPM data, this
  should be revisited - real RPM would let peaks be attributed to actual
  motor harmonics with much higher confidence.
- The FFT math itself (the actual signal processing) is standard,
  self-tested, and not speculative - the uncertainty is entirely in the
  frequency-to-cause interpretation layer on top of it, which is exactly
  where the hedging is applied.

## Phase 2 UI fixes (from owner's real-browser testing)

- **Chart width bug**: every chart rendered as a fixed 300px square inside
  a full-width panel. Root cause: `BBLCharts.createLineChart` measures
  `container.clientWidth` at creation time, but charts were being built
  while the `<main>` ancestor still had `display:none` (visibility was
  only toggled on *after* all charts were created) - and `clientWidth`
  reads as 0 on anything inside a `display:none` ancestor, so every chart
  fell back to `Math.max(0-24, 300)` = 300px. Fixed by moving
  `el("main").classList.add("visible")` to the top of `renderDashboard()`,
  before any chart is built. Verified: canvas now measures ~887px in an
  ~898px panel instead of a fixed 300px.
- **Motor numbering**: charts labeled motors 0-3 (matching the raw log
  field names `motor[0..3]`), but Betaflight's own convention (shown in
  its Configurator, and what the owner expects) numbers them 1-4. Chart
  labels changed to "Motor 1"-"Motor 4"; the underlying field indices
  (`ds.motor[0..3]`) are unchanged, only the display label shifted.
- **Motor layout diagram added**: a small top-down SVG diagram next to
  the Motor Outputs chart, showing the standard Betaflight Quad X motor
  positions (1=rear right, 2=front right, 3=rear left, 4=front left,
  verified against community references - see git log for this commit)
  with a "FRONT" arrow, colored to match each motor's chart series color.
  Explicitly labeled as *not* read from the log (it has no frame geometry
  data) and won't be correct for a non-Quad-X frame or custom motor remap
  - this is a generic reference diagram, not derived from this specific
  aircraft.
- **Legend flicker fixed**: uPlot's live legend uses `display:inline-block`
  text whose width changes with digit count as the cursor moves, which
  was pushing the legend across the 1-line/2-line wrap threshold rapidly
  and causing visible jitter. Fixed with CSS (`.u-legend .u-value {
  min-width: 5.5em; text-align: right; font-variant-numeric:
  tabular-nums; }`) - pins the value column width so wrap state no longer
  depends on the displayed number's digit count. Verified: legend height
  stayed exactly constant across 20 simulated cursor positions swept
  across a chart (previously would have varied).
- **Legend series toggle replaced with a checkbox**: uPlot's default
  toggle dims the whole legend row to 30% opacity when a series is
  hidden, which read as an error state rather than an off switch (owner
  feedback). Replaced with a checkbox-style marker in
  `enhanceLegendCheckboxes()` (`charts.js`): filled + checkmark = showing
  (the default), hollow = hidden, label text stays full opacity always.
  Implemented via a `MutationObserver` watching each legend row's class
  for uPlot's own `u-off` toggle, since uPlot doesn't expose a toggle
  callback directly. Verified: default state is all-checked, clicking a
  marker toggles to hollow/no-checkmark while the series actually
  disappears from the chart.

## Phase 3 details

Added a "PID Tracking (setpoint vs gyro)" section below the vibration
spectrum, one chart per axis (Roll/Pitch/Yaw) plotting Setpoint, Gyro
(filtered), and the tracking Error (`setpoint - gyro`), with a text
summary of detected step-response symptoms underneath each chart.

- `src/pidanalysis.js`: original code (not ported), standard control-
  systems step-response analysis (the same kind used to characterize any
  feedback loop's overshoot/settling/oscillation), applied heuristically
  to noisy real flight data rather than a clean bench step test.
  - `detectStepEvents()`: finds deliberate stick inputs (rapid, sustained
    setpoint changes over a 20ms window, at least 60deg/s, at least
    250ms apart) as distinct from normal continuous stick wiggle.
  - `analyzeStepResponses()`: for each detected step, measures overshoot
    (peak error swing *past* the target in the opposite direction from
    the initial approach - not the same as the initial catch-up lag,
    which is normal), oscillation (hysteresis-based band-crossing count -
    see confidence notes), and settling time (first point error stays
    within a tolerance band for a sustained hold).
  - `summarize()`: turns the per-event results into hedged, plain-English
    text. Never suggests a specific new PID number, per the project's
    hard rule - describes symptoms only.
- Confirmed from the real upstream source (`flightlog.js`, not guessed)
  that `setpoint[0-2]` needs **no unit conversion** on this firmware
  (Betaflight >=4.0.0 uses it raw, already in deg/s, same units as
  converted `gyroADC`) - see git log for the exact source lines checked.
- Correctness validated by `BBLPidAnalysis.selfTest()`: builds a synthetic
  underdamped 2nd-order step response (zeta=0.3, wn=20rad/s) with an
  *analytically known* overshoot % (37.23%, from the standard formula)
  and settling time (~667ms, from the standard "4/(zeta*wn)" formula),
  runs it through the real detection pipeline, and checks the measured
  values land close to the known-correct ones. Passed: measured overshoot
  37.23% (essentially exact), measured settling 562ms (within the known
  imprecision of that textbook approximation formula, not a bug).

### Confidence notes (Phase 3)

- **The oscillation ("ringing") detector went through one real bug found
  by testing against real data, not just the synthetic self-test.** A
  first version counted every raw sign-change of the error signal as a
  "zero crossing" - passed the clean synthetic self-test fine (7
  crossings, sensible for that smooth waveform), but on the real log
  produced 15-85 "crossings" per event, almost all sensor noise wiggling
  near zero rather than real oscillation. Fixed with a hysteresis
  (Schmitt-trigger) band-crossing count instead: a crossing only counts
  when the error genuinely swings from outside the tolerance band on one
  side to outside it on the other. Re-verified against both the
  self-test (still passes, now reports a more sensible 3 crossings) and
  the real log (now mostly 0-3 crossings per event, occasionally higher
  for genuinely oscillatory events, instead of the absurd 15-85). This is
  exactly the kind of thing "verify against real data, not just a clean
  synthetic test" is for.
- **Step detection and response-window thresholds (60deg/s minimum step,
  20ms detection window, 250ms response window, 15% settle tolerance)
  are reasonable first-pass choices, not tuned against a large dataset.**
  They produced plausible-looking results on the one real log available
  (14 roll steps, 6 pitch steps, 2 yaw steps, overshoot 0-90%, settling
  10-97ms) but haven't been validated against a second log or against
  the owner's own sense of how that flight felt to fly. Revisit if a
  future log's results look implausible.
- **Symptom labels are explicitly hedged, never a diagnosis or a PID
  number**, per the project's hard rule. "Oscillation detected" says
  "possible sign of P or D gain... though this alone isn't conclusive
  (could also be pilot input, turbulence, or something unrelated)" -
  this is intentional, not a hedge to remove later.

## Phase 4 details

Added a "Crash / Anomaly Detection" panel (text list, not a chart - the
output is discrete ranked findings, not a continuous signal) at the
bottom of the dashboard.

- `src/crashdetect.js`: original code, except `DISARM_REASON_NAMES` which
  is transcribed directly from the real upstream source
  (`flightlog_fielddefs.js`'s `FLIGHT_LOG_DISARM_REASON`), not guessed.
  Four detectors, most to least authoritative:
  1. **DISARM reason check** - Betaflight logs *why* it disarmed via an
     event frame. If the reason is `CRASH_PROTECTION` or
     `RUNAWAY_TAKEOFF`, that's the flight controller's own onboard
     detection reporting itself, not an inference by this tool - marked
     "high confidence". Any other reason (STICKS, SWITCH, FAILSAFE, etc.)
     is normal and shown as "info", not a symptom.
  2. **Gyro spikes** - any axis exceeding 1500deg/s, heuristic threshold,
     "medium confidence" (physically possible during hard flying, not
     just crashes, though 1500deg/s is well beyond normal even
     aggressive acro).
  3. **Motor dropouts** - all 4 motors dropping from active to near-idle
     within ~60ms with no nearby disarm event, "medium confidence"
     (possible power interruption, but a hard throttle chop can look
     similar).
  4. **Abrupt log end** - log ends with motors still active and no
     disarm recorded, "medium confidence" (possible sudden power loss
     before the FC could log its own disarm, but could just be a partial
     log file).
- **Explicitly NOT implemented: motor "desync" detection.** This log has
  no RPM/eRPM telemetry (no bidirectional DShot data), so there's no way
  to compare commanded motor output against actual motor speed - a
  "desync detector" built from commanded output alone would mostly be
  guessing. Flagged here and in the UI rather than shipped as a fake-
  confident feature (per "tell me directly if something is less reliable
  than expected, don't ship a degraded silent version").
- To get event timing, `buildDataset()` (`app.js`) now also captures
  DISARM event frames, tagged with the most recently seen main-frame time
  as an approximation (event frames don't carry their own timestamp).

### Confidence notes (Phase 4)

- Validated with `BBLCrashDetect.selfTest()`: synthetic data with a known
  gyro spike, a known motor dropout far from any disarm (must be
  flagged), and a known motor dropout right next to a disarm (must NOT
  be flagged, since that's just the FC intentionally cutting power).
  Passed - detectors returned exactly the expected findings, none extra.
- Full pipeline also run against the real sample log: correctly found
  **zero false positives** on what was an uneventful flight - one
  "SWITCH" disarm (normal, pilot-initiated), classified as informational
  rather than a symptom, nothing else flagged. This is a meaningful
  negative-case check, not just "it ran without crashing" - a detector
  that flags everything as suspicious would be useless, and this one
  didn't.
- The heuristic thresholds (1500deg/s gyro spike, 300/60 motor active/
  idle levels, 60ms dropout window) are reasonable first-pass values
  chosen by reasoning about typical flight ranges, not tuned against a
  labeled dataset of real crashes (none was available). If a future
  session has access to a log from an actual known crash, re-verify
  these thresholds catch it and adjust if needed.

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

`src/charts.js`, `src/fft.js`, `src/pidanalysis.js`, and `src/app.js` are
original code (not ported), written for this project.

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
  fft.js            FFT + vibration spectrum analysis (original, self-tested)
  pidanalysis.js    step-response symptom detection (original, self-tested)
  crashdetect.js    crash/anomaly detectors (original, self-tested)
  charts.js         uPlot chart-creation helper (original)
  app.js            dataset builder + dashboard orchestration (original)
/logs/              Sample .bbl files (safe, no location data)
  btfl_007.bbl      Real sample log, used for decoder verification
/docs/              This file
LICENSE             GPL-3.0 (see licensing note above)
NOTICE.md           Attribution details for the ported code
```

Load order in `index.html` matters: uPlot CDN -> tools.js -> datastream.js
-> decoders.js -> decoder.js -> units.js -> fft.js -> pidanalysis.js ->
crashdetect.js -> charts.js -> app.js (each later file depends on globals
defined by the ones before it).

## Open issues / things to know for next session

- **Phase 4 needs the owner's manual confirmation** in their own browser
  (only verified programmatically/self-tested this session).
- **Motor "desync" detection is a known, explicitly-flagged gap** (Phase
  4) - no RPM/eRPM telemetry in this log to detect it reliably. Revisit
  only if a future log ever has bidirectional DShot data.
- **Confirm GitHub Pages live URL loads** (`https://mtmag11.github.io/
  blackbox-analyzer/`) - as of this session, still blocked on an ongoing
  GitHub platform-wide Actions outage (not a repo config issue - GitHub's
  own status page confirmed it, still unresolved after 2.5+ hours across
  multiple check-ins). Nothing to do here but wait for GitHub and check
  again; every deploy attempt so far has failed at startup, gotten stuck
  queued, or been auto-cancelled by a newer push superseding it.
- **Motor layout diagram assumes a standard Quad X frame** with stock
  Betaflight motor numbering - it's a generic reference diagram, not read
  from the log. If the owner's frame is a different layout or has a
  custom motor remap, this diagram would need to become configurable
  (not worth building until/unless it's actually wrong for their setup).
- rcCommand and PID terms (P/I/D/F) are raw units, not real-world units
  (see Phase 1 confidence notes) - setpoint and gyro ARE real units
  (deg/s) as of Phase 3, since that conversion was verified against the
  source. Revisit rcCommand/PID-term units only if a future phase
  actually needs them in real-world terms.
- No performance profiling done yet on very long flights (this sample was
  ~1m17s of flight data across 155k frames and rendered fine; haven't
  tested a 5+ minute flight).
- The dev preview browser tool used during this session cached `src/*.js`
  files across edits within the same tab (stale globals after a file
  edit) - closing and reopening the tab fixed it. Not a real bug in the
  site; just a note in case a future session hits the same confusing
  symptom while testing.
