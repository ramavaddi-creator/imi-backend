// Evidence.js — headless synthesis layer for Antardrishti.
// Pure functions. No React, no display. Turns raw chart math into GRADED
// signals + a compact prompt block. The UI never shows any of this; only the
// AI reading consumes it, to set its Confidence.
//
// Three layers, per design:
//   COMPUTE    — vargas, dignities, a longitude-clean strength proxy, Yogini daśā
//   SYNTHESIZE — corroboration (D1 vs domain varga), period strength, cross-system
//                agreement, birth-time resolution gate
//   INJECT     — synthesizeEvidence() returns { promptBlock, structured }
//                promptBlock -> appended to the AI system context
//                structured  -> NOT displayed now; available for a hidden
//                               evidence-inspector later (your Precision-page ethos)
//
// NOTE ON SHADBALA: full classical Ṣaḍbala needs declination (Ayana Bala) and
// daily speed (Cheṣṭā Bala), which the current engine does not expose. The
// strength here is an HONEST PROXY from the exact-from-longitude components:
// Uccha (exaltation distance), Dig (directional), and varga-dignity across the
// classical saptavarga D1/D2/D3/D7/D9/D12/D30. Labeled accordingly. Wire
// Ayana+Cheṣṭā when the engine returns declination and speed; the synthesis
// layer stays unchanged.

import { vargaSign } from "./Varga.js";

const mod12 = (n) => ((n % 12) + 12) % 12;
const norm360 = (x) => ((x % 360) + 360) % 360;
const GRAHAS = ["Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn"];

// Exaltation sign + degree; debilitation = opposite sign, same degree.
const EXALT = { Sun: [0, 10], Moon: [1, 3], Mars: [9, 28], Mercury: [5, 15], Jupiter: [3, 5], Venus: [11, 27], Saturn: [6, 20] };
const OWN = { Sun: [4], Moon: [3], Mars: [0, 7], Mercury: [2, 5], Jupiter: [8, 11], Venus: [1, 6], Saturn: [9, 10] };
const FRIENDS = {
  Sun: ["Moon", "Mars", "Jupiter"], Moon: ["Sun", "Mercury"], Mars: ["Sun", "Moon", "Jupiter"],
  Mercury: ["Sun", "Venus"], Jupiter: ["Sun", "Moon", "Mars"], Venus: ["Mercury", "Saturn"], Saturn: ["Mercury", "Venus"],
};
const ENEMIES = {
  Sun: ["Venus", "Saturn"], Moon: [], Mars: ["Mercury"], Mercury: ["Moon"],
  Jupiter: ["Mercury", "Venus"], Venus: ["Sun", "Moon"], Saturn: ["Sun", "Moon", "Mars"],
};
// rāśi lords, 0=Aries..11=Pisces
const SIGN_LORD = ["Mars", "Venus", "Mercury", "Moon", "Sun", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Saturn", "Jupiter"];
// Dig Bala: house (1..12) of maximum directional strength
const DIG_STRONG = { Sun: 10, Mars: 10, Moon: 4, Venus: 4, Mercury: 1, Jupiter: 1, Saturn: 7 };

function dignity(graha, signIdx) {
  const ex = EXALT[graha];
  if (!ex) return "neutral";
  if (signIdx === ex[0]) return "exalted";
  if (signIdx === mod12(ex[0] + 6)) return "debilitated";
  if ((OWN[graha] || []).includes(signIdx)) return "own";
  const lord = SIGN_LORD[signIdx];
  if (lord === graha) return "own";
  if ((FRIENDS[graha] || []).includes(lord)) return "friend";
  if ((ENEMIES[graha] || []).includes(lord)) return "enemy";
  return "neutral";
}
const DIGNITY_SCORE = { exalted: 1.0, own: 0.85, friend: 0.65, neutral: 0.5, enemy: 0.3, debilitated: 0.1 };

function uchchaBala(graha, absLon) {
  const ex = EXALT[graha];
  if (!ex) return 0.5;
  const debLon = mod12(ex[0] + 6) * 30 + ex[1];
  const d = Math.abs(((norm360(absLon - debLon) + 540) % 360) - 180); // 0 at debil, 180 at exalt
  return d / 180; // 0..1
}
function digBala(graha, house) {
  const strong = DIG_STRONG[graha];
  if (!strong) return 0.5;
  let diff = Math.abs((house - strong + 12) % 12);
  if (diff > 6) diff = 12 - diff; // 0..6
  return 1 - diff / 6; // 1 at strong house, 0 opposite
}
// varga-dignity across the classical SAPTAVARGA set (D1,D2,D3,D7,D9,D12,D30)
const STRENGTH_VARGAS = [1, 2, 3, 7, 9, 12, 30];
function vargaDignity(graha, absLon) {
  let s = 0;
  for (const D of STRENGTH_VARGAS) s += DIGNITY_SCORE[dignity(graha, vargaSign(absLon, D))];
  return s / STRENGTH_VARGAS.length;
}
function grahaStrength(graha, absLon, house) {
  if (graha === "Rahu" || graha === "Ketu") return { score: 0.5, label: "shadow", dignity: "node" };
  const u = uchchaBala(graha, absLon), d = digBala(graha, house), v = vargaDignity(graha, absLon);
  const score = 0.40 * u + 0.25 * d + 0.35 * v;
  const label = score >= 0.62 ? "STRONG" : score >= 0.45 ? "MODERATE" : "WEAK";
  return { score, label, dignity: dignity(graha, Math.floor(norm360(absLon) / 30)) };
}

/* ---- Yogini Daśā (36-year cycle) — an independent timing system for cross-check ---- */
const YOGINI = [
  { name: "Mangalā", lord: "Moon", yrs: 1 }, { name: "Piṅgalā", lord: "Sun", yrs: 2 },
  { name: "Dhānyā", lord: "Jupiter", yrs: 3 }, { name: "Bhrāmarī", lord: "Mars", yrs: 4 },
  { name: "Bhadrikā", lord: "Mercury", yrs: 5 }, { name: "Ulkā", lord: "Saturn", yrs: 6 },
  { name: "Siddhā", lord: "Venus", yrs: 7 }, { name: "Saṅkaṭā", lord: "Rahu", yrs: 8 },
];
const YR = 365.25;
function yoginiDasha(moonSidLong, birthJD, nowJD) {
  const span = 360 / 27, ML = norm360(moonSidLong);
  const nak = Math.floor(ML / span);          // 0..26
  const r = (nak + 1 + 3) % 8;                 // classical: (nak# + 3) mod 8
  const startIdx = r === 0 ? 7 : r - 1;
  const frac = (ML % span) / span;
  let t = birthJD - frac * YOGINI[startIdx].yrs * YR;
  for (let k = 0; k < 60; k++) {
    const y = YOGINI[(startIdx + k) % 8], dur = y.yrs * YR;
    if (nowJD >= t && nowJD < t + dur) return { ...y, start: t, end: t + dur };
    t += dur;
  }
  return null;
}

/* ---- domain corroboration: D1 promise vs the domain's varga ---- */
function lordOfHouse(houseNum, lagnaSignIdx) {
  return SIGN_LORD[mod12(lagnaSignIdx + houseNum - 1)];
}
function evalDomain(def, ctx) {
  const lord = lordOfHouse(def.house, ctx.lagnaSignIdx);
  const lon = ctx.lon[lord];
  if (lon == null) return null;
  const d1 = dignity(lord, Math.floor(norm360(lon) / 30));
  const dv = dignity(lord, vargaSign(lon, def.varga));
  const st = ctx.strength[lord];
  const houseSign = mod12(ctx.lagnaSignIdx + def.house - 1);
  const sav = ctx.sav ? ctx.sav[houseSign] : 28;
  const corro = DIGNITY_SCORE[dv] >= DIGNITY_SCORE[d1] - 0.05 ? "corroborated" : "contested";
  const conf =
    corro === "corroborated" && st.label !== "WEAK" && sav >= 28 ? "HIGH"
      : corro === "contested" || st.label === "WEAK" || sav < 25 ? "LOW"
        : "MEDIUM";
  return { label: def.label, varga: def.vlabel, lord, d1, dv, strength: st.label, sav, corro, conf };
}
const DOMAINS = [
  { label: "Career / status", house: 10, varga: 10, vlabel: "D10" },
  { label: "Marriage / partner", house: 7, varga: 9, vlabel: "D9" },
  { label: "Wealth", house: 2, varga: 2, vlabel: "D2" },
  { label: "Children", house: 5, varga: 7, vlabel: "D7" },
  { label: "Home / property / parents", house: 4, varga: 12, vlabel: "D12" },
];

/* ---- MAIN ENTRY ---------------------------------------------------------- */
// chart: { bodies:{Sun..Saturn,Rahu,Ketu absLon}, ascLong, lagnaSignIdx,
//          dasha (vimshottari result), sav (SAV array by sign), jd, tob }
export function synthesizeEvidence(chart) {
  const { bodies, ascLong, lagnaSignIdx, dasha, sav, jd, tob } = chart;
  const lon = { ...bodies };
  const houseOf = (L) => mod12(Math.floor(norm360(L) / 30) - lagnaSignIdx) + 1;

  // strength of all seven grahas
  const strength = {};
  for (const g of GRAHAS) if (lon[g] != null) strength[g] = grahaStrength(g, lon[g], houseOf(lon[g]));

  const ctx = { lon, lagnaSignIdx, sav, strength };

  // domains
  const domains = DOMAINS.map((d) => evalDomain(d, ctx)).filter(Boolean);

  // current period strength (MD + AD lords)
  const lordStrength = (L) => {
    if (L === "Rahu" || L === "Ketu") return "shadow (judge by house/bindus)";
    const s = strength[L];
    return s ? `${s.label} (${s.dignity})` : "n/a";
  };
  const period = {
    md: dasha?.md?.lord, mdStrength: dasha?.md?.lord ? lordStrength(dasha.md.lord) : "—",
    ad: dasha?.ad?.lord, adStrength: dasha?.ad?.lord ? lordStrength(dasha.ad.lord) : "—",
  };

  // cross-system check vs Yogini
  let cross = null;
  if (dasha?.md?.lord && bodies.Moon != null && jd != null) {
    const yog = yoginiDasha(bodies.Moon, jd, julianFromDate(new Date()));
    if (yog) cross = { vimshottari: dasha.md.lord, yogini: `${yog.name} (${yog.lord})`, agree: yog.lord === dasha.md.lord };
  }

  // birth-time resolution gate
  const mm = parseInt(String(tob || "").split(":")[1] || "0", 10);
  const coarseTime = Number.isFinite(mm) ? (mm % 5 === 0) : true; // rounded to 5 min => coarse
  const lagnaDeg = norm360(ascLong) % 30;
  const nearLagnaBoundary = lagnaDeg < 1.2 || lagnaDeg > 28.8;

  // ---- compose the compact prompt block (INJECT) ----
  const L = [];
  L.push("SYNTHESIZED CHART-FACTOR SUMMARY — engine-computed. These describe how far traditional factors AGREE within the chart; they say nothing about real-world predictive reliability.");
  L.push("Do NOT recite these labels, varga codes, or numbers to the user; translate to plain cause-and-effect and let them shape how you weigh traditional support (strong / mixed / limited).");
  L.push(`• Current period: Mahādaśā ${period.md} — strength ${period.mdStrength}; Antardaśā ${period.ad} — strength ${period.adStrength}. A strong lord is traditionally read as supportive; weak/enemy as more demanding — describe, do not promise outcomes.`);
  if (cross) {
    L.push(cross.agree
      ? `• Cross-system: Vimśottarī and Yoginī BOTH point to ${cross.vimshottari} now — agreement => traditional support for this period is more consistent (not a prediction).`
      : `• Cross-system: Vimśottarī ${cross.vimshottari} vs Yoginī ${cross.yogini} — the two systems differ — describe traditional support as mixed.`);
  }
  for (const d of domains) {
    L.push(`• ${d.label}: ruler ${d.lord} ${d.d1} in D1 / ${d.dv} in ${d.varga} (${d.corro}), strength ${d.strength}, support bindus ${d.sav}. → traditional factor agreement: ${{ HIGH: "strong", MEDIUM: "mixed", LOW: "limited" }[d.conf]}.`);
  }
  L.push(`• Birth-time resolution: D60 (sum-of-karma) is ${coarseTime ? "BELOW reliable resolution (time looks rounded) — do NOT lean on fine D60 distinctions" : "usable (time given to the odd minute)"}.${nearLagnaBoundary ? " Lagna sits within ~1° of a sign boundary — if the user reports an event that contradicts the reading, suspect a birth-time error and ask to rectify." : ""}`);
  L.push("WEIGHING RULE: corroborated + strong + higher bindus => traditional support strong; contested OR weak OR low bindus => mixed or limited. Never convert this into an outcome probability.");

  return {
    promptBlock: L.join("\n"),
    structured: { strength, domains, period, cross, birthTime: { coarseTime, nearLagnaBoundary, lagnaDeg } },
  };
}

/* small date->JD helper so this module stays engine-independent for the cross-check */
function julianFromDate(date) {
  let y = date.getUTCFullYear(), m = date.getUTCMonth() + 1;
  const d = date.getUTCDate(), hourUT = date.getUTCHours() + date.getUTCMinutes() / 60;
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5 + hourUT / 24;
}
