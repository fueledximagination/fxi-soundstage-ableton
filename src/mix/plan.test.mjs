// Pure unit tests for planMixChain + dB mapping helpers (no SDK, no I/O).
// Run with:  node --experimental-strip-types src/mix/plan.test.mjs
//   or (if strip-types unavailable):  npx tsx src/mix/plan.test.mjs
//
// We import the .ts module directly; node's type-stripping / tsx handles it.
import { planMixChain, dbToGainNormalized, panToNormalized } from "./plan.ts";

let passed = 0;
let failed = 0;
function ok(cond, msg) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  FAIL: ${msg}`);
  }
}
function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ── Fixtures: two representative templates ───────────────────────────────────
const modernPop = {
  key: "modern-pop-master",
  label: "Modern Pop Master",
  description: "",
  loudnessLufsTarget: -9,
  truePeakDb: -1,
  eqBands: [
    { freqHz: 30, gainDb: 0, q: 0.7, type: "highpass" },
    { freqHz: 90, gainDb: 1.5, q: 0.8, type: "lowshelf" },
    { freqHz: 350, gainDb: -1.5, q: 1, type: "bell" },
    { freqHz: 3000, gainDb: 1.5, q: 0.9, type: "bell" },
    { freqHz: 12000, gainDb: 2.5, q: 0.7, type: "highshelf" },
  ],
  compression: { thresholdDb: -16, ratio: 2, attackMs: 15, releaseMs: 120, makeupDb: 2 },
  multiband: {
    low: { thresholdDb: -22, ratio: 2.5 },
    mid: { thresholdDb: -18, ratio: 2 },
    high: { thresholdDb: -20, ratio: 2.2 },
  },
  saturation: { drive: 0.2, type: "soft" },
  stereo: { widthPct: 115, bassMonoHz: 120 },
  limiter: { ceilingDb: -1, gainDb: 4 },
  mixer: { volumeDb: 0, pan: 0, sends: [{ name: "Reverb", amountDb: -24 }] },
};

const acoustic = {
  key: "acoustic-natural",
  label: "Acoustic Natural",
  description: "",
  loudnessLufsTarget: -14,
  truePeakDb: -1,
  eqBands: [
    { freqHz: 35, gainDb: 0, q: 0.7, type: "highpass" },
    { freqHz: 250, gainDb: -1, q: 1, type: "bell" },
    { freqHz: 5000, gainDb: 1, q: 0.8, type: "bell" },
    { freqHz: 11000, gainDb: 1.5, q: 0.7, type: "highshelf" },
  ],
  compression: { thresholdDb: -20, ratio: 1.5, attackMs: 30, releaseMs: 220, makeupDb: 1 },
  multiband: {
    low: { thresholdDb: -26, ratio: 1.5 },
    mid: { thresholdDb: -22, ratio: 1.5 },
    high: { thresholdDb: -24, ratio: 1.5 },
  },
  saturation: { drive: 0.1, type: "none" }, // → Saturator OMITTED
  stereo: { widthPct: 100, bassMonoHz: 100 },
  limiter: { ceilingDb: -1, gainDb: 1.5 },
  mixer: { volumeDb: 0, pan: 0, sends: [{ name: "Reverb", amountDb: -18 }] },
};

// ── planMixChain: device order + content (modern-pop, saturation present) ────
{
  const plan = planMixChain(modernPop);
  const names = plan.devices.map((d) => d.deviceName);
  ok(
    JSON.stringify(names) ===
      JSON.stringify(["EQ Eight", "Glue Compressor", "Multiband Dynamics", "Saturator", "Utility", "Limiter"]),
    `modern-pop device order, got ${names.join(",")}`,
  );

  const eq = plan.devices[0];
  ok(eq.deviceName === "EQ Eight", "first device EQ Eight");
  // eqBands → EQ Eight Frequency targets per band (5 bands → 5 Frequency params)
  const freqParams = eq.params.filter((p) => /Frequency A$/.test(p.name));
  ok(freqParams.length === 5, `EQ Eight has 5 frequency params, got ${freqParams.length}`);
  ok(
    freqParams[0].name === "1 Frequency A" && freqParams[0].value === 30,
    "band 1 frequency = 30 Hz",
  );
  ok(
    freqParams[4].name === "5 Frequency A" && freqParams[4].value === 12000,
    "band 5 frequency = 12000 Hz",
  );
  // 0 dB band emits no Gain param (only non-zero gains)
  const gainParams = eq.params.filter((p) => /Gain A$/.test(p.name));
  ok(gainParams.length === 4, `EQ Eight has 4 gain params (0 dB band skipped), got ${gainParams.length}`);

  // compression → Glue Compressor
  const glue = plan.devices[1];
  ok(glue.deviceName === "Glue Compressor", "second device Glue Compressor");
  const thr = glue.params.find((p) => p.name === "Threshold");
  ok(thr && thr.value === -16, "Glue threshold from compression.thresholdDb");
  const ratio = glue.params.find((p) => p.name === "Ratio");
  ok(ratio && ratio.value === 2, "Glue ratio from compression.ratio");

  // multiband → Multiband Dynamics
  const mb = plan.devices[2];
  ok(mb.deviceName === "Multiband Dynamics", "third device Multiband Dynamics");
  ok(
    mb.params.some((p) => p.name === "Low Below Threshold" && p.value === -22),
    "multiband low threshold carried",
  );

  // saturation → Saturator drive in dB (0.2 * 18 = 3.6)
  const sat = plan.devices[3];
  ok(sat.deviceName === "Saturator", "fourth device Saturator");
  const drive = sat.params.find((p) => p.name === "Drive");
  ok(drive && approx(drive.value, 0.2 * 18), `Saturator drive dB = 3.6, got ${drive && drive.value}`);

  // Utility carries width, bass-mono, precise gain
  const util = plan.devices[4];
  ok(util.deviceName === "Utility", "fifth device Utility");
  ok(util.params.some((p) => p.name === "Stereo Width" && p.value === 115), "Utility width 115%");
  ok(util.params.some((p) => p.name === "Bass Mono Frequency" && p.value === 120), "Utility bass-mono 120 Hz");

  // Limiter present, last
  const lim = plan.devices[plan.devices.length - 1];
  ok(lim.deviceName === "Limiter", "limiter present and last");
  ok(lim.params.some((p) => p.name === "Ceiling" && p.value === -1), "limiter ceiling carried");

  // mixer carried: fader kept at unity (Utility carries gain), pan/sends carried
  ok(plan.mixer.volumeDb === 0, "mixer fader at unity (gain via Utility)");
  ok(plan.mixer.sends.length === 1 && plan.mixer.sends[0].name === "Reverb", "mixer sends carried");
}

// ── planMixChain: acoustic omits Saturator (saturation.type === "none") ──────
{
  const plan = planMixChain(acoustic);
  const names = plan.devices.map((d) => d.deviceName);
  ok(!names.includes("Saturator"), "acoustic omits Saturator (type none)");
  ok(
    JSON.stringify(names) ===
      JSON.stringify(["EQ Eight", "Glue Compressor", "Multiband Dynamics", "Utility", "Limiter"]),
    `acoustic device order, got ${names.join(",")}`,
  );
  ok(names[names.length - 1] === "Limiter", "acoustic limiter present");
}

// ── dbToGainNormalized edge cases ────────────────────────────────────────────
{
  ok(approx(dbToGainNormalized(0), 0.85), "0 dB → 0.85 (unity marker)");
  ok(dbToGainNormalized(6) === 1, "+6 dB → 1.0 (top)");
  ok(dbToGainNormalized(12) === 1, "above +6 dB clamps to 1.0");
  ok(dbToGainNormalized(-70) === 0, "-70 dB → 0.0");
  ok(dbToGainNormalized(-100) === 0, "below -70 dB clamps to 0.0");
  // monotonic in the sub-unity region
  ok(dbToGainNormalized(-6) < dbToGainNormalized(0), "monotonic below unity");
  ok(dbToGainNormalized(0) < dbToGainNormalized(3), "monotonic above unity");
  const v = dbToGainNormalized(-12);
  ok(v >= 0 && v <= 1, "sub-unity value stays in [0,1]");
}

// ── panToNormalized edge cases ───────────────────────────────────────────────
{
  ok(panToNormalized(-1) === 0, "pan -1 → 0.0 (hard left)");
  ok(panToNormalized(0) === 0.5, "pan 0 → 0.5 (center)");
  ok(panToNormalized(1) === 1, "pan +1 → 1.0 (hard right)");
  ok(panToNormalized(-5) === 0, "pan below -1 clamps to 0.0");
  ok(panToNormalized(5) === 1, "pan above +1 clamps to 1.0");
}

console.log(`\nmix/plan.test: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
