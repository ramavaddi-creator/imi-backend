// src/lib/muhurta.js
// Muhūrta (electional) engine: scores days in a range for a stated purpose.
//
// ====================  WIRE YOUR ENGINE HERE  ====================
// Provide ONE adapter object built from your existing sidereal engine:
//   engine.sunMoonSidereal(date)  -> { sun: <0..360 sidereal deg>, moon: <0..360 sidereal deg> }
//   engine.lagnaSidereal(date, lat, lng) -> <0..360 sidereal deg of ascendant>
// Everything else (panchanga, sunrise, doshas, bala, scoring) is self-contained.
// =================================================================

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

// ---- Panchanga from Sun & Moon sidereal longitude ---------------------------
const NAK_NAMES = ["Ashwini","Bharani","Krittika","Rohini","Mrigashira","Ardra","Punarvasu","Pushya",
"Ashlesha","Magha","P.Phalguni","U.Phalguni","Hasta","Chitra","Swati","Vishakha","Anuradha","Jyeshtha",
"Mula","P.Ashadha","U.Ashadha","Shravana","Dhanishta","Shatabhisha","P.Bhadrapada","U.Bhadrapada","Revati"];
const YOGA_NAMES = ["Vishkambha","Priti","Ayushman","Saubhagya","Shobhana","Atiganda","Sukarma","Dhriti",
"Shula","Ganda","Vriddhi","Dhruva","Vyaghata","Harshana","Vajra","Siddhi","Vyatipata","Variyana","Parigha",
"Shiva","Siddha","Sadhya","Shubha","Shukla","Brahma","Indra","Vaidhriti"];
const BAD_YOGAS = new Set(["Vishkambha","Atiganda","Shula","Ganda","Vyaghata","Vajra","Vyatipata","Parigha","Vaidhriti"]);

function panchanga(sun, moon, dayOfWeek) {
  const elong = ((moon - sun) % 360 + 360) % 360;
  const tithi = Math.floor(elong / 12) + 1;               // 1..30
  const nak = Math.floor(((moon % 360) + 360) % 360 / (360 / 27)) + 1; // 1..27
  const yogaIdx = Math.floor((((sun + moon) % 360) + 360) % 360 / (360 / 27));
  // TODO: wire Bhadrā/Viṣṭi-karaṇa detection from your karaṇa table (avoid for starts).
  return {
    tithi,
    nakshatra: nak, nakshatraName: NAK_NAMES[nak - 1],
    yoga: YOGA_NAMES[yogaIdx], yogaBad: BAD_YOGAS.has(YOGA_NAMES[yogaIdx]),
    rikta: [4, 9, 14, 19, 24, 29].includes(tithi),        // Rikta tithis
    amavasya: tithi === 30, purnima: tithi === 15,
    vara: dayOfWeek, // 0=Sun..6=Sat
  };
}

// ---- Sunrise / sunset (NOAA, low-precision) for Rahu Kala etc. --------------
function sunRiseSet(date, lat, lng) {
  const rad = D2R;
  const dayMs = 86400000;
  const jdayN = Math.floor((date.getTime() / dayMs) + 2440587.5 - 0.5) + 0.5;
  function calc(isSunrise) {
    const n = jdayN - 2451545.0 + 0.0008;
    const Jstar = n - lng / 360;
    let M = (357.5291 + 0.98560028 * Jstar) % 360;
    const C = 1.9148*Math.sin(M*rad) + 0.0200*Math.sin(2*M*rad) + 0.0003*Math.sin(3*M*rad);
    const lam = (M + C + 180 + 102.9372) % 360;
    const Jtransit = 2451545.0 + Jstar + 0.0053*Math.sin(M*rad) - 0.0069*Math.sin(2*lam*rad);
    const delta = Math.asin(Math.sin(lam*rad) * Math.sin(23.44*rad)) * R2D;
    const cosH = (Math.sin(-0.833*rad) - Math.sin(lat*rad)*Math.sin(delta*rad)) /
                 (Math.cos(lat*rad)*Math.cos(delta*rad));
    if (cosH > 1 || cosH < -1) return null; // polar day/night
    const H = Math.acos(cosH) * R2D;
    const J = Jtransit + (isSunrise ? -H : H) / 360;
    return (J - 2440587.5) * dayMs;
  }
  const rise = calc(true), set = calc(false);
  return { rise: rise && new Date(rise), set: set && new Date(set) };
}

// Rahu Kala / Yamaganda / Gulika: split day (rise->set) into 8 parts by weekday sequence.
const RAHU_SEQ = [8, 2, 7, 5, 6, 4, 3];     // index per weekday (Sun..Sat), 1..8 part
const YAMA_SEQ = [5, 4, 3, 2, 1, 7, 6];
const GULI_SEQ = [7, 6, 5, 4, 3, 2, 1];
function doshaKalas(rise, set, weekday) {
  if (!rise || !set) return null;
  const part = (set - rise) / 8;
  const slot = (seq) => {
    const i = seq[weekday] - 1;
    return { start: new Date(rise.getTime() + i * part), end: new Date(rise.getTime() + (i + 1) * part) };
  };
  return { rahu: slot(RAHU_SEQ), yama: slot(YAMA_SEQ), gulika: slot(GULI_SEQ) };
}
function inWindow(t, w) { return w && t >= w.start && t < w.end; }

// ---- Tara & Chandra bala relative to the person -----------------------------
function taraBala(janmaNak, dayNak) {
  const count = ((dayNak - janmaNak + 27) % 27) + 1;
  const tara = ((count - 1) % 9) + 1;
  return { tara, bad: [3, 5, 7].includes(tara) }; // Vipat, Pratyari, Vadha
}
function chandraBala(janmaRashi, dayMoonRashi) {
  const house = ((dayMoonRashi - janmaRashi + 12) % 12) + 1;
  return { house, bad: [4, 8, 12].includes(house) };
}

// ---- Activity rules (STARTER table — VERIFY against your texts) -------------
// Favourable nakshatras per purpose. Empty = no nakshatra restriction.
export const ACTIVITY_RULES = {
  job_start:      { favNak: [3,4,7,8,12,13,17,21,22,26,27], favVara: [1,3,4,5], label: "Start a new job" },
  business_open:  { favNak: [3,4,12,13,16,21,22,26,27],     favVara: [3,4,5],   label: "Open / launch a business" },
  contract_sign:  { favNak: [5,7,13,15,17,22,23],           favVara: [1,3,4,5], label: "Sign a contract / deal" },
  travel:         { favNak: [1,6,7,15,16,22,23,24],         favVara: [1,3,4,5], label: "Travel / journey" },
  griha_pravesh:  { favNak: [4,12,13,17,21,22,26,27],       favVara: [1,4,5],   label: "Housewarming" },
  vehicle:        { favNak: [4,7,13,15,16,22,23,24],        favVara: [1,4,5],   label: "Buy a vehicle" },
  education:      { favNak: [5,7,13,17,22,23,26],           favVara: [3,4,5],   label: "Begin education" },
};

// ---- Main scan --------------------------------------------------------------
export function findMuhurta(engine, {
  purpose, startDate, endDate, lat, lng,
  janmaNak, janmaRashi,                 // the person's birth Moon nakshatra & rasi
  dayStartHour = 6, dayEndHour = 18, stepMinutes = 30, topN = 5,
}) {
  const rule = ACTIVITY_RULES[purpose];
  if (!rule) throw new Error("Unknown purpose: " + purpose);

  const results = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dayNoon = new Date(d); dayNoon.setHours(12, 0, 0, 0);
    const { sun, moon } = engine.sunMoonSidereal(dayNoon);
    const weekday = dayNoon.getDay();
    const pa = panchanga(sun, moon, weekday);
    const dayMoonRashi = Math.floor(((moon % 360) + 360) % 360 / 30) + 1;
    const tb = taraBala(janmaNak, pa.nakshatra);
    const cb = chandraBala(janmaRashi, dayMoonRashi);

    // hard rejects
    const hardReject = pa.amavasya || pa.rikta || pa.yogaBad || tb.bad || cb.bad
      || (rule.favNak.length && !rule.favNak.includes(pa.nakshatra));
    if (hardReject) continue;

    // find a clean time window outside Rahu/Yama/Gulika
    const { rise, set } = sunRiseSet(dayNoon, lat, lng);
    const dk = doshaKalas(rise, set, weekday);
    let window = null;
    for (let h = dayStartHour * 60; h <= dayEndHour * 60; h += stepMinutes) {
      const t = new Date(d); t.setHours(0, h, 0, 0);
      if (inWindow(t, dk?.rahu) || inWindow(t, dk?.yama) || inWindow(t, dk?.gulika)) continue;
      const lagna = engine.lagnaSidereal(t, lat, lng);
      const lagnaSign = Math.floor(((lagna % 360) + 360) % 360 / 30) + 1;
      // prefer fixed/dual lagnas for stability (2,5,8,11 fixed; 3,6,9,12 dual)
      const lagnaBonus = [2,5,8,11].includes(lagnaSign) ? 2 : [3,6,9,12].includes(lagnaSign) ? 1 : 0;
      window = { start: t, lagnaSign, lagnaBonus };
      break;
    }
    if (!window) continue;

    let score = 6;
    if (rule.favVara.includes(weekday)) score += 2;
    score += window.lagnaBonus;
    if (pa.purnima) score += 1;
    score = Math.min(score, 12);

    results.push({
      date: new Date(d), score, window: window.start,
      nakshatra: pa.nakshatraName, tithi: pa.tithi, yoga: pa.yoga,
      vara: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][weekday],
      lagnaSign: window.lagnaSign,
      rahuKala: dk?.rahu ? `${fmt(dk.rahu.start)}–${fmt(dk.rahu.end)}` : null,
      reasons: [
        `${pa.nakshatraName} nakshatra (favourable for ${rule.label})`,
        rule.favVara.includes(weekday) ? "Favourable weekday" : null,
        `Tārā ${tb.tara}, Chandra house ${cb.house} — both clear`,
      ].filter(Boolean),
    });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, topN);
}

function fmt(d) { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
