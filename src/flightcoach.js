/*
 * Phase 6: AI Flight Coach (exploratory, not a committed deliverable per
 * the project brief). Original code (not ported from Betaflight
 * blackbox-log-viewer).
 *
 * Hard rule from the project brief: objective metrics only - throttle
 * smoothness/variance, stick input efficiency, disturbance recovery
 * time. NOT subjective "good/bad flying" judgments, since there is no
 * labeled ground truth for that (no dataset of flights labeled "good"
 * vs "bad" by a human to calibrate against). Every function here returns
 * plain descriptive numbers; nothing scores, rates, or grades the flight.
 * The UI layer (app.js) must not add scoring language on top of these
 * either - see PROJECT.md if that temptation comes up in a future phase.
 */

const BBLFlightCoach = {};

// Ignores NaN entries (fields absent for part of a segment, etc).
BBLFlightCoach.computeStats = function (arr) {
  let sum = 0,
    sumSq = 0,
    n = 0;
  for (const v of arr) {
    if (!Number.isNaN(v)) {
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = n ? sum / n : NaN;
  const variance = n ? sumSq / n - mean * mean : NaN;
  return { mean, stdDev: Math.sqrt(Math.max(variance, 0)), n };
};

// Mean of |d(value)/dt| across the series - a measure of "how fast is
// this signal changing on average", independent of its absolute level.
BBLFlightCoach.meanAbsRateOfChange = function (arr, sampleRateHz) {
  let sum = 0,
    count = 0;
  for (let i = 1; i < arr.length; i++) {
    if (Number.isNaN(arr[i]) || Number.isNaN(arr[i - 1])) continue;
    sum += Math.abs(arr[i] - arr[i - 1]) * sampleRateHz;
    count++;
  }
  return count ? sum / count : NaN;
};

// Counts direction reversals (sign changes in the discrete derivative) -
// a proxy for how often stick movement changes direction, i.e. hunting/
// micro-correcting vs. smooth continuous movement. Purely descriptive:
// a high count isn't labeled "bad", it's just reported.
BBLFlightCoach.countReversals = function (arr) {
  let count = 0,
    prevSign = 0;
  for (let i = 1; i < arr.length; i++) {
    if (Number.isNaN(arr[i]) || Number.isNaN(arr[i - 1])) continue;
    const sign = Math.sign(arr[i] - arr[i - 1]);
    if (sign !== 0 && prevSign !== 0 && sign !== prevSign) count++;
    if (sign !== 0) prevSign = sign;
  }
  return count;
};

BBLFlightCoach.throttleSmoothness = function (throttle, sampleRateHz) {
  const stats = BBLFlightCoach.computeStats(throttle);
  return { ...stats, meanAbsRatePerSec: BBLFlightCoach.meanAbsRateOfChange(throttle, sampleRateHz) };
};

BBLFlightCoach.stickActivity = function (stick, sampleRateHz, durationSec) {
  const reversals = BBLFlightCoach.countReversals(stick);
  return {
    meanAbsRatePerSec: BBLFlightCoach.meanAbsRateOfChange(stick, sampleRateHz),
    reversals,
    reversalsPerMin: durationSec > 0 ? reversals / (durationSec / 60) : NaN,
  };
};

/**
 * Disturbance recovery: moments where tracking error (setpoint - gyro)
 * crosses a threshold WITHOUT a nearby deliberate setpoint step (those
 * are pilot inputs, already covered by Phase 3's step-response
 * analyzer) - i.e. the aircraft moved off-track despite the pilot not
 * commanding a change, which is what "disturbance" means here (could be
 * turbulence, prop wash, a bump - the log can't say which). Measures how
 * long it took to return to a small-error band.
 *
 * stepEventTimesSec: from BBLPidAnalysis.detectStepEvents() (Phase 3) -
 * used purely to exclude pilot-commanded moments from being double
 * counted as "disturbances".
 */
BBLFlightCoach.detectDisturbances = function (setpoint, gyro, t, sampleRateHz, stepEventTimesSec, opts) {
  opts = opts || {};
  const errorThreshold = opts.errorThreshold ?? 40; // deg/s
  const settleTolerance = opts.settleTolerance ?? 15; // deg/s
  const settleHoldMs = opts.settleHoldMs ?? 30;
  const minGapFromStepSec = opts.minGapFromStepSec ?? 0.3;
  const minGapBetweenEventsSec = opts.minGapBetweenEventsSec ?? 0.5;
  const responseWindowMs = opts.responseWindowMs ?? 500;

  const error = BBLPidAnalysis.computeError(setpoint, gyro);
  const settleHoldSamples = Math.max(1, Math.round((settleHoldMs / 1000) * sampleRateHz));
  const windowSamples = Math.round((responseWindowMs / 1000) * sampleRateHz);

  const events = [];
  let lastEventTime = -Infinity;

  for (let i = 1; i < error.length; i++) {
    if (Math.abs(error[i]) < errorThreshold || Math.abs(error[i - 1]) >= errorThreshold) continue; // rising edge only

    const tSec = t[i];
    if (tSec - lastEventTime < minGapBetweenEventsSec) continue;
    if (stepEventTimesSec.some((s) => Math.abs(s - tSec) <= minGapFromStepSec)) continue;

    const end = Math.min(error.length, i + windowSamples);
    let settledAtSample = null;
    let consecutiveWithinTolerance = 0;
    for (let j = i; j < end; j++) {
      if (Math.abs(error[j]) <= settleTolerance) {
        consecutiveWithinTolerance++;
        if (settledAtSample === null && consecutiveWithinTolerance >= settleHoldSamples) {
          settledAtSample = j - settleHoldSamples + 1;
        }
      } else {
        consecutiveWithinTolerance = 0;
      }
    }

    events.push({
      timeSec: tSec,
      peakErrorDegPerSec: Math.abs(error[i]),
      recoveryMs: settledAtSample !== null ? ((settledAtSample - i) / sampleRateHz) * 1000 : null,
      recovered: settledAtSample !== null,
    });
    lastEventTime = tSec;
  }

  return events;
};

BBLFlightCoach.summarizeDisturbances = function (events, responseWindowMs) {
  if (events.length === 0) {
    return "No disturbance events detected (moments the aircraft moved off-track without a matching stick input) in this flight.";
  }
  const recovered = events.filter((e) => e.recovered);
  const avgRecoveryMs = recovered.length
    ? recovered.reduce((s, e) => s + e.recoveryMs, 0) / recovered.length
    : null;
  const parts = [`${events.length} disturbance event(s) detected.`];
  if (avgRecoveryMs !== null) {
    parts.push(`Average recovery time ~${avgRecoveryMs.toFixed(0)}ms for the ${recovered.length} that recovered within ${responseWindowMs}ms.`);
  }
  const notRecovered = events.length - recovered.length;
  if (notRecovered > 0) {
    parts.push(`${notRecovered} did not return to a stable error band within ${responseWindowMs}ms.`);
  }
  return parts.join(" ");
};

/**
 * Self-test: a synthetic disturbance far from any step event must be
 * detected with a correct recovery time; an identical disturbance placed
 * right next to a logged step event must be excluded (it's presumably
 * part of the pilot's own input, not an independent disturbance).
 */
BBLFlightCoach.selfTest = function () {
  const sampleRateHz = 1000;
  const duration = 6;
  const n = sampleRateHz * duration;
  const t = new Float64Array(n);
  const setpoint = new Float64Array(n);
  const gyro = new Float64Array(n);

  for (let i = 0; i < n; i++) t[i] = i / sampleRateHz;

  // Disturbance at t=2s, far from any step event: setpoint stays 0,
  // gyro kicks to 80deg/s then decays back over ~100ms.
  for (let i = 2 * sampleRateHz; i < n; i++) {
    const tau = t[i] - 2;
    gyro[i] = 80 * Math.exp(-tau / 0.03);
  }

  // Disturbance at t=4s, but there's a step event logged at t=4.0s too
  // (simulating the pilot moving the stick right as this happened) -
  // should be excluded.
  for (let i = 4 * sampleRateHz; i < n; i++) {
    const tau = t[i] - 4;
    gyro[i] += 80 * Math.exp(-tau / 0.03);
  }

  const stepEventTimesSec = [4.0];

  const events = BBLFlightCoach.detectDisturbances(Array.from(setpoint), Array.from(gyro), Array.from(t), sampleRateHz, stepEventTimesSec);

  const foundFarEvent = events.some((e) => Math.abs(e.timeSec - 2) < 0.05);
  const excludedNearStepEvent = !events.some((e) => Math.abs(e.timeSec - 4) < 0.05);
  const farEvent = events.find((e) => Math.abs(e.timeSec - 2) < 0.05);
  const recoveryOk = farEvent && farEvent.recovered && farEvent.recoveryMs > 0 && farEvent.recoveryMs < 200;

  const pass = foundFarEvent && excludedNearStepEvent && recoveryOk;
  const report = { pass, events, foundFarEvent, excludedNearStepEvent, recoveryOk };

  if (!pass) {
    console.error("BBLFlightCoach.selfTest FAILED", report);
    throw new Error(`Flight coach self-test failed: ${JSON.stringify(report)}`);
  }

  console.log("BBLFlightCoach.selfTest PASSED", report);
  return report;
};
