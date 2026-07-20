/*
 * Phase 1: Flight Replay Dashboard. Original code (not ported from
 * Betaflight blackbox-log-viewer) - orchestrates the decoder (decoder.js)
 * and unit conversions (units.js) into charts (charts.js).
 */

function unwrapDegrees(arr) {
  const out = new Array(arr.length);
  if (arr.length === 0) return out;
  let offset = 0;
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const diff = arr[i] - arr[i - 1];
    if (diff > 180) offset -= 360;
    else if (diff < -180) offset += 360;
    out[i] = arr[i] + offset;
  }
  return out;
}

function findLogSegments(bytes) {
  const marker = FlightLogParser.prototype.FLIGHT_LOG_START_MARKER;
  const starts = [];

  for (let i = 0; i <= bytes.length - marker.length; i++) {
    let matched = true;
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) {
        matched = false;
        break;
      }
    }
    if (matched) starts.push(i);
  }

  if (starts.length === 0) {
    return [{ start: 0, end: bytes.length }];
  }

  const segments = [];
  for (let i = 0; i < starts.length; i++) {
    segments.push({
      start: starts[i],
      end: i + 1 < starts.length ? starts[i + 1] : bytes.length,
    });
  }
  return segments;
}

function el(id) {
  return document.getElementById(id);
}

function buildDataset(bytes, segment) {
  const parser = new FlightLogParser(bytes);

  const t = [];
  const stick = [[], [], [], []]; // roll, pitch, yaw, throttle (rcCommand[0..3], raw)
  const gyroFilt = [[], [], []]; // deg/s
  const gyroUnfilt = [[], [], []]; // deg/s
  const pid = { P: [[], [], []], I: [[], [], []], D: [[], [], []], F: [[], [], []] };
  const vbat = []; // volts if convertible, else raw
  const motor = [[], [], [], []];
  const attRoll = [],
    attPitch = [],
    attHeading = [];
  const frameCount = { I: 0, P: 0, S: 0, E: 0 };

  let idx = null;
  let hasGyroUnfilt = false;
  let hasQuat = false;
  let vbatIsVolts = false;
  let t0 = null;

  parser.onFrameReady = (valid, frame, frameType) => {
    if (!valid) return;
    frameCount[frameType] = (frameCount[frameType] || 0) + 1;

    if (frameType !== "I" && frameType !== "P") return;

    const time = frame[idx.time];
    if (t0 === null) t0 = time;
    t.push((time - t0) / 1e6);

    for (let axis = 0; axis < 4; axis++) {
      const i = idx[`rcCommand[${axis}]`];
      stick[axis].push(i !== undefined ? frame[i] : NaN);
    }

    for (let axis = 0; axis < 3; axis++) {
      const fi = idx[`gyroADC[${axis}]`];
      gyroFilt[axis].push(
        fi !== undefined ? BBLUnits.gyroRawToDegreesPerSecond(parser.sysConfig, frame[fi]) : NaN,
      );

      if (hasGyroUnfilt) {
        const ui = idx[`gyroUnfilt[${axis}]`];
        gyroUnfilt[axis].push(BBLUnits.gyroRawToDegreesPerSecond(parser.sysConfig, frame[ui]));
      } else {
        gyroUnfilt[axis].push(NaN);
      }
    }

    for (const term of ["P", "I", "D", "F"]) {
      for (let axis = 0; axis < 3; axis++) {
        const i = idx[`axis${term}[${axis}]`];
        pid[term][axis].push(i !== undefined ? frame[i] : NaN);
      }
    }

    {
      const i = idx["vbatLatest"];
      if (i === undefined) {
        vbat.push(NaN);
      } else {
        const volts = vbatIsVolts ? BBLUnits.vbatLatestToVolts(parser.sysConfig, frame[i]) : null;
        vbat.push(volts !== null ? volts : frame[i]);
      }
    }

    for (let m = 0; m < 4; m++) {
      const i = idx[`motor[${m}]`];
      motor[m].push(i !== undefined ? frame[i] : NaN);
    }

    if (hasQuat) {
      const att = BBLUnits.quaternionToEulerDegrees(
        frame[idx["imuQuaternion[0]"]],
        frame[idx["imuQuaternion[1]"]],
        frame[idx["imuQuaternion[2]"]],
      );
      attRoll.push(att.rollDeg);
      attPitch.push(att.pitchDeg);
      attHeading.push(att.headingDeg);
    }
  };

  parser.parseHeader(segment.start, segment.end);

  idx = parser.frameDefs.I.nameToIndex;
  hasGyroUnfilt = idx["gyroUnfilt[0]"] !== undefined;
  hasQuat =
    idx["imuQuaternion[0]"] !== undefined &&
    idx["imuQuaternion[1]"] !== undefined &&
    idx["imuQuaternion[2]"] !== undefined;
  vbatIsVolts = BBLUnits.vbatLatestToVolts(parser.sysConfig, 0) !== null;

  parser.parseLogData(false, undefined, segment.end);

  return {
    sysConfig: parser.sysConfig,
    stats: parser.stats,
    frameCount,
    t,
    stick,
    gyroFilt,
    gyroUnfilt,
    hasGyroUnfilt,
    pid,
    vbat,
    vbatIsVolts,
    motor,
    hasQuat,
    attRoll,
    attPitch,
    attHeading,
  };
}

function fmtDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(1);
  return `${m}m ${s}s`;
}

function renderInfoPanel(ds) {
  const sc = ds.sysConfig;
  const duration = ds.t.length ? ds.t[ds.t.length - 1] : 0;

  el("infoPanel").innerHTML = `
    <b>${sc.Product ?? "Betaflight log"}</b> &mdash; ${sc["Firmware revision"] ?? "?"} &mdash; ${sc["Board information"] ?? "?"}<br>
    Duration: <b>${fmtDuration(duration)}</b> &nbsp;|&nbsp;
    Loop time: <b>${sc.looptime ?? "?"}&micro;s</b> &nbsp;|&nbsp;
    Frames: I=${ds.frameCount.I ?? 0}, P=${ds.frameCount.P ?? 0}, corrupt=${ds.stats.totalCorruptFrames}<br>
    rollPID ${JSON.stringify(sc.rollPID)} &nbsp; pitchPID ${JSON.stringify(sc.pitchPID)} &nbsp; yawPID ${JSON.stringify(sc.yawPID)}
    ${ds.vbatIsVolts ? "" : "<br><i>Note: battery voltage shown in raw units - unrecognized firmware version for the volts conversion.</i>"}
  `;
  el("infoPanel").classList.add("visible");
  el("gpsNote").classList.add("visible");
}

function renderDashboard(ds) {
  BBLCharts.clearAll();
  const chartsRoot = el("charts");
  chartsRoot.innerHTML = "";

  // Charts measure their container's clientWidth when created, which reads
  // as 0 while an ancestor is display:none - so main must become visible
  // BEFORE any chart is built, not after (that was the earlier bug causing
  // every chart to fall back to a fixed 300px width in a full-width panel).
  el("main").classList.add("visible");

  renderInfoPanel(ds);

  // 1. Stick & throttle inputs
  BBLCharts.createLineChart(chartsRoot, "Stick & Throttle Inputs (raw rcCommand)", ds.t, [
    { label: "Roll", slot: 1, data: ds.stick[0] },
    { label: "Pitch", slot: 2, data: ds.stick[1] },
    { label: "Yaw", slot: 3, data: ds.stick[2] },
    { label: "Throttle", slot: 4, data: ds.stick[3] },
  ]);

  // 2. Gyro filtered vs unfiltered, one chart per axis
  const axisNames = ["Roll", "Pitch", "Yaw"];
  for (let axis = 0; axis < 3; axis++) {
    const seriesDefs = [{ label: `${axisNames[axis]} (filtered)`, slot: axis + 1, data: ds.gyroFilt[axis] }];
    if (ds.hasGyroUnfilt) {
      seriesDefs.push({ label: `${axisNames[axis]} (unfiltered)`, slot: axis + 1, data: ds.gyroUnfilt[axis], dashed: true });
    }
    BBLCharts.createLineChart(chartsRoot, `Gyro ${axisNames[axis]} (deg/s)`, ds.t, seriesDefs);
  }

  // 3. PID terms, one chart per axis
  const pidSlots = { P: 1, I: 2, D: 3, F: 4 };
  for (let axis = 0; axis < 3; axis++) {
    const seriesDefs = [];
    for (const term of ["P", "I", "D", "F"]) {
      if (ds.pid[term][axis].some((v) => !Number.isNaN(v))) {
        seriesDefs.push({ label: term, slot: pidSlots[term], data: ds.pid[term][axis] });
      }
    }
    BBLCharts.createLineChart(chartsRoot, `${axisNames[axis]} PID Terms (raw)`, ds.t, seriesDefs);
  }

  // 4. Battery voltage
  BBLCharts.createLineChart(
    chartsRoot,
    ds.vbatIsVolts ? "Battery Voltage (V)" : "Battery (raw units)",
    ds.t,
    [{ label: "vbat", slot: 1, data: ds.vbat }],
  );

  // 5. Motor outputs (labeled 1-4 to match Betaflight's own motor numbering,
  // even though the log field names and ds.motor[] are 0-indexed internally)
  renderMotorLayoutDiagram(chartsRoot);
  BBLCharts.createLineChart(chartsRoot, "Motor Outputs (raw)", ds.t, [
    { label: "Motor 1", slot: 1, data: ds.motor[0] },
    { label: "Motor 2", slot: 2, data: ds.motor[1] },
    { label: "Motor 3", slot: 3, data: ds.motor[2] },
    { label: "Motor 4", slot: 4, data: ds.motor[3] },
  ]);

  // 6. Attitude (orientation only - no GPS, no spatial position)
  if (ds.hasQuat) {
    // Heading is stored as 0-360deg; unwrap just for the chart so a normal
    // rotation through north doesn't draw as a fake vertical spike.
    BBLCharts.createLineChart(chartsRoot, "Attitude - orientation only, not position (deg)", ds.t, [
      { label: "Roll", slot: 1, data: ds.attRoll },
      { label: "Pitch", slot: 2, data: ds.attPitch },
      { label: "Heading", slot: 3, data: unwrapDegrees(ds.attHeading) },
    ]);
  }

  // 7. Vibration spectrum (gyroUnfilt only - filtered gyro has already had
  // this content suppressed by the FC's own filters)
  if (ds.hasGyroUnfilt) {
    renderSpectrumSection(chartsRoot, ds);
  }
}

function peaksFooterHtml(peaks) {
  if (peaks.length === 0) {
    return "<i>No prominent peaks above the noise floor.</i>";
  }
  const items = peaks
    .map(
      (p) =>
        `<li><b>${p.freq.toFixed(1)} Hz</b> (${p.magnitudeDb.toFixed(1)} dB, +${p.prominenceDb.toFixed(1)} dB above local floor) &mdash; ${BBLFFT.describeFrequencyRange(p.freq)}</li>`,
    )
    .join("");
  return `<div>Flagged peaks (loudest first):</div><ul>${items}</ul>`;
}

/**
 * Small top-down motor layout diagram. Uses the standard Betaflight Quad X
 * motor numbering (1=rear right, 2=front right, 3=rear left, 4=front left)
 * - verified against Betaflight community references, not assumed - but
 * this is a generic diagram, not read from anything in the log itself
 * (the log doesn't record physical motor position or frame geometry), so
 * it won't be correct for a non-Quad-X frame or a custom motor remap.
 */
function renderMotorLayoutDiagram(container) {
  const wrap = document.createElement("div");
  wrap.className = "chart-panel";

  const h = document.createElement("h3");
  h.textContent = "Motor Layout (top-down, standard Quad X)";
  wrap.appendChild(h);

  const note = document.createElement("p");
  note.className = "diagram-note";
  note.textContent =
    "Standard Betaflight Quad X motor numbering, matched to the colors in the chart below. This is not read from the log (it has no frame geometry data) - if your build uses a different frame or a custom motor remap, this won't match.";
  wrap.appendChild(note);

  const labelStroke = 'stroke="rgba(0,0,0,0.55)" stroke-width="3" paint-order="stroke fill"';
  const svgWrap = document.createElement("div");
  svgWrap.className = "motor-diagram";
  svgWrap.innerHTML = `
    <svg viewBox="0 0 200 200" width="180" height="180" role="img" aria-label="Top-down motor layout: motor 1 rear right, motor 2 front right, motor 3 rear left, motor 4 front left">
      <line x1="100" y1="100" x2="146" y2="54" stroke="var(--axis)" stroke-width="3"/>
      <line x1="100" y1="100" x2="146" y2="146" stroke="var(--axis)" stroke-width="3"/>
      <line x1="100" y1="100" x2="54" y2="146" stroke="var(--axis)" stroke-width="3"/>
      <line x1="100" y1="100" x2="54" y2="54" stroke="var(--axis)" stroke-width="3"/>
      <circle cx="100" cy="100" r="16" fill="var(--surface-1)" stroke="var(--axis)" stroke-width="2"/>
      <polygon points="100,16 88,40 112,40" fill="var(--text-secondary)"/>
      <text x="100" y="10" text-anchor="middle" font-size="11" fill="var(--text-secondary)">FRONT</text>
      <circle cx="146" cy="54" r="17" fill="var(--series-2)"/>
      <text x="146" y="60" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" ${labelStroke}>2</text>
      <circle cx="146" cy="146" r="17" fill="var(--series-1)"/>
      <text x="146" y="152" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" ${labelStroke}>1</text>
      <circle cx="54" cy="146" r="17" fill="var(--series-3)"/>
      <text x="54" y="152" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" ${labelStroke}>3</text>
      <circle cx="54" cy="54" r="17" fill="var(--series-4)"/>
      <text x="54" y="60" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" ${labelStroke}>4</text>
    </svg>
  `;
  wrap.appendChild(svgWrap);
  container.appendChild(wrap);
}

function renderSpectrumSection(chartsRoot, ds) {
  const heading = document.createElement("h2");
  heading.textContent = "Vibration Spectrum (unfiltered gyro)";
  heading.style.fontSize = "0.95rem";
  heading.style.margin = "1.5rem 0 0.25rem";
  chartsRoot.appendChild(heading);

  const note = document.createElement("p");
  note.className = "subtitle";
  note.style.margin = "0 0 0.75rem";
  note.textContent =
    "FFT of raw (unfiltered) gyro per axis. Peak frequency labels below are general FPV-community heuristics, not a diagnosis - this log has no motor RPM telemetry, so a peak can't be attributed to a specific motor or harmonic with confidence.";
  chartsRoot.appendChild(note);

  const sampleRateHz = 1e6 / ds.sysConfig.looptime;
  const axisNames = ["Roll", "Pitch", "Yaw"];

  for (let axis = 0; axis < 3; axis++) {
    const spectrum = BBLFFT.averagedPowerSpectrum(ds.gyroUnfilt[axis], sampleRateHz, 2048);
    const maxDisplayHz = 2000;
    let cutoff = spectrum.freqs.length;
    for (let i = 0; i < spectrum.freqs.length; i++) {
      if (spectrum.freqs[i] > maxDisplayHz) {
        cutoff = i;
        break;
      }
    }
    const freqs = spectrum.freqs.slice(0, cutoff);
    const magnitudeDb = spectrum.magnitudeDb.slice(0, cutoff);
    const peaks = BBLFFT.findPeaks(freqs, magnitudeDb, { minFreq: 5, maxFreq: maxDisplayHz, maxPeaks: 5 });

    BBLCharts.createLineChart(
      chartsRoot,
      `${axisNames[axis]} Gyro Vibration Spectrum (dB vs Hz)`,
      freqs,
      [{ label: `${axisNames[axis]} magnitude`, slot: axis + 1, data: magnitudeDb }],
      { xLabel: "frequency (Hz)", syncKey: "bbl-sync-freq", footerHtml: peaksFooterHtml(peaks) },
    );
  }
}

function loadSegment(bytes, segments, segmentIndex) {
  const ds = buildDataset(bytes, segments[segmentIndex]);
  renderDashboard(ds);
}

let currentBytes = null;
let currentSegments = null;

el("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    currentBytes = new Uint8Array(reader.result);
    currentSegments = findLogSegments(currentBytes);

    const segSelect = el("segmentSelect");
    segSelect.innerHTML = "";
    currentSegments.forEach((_, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `Flight segment ${i + 1} of ${currentSegments.length}`;
      segSelect.appendChild(opt);
    });
    segSelect.style.display = currentSegments.length > 1 ? "inline-block" : "none";

    try {
      loadSegment(currentBytes, currentSegments, 0);
    } catch (err) {
      alert(`Error while parsing: ${err}`);
      console.error(err);
    }
  };
  reader.readAsArrayBuffer(file);
});

el("segmentSelect").addEventListener("change", (e) => {
  if (!currentBytes) return;
  try {
    loadSegment(currentBytes, currentSegments, Number(e.target.value));
  } catch (err) {
    alert(`Error while parsing: ${err}`);
    console.error(err);
  }
});
