/*
 * Adapted from Betaflight blackbox-log-viewer (src/datastream.js)
 * https://github.com/betaflight/blackbox-log-viewer
 * Original work Copyright (C) Nicholas Sherlock and contributors, licensed GPL-3.0.
 * Ported as-is to a plain global script (no ES module import/export) since
 * this project has no build step.
 */

const EOF = -1;

/*
 * Take an array of unsigned byte data and present it as a stream with various methods
 * for reading data in different formats.
 */
function ArrayDataStream(data, start, end) {
  this.data = data;
  this.eof = false;
  this.start = start === undefined ? 0 : start;
  this.end = end === undefined ? data.length : end;
  this.pos = this.start;
}

ArrayDataStream.prototype.readChar = function () {
  if (this.pos < this.end) return String.fromCharCode(this.data[this.pos++]);

  this.eof = true;
  return EOF;
};

ArrayDataStream.prototype.readByte = function () {
  if (this.pos < this.end) return this.data[this.pos++];

  this.eof = true;
  return EOF;
};

ArrayDataStream.prototype.readU8 = ArrayDataStream.prototype.readByte;

ArrayDataStream.prototype.readS8 = function () {
  return BBLTools.signExtend8Bit(this.readByte());
};

ArrayDataStream.prototype.unreadChar = function (_c) {
  this.pos--;
};

ArrayDataStream.prototype.peekChar = function () {
  if (this.pos < this.end) return String.fromCharCode(this.data[this.pos]);

  this.eof = true;
  return EOF;
};

/**
 * Read a (maximally 32-bit) unsigned integer from the stream which was encoded in Variable Byte format.
 */
ArrayDataStream.prototype.readUnsignedVB = function () {
  let i,
    b,
    shift = 0,
    result = 0;

  // 5 bytes is enough to encode 32-bit unsigned quantities
  for (i = 0; i < 5; i++) {
    b = this.readByte();

    if (b === EOF) return 0;

    result = result | ((b & ~0x80) << shift);

    if (b < 128) {
      return result >>> 0;
    }

    shift += 7;
  }

  return 0;
};

ArrayDataStream.prototype.readSignedVB = function () {
  const unsigned = this.readUnsignedVB();

  // Apply ZigZag decoding to recover the signed value
  return (unsigned >>> 1) ^ -(unsigned & 1);
};

ArrayDataStream.prototype.readString = function (length) {
  const chars = new Array(length);
  let i;

  for (i = 0; i < length; i++) {
    chars[i] = this.readChar();
  }

  return chars.join("");
};

ArrayDataStream.prototype.readS16 = function () {
  const b1 = this.readByte(),
    b2 = this.readByte();

  return BBLTools.signExtend16Bit(b1 | (b2 << 8));
};

ArrayDataStream.prototype.readU16 = function () {
  const b1 = this.readByte(),
    b2 = this.readByte();

  return b1 | (b2 << 8);
};

ArrayDataStream.prototype.readU32 = function () {
  const b1 = this.readByte(),
    b2 = this.readByte(),
    b3 = this.readByte(),
    b4 = this.readByte();
  return b1 | (b2 << 8) | (b3 << 16) | (b4 << 24);
};

ArrayDataStream.prototype.EOF = EOF;
