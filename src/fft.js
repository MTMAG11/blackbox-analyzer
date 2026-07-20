/*
 * Phase 2: FFT and vibration-spectrum analysis. Original code (not ported
 * from Betaflight blackbox-log-viewer) - a standard iterative radix-2
 * Cooley-Tukey FFT plus Welch's-method averaged power spectrum and simple
 * peak picking.
 *
 * Correctness is validated by BBLFFT.selfTest() (feeds a synthetic signal
 * of known frequencies through the pipeline and checks the peaks land in
 * the right place) rather than assumed - see PROJECT.md Phase 2 notes.
 */

const BBLFFT = {};

/**
 * In-place iterative radix-2 Cooley-Tukey FFT.
 * re, im: arrays of length n (n MUST be a power of 2), transformed in place.
 */
BBLFFT.transform = function (re, im) {
  const n = re.length;
  if (n & (n - 1)) throw new Error("FFT size must be a power of 2");

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang),
      wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curWr = 1,
        curWi = 0;
      for (let j = 0; j < half; j++) {
        const aRe = re[i + j],
          aIm = im[i + j];
        const bRe = re[i + j + half] * curWr - im[i + j + half] * curWi;
        const bIm = re[i + j + half] * curWi + im[i + j + half] * curWr;

        re[i + j] = aRe + bRe;
        im[i + j] = aIm + bIm;
        re[i + j + half] = aRe - bRe;
        im[i + j + half] = aIm - bIm;

        const nextWr = curWr * wr - curWi * wi;
        curWi = curWr * wi + curWi * wr;
        curWr = nextWr;
      }
    }
  }
};

BBLFFT.hannWindow = function (n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
};

BBLFFT.largestPow2LessOrEqual = function (n) {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
};

/**
 * Welch's method: average the power spectrum of overlapping Hann-windowed
 * segments of the signal. Returns steadier peaks than a single giant FFT
 * and tolerates non-power-of-2 input lengths (windows are power-of-2,
 * the whole signal doesn't need to be).
 *
 * samples: array-like of numbers, uniformly sampled at sampleRateHz.
 * Returns { freqs: Float64Array, magnitude: Float64Array, magnitudeDb: Float64Array }.
 */
BBLFFT.averagedPowerSpectrum = function (samples, sampleRateHz, windowSize) {
  const n = samples.length;
  windowSize = windowSize || 2048;
  if (n < windowSize) {
    windowSize = BBLFFT.largestPow2LessOrEqual(n);
  }
  if (windowSize < 8) {
    return { freqs: new Float64Array(0), magnitude: new Float64Array(0), magnitudeDb: new Float64Array(0) };
  }

  const hop = Math.floor(windowSize / 2);
  const window = BBLFFT.hannWindow(windowSize);

  let windowPower = 0;
  for (let i = 0; i < windowSize; i++) windowPower += window[i] * window[i];

  const numBins = windowSize / 2;
  const accum = new Float64Array(numBins);
  let numWindows = 0;

  const re = new Float64Array(windowSize);
  const im = new Float64Array(windowSize);

  for (let start = 0; start + windowSize <= n; start += hop) {
    for (let i = 0; i < windowSize; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    BBLFFT.transform(re, im);
    for (let k = 0; k < numBins; k++) {
      accum[k] += re[k] * re[k] + im[k] * im[k];
    }
    numWindows++;
  }

  const freqs = new Float64Array(numBins);
  const magnitude = new Float64Array(numBins);
  const magnitudeDb = new Float64Array(numBins);

  if (numWindows === 0) {
    return { freqs, magnitude, magnitudeDb };
  }

  for (let k = 0; k < numBins; k++) {
    freqs[k] = (k * sampleRateHz) / windowSize;
    const avgPower = accum[k] / numWindows / windowPower;
    magnitude[k] = Math.sqrt(avgPower);
    magnitudeDb[k] = 20 * Math.log10(magnitude[k] + 1e-12);
  }

  return { freqs, magnitude, magnitudeDb, numWindows, windowSize };
};

/**
 * Pick local maxima in magnitudeDb that stand at least minProminenceDb
 * above their local neighborhood median, within [minFreq, maxFreq].
 * Returns up to maxPeaks, sorted loudest first.
 */
BBLFFT.findPeaks = function (freqs, magnitudeDb, opts) {
  opts = opts || {};
  const minFreq = opts.minFreq ?? 5;
  const maxFreq = opts.maxFreq ?? (freqs.length ? freqs[freqs.length - 1] : 0);
  const maxPeaks = opts.maxPeaks ?? 6;
  const minProminenceDb = opts.minProminenceDb ?? 6;
  const halfWin = opts.halfWin ?? 20;

  const candidates = [];
  for (let i = 1; i < freqs.length - 1; i++) {
    if (freqs[i] < minFreq || freqs[i] > maxFreq) continue;
    if (magnitudeDb[i] > magnitudeDb[i - 1] && magnitudeDb[i] > magnitudeDb[i + 1]) {
      candidates.push(i);
    }
  }

  const scored = candidates.map((i) => {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(magnitudeDb.length - 1, i + halfWin);
    const windowVals = Array.from(magnitudeDb.slice(lo, hi + 1)).sort((a, b) => a - b);
    const median = windowVals[Math.floor(windowVals.length / 2)];
    return {
      index: i,
      freq: freqs[i],
      magnitudeDb: magnitudeDb[i],
      prominenceDb: magnitudeDb[i] - median,
    };
  });

  const significant = scored.filter((s) => s.prominenceDb >= minProminenceDb);
  significant.sort((a, b) => b.magnitudeDb - a.magnitudeDb);

  return significant.slice(0, maxPeaks);
};

/**
 * General, explicitly-hedged frequency-range labels. Not a diagnosis -
 * we have no RPM telemetry logged, so we can't say "this is motor 3's
 * 2nd harmonic." These are rough FPV-community heuristic ranges only.
 */
BBLFFT.describeFrequencyRange = function (freqHz) {
  if (freqHz < 25) {
    return "Below 25Hz: usually airframe flex or slow oscillation, not typically prop/motor vibration.";
  }
  if (freqHz < 90) {
    return "25-90Hz: possible frame resonance or prop wash range (unconfirmed - no RPM telemetry in this log).";
  }
  if (freqHz < 300) {
    return "90-300Hz: common range for prop imbalance or a bent prop on typical builds (unconfirmed - no RPM telemetry in this log).";
  }
  return "300Hz+: possible motor bearing or electrical/ESC noise (unconfirmed - no RPM telemetry in this log).";
};

/**
 * Self-test: feed a synthetic signal built from known frequencies through
 * the whole pipeline and check the detected peaks land within one FFT bin
 * of the true frequency. Throws on failure. Call from the browser console
 * or the checkFft.html harness - not wired into the UI, this is a
 * correctness check for development, not a user-facing feature.
 */
BBLFFT.selfTest = function () {
  const sampleRateHz = 8000;
  const durationSec = 4;
  const n = sampleRateHz * durationSec;
  const trueFreqs = [100, 450];
  const samples = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const t = i / sampleRateHz;
    let v = 0;
    for (const f of trueFreqs) v += Math.sin(2 * Math.PI * f * t);
    samples[i] = v;
  }

  const spectrum = BBLFFT.averagedPowerSpectrum(samples, sampleRateHz, 2048);
  const peaks = BBLFFT.findPeaks(spectrum.freqs, spectrum.magnitudeDb, { maxPeaks: 4, minProminenceDb: 6 });

  const binWidth = sampleRateHz / spectrum.windowSize;
  const foundNear = (target) => peaks.some((p) => Math.abs(p.freq - target) <= binWidth);

  const results = trueFreqs.map((f) => ({ freq: f, found: foundNear(f) }));
  const allFound = results.every((r) => r.found);

  const report = { pass: allFound, binWidthHz: binWidth, expected: trueFreqs, peaksFound: peaks, results };

  if (!allFound) {
    console.error("BBLFFT.selfTest FAILED", report);
    throw new Error(`FFT self-test failed to find expected peaks: ${JSON.stringify(results)}`);
  }

  console.log("BBLFFT.selfTest PASSED", report);
  return report;
};
