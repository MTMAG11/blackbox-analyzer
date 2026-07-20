/*
 * Phase 3: PID Tuning Analyzer. Original code (not ported from Betaflight
 * blackbox-log-viewer) - detects step-response symptoms (overshoot,
 * oscillation, sluggish settling) from the gyro-vs-setpoint tracking
 * error. This is standard control-systems step-response analysis
 * (rise/overshoot/settling), applied heuristically to noisy real flight
 * data rather than a clean bench step test.
 *
 * Hard rule from the project brief: symptoms only, never a specific new
 * PID number. Every summary string this file produces describes what was
 * observed, hedged, and stops there.
 *
 * Correctness of the actual measurement mechanism (not the frequency/cause
 * interpretation, which is inherently heuristic) is checked by
 * BBLPidAnalysis.selfTest() against a synthetic underdamped 2nd-order step
 * response with an analytically known overshoot % and settling time.
 */

const BBLPidAnalysis = {};

// error[i] = setpoint[i] - gyro[i], both in deg/s (see units.js / app.js
// for why setpoint needs no extra scaling on this firmware).
BBLPidAnalysis.computeError = function (setpoint, gyro) {
  const n = Math.min(setpoint.length, gyro.length);
  const err = new Array(n);
  for (let i = 0; i < n; i++) err[i] = setpoint[i] - gyro[i];
  return err;
};

/**
 * Detect deliberate "step" inputs in the setpoint signal - rapid,
 * sustained changes (a punch, flick, or hard correction), as distinct
 * from the small continuous wiggle of normal stick control.
 *
 * Returns [{ index, stepSize }], index = sample where the windowed rate
 * of change peaks, stepSize = net setpoint change (deg/s) over the window.
 */
BBLPidAnalysis.detectStepEvents = function (setpoint, sampleRateHz, opts) {
  opts = opts || {};
  const windowMs = opts.windowMs ?? 20;
  const minStepSize = opts.minStepSize ?? 60;
  const minGapMs = opts.minGapMs ?? 250;

  const windowSamples = Math.max(1, Math.round((windowMs / 1000) * sampleRateHz));
  const n = setpoint.length;

  const delta = new Float64Array(n);
  for (let i = windowSamples; i < n; i++) {
    delta[i] = setpoint[i] - setpoint[i - windowSamples];
  }

  const minGapSamples = Math.round((minGapMs / 1000) * sampleRateHz);
  const events = [];
  let lastEventIndex = -Infinity;

  for (let i = windowSamples + 1; i < n - 1; i++) {
    const mag = Math.abs(delta[i]);
    if (mag < minStepSize) continue;
    if (mag < Math.abs(delta[i - 1]) || mag < Math.abs(delta[i + 1])) continue; // local max only
    if (i - lastEventIndex < minGapSamples) continue;

    events.push({ index: i, stepSize: delta[i] });
    lastEventIndex = i;
  }

  return events;
};

/**
 * Characterize the tracking-error response following each detected step:
 * overshoot (peak error swing past the target, in the OPPOSITE direction
 * from the initial approach - not the same as the initial catch-up lag,
 * which is normal and expected), oscillation (2+ zero crossings before
 * settling), and settling time (first point the error stays within
 * tolerance for a sustained hold).
 */
BBLPidAnalysis.analyzeStepResponses = function (setpoint, gyro, sampleRateHz, opts) {
  opts = opts || {};
  const responseWindowMs = opts.responseWindowMs ?? 250;
  const settleToleranceRatio = opts.settleToleranceRatio ?? 0.15;
  const settleToleranceFloor = opts.settleToleranceFloor ?? 5; // deg/s, for small steps
  const settleHoldMs = opts.settleHoldMs ?? 30;

  const error = BBLPidAnalysis.computeError(setpoint, gyro);
  const events = BBLPidAnalysis.detectStepEvents(setpoint, sampleRateHz, opts);

  const windowSamples = Math.round((responseWindowMs / 1000) * sampleRateHz);
  const settleHoldSamples = Math.max(1, Math.round((settleHoldMs / 1000) * sampleRateHz));

  return events.map((ev) => {
    const start = ev.index;
    const end = Math.min(error.length, start + windowSamples);
    const stepSize = ev.stepSize;
    const tolerance = Math.max(Math.abs(stepSize) * settleToleranceRatio, settleToleranceFloor);

    const initialSign = Math.sign(error[start]) || Math.sign(stepSize) || 1;

    // Hysteresis (Schmitt-trigger) band-crossing count: a "crossing" only
    // counts when the error genuinely swings from outside the tolerance
    // band on one side to outside it on the other. A raw sign-change
    // counter (any time error crosses exactly 0) was tried first and
    // produced 15-85 "crossings" per event on real flight data - almost
    // all sensor noise wiggling near zero, not real oscillation. This
    // band-based version ignores anything that doesn't clear the band.
    let bandState = error[start] > tolerance ? 1 : error[start] < -tolerance ? -1 : 0;
    let bandCrossings = 0;
    let peakOvershoot = 0;
    let sawOppositeBand = false;
    let settledAtSample = null;
    let consecutiveWithinTolerance = 0;

    for (let i = start; i < end; i++) {
      const e = error[i];

      if (e > tolerance) {
        if (bandState === -1) bandCrossings++;
        bandState = 1;
      } else if (e < -tolerance) {
        if (bandState === 1) bandCrossings++;
        bandState = -1;
      }

      if (bandState === -initialSign) {
        sawOppositeBand = true;
      }
      if (sawOppositeBand && bandState === -initialSign && Math.abs(e) > peakOvershoot) {
        peakOvershoot = Math.abs(e);
      }

      if (Math.abs(e) <= tolerance) {
        consecutiveWithinTolerance++;
        if (settledAtSample === null && consecutiveWithinTolerance >= settleHoldSamples) {
          settledAtSample = i - settleHoldSamples + 1;
        }
      } else {
        consecutiveWithinTolerance = 0;
      }
    }

    const overshootRatio = Math.abs(stepSize) > 1e-6 ? peakOvershoot / Math.abs(stepSize) : 0;
    const settlingTimeMs = settledAtSample !== null ? ((settledAtSample - start) / sampleRateHz) * 1000 : null;

    return {
      timeIndex: start,
      stepSize,
      overshootRatio,
      bandCrossings,
      settlingTimeMs,
      settled: settledAtSample !== null,
    };
  });
};

/**
 * Turn a list of per-event results into a short, hedged, human-readable
 * summary. Symptoms only - never suggests a specific new PID number.
 */
BBLPidAnalysis.summarize = function (events, axisName, responseWindowMs) {
  if (events.length === 0) {
    return `${axisName}: no clear step inputs detected in this flight (log may be too gentle, or the detection threshold needs adjusting for your flying style) - nothing to report.`;
  }

  const n = events.length;
  const avgOvershootPct = (events.reduce((s, e) => s + e.overshootRatio, 0) / n) * 100;
  const ringingEvents = events.filter((e) => e.bandCrossings >= 2);
  const settledEvents = events.filter((e) => e.settled);
  const avgSettlingMs = settledEvents.length
    ? settledEvents.reduce((s, e) => s + e.settlingTimeMs, 0) / settledEvents.length
    : null;
  const neverSettledCount = n - settledEvents.length;

  const parts = [`${axisName}: ${n} step input${n === 1 ? "" : "s"} detected.`];

  parts.push(
    `Average overshoot ~${avgOvershootPct.toFixed(0)}% of step size (peak swing past the target after first reaching it - 0% would mean it approached and stopped with no swing-past).`,
  );

  if (ringingEvents.length > 0) {
    parts.push(
      `${ringingEvents.length} of ${n} step(s) show oscillation (error swung past the tolerance band 2+ times on alternating sides before settling) - a possible sign of P or D gain being higher than the airframe can damp, though this alone isn't conclusive (could also be pilot input, turbulence, or something unrelated).`,
    );
  }

  if (avgSettlingMs !== null) {
    parts.push(`Average settling time ~${avgSettlingMs.toFixed(0)}ms for events that did settle.`);
  }
  if (neverSettledCount > 0) {
    parts.push(
      `${neverSettledCount} of ${n} step(s) never settled within the ${responseWindowMs}ms analysis window - could mean a sluggish response, or just a window too short for how large that particular input was.`,
    );
  }

  return parts.join(" ");
};

/**
 * Self-test: builds a synthetic underdamped 2nd-order step response with
 * an analytically known overshoot % and settling time, runs it through
 * the real detection/analysis pipeline, and checks the measured values
 * land close to the known-correct ones. Uses a strict 2% settling
 * tolerance to match the classic textbook "2% settling time" formula
 * (the production default of 15% is intentionally more forgiving, since
 * real flight data is noisy - that's a separate, deliberate choice, not
 * what's being validated here).
 */
BBLPidAnalysis.selfTest = function () {
  const sampleRateHz = 1000;
  const duration = 2;
  const n = sampleRateHz * duration;
  const stepTime = 0.5;
  const stepSize = 100;
  const zeta = 0.3;
  const wn = 20;

  const setpoint = new Float64Array(n);
  const gyro = new Float64Array(n);

  const wd = wn * Math.sqrt(1 - zeta * zeta);
  const phi = Math.acos(zeta);

  for (let i = 0; i < n; i++) {
    const t = i / sampleRateHz;
    setpoint[i] = t < stepTime ? 0 : stepSize;
    if (t < stepTime) {
      gyro[i] = 0;
    } else {
      const tau = t - stepTime;
      const y = 1 - (Math.exp(-zeta * wn * tau) / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * tau + phi);
      gyro[i] = stepSize * y;
    }
  }

  const expectedOvershootPct = 100 * Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta));
  const expectedSettlingMs = (4 / (zeta * wn)) * 1000; // classic 2% settling time formula

  const results = BBLPidAnalysis.analyzeStepResponses(setpoint, gyro, sampleRateHz, {
    minStepSize: 50,
    responseWindowMs: 1200,
    settleToleranceRatio: 0.02,
    settleToleranceFloor: 0,
  });

  if (results.length !== 1) {
    throw new Error(`BBLPidAnalysis.selfTest: expected exactly 1 step event, found ${results.length}`);
  }

  const measured = results[0];
  const measuredOvershootPct = measured.overshootRatio * 100;

  const overshootOk = Math.abs(measuredOvershootPct - expectedOvershootPct) < 10;
  const settlingOk = measured.settled && Math.abs(measured.settlingTimeMs - expectedSettlingMs) < 150;
  const pass = overshootOk && settlingOk;

  const report = {
    pass,
    expectedOvershootPct,
    measuredOvershootPct,
    expectedSettlingMs,
    measuredSettlingMs: measured.settlingTimeMs,
    bandCrossings: measured.bandCrossings,
  };

  if (!pass) {
    console.error("BBLPidAnalysis.selfTest FAILED", report);
    throw new Error(`PID step-response self-test failed: ${JSON.stringify(report)}`);
  }

  console.log("BBLPidAnalysis.selfTest PASSED", report);
  return report;
};
