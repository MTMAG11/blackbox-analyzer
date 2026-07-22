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
  const setpoint = [[], [], []]; // roll, pitch, yaw - deg/s, already scaled in the log (BF >=4.0.0)
  const vbat = []; // volts if convertible, else raw
  const baroAlt = []; // meters, relative to boot - not GPS, no absolute reference
  const motor = [[], [], [], []];
  const attRoll = [],
    attPitch = [],
    attHeading = [];
  const attQuat = { x: [], y: [], z: [], w: [] }; // normalized quaternion, for Phase 5's 3D model
  const frameCount = { I: 0, P: 0, S: 0, E: 0 };
  const disarmEvents = []; // [{ timeSec, reason }]

  let idx = null;
  let hasGyroUnfilt = false;
  let hasQuat = false;
  let hasSetpoint = false;
  let hasBaroAlt = false;
  let hasStick = false;
  let hasMotor = false;
  let hasVbat = false;
  let vbatIsVolts = false;
  let t0 = null;
  let lastKnownTime = null;

  parser.onFrameReady = (valid, frame, frameType) => {
    if (!valid) return;
    frameCount[frameType] = (frameCount[frameType] || 0) + 1;

    if (frameType === "E") {
      // Event frames carry no timestamp of their own; tag with the most
      // recently seen main-frame time as an approximation (events are
      // interleaved close to nearby I/P frames in the byte stream).
      if (frame.event === FlightLogEvent.DISARM && lastKnownTime !== null) {
        disarmEvents.push({ timeSec: (lastKnownTime - t0) / 1e6, reason: frame.data.reason });
      }
      return;
    }

    if (frameType !== "I" && frameType !== "P") return;

    const time = frame[idx.time];
    if (t0 === null) t0 = time;
    lastKnownTime = time;
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

    for (let axis = 0; axis < 3; axis++) {
      const i = idx[`setpoint[${axis}]`];
      setpoint[axis].push(i !== undefined ? frame[i] : NaN);
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

    if (hasBaroAlt) {
      baroAlt.push(BBLUnits.baroAltToMeters(frame[idx["baroAlt"]]));
    }

    if (hasQuat) {
      const q = BBLUnits.normalizeQuaternion(
        frame[idx["imuQuaternion[0]"]],
        frame[idx["imuQuaternion[1]"]],
        frame[idx["imuQuaternion[2]"]],
      );
      attQuat.x.push(q.x);
      attQuat.y.push(q.y);
      attQuat.z.push(q.z);
      attQuat.w.push(q.w);

      const att = BBLUnits.eulerDegreesFromNormalizedQuaternion(q);
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
  hasSetpoint = idx["setpoint[0]"] !== undefined && idx["setpoint[1]"] !== undefined && idx["setpoint[2]"] !== undefined;
  hasBaroAlt = idx["baroAlt"] !== undefined;
  hasStick = idx["rcCommand[0]"] !== undefined;
  hasMotor = idx["motor[0]"] !== undefined;
  hasVbat = idx["vbatLatest"] !== undefined;
  vbatIsVolts = BBLUnits.vbatLatestToVolts(parser.sysConfig, 0) !== null;

  parser.parseLogData(false, undefined, segment.end);

  return {
    sysConfig: parser.sysConfig,
    stats: parser.stats,
    frameCount,
    t,
    stick,
    hasStick,
    gyroFilt,
    gyroUnfilt,
    hasGyroUnfilt,
    pid,
    setpoint,
    hasSetpoint,
    vbat,
    vbatIsVolts,
    hasVbat,
    baroAlt,
    hasBaroAlt,
    motor,
    hasMotor,
    hasQuat,
    attRoll,
    attPitch,
    attHeading,
    attQuat,
    disarmEvents,
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

/**
 * Builds a tab bar + one panel per name, all appended to `container` in
 * normal (visible) document flow - callers must populate every panel with
 * its charts BEFORE calling activate(), not after. Charts measure their
 * container's clientWidth at creation time, which reads as 0 inside a
 * display:none ancestor (the same bug already fixed once for `main` -
 * see the comment in renderDashboard), so panels stay visible during
 * construction and only get hidden once everything inside them exists.
 */
function createTabs(container, tabNames) {
  container.innerHTML = "";
  const tabBar = document.createElement("div");
  tabBar.className = "tab-bar";
  const panelsWrap = document.createElement("div");

  const panels = {};
  const buttons = {};

  const activate = (name) => {
    tabNames.forEach((n) => {
      const isActive = n === name;
      panels[n].style.display = isActive ? "" : "none";
      buttons[n].classList.toggle("active", isActive);
    });
  };

  tabNames.forEach((name) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-button";
    btn.textContent = name;
    btn.addEventListener("click", () => activate(name));
    tabBar.appendChild(btn);
    buttons[name] = btn;

    const panel = document.createElement("div");
    panel.className = "tab-panel";
    panelsWrap.appendChild(panel);
    panels[name] = panel;
  });

  container.appendChild(tabBar);
  container.appendChild(panelsWrap);

  return { panels, activate };
}

function renderOverviewTab(container, ds, crashFindings) {
  const wrap = document.createElement("div");
  wrap.className = "chart-panel";

  const h = document.createElement("h3");
  h.textContent = "At a Glance";
  wrap.appendChild(h);

  const highOrMedium = crashFindings.filter((f) => f.confidence === "high" || f.confidence === "medium");
  const crashLine =
    highOrMedium.length === 0
      ? "No crash or anomaly indicators found - see the Crash Detection tab for detail."
      : `${highOrMedium.length} possible issue(s) flagged - see the Crash Detection tab for detail.`;

  const p = document.createElement("p");
  p.className = "diagram-note";
  p.style.fontSize = "0.85rem";
  p.innerHTML = `This flight lasted <b>${fmtDuration(ds.t.length ? ds.t[ds.t.length - 1] : 0)}</b>. ${crashLine} Use the tabs above for the full charts - this page is just a quick summary.`;
  wrap.appendChild(p);

  container.appendChild(wrap);
}

function renderFlightReplayTab(container, ds) {
  // 1. Stick & throttle inputs (RC input can be disabled in Betaflight's
  // Blackbox tab since 4.3 to save space, like every other field group
  // checked here - not assumed present just because it usually is)
  if (ds.hasStick) {
    BBLCharts.createLineChart(container, "Stick & Throttle Inputs (raw rcCommand)", ds.t, [
      { label: "Roll", slot: 1, data: ds.stick[0] },
      { label: "Pitch", slot: 2, data: ds.stick[1] },
      { label: "Yaw", slot: 3, data: ds.stick[2] },
      { label: "Throttle", slot: 4, data: ds.stick[3] },
    ]);
  } else {
    renderMissingFieldNote(container, "No RC command (stick/throttle) data in this log - this field group was disabled when the flight was logged.");
  }

  // 2. Gyro filtered vs unfiltered, one chart per axis (gyro is always
  // logged - Betaflight doesn't offer a checkbox to disable it)
  const axisNames = ["Roll", "Pitch", "Yaw"];
  for (let axis = 0; axis < 3; axis++) {
    const seriesDefs = [{ label: `${axisNames[axis]} (filtered)`, slot: axis + 1, data: ds.gyroFilt[axis] }];
    if (ds.hasGyroUnfilt) {
      seriesDefs.push({ label: `${axisNames[axis]} (unfiltered)`, slot: axis + 1, data: ds.gyroUnfilt[axis], dashed: true });
    }
    BBLCharts.createLineChart(container, `Gyro ${axisNames[axis]} (deg/s)`, ds.t, seriesDefs);
  }

  // 3. PID terms, one chart per axis (whole group can be disabled)
  const pidSlots = { P: 1, I: 2, D: 3, F: 4 };
  const hasPid = ["P", "I", "D", "F"].some((term) => ds.pid[term].some((axisArr) => axisArr.some((v) => !Number.isNaN(v))));
  if (hasPid) {
    for (let axis = 0; axis < 3; axis++) {
      const seriesDefs = [];
      for (const term of ["P", "I", "D", "F"]) {
        if (ds.pid[term][axis].some((v) => !Number.isNaN(v))) {
          seriesDefs.push({ label: term, slot: pidSlots[term], data: ds.pid[term][axis] });
        }
      }
      BBLCharts.createLineChart(container, `${axisNames[axis]} PID Terms (raw)`, ds.t, seriesDefs);
    }
  } else {
    renderMissingFieldNote(container, "No PID term data in this log - this field group was disabled when the flight was logged.");
  }

  // 4. Battery voltage
  if (ds.hasVbat) {
    BBLCharts.createLineChart(
      container,
      ds.vbatIsVolts ? "Battery Voltage (V)" : "Battery (raw units)",
      ds.t,
      [{ label: "vbat", slot: 1, data: ds.vbat }],
    );
  } else {
    renderMissingFieldNote(container, "No battery voltage data in this log - this field group was disabled when the flight was logged.");
  }

  // 5. Motor outputs (labeled 1-4 to match Betaflight's own motor numbering,
  // even though the log field names and ds.motor[] are 0-indexed internally)
  renderMotorLayoutDiagram(container);
  if (ds.hasMotor) {
    BBLCharts.createLineChart(container, "Motor Outputs (raw)", ds.t, [
      { label: "Motor 1", slot: 1, data: ds.motor[0] },
      { label: "Motor 2", slot: 2, data: ds.motor[1] },
      { label: "Motor 3", slot: 3, data: ds.motor[2] },
      { label: "Motor 4", slot: 4, data: ds.motor[3] },
    ]);
  } else {
    renderMissingFieldNote(container, "No motor output data in this log - this field group was disabled when the flight was logged.");
  }

  // 6. Attitude (orientation only - no GPS, no spatial position)
  if (ds.hasQuat) {
    // Heading is stored as 0-360deg; unwrap just for the chart so a normal
    // rotation through north doesn't draw as a fake vertical spike.
    BBLCharts.createLineChart(container, "Attitude - orientation only, not position (deg)", ds.t, [
      { label: "Roll", slot: 1, data: ds.attRoll },
      { label: "Pitch", slot: 2, data: ds.attPitch },
      { label: "Heading", slot: 3, data: unwrapDegrees(ds.attHeading) },
    ]);
  }

  // 7. Altitude (barometer, relative to boot - not GPS, no absolute reference)
  if (ds.hasBaroAlt) {
    BBLCharts.createLineChart(container, "Altitude - barometer, relative to boot, not GPS (m)", ds.t, [
      { label: "Altitude", slot: 1, data: ds.baroAlt },
    ]);
  }
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

  const crashFindings = BBLCrashDetect.analyze(ds);

  const tabNames = ["Overview", "Flight Replay", "Vibration", "PID Tuning", "Crash Detection", "3D Attitude", "Flight Metrics"];
  const { panels, activate } = createTabs(chartsRoot, tabNames);

  renderOverviewTab(panels["Overview"], ds, crashFindings);
  renderFlightReplayTab(panels["Flight Replay"], ds);

  // Vibration spectrum (gyroUnfilt only - filtered gyro has already had
  // this content suppressed by the FC's own filters)
  if (ds.hasGyroUnfilt) {
    renderSpectrumSection(panels["Vibration"], ds);
  } else {
    panels["Vibration"].innerHTML = '<p class="diagram-note">No unfiltered gyro data in this log.</p>';
  }

  // PID tuning: gyro-vs-setpoint tracking error and step-response symptoms
  if (ds.hasSetpoint) {
    renderPidAnalysisSection(panels["PID Tuning"], ds);
  } else {
    panels["PID Tuning"].innerHTML = '<p class="diagram-note">No setpoint data in this log.</p>';
  }

  // Crash / anomaly detection: ranked possibilities, never a diagnosis
  renderCrashSection(panels["Crash Detection"], ds, crashFindings);

  // 3D attitude reconstruction (orientation only - no GPS, no position/path)
  if (ds.hasQuat) {
    renderAttitude3DSection(panels["3D Attitude"], ds);
  } else {
    panels["3D Attitude"].innerHTML = '<p class="diagram-note">No imuQuaternion data in this log.</p>';
  }

  // Flight metrics (exploratory) - objective numbers only, never a
  // subjective "good/bad flying" rating (no labeled ground truth for that)
  if (ds.hasSetpoint) {
    renderFlightCoachSection(panels["Flight Metrics"], ds);
  } else {
    panels["Flight Metrics"].innerHTML = '<p class="diagram-note">No setpoint data in this log.</p>';
  }

  // Every panel is fully built now - safe to hide all but the first.
  activate(tabNames[0]);
}

function renderMissingFieldNote(container, message) {
  const p = document.createElement("p");
  p.className = "diagram-note";
  p.textContent = message;
  container.appendChild(p);
}

function confidenceBadgeHtml(confidence) {
  const labels = { high: "High confidence", medium: "Possible", info: "Info" };
  return `<span class="finding-badge ${confidence}">${labels[confidence] ?? confidence}</span>`;
}

function renderCrashSection(chartsRoot, ds, findings) {
  const wrap = document.createElement("div");
  wrap.className = "chart-panel";

  const h = document.createElement("h3");
  h.textContent = "Crash / Anomaly Detection";
  wrap.appendChild(h);

  const note = document.createElement("p");
  note.className = "diagram-note";
  note.textContent =
    "Ranked possibilities, not a diagnosis. “High confidence” only applies to Betaflight's own onboard crash/runaway detection reporting itself via the disarm reason - everything else is a heuristic that can have false positives. Motor “desync” specifically isn't detected: this log has no RPM/eRPM telemetry, so there's no reliable way to tell commanded motor output apart from an actual mechanical failure.";
  wrap.appendChild(note);

  const list = document.createElement("ul");
  list.className = "finding-list";

  if (findings.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = "<span>No crash or anomaly indicators found in this flight.</span>";
    list.appendChild(li);
  } else {
    for (const f of findings) {
      const li = document.createElement("li");
      li.innerHTML = `${confidenceBadgeHtml(f.confidence)}<span>${f.description}</span>`;
      list.appendChild(li);
    }
  }

  wrap.appendChild(list);
  chartsRoot.appendChild(wrap);
}

function metricRow(label, value) {
  return `<dt>${label}:</dt><dd>${value}</dd>`;
}

function renderFlightCoachSection(chartsRoot, ds) {
  const wrap = document.createElement("div");
  wrap.className = "chart-panel";

  const h = document.createElement("h3");
  h.textContent = "Flight Metrics (exploratory)";
  wrap.appendChild(h);

  const note = document.createElement("p");
  note.className = "diagram-note";
  note.textContent =
    "Objective numbers only - not a skill rating or a \"good/bad flying\" judgment. There's no labeled dataset of flights scored by a human to calibrate a rating against, so this section deliberately stops at description. Read these as raw data points, not a grade.";
  wrap.appendChild(note);

  const sampleRateHz = 1e6 / ds.sysConfig.looptime;
  const durationSec = ds.t.length ? ds.t[ds.t.length - 1] : 0;
  const axisNames = ["Roll", "Pitch", "Yaw"];

  if (ds.hasStick) {
    const grid = document.createElement("div");
    grid.className = "metrics-grid";

    const throttle = BBLFlightCoach.throttleSmoothness(ds.stick[3], sampleRateHz);
    const throttleGroup = document.createElement("div");
    throttleGroup.className = "metrics-group";
    throttleGroup.innerHTML = `<h4>Throttle</h4><dl>
      ${metricRow("Mean", throttle.mean.toFixed(0))}
      ${metricRow("Std dev", throttle.stdDev.toFixed(1))}
      ${metricRow("Mean |rate of change|", `${throttle.meanAbsRatePerSec.toFixed(0)}/s`)}
    </dl>`;
    grid.appendChild(throttleGroup);

    for (let axis = 0; axis < 3; axis++) {
      const activity = BBLFlightCoach.stickActivity(ds.stick[axis], sampleRateHz, durationSec);
      const group = document.createElement("div");
      group.className = "metrics-group";
      group.innerHTML = `<h4>${axisNames[axis]} Stick Activity</h4><dl>
        ${metricRow("Mean |rate of change|", `${activity.meanAbsRatePerSec.toFixed(0)}/s`)}
        ${metricRow("Direction reversals", `${activity.reversals} (${activity.reversalsPerMin.toFixed(1)}/min)`)}
      </dl>`;
      grid.appendChild(group);
    }

    wrap.appendChild(grid);
  } else {
    renderMissingFieldNote(wrap, "No RC command (stick/throttle) data in this log - throttle and stick activity metrics need it.");
  }

  const disturbanceNote = document.createElement("div");
  disturbanceNote.className = "chart-footer";
  const parts = [];
  for (let axis = 0; axis < 3; axis++) {
    const stepEvents = BBLPidAnalysis.detectStepEvents(ds.setpoint[axis], sampleRateHz);
    const stepEventTimesSec = stepEvents.map((e) => e.index / sampleRateHz);
    const disturbances = BBLFlightCoach.detectDisturbances(
      ds.setpoint[axis],
      ds.gyroFilt[axis],
      ds.t,
      sampleRateHz,
      stepEventTimesSec,
    );
    parts.push(`<div><b>${axisNames[axis]}:</b> ${BBLFlightCoach.summarizeDisturbances(disturbances, 500)}</div>`);
  }
  disturbanceNote.innerHTML = `<div style="margin-bottom:0.3rem;"><b>Disturbance recovery</b> (off-track moments not matching a stick input, distinct from the pilot-input step responses in the PID Tracking section above):</div>${parts.join("")}`;
  wrap.appendChild(disturbanceNote);

  chartsRoot.appendChild(wrap);
}

function renderPidAnalysisSection(chartsRoot, ds) {
  const note = document.createElement("p");
  note.className = "subtitle";
  note.style.margin = "0 0 0.75rem";
  note.textContent =
    "Detects step-input symptoms (overshoot, oscillation, sluggish settling) from how closely gyro tracked setpoint. Symptoms only, not a tuning recommendation - see the note below each axis for what this can and can't tell you.";
  chartsRoot.appendChild(note);

  const sampleRateHz = 1e6 / ds.sysConfig.looptime;
  const axisNames = ["Roll", "Pitch", "Yaw"];
  const responseWindowMs = 250;

  for (let axis = 0; axis < 3; axis++) {
    const error = BBLPidAnalysis.computeError(ds.setpoint[axis], ds.gyroFilt[axis]);
    const events = BBLPidAnalysis.analyzeStepResponses(ds.setpoint[axis], ds.gyroFilt[axis], sampleRateHz, {
      responseWindowMs,
    });
    const summary = BBLPidAnalysis.summarize(events, axisNames[axis], responseWindowMs);

    BBLCharts.createLineChart(
      chartsRoot,
      `${axisNames[axis]} Setpoint vs Gyro (deg/s)`,
      ds.t,
      [
        { label: "Setpoint", slot: 1, data: ds.setpoint[axis] },
        { label: "Gyro (filtered)", slot: 2, data: ds.gyroFilt[axis] },
        { label: "Error", slot: 3, data: error, dashed: true },
      ],
      { footerHtml: `<div>${summary}</div>` },
    );
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

/**
 * 3D drone model driven directly by the recorded quaternion (not by the
 * Euler angles from the chart above, to avoid gimbal-lock artifacts near
 * +-90deg pitch). Local body frame: +X = forward (this is the axis
 * BBLAttitude3D.selfTest() confirmed matches BBLUnits' roll exactly, so
 * it's the roll/longitudinal axis), +Y = right, Z = up out of the local
 * X-Y plane. Motor local positions match the Phase 2 top-down diagram's
 * numbering (1=rear right, 2=front right, 3=rear left, 4=front left).
 */
function renderAttitude3DSection(chartsRoot, ds) {
  const wrap = document.createElement("div");
  wrap.className = "chart-panel";

  const h = document.createElement("h3");
  h.textContent = "Attitude Reconstruction (3D) & Stick Position";
  wrap.appendChild(h);

  const note = document.createElement("p");
  note.className = "diagram-note";
  note.textContent =
    "Orientation shown, not position - no GPS in this log. The model starts nose-away-from-viewer regardless of the actual compass direction at the start of the flight, then rotates left/right with yaw relative to that starting direction. Absolute compass heading is the number in the readout below. Roll/pitch math is self-tested and matches the Attitude chart above exactly - treat the shape as a rough guide, not a precise replay. The two squares show stick position (Mode 2 layout: left stick = yaw/throttle, right stick = roll/pitch) using the fixed -500..+500 / 1000..2000 ranges Betaflight logs rcCommand in, not this flight's own min/max - so the dot only reaches a corner on genuinely full stick deflection.";
  wrap.appendChild(note);

  const armStyle = "width:65px;height:3px;background:var(--axis);transform-origin:0 50%;";
  const sticksHtml = ds.hasStick
    ? `
    <div class="stick-squares">
      <div class="stick-square-wrap">
        <div class="stick-square"><div class="stick-dot" id="stickDotLeft"></div></div>
        <div class="stick-square-label">Yaw / Throttle</div>
      </div>
      <div class="stick-square-wrap">
        <div class="stick-square"><div class="stick-dot" id="stickDotRight"></div></div>
        <div class="stick-square-label">Roll / Pitch</div>
      </div>
    </div>`
    : `<p class="diagram-note">No RC command (stick) data in this log - can't show stick position.</p>`;

  const scene = document.createElement("div");
  scene.className = "attitude3d-wrap";
  scene.innerHTML = `
    <div class="replay-visuals">
      <div class="attitude3d-scene">
        <div class="attitude3d-camera">
          <div class="attitude3d-drone" id="attitude3dDrone">
            <div class="d3-arm" style="${armStyle}transform:rotate3d(0,0,1,135deg);"></div>
            <div class="d3-arm" style="${armStyle}transform:rotate3d(0,0,1,45deg);"></div>
            <div class="d3-arm" style="${armStyle}transform:rotate3d(0,0,1,-135deg);"></div>
            <div class="d3-arm" style="${armStyle}transform:rotate3d(0,0,1,-45deg);"></div>
            <div class="d3-motor" style="background:var(--series-1);transform:translate3d(-46px,46px,0);">1</div>
            <div class="d3-motor" style="background:var(--series-2);transform:translate3d(46px,46px,0);">2</div>
            <div class="d3-motor" style="background:var(--series-3);transform:translate3d(-46px,-46px,0);">3</div>
            <div class="d3-motor" style="background:var(--series-4);transform:translate3d(46px,-46px,0);">4</div>
            <div class="d3-nose" style="transform:translate3d(72px,0,0) rotate3d(0,0,1,90deg);"></div>
            <div class="d3-hub"></div>
          </div>
        </div>
      </div>
      ${sticksHtml}
    </div>
    <div class="attitude3d-controls">
      <button type="button" id="attitude3dPlay">Play</button>
      <input type="range" id="attitude3dSeek" min="0" max="${Math.max(ds.t.length - 1, 0)}" value="0" step="1">
    </div>
    <div class="attitude3d-readout" id="attitude3dReadout"></div>
  `;
  wrap.appendChild(scene);
  chartsRoot.appendChild(wrap);

  const droneEl = scene.querySelector("#attitude3dDrone");
  const playBtn = scene.querySelector("#attitude3dPlay");
  const seekEl = scene.querySelector("#attitude3dSeek");
  const readoutEl = scene.querySelector("#attitude3dReadout");
  const stickDotLeft = scene.querySelector("#stickDotLeft");
  const stickDotRight = scene.querySelector("#stickDotRight");

  // Heading for the visual is RELATIVE to the start of the flight: the
  // model begins nose-away-from-viewer no matter what compass direction
  // the aircraft actually faced, then yaw turns rotate it left/right from
  // there (owner preference). Unwrapped so a 360 crossing doesn't snap it.
  // The -90 maps the model's local +X nose axis from its resting CSS
  // direction (screen right) to up-screen/away. Absolute heading stays in
  // the readout text.
  const headingUnwrapped = unwrapDegrees(ds.attHeading);

  // Fixed physical stick ranges (Betaflight's rcCommand encoding, not
  // derived from this flight's own min/max - using the flight's range
  // would make partial stick deflection look like it maxed out). Roll/
  // pitch/yaw are -500..+500 centered on 0; throttle is the raw
  // 1000..2000 PWM-style range centered on 1500. Confirmed against the
  // real log: throttle hit exactly 1000 and 2000, roll/pitch/yaw stayed
  // well inside +-500 - consistent with these being the real endpoints,
  // not just what got flown.
  const clampNorm = (value, center, halfRange) => Math.max(-1, Math.min(1, (value - center) / halfRange));

  const positionDot = (dotEl, xNorm, yNorm) => {
    if (!dotEl) return;
    dotEl.style.left = `${50 + xNorm * 50}%`;
    dotEl.style.top = `${50 - yNorm * 50}%`; // inverted: up on screen = higher value
  };

  const applyFrame = (i) => {
    const relYaw = headingUnwrapped[i] - headingUnwrapped[0];
    const q = BBLAttitude3D.eulerQuaternion(ds.attRoll[i], ds.attPitch[i], -90 + relYaw);
    droneEl.style.transform = BBLAttitude3D.quaternionToCssMatrix3d(q);
    seekEl.value = i;
    readoutEl.textContent = `t=${ds.t[i].toFixed(1)}s   roll=${ds.attRoll[i].toFixed(0)}°   pitch=${ds.attPitch[i].toFixed(0)}°   heading=${ds.attHeading[i].toFixed(0)}°`;

    if (ds.hasStick) {
      positionDot(stickDotLeft, clampNorm(ds.stick[2][i], 0, 500), clampNorm(ds.stick[3][i], 1500, 500));
      positionDot(stickDotRight, clampNorm(ds.stick[0][i], 0, 500), clampNorm(ds.stick[1][i], 0, 500));
    }
  };

  const player = BBLAttitude3D.createPlayer(ds.t, applyFrame, { rate: 1 });

  playBtn.addEventListener("click", () => {
    if (player.isPlaying()) {
      player.pause();
      playBtn.textContent = "Play";
    } else {
      player.play();
      playBtn.textContent = "Pause";
    }
  });

  seekEl.addEventListener("input", () => {
    player.pause();
    playBtn.textContent = "Play";
    player.seekToIndex(Number(seekEl.value));
  });

  if (ds.t.length > 0) applyFrame(0);
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
    const bytes = new Uint8Array(reader.result);
    const segments = findLogSegments(bytes);
    loadIntoMainDashboard(bytes, segments, 0);
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

function loadIntoMainDashboard(bytes, segments, segmentIndex) {
  currentBytes = bytes;
  currentSegments = segments;

  const segSelect = el("segmentSelect");
  segSelect.innerHTML = "";
  segments.forEach((_, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `Flight segment ${i + 1} of ${segments.length}`;
    segSelect.appendChild(opt);
  });
  segSelect.style.display = segments.length > 1 ? "inline-block" : "none";
  segSelect.value = segmentIndex;

  el("placeholder").style.display = "none";

  try {
    loadSegment(bytes, segments, segmentIndex);
  } catch (err) {
    alert(`Error while parsing: ${err}`);
    console.error(err);
  }
}

function renderBatchResults(rows) {
  const container = el("batchResults");
  if (rows.length === 0) {
    container.innerHTML = '<p class="diagram-note">No files scanned yet.</p>';
    return;
  }

  const table = document.createElement("table");
  table.className = "batch-table";
  table.innerHTML = "<thead><tr><th>File</th><th>Segment</th><th>Duration</th><th>Throttle range</th><th>Verdict</th></tr></thead>";
  const tbody = document.createElement("tbody");

  rows.forEach((row) => {
    const tr = document.createElement("tr");
    const canLoad = row.bytes !== null;
    if (canLoad) tr.className = "clickable";

    const durationText = row.scan.durationSec ? `${row.scan.durationSec.toFixed(1)}s` : "n/a";
    const throttleText = row.scan.throttleRange !== null && row.scan.throttleRange !== undefined ? row.scan.throttleRange.toFixed(0) : "n/a";

    tr.innerHTML = `
      <td>${row.fileName}</td>
      <td>${row.segmentLabel}</td>
      <td>${durationText}</td>
      <td>${throttleText}</td>
      <td><span class="batch-verdict ${row.classification.likelyFlight ? "yes" : "no"}" title="${row.classification.reason}">${row.classification.likelyFlight ? "Likely flight" : "Probably not"}</span></td>
    `;

    if (canLoad) {
      tr.addEventListener("click", () => {
        loadIntoMainDashboard(row.bytes, row.segments, row.segmentIndex);
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    }
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.innerHTML = "";
  container.appendChild(table);
}

el("batchInput").addEventListener("change", (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;

  el("batchResults").innerHTML = '<p class="diagram-note">Scanning...</p>';

  const rows = [];
  let pending = files.length;

  files.forEach((file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const bytes = new Uint8Array(reader.result);
        const segments = findLogSegments(bytes);
        segments.forEach((segment, segmentIndex) => {
          const scan = BBLBatchScan.quickScanLog(bytes, segment);
          const classification = BBLBatchScan.classifyFlight(scan);
          rows.push({
            fileName: file.name,
            segmentLabel: segments.length > 1 ? `${segmentIndex + 1} of ${segments.length}` : "1 of 1",
            segmentIndex,
            scan,
            classification,
            bytes,
            segments,
          });
        });
      } catch (err) {
        rows.push({
          fileName: file.name,
          segmentLabel: "-",
          segmentIndex: 0,
          scan: { durationSec: 0, throttleRange: null },
          classification: { likelyFlight: false, reason: `Failed to parse: ${err}` },
          bytes: null,
          segments: null,
        });
      }

      pending--;
      if (pending === 0) {
        rows.sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : a.segmentIndex - b.segmentIndex));
        renderBatchResults(rows);
      }
    };
    reader.readAsArrayBuffer(file);
  });
});
