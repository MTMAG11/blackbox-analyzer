/*
 * Phase 0 test harness: load a .bbl file, run it through the decoder, and
 * print out header config + sample frame values so we can eyeball them
 * against known-good numbers from the log.
 */

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
    // Not every log necessarily begins exactly at byte 0 with this marker
    // intact (e.g. if truncated) - fall back to treating the whole file as
    // one segment so parseHeader can at least try.
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

function fieldRow(names, frame) {
  if (!frame) return "(no frame captured)";
  return names.map((name, i) => `${name}=${frame[i]}`).join("  ");
}

function el(id) {
  return document.getElementById(id);
}

function log(msg) {
  el("output").textContent += `${msg}\n`;
}

function analyzeLog(bytes) {
  el("output").textContent = "";

  const segments = findLogSegments(bytes);
  log(`Found ${segments.length} flight log segment(s) in this file. Showing segment 1.\n`);

  const segment = segments[0];
  const parser = new FlightLogParser(bytes);

  let firstIFrame = null;
  let firstPFrame = null;
  let frameCount = { I: 0, P: 0, S: 0, E: 0 };

  parser.onFrameReady = (valid, frame, frameType, _start, _size) => {
    if (!valid) return;
    frameCount[frameType] = (frameCount[frameType] || 0) + 1;
    if (frameType === "I" && !firstIFrame) firstIFrame = frame.slice();
    if (frameType === "P" && !firstPFrame) firstPFrame = frame.slice();
  };

  parser.parseHeader(segment.start, segment.end);
  parser.parseLogData(false, undefined, segment.end);

  const sc = parser.sysConfig;

  log("=== Header / sysConfig ===");
  log(`Firmware: ${sc.Product ?? "?"} / ${sc["Firmware revision"] ?? "?"}`);
  log(`Board: ${sc["Board information"] ?? "?"}`);
  log(`Looptime: ${sc.looptime ?? "?"} us`);
  log(`rollPID: ${JSON.stringify(sc.rollPID)}`);
  log(`pitchPID: ${JSON.stringify(sc.pitchPID)}`);
  log(`yawPID: ${JSON.stringify(sc.yawPID)}`);
  log(`minthrottle/maxthrottle: ${sc.minthrottle} / ${sc.maxthrottle}`);
  log(`vbatref: ${sc.vbatref}`);
  log("");

  log("=== Frame field names (I/P frame) ===");
  log(parser.frameDefs.I.name.join(", "));
  log("");

  log("=== Frame counts ===");
  log(JSON.stringify(frameCount));
  log("");

  log("=== First I-frame values ===");
  log(fieldRow(parser.frameDefs.I.name, firstIFrame));
  log("");

  log("=== First P-frame values ===");
  log(fieldRow(parser.frameDefs.P.name, firstPFrame));
  log("");

  log("=== Parse stats ===");
  log(`Total bytes: ${parser.stats.totalBytes}`);
  log(`Corrupt frames: ${parser.stats.totalCorruptFrames}`);
}

el("fileInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    const bytes = new Uint8Array(reader.result);
    try {
      analyzeLog(bytes);
    } catch (err) {
      el("output").textContent = `Error while parsing: ${err}\n${err.stack ?? ""}`;
    }
  };
  reader.readAsArrayBuffer(file);
});
