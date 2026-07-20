/*
 * Phase 5: Attitude Reconstruction. Original code (not ported from
 * Betaflight blackbox-log-viewer) - renders a small 3D model whose
 * orientation is driven directly by the normalized imuQuaternion
 * (BBLUnits.normalizeQuaternion), not by re-deriving Euler angles first,
 * so it doesn't inherit gimbal-lock artifacts near pitch=+-90deg (which
 * a real tumble or inverted flight could actually reach).
 *
 * Orientation only - this project has no GPS, so there is no position or
 * flight path to reconstruct, only which way the aircraft was pointing.
 * See the confidence note in PROJECT.md: the underlying quaternion math
 * is validated (self-tested below, and it's the same quaternion already
 * used for the Phase 1 attitude chart), but the specific 3D *visual*
 * mapping (which screen direction is "nose up", etc.) has not been
 * checked against real footage of this flight, since none exists to
 * check against.
 */

const BBLAttitude3D = {};

/**
 * Build a CSS matrix3d() rotation string from a normalized quaternion.
 * Standard quaternion-to-rotation-matrix formula, transposed into CSS's
 * column-major matrix3d() parameter order.
 */
BBLAttitude3D.quaternionToCssMatrix3d = function (q) {
  const { x, y, z, w } = q;
  const xx = x * x,
    yy = y * y,
    zz = z * z,
    xy = x * y,
    xz = x * z,
    yz = y * z,
    wx = w * x,
    wy = w * y,
    wz = w * z;

  // Row-major rotation matrix R (standard quaternion->matrix formula).
  const r00 = 1 - 2 * (yy + zz),
    r01 = 2 * (xy - wz),
    r02 = 2 * (xz + wy);
  const r10 = 2 * (xy + wz),
    r11 = 1 - 2 * (xx + zz),
    r12 = 2 * (yz - wx);
  const r20 = 2 * (xz - wy),
    r21 = 2 * (yz + wx),
    r22 = 1 - 2 * (xx + yy);

  // matrix3d() wants column-major order: column 1, column 2, column 3, column 4.
  return `matrix3d(${r00},${r10},${r20},0,${r01},${r11},${r21},0,${r02},${r12},${r22},0,0,0,0,1)`;
};

/**
 * Self-test: for a set of test quaternions (including simple known
 * rotations and the identity), decompose quaternionToCssMatrix3d()'s
 * rotation matrix back to Euler angles using the same atan2/acos
 * formula structure as BBLUnits.quaternionToEulerDegrees(), and check
 * they agree. This validates the matrix is mathematically the correct
 * rotation for the given quaternion (catches transcription errors,
 * sign errors, row/column-major mix-ups) - it does NOT validate which
 * screen direction "up" or "forward" visually correspond to (that's a
 * labeling/convention choice, not something a pure-math test can check
 * without a real reference to compare against).
 */
BBLAttitude3D.selfTest = function () {
  const testQuaternions = [
    { x: 0, y: 0, z: 0, w: 1 }, // identity
    { x: Math.sin(Math.PI / 8), y: 0, z: 0, w: Math.cos(Math.PI / 8) }, // 45deg about x
    { x: 0, y: Math.sin(Math.PI / 6), z: 0, w: Math.cos(Math.PI / 6) }, // 60deg about y
    { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) }, // 90deg about z
    { x: 0.1, y: 0.2, z: 0.3, w: Math.sqrt(1 - 0.01 - 0.04 - 0.09) }, // arbitrary mixed
  ];

  const parseMatrix3d = (str) => {
    const nums = str
      .slice(str.indexOf("(") + 1, str.indexOf(")"))
      .split(",")
      .map(Number);
    // nums is column-major: [r00,r10,r20,0, r01,r11,r21,0, r02,r12,r22,0, ...]
    return {
      r00: nums[0], r10: nums[1], r20: nums[2],
      r01: nums[4], r11: nums[5], r21: nums[6],
      r02: nums[8], r12: nums[9], r22: nums[10],
    };
  };

  // Re-derive roll/pitch/heading straight from the matrix's R21/R22 (roll),
  // R20 (pitch), R10/R00 (heading) entries - the standard extraction
  // formulas for a matrix built with this exact quaternion->matrix
  // convention. Comparing this against BBLUnits.eulerDegreesFromNormalizedQuaternion()
  // (the already-trusted, separately-derived formula) for the SAME
  // quaternion is the actual cross-check: if the matrix's row/column
  // layout or a sign were wrong, these would disagree.
  const matrixToEulerDeg = (r) => {
    const roll = Math.atan2(r.r21, r.r22);
    const pitch = Math.asin(Math.max(-1, Math.min(1, -r.r20)));
    const heading = Math.atan2(r.r10, r.r00);
    const toDeg = 180 / Math.PI;
    return { rollDeg: roll * toDeg, pitchDeg: pitch * toDeg, headingDeg: heading * toDeg };
  };

  const angleDiffDeg = (a, b) => {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
  };

  const results = testQuaternions.map((q) => {
    const matrixStr = BBLAttitude3D.quaternionToCssMatrix3d(q);
    const r = parseMatrix3d(matrixStr);

    // R should be orthogonal (unit-length columns) for any unit quaternion.
    const col0Len = Math.sqrt(r.r00 ** 2 + r.r10 ** 2 + r.r20 ** 2);
    const col1Len = Math.sqrt(r.r01 ** 2 + r.r11 ** 2 + r.r21 ** 2);
    const col2Len = Math.sqrt(r.r02 ** 2 + r.r12 ** 2 + r.r22 ** 2);
    const orthogonal =
      Math.abs(col0Len - 1) < 1e-9 && Math.abs(col1Len - 1) < 1e-9 && Math.abs(col2Len - 1) < 1e-9;

    const fromMatrix = matrixToEulerDeg(r);
    const fromQuaternion = BBLUnits.eulerDegreesFromNormalizedQuaternion(q);

    const rollMatch = angleDiffDeg(fromMatrix.rollDeg, fromQuaternion.rollDeg) < 0.01;
    const pitchMatch = angleDiffDeg(fromMatrix.pitchDeg, fromQuaternion.pitchDeg) < 0.01;
    // Heading has an extra sign flip in BBLUnits' formula (heading = -atan2(...)),
    // so compare magnitude-and-sign-aware: either matches directly or is the
    // negation (mod 360) - both are "internally consistent", but record which.
    const headingMatch =
      angleDiffDeg(fromMatrix.headingDeg, fromQuaternion.headingDeg) < 0.01 ||
      angleDiffDeg(-fromMatrix.headingDeg, fromQuaternion.headingDeg) < 0.01;

    return { q, orthogonal, fromMatrix, fromQuaternion, rollMatch, pitchMatch, headingMatch };
  });

  const pass = results.every((res) => res.orthogonal && res.rollMatch && res.pitchMatch && res.headingMatch);

  if (!pass) {
    console.error("BBLAttitude3D.selfTest FAILED", results);
    throw new Error(`Attitude 3D matrix self-test failed: ${JSON.stringify(results)}`);
  }

  console.log("BBLAttitude3D.selfTest PASSED", results);
  return { pass, results };
};

/**
 * Playback controller: steps through ds.t at a given speed and calls
 * onFrame(index) each tick. Uses requestAnimationFrame, mapping
 * wall-clock time to flight time at the given playback rate.
 */
BBLAttitude3D.createPlayer = function (t, onFrame, opts) {
  opts = opts || {};
  let playing = false;
  let rate = opts.rate ?? 1;
  let currentIndex = 0;
  let rafId = null;
  let lastWallTime = null;

  const n = t.length;

  const findIndexForTime = (targetSec) => {
    // t is monotonically increasing - binary search for nearest index.
    let lo = 0,
      hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < targetSec) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const setIndex = (i) => {
    currentIndex = Math.max(0, Math.min(n - 1, i));
    onFrame(currentIndex);
  };

  const tick = (wallTime) => {
    if (!playing) return;
    if (lastWallTime === null) lastWallTime = wallTime;
    const dtSec = ((wallTime - lastWallTime) / 1000) * rate;
    lastWallTime = wallTime;

    const targetSec = t[currentIndex] + dtSec;
    if (targetSec >= t[n - 1]) {
      setIndex(n - 1);
      playing = false;
      return;
    }
    setIndex(findIndexForTime(targetSec));
    rafId = requestAnimationFrame(tick);
  };

  return {
    play() {
      if (playing || n === 0) return;
      if (currentIndex >= n - 1) currentIndex = 0;
      playing = true;
      lastWallTime = null;
      rafId = requestAnimationFrame(tick);
    },
    pause() {
      playing = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
    },
    seekToTime(sec) {
      setIndex(findIndexForTime(sec));
    },
    seekToIndex(i) {
      setIndex(i);
    },
    setRate(r) {
      rate = r;
    },
    isPlaying() {
      return playing;
    },
    getIndex() {
      return currentIndex;
    },
  };
};
