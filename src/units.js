/*
 * Unit conversion helpers, adapted from Betaflight blackbox-log-viewer
 * (src/flightlog.js: FlightLog.prototype.accRawToGs,
 * FlightLog.prototype.gyroRawToDegreesPerSecond, and the vbatLatest/
 * amperageLatest cases in flightlog_fields_presenter.js's field formatter,
 * plus the quaternion-to-Euler-angle math in flightlog.js's
 * computeAttitude()).
 * https://github.com/betaflight/blackbox-log-viewer
 * Original work Copyright (C) Nicholas Sherlock and contributors, licensed GPL-3.0.
 *
 * Only the modern-Betaflight-firmware branches are ported (this project's
 * hardware is confirmed on Betaflight 2025.12.5). Older-firmware fallback
 * branches upstream (pre-4.0.0 vbat, pre-3.1.7 amperage, gyro+acc fallback
 * attitude estimation when no quaternion is logged) were intentionally
 * left out rather than guessed at - if a log from much older firmware is
 * ever loaded, these functions fall back to labeling values as raw/
 * unconverted instead of silently showing a wrong number.
 */

const BBLUnits = {};

BBLUnits.accRawToGs = function (sysConfig, value) {
  return value / sysConfig.acc_1G;
};

BBLUnits.gyroRawToDegreesPerSecond = function (sysConfig, value) {
  return ((sysConfig.gyroScale * 1000000) / (Math.PI / 180.0)) * value;
};

// Returns volts, or null if this firmware/version combo isn't one of the
// branches we've ported (see file header).
BBLUnits.vbatLatestToVolts = function (sysConfig, value) {
  if (
    sysConfig.firmwareType === 3 /* FIRMWARE_TYPE_BETAFLIGHT */ &&
    BBLTools.versionGte(sysConfig.firmwareVersion, "4.0.0")
  ) {
    return value / 100;
  }
  return null;
};

// Returns amps, or null if unsupported (see file header).
BBLUnits.amperageLatestToAmps = function (sysConfig, value) {
  if (
    sysConfig.firmwareType === 3 /* FIRMWARE_TYPE_BETAFLIGHT */ &&
    BBLTools.versionGte(sysConfig.firmwareVersion, "3.1.7")
  ) {
    return value / 100;
  }
  return null;
};

/**
 * Convert the 3 logged imuQuaternion components (x, y, z; fixed-point
 * int16 scaled by 0x7FFF) into a normalized unit quaternion {x,y,z,w}.
 *
 * Betaflight only logs x/y/z, not w - w is reconstructed from the unit
 * quaternion constraint (x^2+y^2+z^2+w^2=1), which is exactly what
 * upstream's computeAttitude() does. Shared by quaternionToEulerDegrees()
 * (Phase 1) and attitude3d.js's 3D rotation matrix (Phase 5) so both use
 * the exact same reconstructed quaternion.
 */
BBLUnits.normalizeQuaternion = function (rawX, rawY, rawZ) {
  const scale = 0x7fff;
  const q = { x: rawX / scale, y: rawY / scale, z: rawZ / scale, w: 1.0 };

  let m = q.x ** 2 + q.y ** 2 + q.z ** 2;
  if (m < 1.0) {
    q.w = Math.sqrt(1.0 - m);
  } else {
    m = Math.sqrt(m);
    q.x /= m;
    q.y /= m;
    q.z /= m;
    q.w = 0;
  }

  return q;
};

/**
 * Roll/pitch/heading in degrees from an already-normalized quaternion
 * {x,y,z,w}. Split out from quaternionToEulerDegrees() so callers that
 * already have a normalized q (e.g. app.js storing it for the Phase 5 3D
 * model) don't need to re-normalize.
 */
BBLUnits.eulerDegreesFromNormalizedQuaternion = function (q) {
  const xx = q.x ** 2,
    xy = q.x * q.y,
    xz = q.x * q.z,
    wx = q.w * q.x,
    yy = q.y ** 2,
    yz = q.y * q.z,
    wy = q.w * q.y,
    zz = q.z ** 2,
    wz = q.w * q.z;

  const roll = Math.atan2(2 * (wx + yz), 1 - 2 * (xx + yy));
  const pitch = 0.5 * Math.PI - Math.acos(2 * (wy - xz));
  let heading = -Math.atan2(2 * (wz + xy), 1 - 2 * (yy + zz));
  if (heading < 0) heading += 2 * Math.PI;

  const toDeg = 180 / Math.PI;
  return {
    rollDeg: roll * toDeg,
    pitchDeg: pitch * toDeg,
    headingDeg: heading * toDeg,
  };
};

/**
 * Convenience wrapper for callers that only have the raw logged values.
 * Returns {rollDeg, pitchDeg, headingDeg}.
 */
BBLUnits.quaternionToEulerDegrees = function (rawX, rawY, rawZ) {
  return BBLUnits.eulerDegreesFromNormalizedQuaternion(BBLUnits.normalizeQuaternion(rawX, rawY, rawZ));
};
