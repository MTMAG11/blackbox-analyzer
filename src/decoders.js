/*
 * Adapted from Betaflight blackbox-log-viewer (src/decoders.js)
 * https://github.com/betaflight/blackbox-log-viewer
 * Original work Copyright (C) Nicholas Sherlock and contributors, licensed GPL-3.0.
 * Ported as-is to a plain global script (no ES module import/export) since
 * this project has no build step. Extends ArrayDataStream.prototype from
 * datastream.js with the "tag" group encodings (multiple field values packed
 * into a shared selector byte).
 */

ArrayDataStream.prototype.readTag2_3S32 = function (values) {
  let leadByte, byte1, byte2, byte3, byte4, i;

  leadByte = this.readByte();

  switch (leadByte >> 6) {
    case 0:
      // 2-bit fields
      values[0] = BBLTools.signExtend2Bit((leadByte >> 4) & 0x03);
      values[1] = BBLTools.signExtend2Bit((leadByte >> 2) & 0x03);
      values[2] = BBLTools.signExtend2Bit(leadByte & 0x03);
      break;
    case 1:
      // 4-bit fields
      values[0] = BBLTools.signExtend4Bit(leadByte & 0x0f);

      leadByte = this.readByte();

      values[1] = BBLTools.signExtend4Bit(leadByte >> 4);
      values[2] = BBLTools.signExtend4Bit(leadByte & 0x0f);
      break;
    case 2:
      // 6-bit fields
      values[0] = BBLTools.signExtend6Bit(leadByte & 0x3f);

      leadByte = this.readByte();
      values[1] = BBLTools.signExtend6Bit(leadByte & 0x3f);

      leadByte = this.readByte();
      values[2] = BBLTools.signExtend6Bit(leadByte & 0x3f);
      break;
    case 3:
      // Fields are 8, 16 or 24 bits, read selector to figure out which field is which size
      for (i = 0; i < 3; i++) {
        switch (leadByte & 0x03) {
          case 0: // 8-bit
            byte1 = this.readByte();
            values[i] = BBLTools.signExtend8Bit(byte1);
            break;
          case 1: // 16-bit
            byte1 = this.readByte();
            byte2 = this.readByte();
            values[i] = BBLTools.signExtend16Bit(byte1 | (byte2 << 8));
            break;
          case 2: // 24-bit
            byte1 = this.readByte();
            byte2 = this.readByte();
            byte3 = this.readByte();
            values[i] = BBLTools.signExtend24Bit(
              byte1 | (byte2 << 8) | (byte3 << 16),
            );
            break;
          case 3: // 32-bit
            byte1 = this.readByte();
            byte2 = this.readByte();
            byte3 = this.readByte();
            byte4 = this.readByte();
            values[i] = byte1 | (byte2 << 8) | (byte3 << 16) | (byte4 << 24);
            break;
        }

        leadByte >>= 2;
      }
      break;
  }
};

ArrayDataStream.prototype.readTag2_3SVariable = function (values) {
  let leadByte, leadByte2, leadByte3, byte1, byte2, byte3, byte4, i;

  leadByte = this.readByte();

  switch (leadByte >> 6) {
    case 0:
      // 2 bits per field
      values[0] = BBLTools.signExtend2Bit((leadByte >> 4) & 0x03);
      values[1] = BBLTools.signExtend2Bit((leadByte >> 2) & 0x03);
      values[2] = BBLTools.signExtend2Bit(leadByte & 0x03);
      break;
    case 1:
      // 5,5,4 bits per field
      values[0] = BBLTools.signExtend5Bit((leadByte & 0x3e) >> 1);

      leadByte2 = this.readByte();

      values[1] = BBLTools.signExtend5Bit(
        ((leadByte & 0x01) << 5) | ((leadByte2 & 0x0f) >> 4),
      );
      values[2] = BBLTools.signExtend4Bit(leadByte2 & 0x0f);
      break;
    case 2:
      // 8,7,7 bits per field
      leadByte2 = this.readByte();
      values[1] = BBLTools.signExtend8Bit(
        ((leadByte & 0x3f) << 2) | ((leadByte2 & 0xc0) >> 6),
      );

      leadByte3 = this.readByte();
      values[1] = BBLTools.signExtend7Bit(
        ((leadByte2 & 0x3f) << 1) | ((leadByte2 & 0x80) >> 7),
      );

      values[2] = BBLTools.signExtend7Bit(leadByte3 & 0x7f);
      break;
    case 3:
      // Fields are 8, 16 or 24 bits, read selector to figure out which field is which size
      for (i = 0; i < 3; i++) {
        switch (leadByte & 0x03) {
          case 0: // 8-bit
            byte1 = this.readByte();
            values[i] = BBLTools.signExtend8Bit(byte1);
            break;
          case 1: // 16-bit
            byte1 = this.readByte();
            byte2 = this.readByte();
            values[i] = BBLTools.signExtend16Bit(byte1 | (byte2 << 8));
            break;
          case 2: // 24-bit
            byte1 = this.readByte();
            byte2 = this.readByte();
            byte3 = this.readByte();
            values[i] = BBLTools.signExtend24Bit(
              byte1 | (byte2 << 8) | (byte3 << 16),
            );
            break;
          case 3: // 32-bit
            byte1 = this.readByte();
            byte2 = this.readByte();
            byte3 = this.readByte();
            byte4 = this.readByte();
            values[i] = byte1 | (byte2 << 8) | (byte3 << 16) | (byte4 << 24);
            break;
        }

        leadByte >>= 2;
      }
      break;
  }
};

ArrayDataStream.prototype.readTag8_4S16_v1 = function (values) {
  const FIELD_ZERO = 0,
    FIELD_4BIT = 1,
    FIELD_8BIT = 2,
    FIELD_16BIT = 3;
  let selector, combinedChar, char1, char2, i;

  selector = this.readByte();

  for (i = 0; i < 4; i++) {
    switch (selector & 0x03) {
      case FIELD_ZERO:
        values[i] = 0;
        break;
      case FIELD_4BIT: // Two 4-bit fields
        combinedChar = this.readByte();

        values[i] = BBLTools.signExtend4Bit(combinedChar & 0x0f);

        i++;
        selector >>= 2;

        values[i] = BBLTools.signExtend4Bit(combinedChar >> 4);
        break;
      case FIELD_8BIT: // 8-bit field
        values[i] = BBLTools.signExtend8Bit(this.readByte());
        break;
      case FIELD_16BIT: // 16-bit field
        char1 = this.readByte();
        char2 = this.readByte();

        values[i] = BBLTools.signExtend16Bit(char1 | (char2 << 8));
        break;
    }

    selector >>= 2;
  }
};

ArrayDataStream.prototype.readTag8_4S16_v2 = function (values) {
  const FIELD_ZERO = 0,
    FIELD_4BIT = 1,
    FIELD_8BIT = 2,
    FIELD_16BIT = 3;
  let selector, i, char1, char2, buffer, nibbleIndex;

  selector = this.readByte();

  nibbleIndex = 0;
  for (i = 0; i < 4; i++) {
    switch (selector & 0x03) {
      case FIELD_ZERO:
        values[i] = 0;
        break;
      case FIELD_4BIT:
        if (nibbleIndex === 0) {
          buffer = this.readByte();
          values[i] = BBLTools.signExtend4Bit(buffer >> 4);
          nibbleIndex = 1;
        } else {
          values[i] = BBLTools.signExtend4Bit(buffer & 0x0f);
          nibbleIndex = 0;
        }
        break;
      case FIELD_8BIT:
        if (nibbleIndex === 0) {
          values[i] = BBLTools.signExtend8Bit(this.readByte());
        } else {
          char1 = (buffer & 0x0f) << 4;
          buffer = this.readByte();

          char1 |= buffer >> 4;
          values[i] = BBLTools.signExtend8Bit(char1);
        }
        break;
      case FIELD_16BIT:
        if (nibbleIndex === 0) {
          char1 = this.readByte();
          char2 = this.readByte();

          values[i] = BBLTools.signExtend16Bit((char1 << 8) | char2);
        } else {
          char1 = this.readByte();
          char2 = this.readByte();

          values[i] = BBLTools.signExtend16Bit(
            ((buffer & 0x0f) << 12) | (char1 << 4) | (char2 >> 4),
          );

          buffer = char2;
        }
        break;
    }

    selector >>= 2;
  }
};

ArrayDataStream.prototype.readTag8_8SVB = function (values, valueCount) {
  let i, header;

  if (valueCount === 1) {
    values[0] = this.readSignedVB();
  } else {
    header = this.readByte();

    for (i = 0; i < 8; i++, header >>= 1)
      values[i] = header & 0x01 ? this.readSignedVB() : 0;
  }
};
