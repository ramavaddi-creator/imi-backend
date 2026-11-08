// engine.js — Antardṛṣṭi sidereal calculation core (pure, no React).
// Shared by the browser app AND the server-side AI function so both see identical facts.
// Extracted unchanged from App.jsx except where marked FIX (Reliability Upgrade 2026-11).
import { Body, MakeTime, GeoVector, Ecliptic } from "astronomy-engine";
import { bhinnashtakavarga, sarvashtakavarga } from "../Ashtakavarga.js";
import { synthesizeEvidence } from "../Evidence.js";

/* ============================================================
   SIDEREAL (LAHIRI) ASTRONOMY CORE  — sign / nakshatra / dasha grade
   Standard algorithms (Meeus + Standish low-precision elements).
   Not a substitute for Swiss Ephemeris cusp precision.
   ============================================================ */
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const norm360 = (x) => ((x % 360) + 360) % 360;
const sind = (d) => Math.sin(d * D2R), cosd = (d) => Math.cos(d * D2R), tand = (d) => Math.tan(d * D2R);

function julianDay(y, m, d, hourUT) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5 + hourUT / 24;
}
function jdToDate(jd) {
  let z = Math.floor(jd + 0.5), f = jd + 0.5 - z, A = z;
  if (z >= 2299161) { const a = Math.floor((z - 1867216.25) / 36524.25); A = z + 1 + a - Math.floor(a / 4); }
  const B = A + 1524, C = Math.floor((B - 122.1) / 365.25), D = Math.floor(365.25 * C),
        E = Math.floor((B - D) / 30.6001);
  const day = B - D - Math.floor(30.6001 * E) + f;
  const month = E < 14 ? E - 1 : E - 13;
  const year = month > 2 ? C - 4716 : C - 4715;
  return { y: year, m: month, d: Math.floor(day) };
}
const Tcent = (jd) => (jd - 2451545.0) / 36525;
function lahiri(jd) { const Y = 2000.0 + (jd - 2451545.0) / 365.25; return 23.85250 + 0.0139673 * (Y - 2000.0); }
function obliquity(T) { return 23.439291 - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T; }

function sunTrop(jd) {
  const T = Tcent(jd);
  const L0 = norm360(280.46646 + 36000.76983 * T + 0.0003032 * T * T);
  const M = norm360(357.52911 + 35999.05029 * T - 0.0001537 * T * T);
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sind(M)
          + (0.019993 - 0.000101 * T) * sind(2 * M) + 0.000289 * sind(3 * M);
  return norm360(L0 + C);
}
function moonTrop(jd) {
  const T = Tcent(jd);
  const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + T ** 3 / 538841 - T ** 4 / 65194000;
  const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + T ** 3 / 545868 - T ** 4 / 113065000;
  const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + T ** 3 / 24490000;
  const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + T ** 3 / 69699 - T ** 4 / 14712000;
  const F = 93.2720950 + 483202.0175233 * T - 0.0036539 * T * T - T ** 3 / 3526000 + T ** 4 / 863310000;
  const E = 1 - 0.002516 * T - 0.0000074 * T * T;
  const terms = [
    [6288774, 0, 0, 1, 0, 0], [1274027, 2, 0, -1, 0, 0], [658314, 2, 0, 0, 0, 0], [213618, 0, 0, 2, 0, 0],
    [-185116, 0, 1, 0, 0, 1], [-114332, 0, 0, 0, 2, 0], [58793, 2, 0, -2, 0, 0], [57066, 2, -1, -1, 0, 1],
    [53322, 2, 0, 1, 0, 0], [45758, 2, -1, 0, 0, 1], [-40923, 0, 1, -1, 0, 1], [-34720, 1, 0, 0, 0, 0],
    [-30383, 0, 1, 1, 0, 1], [15327, 2, 0, 0, -2, 0], [-12528, 0, 0, 1, 2, 0], [10980, 0, 0, 1, -2, 0],
    [10675, 4, 0, -1, 0, 0], [10034, 0, 0, 3, 0, 0], [8548, 4, 0, -2, 0, 0], [-7888, 2, 1, -1, 0, 1],
    [-6766, 2, 1, 0, 0, 1], [-5163, 1, 0, -1, 0, 0], [4987, 1, 1, 0, 0, 1], [4036, 2, -1, 1, 0, 1],
    [3994, 2, 0, 2, 0, 0], [3861, 4, 0, 0, 0, 0], [3665, 2, 0, -3, 0, 0]
  ];
  let sum = 0;
  for (const [c, dd, mm, mp, ff, ef] of terms) {
    let coef = c; if (ef) coef *= Math.pow(E, Math.abs(mm));
    sum += coef * sind(dd * D + mm * M + mp * Mp + ff * F);
  }
  return norm360(Lp + sum * 1e-6);
}
function rahuTrop(jd) {
  const T = Tcent(jd);
  return norm360(125.0445479 - 1934.1362891 * T + 0.0020754 * T * T + T ** 3 / 467441);
}
// STAGE 2 (2026-11, approved by owner): planets now come from Astronomy Engine
// (MIT licence, VSOP87-based, accurate to about an arcsecond in this era) instead of
// the Standish low-precision Keplerian elements used in stage 1. Positions are
// geocentric, apparent (light-time + aberration), on the true ecliptic of date;
// Lahiri ayanamsa, Sun, Moon, node and Ascendant conventions are unchanged.
const AE_BODY = { Mercury: Body.Mercury, Venus: Body.Venus, Mars: Body.Mars, Jupiter: Body.Jupiter, Saturn: Body.Saturn };
const jdToJsDate = (jd) => new Date((jd - 2440587.5) * 86400000);
function planetTrop(name, jd) {
  const t = MakeTime(jdToJsDate(jd));
  return norm360(Ecliptic(GeoVector(AE_BODY[name], t, true)).elon);
}
function gmst(jd) {
  const T = Tcent(jd);
  return norm360(280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T ** 3 / 38710000);
}
function ascendantTrop(jd, lat, lon) {
  const ramc = norm360(gmst(jd) + lon), eps = obliquity(Tcent(jd));
  return norm360(Math.atan2(cosd(ramc), -(sind(ramc) * cosd(eps) + tand(lat) * sind(eps))) * R2D);
}


const SIGNS = ["Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces"];
const RASHI = ["Meṣa", "Vṛṣabha", "Mithuna", "Karka", "Siṃha", "Kanyā", "Tulā", "Vṛścika", "Dhanu", "Makara", "Kumbha", "Mīna"];
const NAK = ["Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra", "Punarvasu", "Pushya", "Ashlesha", "Magha", "Purva Phalguni", "Uttara Phalguni", "Hasta", "Chitra", "Swati", "Vishakha", "Anuradha", "Jyeshtha", "Mula", "Purva Ashadha", "Uttara Ashadha", "Shravana", "Dhanishta", "Shatabhisha", "Purva Bhadrapada", "Uttara Bhadrapada", "Revati"];
const signIdx = (L) => Math.floor(norm360(L) / 30);
const degInSign = (L) => norm360(L) % 30;
function nakInfo(L) {
  const span = 360 / 27, i = Math.floor(norm360(L) / span);
  const pada = Math.floor((norm360(L) % span) / (span / 4)) + 1;
  return { name: NAK[i], idx: i, pada };
}
// D9 Navamsa: 108 parts of 3°20'; continuous count from Aries equals Parashari rule.
function navamsaSign(L) { return Math.floor(norm360(L) / (30 / 9)) % 12; }
// D10 Dashamsha: odd sign counts from itself, even sign from the 9th.
function dashamshaSign(L) {
  const s = signIdx(L), part = Math.floor((norm360(L) % 30) / 3);
  const start = (s % 2 === 0) ? s : (s + 8);
  return (start + part) % 12;
}

/* ---- Vimshottari Dasha (365.25-day year) ---- */
const ORDER = ["Ketu", "Venus", "Sun", "Moon", "Mars", "Rahu", "Jupiter", "Saturn", "Mercury"];
const YEARS = { Ketu: 7, Venus: 20, Sun: 6, Moon: 10, Mars: 7, Rahu: 18, Jupiter: 16, Saturn: 19, Mercury: 17 };
const YR = 365.25;
function vimshottari(moonSid, birthJD, nowJD) {
  const span = 360 / 27, pos = norm360(moonSid) % span, frac = pos / span;
  const nakIdx = Math.floor(norm360(moonSid) / span), lord = ORDER[nakIdx % 9];
  const virtualStart = birthJD - frac * YEARS[lord] * YR;
  // Mahadasha
  let t = virtualStart, mi = ORDER.indexOf(lord), md = null;
  for (let k = 0; k < 25; k++) { const L = ORDER[(mi + k) % 9], dur = YEARS[L] * YR; if (nowJD >= t && nowJD < t + dur) { md = { lord: L, start: t, end: t + dur }; break; } t += dur; }
  // Antardasha
  let ta = md.start, ad = null, ai = ORDER.indexOf(md.lord);
  for (let k = 0; k < 9; k++) { const L = ORDER[(ai + k) % 9], dur = (YEARS[md.lord] * YEARS[L] / 120) * YR; if (nowJD >= ta && nowJD < ta + dur) { ad = { lord: L, start: ta, end: ta + dur }; break; } ta += dur; }
  // Pratyantardasha
  let tp = ad.start, pd = null, pi = ORDER.indexOf(ad.lord), adDur = ad.end - ad.start;
  for (let k = 0; k < 9; k++) { const L = ORDER[(pi + k) % 9], dur = adDur * YEARS[L] / 120; if (nowJD >= tp && nowJD < tp + dur) { pd = { lord: L, start: tp, end: tp + dur }; break; } tp += dur; }
  // upcoming MD list
  const seq = []; let tt = md.start, ii = ORDER.indexOf(md.lord);
  for (let k = 0; k < 5; k++) { const L = ORDER[(ii + k) % 9], dur = YEARS[L] * YR; seq.push({ lord: L, start: tt, end: tt + dur }); tt += dur; }
  return { md, ad, pd, balanceLord: lord, seq };
}


export function computeChartCore(bd, now = new Date()) {
  if (!bd.dob || !bd.tob || bd.lat === "" || bd.lon === "" || bd.lat == null || bd.lon == null) {
    throw new Error("Need date, time, and a place with coordinates.");
  }
  const [Y, M, D] = String(bd.dob).split("-").map(Number);
  const [hh, mm] = String(bd.tob).split(":").map(Number);
  const tzn = parseFloat(bd.tz) || 0, la = parseFloat(bd.lat), lo = parseFloat(bd.lon);
  const hourUT = hh + mm / 60 - tzn;
  const jd = julianDay(Y, M, D, hourUT);
  const ay = lahiri(jd);
  const sid = (L) => norm360(L - ay);
  const bodies = {
    Sun: sid(sunTrop(jd)), Moon: sid(moonTrop(jd)), Mars: sid(planetTrop("Mars", jd)),
    Mercury: sid(planetTrop("Mercury", jd)), Jupiter: sid(planetTrop("Jupiter", jd)),
    Venus: sid(planetTrop("Venus", jd)), Saturn: sid(planetTrop("Saturn", jd)),
    Rahu: sid(rahuTrop(jd)),
  };
  bodies.Ketu = norm360(bodies.Rahu + 180);
  const asc = sid(ascendantTrop(jd, la, lo));
  const lagnaSign = signIdx(asc);
  const avSigns = {
    Sun: signIdx(bodies.Sun), Moon: signIdx(bodies.Moon), Mars: signIdx(bodies.Mars),
    Mercury: signIdx(bodies.Mercury), Jupiter: signIdx(bodies.Jupiter),
    Venus: signIdx(bodies.Venus), Saturn: signIdx(bodies.Saturn), Lagna: lagnaSign,
  };
  const avBav = bhinnashtakavarga(avSigns);
  const avSav = sarvashtakavarga(avBav);
  const nowJD = julianDay(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCHours() + now.getUTCMinutes() / 60);
  const dasha = vimshottari(bodies.Moon, jd, nowJD);
  const evidence = synthesizeEvidence({
    bodies, ascLong: asc, lagnaSignIdx: lagnaSign,
    dasha, sav: avSav, jd, tob: bd.tob,
  });
  const moonNak = nakInfo(bodies.Moon);
  const placements = Object.entries(bodies).map(([p, L]) => {
    const house = ((signIdx(L) - lagnaSign + 12) % 12) + 1;
    return {
      p, sign: SIGNS[signIdx(L)], deg: degInSign(L).toFixed(1), house,
      nav: SIGNS[navamsaSign(L)], das: SIGNS[dashamshaSign(L)],
      vargottama: signIdx(L) === navamsaSign(L),
    };
  });
  return {
    name: bd.name, dob: bd.dob, tob: bd.tob, place: bd.place, lat: la, lon: lo, tz: tzn, jd, ay, moonSidLong: bodies.Moon, bodies,
    lagna: { sign: SIGNS[lagnaSign], rashi: RASHI[lagnaSign], deg: degInSign(asc).toFixed(1), nav: SIGNS[navamsaSign(asc)], das: SIGNS[dashamshaSign(asc)] },
    moon: { sign: SIGNS[signIdx(bodies.Moon)], deg: degInSign(bodies.Moon).toFixed(1), nak: moonNak },
    sun: { sign: SIGNS[signIdx(bodies.Sun)] },
    dasha, placements, lagnaSignIdx: lagnaSign,
    ashtakavarga: { bav: avBav, sav: avSav, signs: avSigns },
    evidence,
  };
}

export const ENGINE_VERSION = "2026.11-r2 (Meeus Sun/Moon, Astronomy Engine 2.1.19 planets, mean node, linear Lahiri)";
export {
  D2R, norm360, julianDay, jdToDate, Tcent, lahiri, sunTrop, moonTrop, rahuTrop, planetTrop, gmst, ascendantTrop,
  SIGNS, RASHI, NAK, signIdx, degInSign, nakInfo, navamsaSign, dashamshaSign, ORDER, YEARS, YR, vimshottari,
};
