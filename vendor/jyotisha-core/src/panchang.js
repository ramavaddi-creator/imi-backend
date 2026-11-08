// jyotisha-core: daily Panchangam for a place, built on the shared engine.
// ASTRONOMICAL CALCULATION ONLY. It states where the Sun and Moon are and the traditional
// day-divisions that follow from them; it makes no claim about effects (that is interpretation).
//
// Conventions (stated in every result's provenance):
// - Elements (tithi, nakshatra, yoga, karana, vara) are taken at local sunrise.
// - Sidereal longitudes from engine.js (Meeus Sun/Moon, linear Lahiri ayanamsha).
// - Sunrise/sunset/moonrise/moonset from astronomy-engine SearchRiseSet (upper limb, standard refraction).
// - Times are converted with the IANA time zone of the place (daylight saving handled by Intl).

import { Body, Observer, SearchRiseSet, MakeTime } from "astronomy-engine";
import { julianDay, lahiri, sunTrop, moonTrop, norm360, ENGINE_VERSION } from "./lib/engine.js";

export const CORE_VERSION = "2026.11.0";

const NAK = ["Ashwini","Bharani","Krittika","Rohini","Mrigashira","Ardra","Punarvasu","Pushya","Ashlesha","Magha","Purva Phalguni","Uttara Phalguni",
  "Hasta","Chitra","Swati","Vishakha","Anuradha","Jyeshtha","Mula","Purva Ashadha","Uttara Ashadha","Shravana","Dhanishta","Shatabhisha","Purva Bhadrapada","Uttara Bhadrapada","Revati"];
const YOGA = ["Vishkambha","Priti","Ayushman","Saubhagya","Shobhana","Atiganda","Sukarma","Dhriti","Shula","Ganda","Vriddhi","Dhruva","Vyaghata","Harshana",
  "Vajra","Siddhi","Vyatipata","Variyana","Parigha","Shiva","Siddha","Sadhya","Shubha","Shukla","Brahma","Indra","Vaidhriti"];
const TITHI = ["Pratipada","Dwitiya","Tritiya","Chaturthi","Panchami","Shashthi","Saptami","Ashtami","Navami","Dashami","Ekadashi","Dwadashi","Trayodashi","Chaturdashi"];
const VARA = ["Ravivara (Sunday)","Somavara (Monday)","Mangalavara (Tuesday)","Budhavara (Wednesday)","Guruvara (Thursday)","Shukravara (Friday)","Shanivara (Saturday)"];
const MOVING_KARANA = ["Bava","Balava","Kaulava","Taitila","Gara","Vanija","Vishti"];
// Same tables as muhurta.js (day split into 8 parts, part index per weekday Sun..Sat).
const RAHU_SEQ = [8, 2, 7, 5, 6, 4, 3], YAMA_SEQ = [5, 4, 3, 2, 1, 7, 6], GULI_SEQ = [7, 6, 5, 4, 3, 2, 1];

// ---------------------------------------------------------------- time zones (IANA)
export function tzOffsetMinutes(tz, date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(date).filter((x) => x.type !== "literal").map((x) => [x.type, Number(x.value)]));
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}
// The instant of local midnight at the start of `dateStr` (YYYY-MM-DD) in `tz`.
export function localMidnight(dateStr, tz) {
  const [Y, M, D] = dateStr.split("-").map(Number);
  let t = Date.UTC(Y, M - 1, D);
  for (let i = 0; i < 3; i++) t = Date.UTC(Y, M - 1, D) - tzOffsetMinutes(tz, new Date(t)) * 60000;
  return new Date(t);
}
export const localTime = (date, tz) => (date ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date) : null);
const localWeekday = (date, tz) => ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date));

// ---------------------------------------------------------------- elements
export function siderealSunMoon(date) {
  const h = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const jd = julianDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), h);
  const ay = lahiri(jd);
  return { sun: norm360(sunTrop(jd) - ay), moon: norm360(moonTrop(jd) - ay), jd };
}
export function karanaName(k) {           // k = 0..59 (half-tithis since new moon)
  if (k === 0) return "Kimstughna";
  if (k === 57) return "Shakuni";
  if (k === 58) return "Chatushpada";
  if (k === 59) return "Naga";
  return MOVING_KARANA[(k - 1) % 7];
}
export function elements(sun, moon) {
  const elong = norm360(moon - sun);
  const tithi = Math.floor(elong / 12) + 1;                       // 1..30
  const paksha = tithi <= 15 ? "Shukla" : "Krishna";
  const tName = tithi === 15 ? "Purnima" : tithi === 30 ? "Amavasya" : TITHI[(tithi - 1) % 15];
  const nakSpan = 360 / 27;
  const nIdx = Math.floor(moon / nakSpan);
  const pada = Math.floor((moon % nakSpan) / (nakSpan / 4)) + 1;
  const yIdx = Math.floor(norm360(sun + moon) / nakSpan);
  const k = Math.floor(elong / 6);
  return { tithi, tithiName: `${paksha} ${tName}`, paksha, nakshatra: NAK[nIdx], nakshatraNumber: nIdx + 1, pada, yoga: YOGA[yIdx], karana: karanaName(k), elongation: elong };
}

function riseSet(body, obs, start, dir) {
  const t = SearchRiseSet(body, obs, dir, MakeTime(start), 1.0);
  return t ? t.date : null;
}

// ---------------------------------------------------------------- the daily Panchangam
export function dailyPanchang({ date, lat, lng, tz, place }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  const obs = new Observer(lat, lng, 0);
  const midnight = localMidnight(date, tz);
  const sunrise = riseSet(Body.Sun, obs, midnight, +1), sunset = riseSet(Body.Sun, obs, midnight, -1);
  const moonrise = riseSet(Body.Moon, obs, midnight, +1), moonset = riseSet(Body.Moon, obs, midnight, -1);
  const anchor = sunrise ?? midnight;                               // polar edge case: no sunrise
  const { sun, moon } = siderealSunMoon(anchor);
  const el = elements(sun, moon);
  const weekday = localWeekday(anchor, tz);
  const slot = (seq) => {
    if (!sunrise || !sunset) return null;
    const part = (sunset - sunrise) / 8, i = seq[weekday] - 1;
    return { start: localTime(new Date(sunrise.getTime() + i * part), tz), end: localTime(new Date(sunrise.getTime() + (i + 1) * part), tz) };
  };
  const abhijit = sunrise && sunset ? (() => { const m = (sunset - sunrise) / 15; return { start: localTime(new Date(sunrise.getTime() + 7 * m), tz), end: localTime(new Date(sunrise.getTime() + 8 * m), tz) }; })() : null;
  return {
    kind: "calculation",
    date, place, vara: VARA[weekday],
    ...el,
    sunrise: localTime(sunrise, tz), sunset: localTime(sunset, tz), moonrise: localTime(moonrise, tz), moonset: localTime(moonset, tz),
    rahuKalam: slot(RAHU_SEQ), yamagandam: slot(YAMA_SEQ), gulika: slot(GULI_SEQ), abhijit,
    provenance: {
      coreVersion: CORE_VERSION, engine: ENGINE_VERSION,
      ayanamsha: "Lahiri (linear approximation)", node: "mean",
      riseSet: "astronomy-engine SearchRiseSet (upper limb, standard refraction)",
      convention: "Elements at local sunrise; times in the place's IANA time zone",
      location: { place, lat, lng, tz }, sunriseUtc: sunrise ? sunrise.toISOString() : null,
      note: "Astronomical calculation. Traditional interpretations are separate and are not claims of effect.",
    },
  };
}
