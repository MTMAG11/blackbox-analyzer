# FPV Blackbox Analysis Platform

A browser-based tool for analyzing Betaflight `.bbl` blackbox logs from an FPV
drone — decode, replay, and inspect flight telemetry entirely client-side.
No backend, no upload, no build step. Your log never leaves your browser.

**Live**: https://mtmag11.github.io/blackbox-analyzer/

## What it does

Load a `.bbl` file and get a tabbed dashboard:

- **Overview** — at-a-glance duration and crash-status summary
- **Flight Replay** — stick/throttle inputs, gyro (filtered + unfiltered),
  PID terms, battery voltage, motor outputs (with a top-down motor-layout
  diagram), orientation, and barometric altitude
- **Vibration** — FFT-based vibration spectrum per axis, with flagged
  frequency peaks
- **PID Tuning** — setpoint-vs-gyro tracking error and step-response
  symptoms (overshoot, oscillation, sluggish settling)
- **Crash Detection** — ranked possibilities (never a confident diagnosis),
  led by Betaflight's own onboard crash/runaway detection when available
- **3D Attitude** — a small rotating model driven by the logged orientation
  quaternion, with playback controls
- **Flight Metrics** — objective, unscored numbers (throttle smoothness,
  stick activity, disturbance recovery time)

There's also a batch-upload mode that screens multiple log files at once
and flags which ones look like real flights vs. a bench test.

No GPS data is ever available on this hardware, so nothing here shows or
implies spatial position — orientation only.

## Using it

Just open `index.html` in a browser (double-click it — no server needed),
or use the [live version](https://mtmag11.github.io/blackbox-analyzer/).
Choose a `.bbl` file and the dashboard populates.

## Tech

Plain HTML/CSS/JavaScript. No npm, no framework, no bundler — every
`<script>` in `index.html` is loaded directly, in dependency order. The
one external dependency is [uPlot](https://github.com/leeoniya/uPlot),
loaded via CDN, for the charts.

The binary log decoder is adapted from Betaflight's own
[`blackbox-log-viewer`](https://github.com/betaflight/blackbox-log-viewer)
rather than reverse-engineered from scratch — see [NOTICE.md](NOTICE.md)
for attribution details.

For project history, architecture notes, and what's been verified vs.
what's still a heuristic, see [`docs/PROJECT.md`](docs/PROJECT.md).

## License

GPL-3.0 — see [LICENSE](LICENSE). This repo incorporates GPL-3.0 code from
Betaflight's blackbox-log-viewer (see [NOTICE.md](NOTICE.md)), which is
why the whole repo carries that license.
