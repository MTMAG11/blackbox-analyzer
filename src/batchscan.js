/*
 * Batch upload support: a lightweight scan (duration, throttle range,
 * frame counts - NOT the full per-sample dataset buildDataset() builds)
 * so many files/segments can be screened quickly, plus a heuristic
 * classifier for "does this look like a real flight". Original code, not
 * ported from Betaflight blackbox-log-viewer.
 *
 * The classifier is a heuristic, not certain - it's presented that way in
 * the UI (reasons shown alongside the verdict), matching the project's
 * established pattern for anything inferred rather than read directly
 * from the log (see crashdetect.js).
 */

const BBLBatchScan = {};

/**
 * Lightweight pass over one log segment: just duration and throttle
 * stick range, not the full converted dataset. Much faster than
 * buildDataset() when screening many files.
 */
BBLBatchScan.quickScanLog = function (bytes, segment) {
  const parser = new FlightLogParser(bytes);
  let idx = null;
  let t0 = null;
  let tLast = null;
  let minThrottle = Infinity;
  let maxThrottle = -Infinity;
  const frameCount = { I: 0, P: 0, S: 0, E: 0 };

  parser.onFrameReady = (valid, frame, frameType) => {
    if (!valid) return;
    frameCount[frameType] = (frameCount[frameType] || 0) + 1;
    if (frameType !== "I" && frameType !== "P") return;

    const time = frame[idx.time];
    if (t0 === null) t0 = time;
    tLast = time;

    const ti = idx["rcCommand[3]"];
    if (ti !== undefined) {
      const v = frame[ti];
      if (v < minThrottle) minThrottle = v;
      if (v > maxThrottle) maxThrottle = v;
    }
  };

  parser.parseHeader(segment.start, segment.end);
  idx = parser.frameDefs.I.nameToIndex;
  parser.parseLogData(false, undefined, segment.end);

  const durationSec = t0 !== null && tLast !== null ? (tLast - t0) / 1e6 : 0;
  const hasThrottle = minThrottle !== Infinity && maxThrottle !== -Infinity;

  return {
    sysConfig: parser.sysConfig,
    durationSec,
    minThrottle: hasThrottle ? minThrottle : null,
    maxThrottle: hasThrottle ? maxThrottle : null,
    throttleRange: hasThrottle ? maxThrottle - minThrottle : null,
    frameCount,
    corruptFrames: parser.stats.totalCorruptFrames,
  };
};

/**
 * Heuristic "does this look like a real flight" classifier. Not certain -
 * a very short hover or a log with unusual throttle mapping could be
 * misclassified either way. Reasons are always included so the owner can
 * override their own judgment rather than trust a bare true/false.
 */
BBLBatchScan.classifyFlight = function (scan, opts) {
  opts = opts || {};
  const minDurationSec = opts.minDurationSec ?? 3;
  const minThrottleRange = opts.minThrottleRange ?? 150;

  if (scan.durationSec < minDurationSec) {
    return {
      likelyFlight: false,
      reason: `Duration ${scan.durationSec.toFixed(1)}s is under the ${minDurationSec}s threshold - probably a brief arm/disarm, not a flight.`,
    };
  }
  if (scan.throttleRange === null) {
    return { likelyFlight: false, reason: "No rcCommand throttle data found in this segment - can't assess." };
  }
  if (scan.throttleRange < minThrottleRange) {
    return {
      likelyFlight: false,
      reason: `Throttle stick range was only ${scan.throttleRange.toFixed(0)} (threshold ${minThrottleRange}) - motors probably never spun up much, likely a bench/ground test.`,
    };
  }
  return {
    likelyFlight: true,
    reason: `Duration ${scan.durationSec.toFixed(1)}s, throttle stick range ${scan.throttleRange.toFixed(0)} - looks like a real flight.`,
  };
};

/**
 * Self-test: a synthetic "real flight" scan must classify true, a
 * too-short one and a throttle-never-moved one must both classify false.
 */
BBLBatchScan.selfTest = function () {
  const realFlight = BBLBatchScan.classifyFlight({ durationSec: 45, throttleRange: 600 });
  const tooShort = BBLBatchScan.classifyFlight({ durationSec: 1.2, throttleRange: 600 });
  const noThrottleMovement = BBLBatchScan.classifyFlight({ durationSec: 45, throttleRange: 20 });

  const pass = realFlight.likelyFlight === true && tooShort.likelyFlight === false && noThrottleMovement.likelyFlight === false;
  const report = { pass, realFlight, tooShort, noThrottleMovement };

  if (!pass) {
    console.error("BBLBatchScan.selfTest FAILED", report);
    throw new Error(`Batch scan classifier self-test failed: ${JSON.stringify(report)}`);
  }

  console.log("BBLBatchScan.selfTest PASSED", report);
  return report;
};
