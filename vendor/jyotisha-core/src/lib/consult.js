// consult.js — Antardṛṣṭi consultation core (pure; runs on the SERVER inside netlify/functions/ai.mjs).
// Reliability Upgrade 2026-11. Responsibilities:
//   1. buildFacts()      — canonical, engine-derived facts (R02/R03/R04): full Antardaśā tables,
//                          age, elapsed time, Saturn returns from actual transits. The AI never computes these.
//   2. classifyIntent()  — adaptive answer length (R11) and context-appropriate feedback (R15).
//   3. buildSystemPrompt — the ONLY place the consultation prompt is written. The browser can no longer
//                          send a system prompt (closes the open-proxy defect S-01).
//   4. validateAnswer()  — deterministic checks of daśā sequence/date, age, elapsed-year and
//                          Saturn-return claims against the facts (R05). Not an AI checking an AI.
import {
  julianDay, jdToDate, lahiri, planetTrop, norm360, SIGNS, ORDER, YEARS, YR, ENGINE_VERSION,
} from "./engine.js";

const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtJD = (jd) => { const d = jdToDate(jd); return `${d.d} ${MONTHS[d.m]} ${d.y}`; };
const yearOf = (jd) => jdToDate(jd).y;
const jdNow = (now) => julianDay(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate(),
  now.getUTCHours() + now.getUTCMinutes() / 60);
const PLANETS = ["Sun", "Moon", "Mars", "Mercury", "Jupiter", "Venus", "Saturn", "Rahu", "Ketu"];
const DEBIL_SIGN = { Sun: 6, Moon: 7, Mars: 3, Mercury: 11, Jupiter: 9, Venus: 5, Saturn: 0 };
export const HOUSE_AREAS = { 1: "self, body", 2: "wealth, family, speech", 3: "courage, siblings", 4: "home, mother, property", 5: "children, creativity, intellect", 6: "service, debts, competition, illness", 7: "spouse, partnership", 8: "upheaval, the hidden, longevity", 9: "fortune, father, dharma, higher learning", 10: "career, status", 11: "gains, income, networks", 12: "loss, expense, foreign lands, liberation" };
// Sign rulership (Parāśari, seven classical planets; Rāhu/Ketu own no sign here).
const SIGN_LORD = ["Mars", "Venus", "Mercury", "Moon", "Sun", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Saturn", "Jupiter"];
export function houseLordship(lagnaIdx) {
  const houses = Array.from({ length: 12 }, (_, h) => ({ house: h + 1, sign: SIGNS[(lagnaIdx + h) % 12], lord: SIGN_LORD[(lagnaIdx + h) % 12] }));
  const owns = {};
  for (const x of houses) (owns[x.lord] ||= []).push(x.house);
  // Yogakāraka: one planet owning both a kendra (4, 7, 10) and a trikona (5, 9).
  const yogakaraka = Object.keys(owns).filter((p) => owns[p].some((h) => [4, 7, 10].includes(h)) && owns[p].some((h) => [5, 9].includes(h)));
  return { houses, owns, lagnaLord: houses[0].lord, yogakaraka };
}

/* ------------------------------------------------------------------ facts */
function subPeriods(lord, start, end) {
  const out = []; let t = start; const i = ORDER.indexOf(lord), dur = end - start;
  for (let k = 0; k < 9; k++) {
    const L = ORDER[(i + k) % 9], d = dur * YEARS[L] / 120;
    out.push({ lord: L, start: t, end: t + d }); t += d;
  }
  return out;
}
function mahadashas(moonSid, birthJD) {
  const span = 360 / 27, frac = (norm360(moonSid) % span) / span;
  const first = ORDER[Math.floor(norm360(moonSid) / span) % 9];
  let t = birthJD - frac * YEARS[first] * YR; const i = ORDER.indexOf(first), out = [];
  for (let k = 0; k < 10; k++) { const L = ORDER[(i + k) % 9], d = YEARS[L] * YR; out.push({ lord: L, start: t, end: t + d }); t += d; }
  return { mds: out, balanceFraction: 1 - frac, firstLord: first };
}
function ageAt(dob, now) {
  const [Y, M, D] = String(dob).split("-").map(Number);
  let a = now.getUTCFullYear() - Y;
  if (now.getUTCMonth() + 1 < M || (now.getUTCMonth() + 1 === M && now.getUTCDate() < D)) a -= 1;
  return a;
}
const yrsBetween = (a, b) => (b - a) / YR;

// Saturn returns from the engine's own transit positions, including retrograde multiple contacts.
export function saturnReturns(natalSatSid, birthJD, horizonYears = 95) {
  const sid = (jd) => norm360(planetTrop("Saturn", jd) - lahiri(jd));
  const diff = (jd) => ((sid(jd) - natalSatSid + 540) % 360) - 180;
  const contacts = []; let prevJD = birthJD + 3650, prev = diff(prevJD);
  for (let jd = prevJD + 5; jd < birthJD + horizonYears * YR; jd += 5) {
    const cur = diff(jd);
    if (Math.sign(cur) !== Math.sign(prev) && Math.abs(cur - prev) < 10) {
      let a = jd - 5, b = jd; // bisect to ~1 hour
      for (let k = 0; k < 20; k++) { const m = (a + b) / 2; if (Math.sign(diff(m)) === Math.sign(diff(a))) a = m; else b = m; }
      contacts.push((a + b) / 2);
    }
    prevJD = jd; prev = cur;
  }
  const returns = [];
  for (const c of contacts) {
    const last = returns[returns.length - 1];
    if (last && c - last.contacts[last.contacts.length - 1] < 2 * YR) last.contacts.push(c);
    else returns.push({ contacts: [c] });
  }
  return returns.map((r, i) => ({ n: i + 1, first: r.contacts[0], last: r.contacts[r.contacts.length - 1], contacts: r.contacts }));
}

export function buildFacts(chart, now = new Date()) {
  const nowJD = jdNow(now);
  const birthJD = chart.jd;
  const { mds, balanceFraction, firstLord } = mahadashas(chart.moonSidLong, birthJD);
  const mdIdx = mds.findIndex((m) => nowJD >= m.start && nowJD < m.end);
  const md = mds[mdIdx], nextMD = mds[mdIdx + 1];
  const ads = subPeriods(md.lord, md.start, md.end);
  const nextAds = nextMD ? subPeriods(nextMD.lord, nextMD.start, nextMD.end) : [];
  const ad = ads.find((x) => nowJD >= x.start && nowJD < x.end);
  const adIdx = ads.indexOf(ad);
  const nextAD = ads[adIdx + 1] || nextAds[0];
  const pds = subPeriods(ad.lord, ad.start, ad.end);
  const pd = pds.find((x) => nowJD >= x.start && nowJD < x.end);
  const satNatal = chart.bodies ? chart.bodies.Saturn : null;
  const returns = satNatal == null ? [] : saturnReturns(satNatal, birthJD);
  const debilitated = (chart.placements || [])
    .filter((p) => DEBIL_SIGN[p.p] != null && SIGNS.indexOf(p.sign) === DEBIL_SIGN[p.p]).map((p) => p.p);
  // Every Antardaśā in the lifetime horizon — the validator's ground truth.
  const allAds = mds.flatMap((m) => subPeriods(m.lord, m.start, m.end).map((x) => ({ md: m.lord, ...x })))
    .filter((x) => x.end > birthJD);
  return {
    engineVersion: ENGINE_VERSION,
    method: { zodiac: "sidereal", ayanamsa: "Lahiri (linear approximation)", houses: "whole-sign", dashaYearDays: YR, nodeModel: "mean node" },
    nowJD, birthJD, today: fmtJD(nowJD),
    age: chart.dob ? ageAt(chart.dob, now) : null,
    birthBalance: { lord: firstLord, remainingYears: +(balanceFraction * YEARS[firstLord]).toFixed(2) },
    mds, md, nextMD, ads, nextAds, ad, nextAD, pds, pd, allAds,
    mdElapsedYears: +yrsBetween(md.start, nowJD).toFixed(1),
    mdRemainingYears: +yrsBetween(nowJD, md.end).toFixed(1),
    saturnReturns: returns, debilitated,
    lordship: houseLordship(chart.lagnaSignIdx),
  };
}

export function factsBlock(f) {
  const row = (x, cur) => `  ${x.lord.padEnd(8)} ${fmtJD(x.start)} → ${fmtJD(x.end)}${cur ? "   ← NOW" : ""}`;
  const sr = f.saturnReturns.length
    ? f.saturnReturns.slice(0, 3).map((r) => `  Saturn return ${r.n}: exact ${r.contacts.length > 1 ? `${r.contacts.length} times (retrograde), ` : ""}${fmtJD(r.first)}${r.contacts.length > 1 ? ` … ${fmtJD(r.last)}` : ""} — ${r.last < f.nowJD ? "COMPLETED" : r.first > f.nowJD ? "AHEAD" : "IN PROGRESS"}`).join("\n")
    : "  not available";
  return `CALCULATED FACTS — AUTHORITATIVE (engine ${f.engineVersion}).
Every date, age, elapsed time, period name and period order you state MUST come from this block. If something is not here, say it is not available — never estimate it.
Today: ${f.today}. Current age: ${f.age ?? "not available"}.
Method: sidereal, Lahiri ayanāṃśa, whole-sign houses, Vimśottarī with ${f.method.dashaYearDays}-day years, mean lunar node.
Birth daśā balance: ${f.birthBalance.lord}, ${f.birthBalance.remainingYears} years remaining at birth.
Current Mahādaśā: ${f.md.lord} ${fmtJD(f.md.start)} → ${fmtJD(f.md.end)} (${f.mdElapsedYears} years elapsed, ${f.mdRemainingYears} remaining).
Next Mahādaśā: ${f.nextMD ? `${f.nextMD.lord} ${fmtJD(f.nextMD.start)} → ${fmtJD(f.nextMD.end)}` : "not available"}.
ALL Antardaśās of the current ${f.md.lord} Mahādaśā, in order:
${f.ads.map((x) => row(x, x === f.ad)).join("\n")}
The Antardaśā AFTER ${f.md.lord}–${f.ad.lord} is ${f.nextAD ? `${f.nextAD === f.nextAds[0] ? f.nextMD.lord : f.md.lord}–${f.nextAD.lord}, from ${fmtJD(f.nextAD.start)}` : "not available"}.
${f.nextMD ? `Antardaśās of the next (${f.nextMD.lord}) Mahādaśā:\n${f.nextAds.map((x) => row(x, false)).join("\n")}` : ""}
Pratyantardaśās of ${f.md.lord}–${f.ad.lord}:
${f.pds.map((x) => row(x, x === f.pd)).join("\n")}
Saturn returns (from computed transits of Saturn over its natal sidereal longitude):
${sr}
House lords (whole-sign from lagna): ${f.lordship.houses.map((x) => `H${x.house} ${x.sign}–${x.lord}`).join(", ")}.
Each planet rules: ${Object.entries(f.lordship.owns).map(([p, hs]) => `${p} ${hs.join(" & ")} (${hs.map((h) => HOUSE_AREAS[h]).join(" | ")})`).join("; ")}. Lagna lord: ${f.lordship.lagnaLord}. Yogakāraka: ${f.lordship.yogakaraka.join(", ") || "none"}. Rāhu and Ketu rule no house here.
Never confuse the house a planet OCCUPIES with the houses it RULES — use this table for every lordship statement, including plain-language ones ("Saturn governs your career and fortune").
Debilitated by sign: ${f.debilitated.length ? f.debilitated.join(", ") + " — cancellation (Neecha Bhanga) conditions are NOT yet evaluated by this engine; do not call the planet simply weak or strong on this basis." : "none"}`;
}

/* ------------------------------------------------------------------ intent */
export function classifyIntent(text, task) {
  if (task === "report") return "report";
  if (task === "opening") return "interpretation";
  const t = String(text || "").toLowerCase();
  if (/\b(privacy|private|data|delete|store|stored|log|logs|cookie|bug|error|app|website|account|refund|how does (this|the) (app|tool|site)|who (made|built)|security|research mode|classical detail|settings?|toggle|menu|button|feature|download|backup|voice)\b/.test(t)
      && !/\b(dasha|daśā|antar|mahadasha|planet|house|lagna|chart)\b/.test(t)) return "meta";
  if (/\bpart\s*\d+\s*(of|\/)\s*\d+\b/.test(t)) return "multipart";
  if (/\b(when (does|did|will)|what (is|are) my|which (dasha|period|antar)|start|begin|end|follows?|after|before|next (dasha|antar|period)|dates?|how (old|long|many years)|longitude|degree|nakshatra|bindu|score|age)\b/.test(t)
      && t.length < 220) return "calculation";
  if ((t.match(/\?/g) || []).length >= 3 || /(^|\n)\s*\d+[.)]\s/.test(t)) return "detailed";
  return "interpretation";
}
const LENGTH_RULE = {
  calculation: "This is a CALCULATION question. Answer in 1–3 sentences straight from CALCULATED FACTS, with the date(s). No interpretation unless asked. No follow-up question.",
  interpretation: "Standard interpretation: about 80–150 words. Give the answer first, then ONE short reason naming the chart factors used, then any essential limitation. No headings, no repeated summary.",
  detailed: "Several questions or an in-depth request: answer each sub-question exactly once, in order, numbered to match the user's numbering, ~200–350 words total unless more is clearly needed. Never repeat a conclusion.",
  report: "Full report on explicit request: short sections for Career, Wealth, Relationships, Health, and the most important upcoming period. Each states chart factors used and limits. No percentages.",
  meta: "This is a question about the app/software/privacy, NOT astrology. Answer as product support in 1–4 sentences. Do not read the chart.",
  multipart: "The user is sending a message in parts. If not all parts have arrived, reply only: \"Received part X of Y — send the rest and I'll answer everything together.\" Do not interpret anything yet.",
};
// UI update 2026-11: plain-language default ("Simple answer") for everyday users.
export const SIMPLE_FORMAT = `SIMPLE ANSWER FORMAT (default for everyday users). Write for an intelligent person with no astrology background, warmly and directly, in about 90–130 words, using these five short parts as plain lines (labels as shown, no other headings):
Short answer: one sentence that answers the actual question in everyday words.
Right now: the current period by name ("the Saturn–Rahu period") with its end date, and what tradition links it to, in plain life terms.
What's next: the next relevant period with its start date and what tradition links it to.
What helps: two or three practical, common-sense suggestions related to the question (never medical, legal or investment instructions).
Close with exactly: "This is a traditional reading, not a guarantee."
Use the person's life areas (money, work, marriage, home, health) instead of house numbers; no D1/D9/D10, no untranslated Sanskrit beyond period names. Tradition can be described as "more supportive" or "more demanding" for an area — never promise an outcome, never say "will", "highly favourable" or "very good chances".`;
export const APP_GUIDE = `APP GUIDE (answer questions about the app from this, as product support):
- Classical detail (More menu): switches answers to astrologer style with houses, vargas and Sanskrit; off by default (plain language). It changes wording only, not calculations.
- Explain the astrology (link under an answer): re-explains that answer in astrologer style once.
- Research mode (More menu, opt-in): adds "Download anonymized record", which saves a file to the user's own device with chart structure, current periods, events mapped to periods and feedback ratings; nothing is sent anywhere.
- More menu also has: voice input language, chart image, PDF report, daśā timeline, full backup and restore, delete chart & conversation.
- Chart summary bar (under the name): tap to show Lagna, Moon sign, Nakshatra, current periods and the Life timeline.
- Life timeline: users can add dated past events; they are shown against the periods running then, as context only.
- Privacy: the chart and conversation are stored on this device; birth date, time and coordinates go to the app's server function to calculate; the AI provider gets chart facts and the conversation, not the name or birthplace. Usage is counted anonymously.`;
export const FEEDBACK_KIND = { calculation: "calculation", interpretation: "interpretation", detailed: "interpretation", report: "interpretation", meta: "none", multipart: "none" };

/* ------------------------------------------------------------------ prompt */
export const CLASSICAL_KB = `CLASSICAL REFERENCE NOTES (condensed — Parāśari lineage; descriptive symbolism, not evidence of outcomes):
GRAHAS: Sun=soul,father,authority. Moon=mind,mother,public. Mars=energy,siblings,land,courage. Mercury=intellect,speech,commerce. Jupiter=wisdom,children,dharma,expansion. Venus=spouse,pleasure,arts. Saturn=discipline,delay,labour,structure. Rahu=ambition,foreign,obsession. Ketu=detachment,spirituality,past karma.
BHAVAS: 1 self; 2 wealth/family/speech; 3 courage/siblings; 4 home/mother/property; 5 children/intellect; 6 debt/disease/service; 7 spouse/partnership; 8 upheaval/the hidden; 9 fortune/father/dharma; 10 career/status; 11 gains/networks; 12 loss/expense/foreign/moksha.
DAŚĀ PRINCIPLE: a period tends to emphasise the houses its lord owns and occupies; well-placed kendra/trikona lords are read as supportive, 6/8/12 lords as demanding. Yogakāraka = owns both a kendra and a trikona for the lagna.
YOGAS: Gajakesari, Dhana, Vipareeta Rāja, Kemadruma — name one only after confirming its exact conditions in the chart facts. Neecha Bhanga = classical conditions that cancel debilitation; this engine does not evaluate them yet.`;

export function buildSystemPrompt({ chartText, facts, detail, intent, events, language }) {
  const ev = (events || []).length
    ? "USER-REPORTED PAST EVENTS (provided_by_user — RETROSPECTIVE ONLY):\n" + events.map((e) => `- ${e.date}: ${e.type} (running then: ${e.md}–${e.ad})`).join("\n")
      + "\nYou may discuss how these sit in the daśā sequence. NEVER say the chart predicted, confirmed or \"saw\" them, and never count them as evidence the reading is accurate."
    : "USER-REPORTED PAST EVENTS: none.";
  return `You are the interpretation layer of Antardṛṣṭi, a transparent traditional Jyotiṣa app. Calculation is done by the engine; you explain. You do not predict events.

LANGUAGE: Reply in the language and script the user last wrote in${language ? ` (UI language: ${language})` : ""}; opening message in English. Keep Sanskrit technical terms untranslated.

${factsBlock(facts)}

${chartText}

${ev}

${CLASSICAL_KB}

HARD RULES (a deterministic validator checks your answer against CALCULATED FACTS; violating answers are rejected):
1. Never compute ages, elapsed years, period dates, period order or planetary returns yourself — copy them from CALCULATED FACTS. Within any Mahādaśā the Antardaśā order is the table shown; never infer a successor from general knowledge.
2. If a needed value is not in the facts, say "not available from the engine". Never invent it.
3. No forced predictions: do not promise events, do not give money amounts or salary figures, do not compress uncertainty into a precise window. You may describe what a period traditionally emphasises.
4. Certainty — never write "High confidence" or any percentage. If certainty matters, separate: (a) calculation: from the engine; (b) traditional support: strong / mixed / limited within the Parāśari framework, naming at least one supporting and one contrary factor; (c) real-world predictive reliability: not scientifically established.
5. Debilitation, Ashtakavarga and single placements are ONE factor each. Never give a life verdict or personality profile from one factor or one bindu score.
6. Corrections: if the user says you were wrong, compare your earlier statement with CALCULATED FACTS. If it was wrong, quote it briefly and say plainly it was wrong, then give the correct fact. Never deny what appears earlier in this conversation.
7. Ask at most ONE follow-up question, and only if the answer genuinely depends on it. Never ask whether a calculation "matched your life".
8. Write plain text only: no asterisks, underscores, markdown headings or bold — the app shows them as raw symbols.
9. Privacy questions: say only what is true — birth details are used by the app's server function to compute the chart; the AI provider receives chart facts and the conversation, not the user's name or birthplace. Do not make absolute guarantees.

LENGTH AND FORM: ${!detail && (intent === "interpretation" || intent === "detailed") ? SIMPLE_FORMAT + (intent === "detailed" ? " If the user asked several questions, give one short answer per question in the same plain style, then the closing line once." : "") : LENGTH_RULE[intent] || LENGTH_RULE.interpretation}
${intent === "meta" ? APP_GUIDE : ""}
${detail
    ? "AUDIENCE: astrologer view — classical notation (H1–H12, D9/D10, dignities, daśā lords) is welcome."
    : "AUDIENCE: intelligent non-astrologer — name life areas (money, work, marriage, home) instead of house numbers; no D1/D9/H-numbers or untranslated jargon in what the user sees. You may name planets and the current period plainly."}`;
}

/* ------------------------------------------------------------------ validator */
const PL = "(Sun|Moon|Mars|Mercury|Jupiter|Venus|Saturn|Rahu|Ketu)";
const NAME = (s) => s[0].toUpperCase() + s.slice(1).toLowerCase();
const sentences = (text) => String(text).split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());

function successorsOf(f, a) {
  // allowed Antardaśā successors of `a`, given the lifetime table
  const out = new Set();
  f.allAds.forEach((x, i) => { if (x.lord === a && f.allAds[i + 1]) out.add(f.allAds[i + 1].lord); });
  return out;
}
function pairSpan(f, md, ad) {
  return f.allAds.filter((x) => x.md === md && x.lord === ad);
}

export function validateAnswer(text, f) {
  const violations = [];
  const nowY = yearOf(f.nowJD);
  for (const s of sentences(text)) {
    const plain = s.replace(/\*\*/g, "").replace(/[–—]/g, "-");
    // (1) "X follows Y", "after Y comes X", "Y is followed by X", "Y → X"
    const pats = [
      [new RegExp(`\\b${PL}\\b[^.?!]{0,40}?\\b(?:follows|comes after|succeeds)\\s+(?:the\\s+)?(?:\\w+-)?${PL}\\b`, "i"), (m) => [m[2], m[1]]],
      [new RegExp(`\\bafter\\s+(?:the\\s+)?(?:\\w+-)?${PL}\\b[^.?!]{0,30}?\\b(?:comes|is|begins|starts|follows)\\s+(?:the\\s+)?(?:\\w+-)?${PL}\\b`, "i"), (m) => [m[1], m[2]]],
      [new RegExp(`\\b(?:\\w+-)?${PL}\\b[^.?!]{0,30}?\\b(?:is followed by|gives way to|hands over to|then)\\s+(?:the\\s+)?(?:\\w+-)?${PL}\\b`, "i"), (m) => [m[1], m[2]]],
    ];
    for (const [re, pick] of pats) {
      const m = plain.match(re);
      if (!m) continue;
      const [prev, next] = pick(m).map(NAME);
      const ok = successorsOf(f, prev).has(next) || ORDER[(ORDER.indexOf(prev) + 1) % 9] === next;
      if (!ok) violations.push({ type: "sequence", sentence: s.trim(), detail: `${next} does not follow ${prev}. After ${f.md.lord}–${prev} comes ${f.md.lord}–${[...successorsOf(f, prev)][0] || ORDER[(ORDER.indexOf(prev) + 1) % 9]}.` });
    }
    // (2) "Saturn–Rahu ... 2029": a year attached to a named MD–AD pair must fall inside that period
    const pr = new RegExp(`\\b${PL}\\s*[-/]\\s*${PL}\\b([^.?!]{0,60})`, "gi");
    let pm;
    while ((pm = pr.exec(plain))) {
      const md = NAME(pm[1]), ad = NAME(pm[2]);
      const yrs = [...pm[3].matchAll(/\b(19\d{2}|20\d{2}|21\d{2})\b/g)].map((x) => +x[1]).slice(0, 2);
      if (!yrs.length || /\b(born|birth|since|until|before)\b/i.test(pm[3])) continue;
      const spans = pairSpan(f, md, ad);
      if (!spans.length) continue;
      const fits = yrs.every((y) => spans.some((x) => y >= yearOf(x.start) && y <= yearOf(x.end)));
      if (!fits) violations.push({ type: "date", sentence: s.trim(), detail: `${md}–${ad} runs ${spans.map((x) => `${fmtJD(x.start)} → ${fmtJD(x.end)}`).join("; ")}.` });
    }
    // (3) age claims
    const am = plain.match(/\b(?:you are|you're|you are now|now|currently|at the age of|aged)\s+(\d{2})\b(?!\s*(?:%|degrees|°))/i)
      || (/\b(you are|you're|you turned)\b/i.test(plain) ? plain.match(/\b(\d{2})\s*(?:years?|yrs?)[- ]old\b/i) : null);
    if (am && f.age != null && /\b(you|you're|your)\b/i.test(plain) && !/\b(will|when you|by|until|at)\b[^.]{0,20}\b\d{2}\b/i.test(plain)) {
      if (Math.abs(+am[1] - f.age) > 0) violations.push({ type: "age", sentence: s.trim(), detail: `Current age is ${f.age}.` });
    }
    // (4) elapsed years since a past year: "since 2011 … 19 years"
    const ym = plain.match(/\b(19\d{2}|20\d{2})\b/);
    const em = plain.match(/\b(\d{1,2})\s+years?\s+(?:ago|elapsed|have passed|already|into|old|since|later)\b/i);
    if (ym && em && +ym[1] < nowY && /\b(since|began|begun|started|starting|from|ago|old|into|elapsed|passed)\b/i.test(plain)) {
      const actual = nowY - +ym[1];
      if (Math.abs(+em[1] - actual) > 1) violations.push({ type: "elapsed", sentence: s.trim(), detail: `${ym[1]} was about ${actual} years ago (today is ${f.today}).` });
    }
    // (5) Saturn-return status
    const rm = plain.match(/\b(first|1st|second|2nd|third|3rd)\s+saturn\s+return\b/i);
    if (rm) {
      const n = { first: 1, "1st": 1, second: 2, "2nd": 2, third: 3, "3rd": 3 }[rm[1].toLowerCase()];
      const r = f.saturnReturns.find((x) => x.n === n);
      if (r) {
        const saysDone = /\b(completed|complete|finished|behind you|already (had|passed|went)|have passed|is over|was over)\b/i.test(plain);
        const saysAhead = /\b(ahead|upcoming|coming|will (come|arrive|begin|happen)|yet to|approaching)\b/i.test(plain);
        if (saysDone && r.last > f.nowJD) violations.push({ type: "saturn-return", sentence: s.trim(), detail: `Saturn return ${n} is not complete: it is exact ${fmtJD(r.first)}${r.contacts.length > 1 ? ` … ${fmtJD(r.last)}` : ""}.` });
        if (saysAhead && r.last < f.nowJD) violations.push({ type: "saturn-return", sentence: s.trim(), detail: `Saturn return ${n} is already complete (${fmtJD(r.first)}${r.contacts.length > 1 ? ` … ${fmtJD(r.last)}` : ""}).` });
      }
    }
    // (5b) house-lordship and yogakāraka claims must match the lordship table
    if (f.lordship) {
      const ORD = "(1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|11th|12th|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|1|2|3|4|5|6|7|8|9|10|11|12)";
      const toN = (w) => { const m = { first:1, second:2, third:3, fourth:4, fifth:5, sixth:6, seventh:7, eighth:8, ninth:9, tenth:10, eleventh:11, twelfth:12 }; return m[w.toLowerCase()] || parseInt(w, 10); };
      const PL7 = "(Sun|Moon|Mars|Mercury|Jupiter|Venus|Saturn)";
      const claims = [];
      // "Saturn rules your 9th and 10th houses", "Saturn is the lord of the third house"
      const r1 = new RegExp(`\\b${PL7}\\s+(?:rules|owns|lords(?:\\s+over)?|governs|is\\s+(?:the\\s+)?(?:lord|ruler)\\s+of)\\s+(?:over\\s+)?(?:both\\s+)?(?:your\\s+|the\\s+)?(${ORD}(?:\\s*(?:,|and|&)\\s*(?:the\\s+|your\\s+)?${ORD})*)(?:[- ]|\\s+)houses?\\b`, "gi");
      for (const m of plain.matchAll(r1)) claims.push([NAME(m[1]), [...m[2].matchAll(new RegExp(ORD, "gi"))].map((x) => toN(x[0]))]);
      // "the third lord Saturn", "3rd-house lord, Saturn", "lord of the third house is Saturn"
      const r2 = new RegExp(`\\b(?:the\\s+|your\\s+)?${ORD}(?:[- ]house)?\\s+lord\\s*(?:,|is|—|-|:)?\\s*${PL7}\\b`, "gi");
      for (const m of plain.matchAll(r2)) claims.push([NAME(m[2]), [toN(m[1])]]);
      const r3 = new RegExp(`\\blord\\s+of\\s+(?:your\\s+|the\\s+)?${ORD}(?:[- ]|\\s+)house\\s*(?:,|is|—|-|:)?\\s*${PL7}\\b`, "gi");
      for (const m of plain.matchAll(r3)) claims.push([NAME(m[2]), [toN(m[1])]]);
      const r4 = new RegExp(`\\b${PL7},?\\s+(?:your|the)\\s+${ORD}(?:[- ]house)?\\s+lord\\b`, "gi");
      for (const m of plain.matchAll(r4)) claims.push([NAME(m[1]), [toN(m[2])]]);
      for (const [planet, hs] of claims) {
        const own = f.lordship.owns[planet] || [];
        const bad = hs.filter((h) => !own.includes(h));
        if (bad.length) violations.push({ type: "lordship", sentence: s.trim(), detail: `${planet} rules house${own.length > 1 ? "s" : ""} ${own.join(" & ")} for this lagna, not ${bad.join(" & ")}.` });
      }
      // Plain-language lordship: "Saturn owns the areas of career and gains", "Saturn governs your career and fortune"
      const AREA = [[/\bcareer|status|profession|reputation\b/i, [10]], [/\bgains?\b|\bincome\b|\bnetworks?\b|\bfriendships?\b/i, [11]],
        [/\bfortune\b|\bluck\b|\bdharma\b|\bfather\b|higher learning/i, [9]], [/\bspouse\b|\bpartnerships?\b|\bmarriage\b/i, [7]],
        [/\bchildren\b|\bcreativity\b/i, [5]], [/\bhome\b|\bmother\b|\bproperty\b/i, [4]], [/\bsiblings?\b|\bcourage\b/i, [3]],
        [/\bwealth\b|\bfamily\b|\bspeech\b/i, [2]], [/\bdebts?\b|\bcompetition\b|\benemies\b/i, [6]], [/\bexpenses?\b|\bloss(?:es)?\b|foreign/i, [12]]];
      const r5 = new RegExp(`\\b${PL7}\\s+(?:owns|governs|is\\s+(?:the\\s+)?lord\\s+of|rules\\s+(?:your|over\\s+your|the\\s+areas?\\s+of))\\s+(?:the\\s+areas?\\s+of\\s+|the\\s+houses?\\s+of\\s+|your\\s+)?([^.;:—–(]{3,80})`, "gi");
      for (const m of plain.matchAll(r5)) {
        if (/\bhouses?\b/i.test(m[2]) && new RegExp(ORD, "i").test(m[2])) continue; // numeric form handled above
        const planet = NAME(m[1]), own = f.lordship.owns[planet] || [], bad = [];
        for (const piece of m[2].split(/\s-\s/)[0].split(/\/|,|\band\b|&/)) {
          const hit = AREA.find(([re]) => re.test(piece));
          if (hit && !hit[1].some((h) => own.includes(h))) bad.push(`${piece.trim()} (house ${hit[1][0]})`);
        }
        if (bad.length) violations.push({ type: "lordship", sentence: s.trim(), detail: `${planet} rules house${own.length > 1 ? "s" : ""} ${own.join(" & ")} (${own.map((h) => HOUSE_AREAS[h]).join("; ")}) for this lagna — not ${bad.join(", ")}.` });
      }
      const ll = plain.match(new RegExp(`\\b${PL7}\\s+is\\s+(?:your|the)\\s+(?:lagna|ascendant)\\s+lord\\b`, "i")) || plain.match(new RegExp(`\\b(?:lagna|ascendant)\\s+lord\\s*(?:,|is|—|-|:)?\\s*${PL7}\\b`, "i"));
      if (ll) { const p = NAME(ll[1]); if (p !== f.lordship.lagnaLord) violations.push({ type: "lordship", sentence: s.trim(), detail: `The lagna lord is ${f.lordship.lagnaLord}, not ${p}.` }); }
      const yk = plain.match(new RegExp(`\\b${PL7}\\s+is\\s+(?:your|the|a)\\s+yoga[\\s-]?k[aā]raka\\b`, "i"));
      if (yk && !f.lordship.yogakaraka.includes(NAME(yk[1]))) violations.push({ type: "lordship", sentence: s.trim(), detail: `The yogakāraka for this lagna is ${f.lordship.yogakaraka.join(", ") || "none"}, not ${NAME(yk[1])}.` });
    }
    // (6) banned certainty forms (R12)
    if (/\bhigh confidence\b|\b\d{1,3}\s?%\s*(?:chance|likel|probab|confiden|certain)/i.test(plain))
      violations.push({ type: "certainty", sentence: s.trim(), detail: "Certainty must be stated as calculation / traditional support / predictive reliability, without a single 'High confidence' label or percentage." });
  }
  return { ok: violations.length === 0, violations };
}

export function repairAnswer(text, violations) {
  const bad = new Set(violations.map((v) => v.sentence));
  const kept = sentences(text).filter((s) => !bad.has(s.trim())).join(" ");
  const notes = [...new Set(violations.map((v) => v.detail))].map((d) => `• ${d}`).join("\n");
  return `${kept}\n\nCorrected by the calculation engine:\n${notes}`.trim();
}

/* ------------------------------------------------------------------ chart text (no name / DOB / place) */
export function chartText(c) {
  const p = c.placements.map((x) => `${x.p} ${x.sign} ${x.deg}° (H${x.house})`).join("; ");
  const d9 = c.placements.map((x) => `${x.p}→${x.nav}${x.vargottama ? "*vargottama" : ""}`).join(", ");
  const d10 = c.placements.map((x) => `${x.p}→${x.das}`).join(", ");
  const av = c.ashtakavarga, Lx = c.lagnaSignIdx;
  const savHouses = Array.from({ length: 12 }, (_, h) => `H${h + 1}:${av.sav[(Lx + h) % 12]}`).join(", ");
  return `CHART (computed by the engine):
Lagna: ${c.lagna.sign} ${c.lagna.deg}° (Navāṃśa ${c.lagna.nav}, Daśāṃśa ${c.lagna.das})
Moon: ${c.moon.sign} ${c.moon.deg}° — ${c.moon.nak.name} pada ${c.moon.nak.pada}
D1 placements (whole-sign house from lagna): ${p}
D9 Navāṃśa: ${d9}
D10 Daśāṃśa: ${d10}
Sarvāṣṭakavarga by house from lagna (bindus; total 337, average ≈28): ${savHouses}. One factor among many — never a verdict on its own.

${c.evidence ? c.evidence.promptBlock : ""}`;
}

/* ------------------------------------------------------------------ plain-text output */
export function stripMarkdown(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1")
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/gm, "$1$2")
    .replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s).,;:!?]|$)/gm, "$1$2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*/g, "");
}
