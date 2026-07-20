/*
 * Adapted from Betaflight blackbox-log-viewer (src/tools.js)
 * https://github.com/betaflight/blackbox-log-viewer
 * Original work Copyright (C) Nicholas Sherlock and contributors, licensed GPL-3.0.
 * This file: trimmed to only the byte/number helpers the decoder needs
 * (dropped DOM/canvas helpers that aren't used for parsing).
 */

const BBLTools = {};

// Convert a hexadecimal string (that represents a binary 32-bit float) into a float
BBLTools.hexToFloat = function (string) {
  const arr = new Uint32Array(1);
  arr[0] = parseInt(string, 16);

  const floatArr = new Float32Array(arr.buffer);

  return floatArr[0];
};

BBLTools.uint32ToFloat = function (value) {
  const arr = new Uint32Array(1);
  arr[0] = value;

  const floatArr = new Float32Array(arr.buffer);

  return floatArr[0];
};

BBLTools.asciiArrayToString = function (arr) {
  return String.fromCodePoint(...arr);
};

BBLTools.asciiStringToByteArray = function (s) {
  const bytes = [];

  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));

  return bytes;
};

BBLTools.signExtend24Bit = function (u) {
  return u & 0x800000 ? u | 0xff000000 : u;
};

BBLTools.signExtend16Bit = function (word) {
  return word & 0x8000 ? word | 0xffff0000 : word;
};

BBLTools.signExtend14Bit = function (word) {
  return word & 0x2000 ? word | 0xffffc000 : word;
};

BBLTools.signExtend8Bit = function (byte) {
  return byte & 0x80 ? byte | 0xffffff00 : byte;
};

BBLTools.signExtend7Bit = function (byte) {
  return byte & 0x40 ? byte | 0xffffff80 : byte;
};

BBLTools.signExtend6Bit = function (byte) {
  return byte & 0x20 ? byte | 0xffffffc0 : byte;
};

BBLTools.signExtend5Bit = function (byte) {
  return byte & 0x10 ? byte | 0xffffffe0 : byte;
};

BBLTools.signExtend4Bit = function (nibble) {
  return nibble & 0x08 ? nibble | 0xfffffff0 : nibble;
};

BBLTools.signExtend2Bit = function (byte) {
  return byte & 0x02 ? byte | 0xfffffffc : byte;
};

BBLTools.stringHasComma = function (string) {
  return string.match(/.*,.*/) != null;
};

BBLTools.parseCommaSeparatedString = function (string, length) {
  const parts = string.split(",");
  let result;
  let value;

  length = length || parts.length;

  if (length < 2) {
    value = parts.indexOf(".") ? parseFloat(parts) : parseInt(parts, 10);
    return isNaN(value) ? string : value;
  } else {
    result = new Array(length);
    for (let i = 0; i < length; i++) {
      if (i < parts.length) {
        value = parts[i].indexOf(".")
          ? parseFloat(parts[i])
          : parseInt(parts[i], 10);
        result[i] = isNaN(value) ? parts[i] : value;
      } else {
        result[i] = null;
      }
    }
    return result;
  }
};

// Numeric x.y.z version comparison (replaces the semver package dependency
// from upstream, since this project has no build step / no npm packages).
BBLTools.versionGte = function (a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
};
