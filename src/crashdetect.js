/*
 * Phase 4: Automatic Crash Detector. Original code (not ported from
 * Betaflight blackbox-log-viewer), except DISARM_REASON_NAMES which is
 * transcribed from the real upstream source
 * (flightlog_fielddefs.js: FLIGHT_LOG_DISARM_REASON) - not guessed.
 *
 * Hard rule from the project brief: root-cause guesses are ranked
 * possibilities, never a confident diagnosis. Every detector here reports
 * a confidence level and a hedged description; nothing claims certainty
 * except the one signal that genuinely is authoritative (see below).
 *
 * Signal priority, most to least reliable:
 *  1. DISARM reason "CRASH_PROTECTION" or "RUNAWAY_TAKEOFF" - this is
 *     Betaflight's OWN onboard crash/runaway detection reporting itself,
 *     not an inference by this tool. High confidence.
 *  2. Extreme gyro rate spikes - heuristic threshold, medium confidence.
 *  3. All-motor dropout not explained by a nearby disarm - heuristic,
 *     medium confidence (could also be a hard throttle chop).
 *  4. Log ending abruptly while motors were still active - heuristic,
 *     medium confidence (could also just be a partial log file).
 *
 * NOT implemented: motor "desync" detection. This log has no RPM/eRPM
 * telemetry (no bidirectional DShot data), so there's no way to compare
 * commanded motor output against actual motor speed - any "desync
 * detector" built from commanded output alone would mostly be guessing.
 * Rather than ship a fake-confident feature, this is flagged as a known
 * gap (see PROJECT.md) instead.
 */

const BBLCrashDetect = {};

// Transcribed from Betaflight blackbox-log-viewer's flightlog_fielddefs.js
// (FLIGHT_LOG_DISARM_REASON), which mirrors the firmware's own enum order.
const DISARM_REASON_NAMES = [
  "ARMING_DISABLED",
  "FAILSAFE",
  "THROTTLE_TIMEOUT",
  "STICKS",
  "SWITCH",
  "CRASH_PROTECTION",
  "RUNAWAY_TAKEOFF",
  "GPS_RESCUE",
  "SERIAL_IO",
];

const CRASH_RELATED_DISARM_REASONS = new Set(["CRASH_PROTECTION", "RUNAWAY_TAKEOFF"]);

BBLCrashDetect.disarmReasonName = function (code) {
  return DISARM_REASON_NAMES[code] ?? `UNKNOWN(${code})`;
};

/**
 * disarmEvents: [{ timeSec, reason }] from app.js's buildDataset.
 * Returns one finding per disarm event - "high" confidence if the FC's
 * own reason code is crash/runaway related, "info" otherwise (still
 * useful context, not a symptom).
 */
BBLCrashDetect.evaluateDisarmEvents = function (disarmEvents) {
  return disarmEvents.map((ev) => {
    const name = BBLCrashDetect.disarmReasonName(ev.reason);
    const isCrashRelated = CRASH_RELATED_DISARM_REASONS.has(name);
    return {
      type: "disarm-reason",
      timeSec: ev.timeSec,
      confidence: isCrashRelated ? "high" : "info",
      description: isCrashRelated
        ? `Flight controller disarmed itself at ${ev.timeSec.toFixed(1)}s with reason "${name}" - this is Betaflight's own onboard crash/runaway detection reporting itself, not an inference by this tool.`
        : `Disarmed at ${ev.timeSec.toFixed(1)}s, reason "${name}" - normal/expected disarm, not crash-related.`,
    };
  });
};

/**
 * Extreme, sustained-instant gyro rate on any axis - well beyond what a
 * normal flight (even aggressive acro) typically produces, and physically
 * unconstrained by the pilot's configured rates (a real impact can spin
 * the airframe far faster than any commanded rate).
 */
BBLCrashDetect.detectGyroSpikes = function (gyroFilt, t, opts) {
  opts = opts || {};
  const thresholdDegPerSec = opts.thresholdDegPerSec ?? 1500;
  const minGapSec = opts.minGapSec ?? 1.0;

  const axisNames = ["Roll", "Pitch", "Yaw"];
  const findings = [];
  let lastSpikeTime = -Infinity;

  for (let i = 0; i < t.length; i++) {
    let maxAbs = 0;
    let maxAxis = -1;
    for (let axis = 0; axis < 3; axis++) {
      const v = Math.abs(gyroFilt[axis][i]);
      if (v > maxAbs) {
        maxAbs = v;
        maxAxis = axis;
      }
    }
    if (maxAbs >= thresholdDegPerSec && t[i] - lastSpikeTime >= minGapSec) {
      findings.push({
        type: "gyro-spike",
        timeSec: t[i],
        confidence: "medium",
        description: `Extreme gyro rate on ${axisNames[maxAxis]} at ${t[i].toFixed(1)}s (${maxAbs.toFixed(0)} deg/s) - well beyond normal flight, consistent with (but not proof of) a physical impact or violent tumble.`,
      });
      lastSpikeTime = t[i];
    }
  }

  return findings;
};

/**
 * All 4 motors dropping from active output to near-idle within a short
 * window, NOT explained by a nearby logged disarm - possible power
 * interruption/brownout, though a very hard throttle chop can look
 * similar and isn't itself a crash.
 */
BBLCrashDetect.detectMotorDropouts = function (motor, t, sampleRateHz, disarmTimesSec, opts) {
  opts = opts || {};
  const activeThreshold = opts.activeThreshold ?? 300;
  const idleThreshold = opts.idleThreshold ?? 60;
  const windowMs = opts.windowMs ?? 60;
  const minGapFromDisarmSec = opts.minGapFromDisarmSec ?? 0.5;
  const minGapBetweenEventsSec = opts.minGapBetweenEventsSec ?? 1.0;

  const windowSamples = Math.max(1, Math.round((windowMs / 1000) * sampleRateHz));
  const findings = [];
  let lastEventTime = -Infinity;

  for (let i = windowSamples; i < t.length; i++) {
    let wasActive = true;
    let isIdle = true;
    for (let m = 0; m < 4; m++) {
      if (motor[m][i - windowSamples] < activeThreshold) wasActive = false;
      if (motor[m][i] > idleThreshold) isIdle = false;
    }

    if (wasActive && isIdle) {
      const tSec = t[i];
      if (tSec - lastEventTime < minGapBetweenEventsSec) continue;

      const nearDisarm = disarmTimesSec.some((d) => Math.abs(d - tSec) <= minGapFromDisarmSec);
      if (nearDisarm) continue; // expected: a normal disarm intentionally cuts motors

      findings.push({
        type: "motor-dropout",
        timeSec: tSec,
        confidence: "medium",
        description: `All 4 motors dropped from active output to near-idle within ~${windowMs}ms at ${tSec.toFixed(1)}s, with no disarm event logged nearby - possible power interruption or brownout, though a very hard throttle chop can look similar and isn't itself a crash.`,
      });
      lastEventTime = tSec;
    }
  }

  return findings;
};

/**
 * The log ends while motors were still commanded active and no disarm
 * was recorded - could mean the flight controller lost power abruptly
 * before it could log its own disarm, or could just mean this file is a
 * partial capture of a longer flight. Not conclusive by itself.
 */
BBLCrashDetect.detectAbruptEnd = function (motor, t, disarmTimesSec, opts) {
  opts = opts || {};
  const activeThreshold = opts.activeThreshold ?? 150;
  const disarmGraceSec = opts.disarmGraceSec ?? 2;

  if (t.length === 0) return [];

  const lastIdx = t.length - 1;
  const lastTime = t[lastIdx];
  const motorsActive = [0, 1, 2, 3].some((m) => motor[m][lastIdx] > activeThreshold);
  const hadDisarmNearEnd = disarmTimesSec.some((d) => lastTime - d < disarmGraceSec);

  if (motorsActive && !hadDisarmNearEnd) {
    return [
      {
        type: "abrupt-end",
        timeSec: lastTime,
        confidence: "medium",
        description: `The log ends at ${lastTime.toFixed(1)}s with motors still commanded active and no disarm event recorded - could mean the flight controller lost power abruptly (crash, battery disconnect) before it could log a disarm, or could just mean this file only captures part of a longer flight. Not conclusive by itself.`,
      },
    ];
  }
  return [];
};

const CONFIDENCE_RANK = { high: 0, medium: 1, info: 2 };

/**
 * Runs every detector and returns one ranked list, most-confident first.
 */
BBLCrashDetect.analyze = function (ds) {
  const sampleRateHz = 1e6 / ds.sysConfig.looptime;
  const disarmTimesSec = ds.disarmEvents.map((e) => e.timeSec);

  const findings = [
    ...BBLCrashDetect.evaluateDisarmEvents(ds.disarmEvents),
    ...BBLCrashDetect.detectGyroSpikes(ds.gyroFilt, ds.t),
    ...BBLCrashDetect.detectMotorDropouts(ds.motor, ds.t, sampleRateHz, disarmTimesSec),
    ...BBLCrashDetect.detectAbruptEnd(ds.motor, ds.t, disarmTimesSec),
  ];

  findings.sort((a, b) => {
    const rankDiff = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    return rankDiff !== 0 ? rankDiff : a.timeSec - b.timeSec;
  });

  return findings;
};

/**
 * Self-test: builds synthetic data with a known gyro spike and a known
 * motor dropout (one near a disarm, which must NOT be flagged; one far
 * from any disarm, which must be flagged), and checks the detectors find
 * exactly what's expected - no more, no less.
 */
BBLCrashDetect.selfTest = function () {
  const sampleRateHz = 1000;
  const duration = 10;
  const n = sampleRateHz * duration;

  const t = new Float64Array(n);
  const gyroFilt = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const motor = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];

  for (let i = 0; i < n; i++) {
    t[i] = i / sampleRateHz;
    for (let axis = 0; axis < 3; axis++) gyroFilt[axis][i] = 0;
    for (let m = 0; m < 4; m++) motor[m][i] = 500; // "active" baseline throughout
  }

  // Known gyro spike on Pitch at t=3s
  const spikeIdx = 3 * sampleRateHz;
  gyroFilt[1][spikeIdx] = 1800;

  // Known motor dropout at t=5s, NOT near any disarm -> should be flagged
  for (let i = 5 * sampleRateHz; i < 5 * sampleRateHz + 20; i++) {
    for (let m = 0; m < 4; m++) motor[m][i] = 20;
  }
  for (let i = 5 * sampleRateHz + 20; i < n; i++) {
    for (let m = 0; m < 4; m++) motor[m][i] = 500; // recovers (so it's not just the flight ending)
  }

  // Known motor dropout at t=8s, WITHIN 0.5s of a logged disarm -> should NOT be flagged
  for (let i = 8 * sampleRateHz; i < 8 * sampleRateHz + 20; i++) {
    for (let m = 0; m < 4; m++) motor[m][i] = 20;
  }

  const disarmTimesSec = [8.0];

  const spikes = BBLCrashDetect.detectGyroSpikes(gyroFilt, Array.from(t));
  const dropouts = BBLCrashDetect.detectMotorDropouts(motor, Array.from(t), sampleRateHz, disarmTimesSec);

  const spikeOk = spikes.length === 1 && Math.abs(spikes[0].timeSec - 3) < 0.05;
  const dropoutOk =
    dropouts.length === 1 && Math.abs(dropouts[0].timeSec - 5) < 0.1; // only the far-from-disarm one

  const pass = spikeOk && dropoutOk;
  const report = { pass, spikes, dropouts, spikeOk, dropoutOk };

  if (!pass) {
    console.error("BBLCrashDetect.selfTest FAILED", report);
    throw new Error(`Crash detector self-test failed: ${JSON.stringify(report)}`);
  }

  console.log("BBLCrashDetect.selfTest PASSED", report);
  return report;
};
