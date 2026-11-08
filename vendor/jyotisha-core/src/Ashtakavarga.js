// Ashtakavarga.js — Parashari Bhinnashtakavarga (BAV) + Sarvashtakavarga (SAV)
// Pure functions. No React, no engine dependency.
//
// Each planet's BAV is built from contributions of 8 reference points
// (Sun, Moon, Mars, Mercury, Jupiter, Venus, Saturn, Lagna). A contributor
// "gives a bindu" to a sign if that sign falls in one of its benefic houses,
// counted (1-based, inclusive) FROM the contributor's own sign.
//
// Classical per-planet totals (used as validation checksums):
//   Sun 48, Moon 49, Mars 39, Mercury 54, Jupiter 56, Venus 52, Saturn 39
//   => Sarvashtakavarga grand total = 337

export const AV_PLANETS = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn'];
export const CONTRIBUTORS = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Lagna'];

// Benefic-house tables (houses counted from each contributor).
// BENEFIC[planet][contributor] = [house numbers 1..12].
export const BENEFIC = {
  Sun: {
    Sun: [1, 2, 4, 7, 8, 9, 10, 11],
    Moon: [3, 6, 10, 11],
    Mars: [1, 2, 4, 7, 8, 9, 10, 11],
    Mercury: [3, 5, 6, 9, 10, 11, 12],
    Jupiter: [5, 6, 9, 11],
    Venus: [6, 7, 12],
    Saturn: [1, 2, 4, 7, 8, 9, 10, 11],
    Lagna: [3, 4, 6, 10, 11, 12],
  },
  Moon: {
    Sun: [3, 6, 7, 8, 10, 11],
    Moon: [1, 3, 6, 7, 10, 11],
    Mars: [2, 3, 5, 6, 9, 10, 11],
    Mercury: [1, 3, 4, 5, 7, 8, 10, 11],
    Jupiter: [1, 4, 7, 8, 10, 11, 12],
    Venus: [3, 4, 5, 7, 9, 10, 11],
    Saturn: [3, 5, 6, 11],
    Lagna: [3, 6, 10, 11],
  },
  Mars: {
    Sun: [3, 5, 6, 10, 11],
    Moon: [3, 6, 11],
    Mars: [1, 2, 4, 7, 8, 10, 11],
    Mercury: [3, 5, 6, 11],
    Jupiter: [6, 10, 11, 12],
    Venus: [6, 8, 11, 12],
    Saturn: [1, 4, 7, 8, 9, 10, 11],
    Lagna: [1, 3, 6, 10, 11],
  },
  Mercury: {
    Sun: [5, 6, 9, 11, 12],
    Moon: [2, 4, 6, 8, 10, 11],
    Mars: [1, 2, 4, 7, 8, 9, 10, 11],
    Mercury: [1, 3, 5, 6, 9, 10, 11, 12],
    Jupiter: [6, 8, 11, 12],
    Venus: [1, 2, 3, 4, 5, 8, 9, 11],
    Saturn: [1, 2, 4, 7, 8, 9, 10, 11],
    Lagna: [1, 2, 4, 6, 8, 10, 11],
  },
  Jupiter: {
    Sun: [1, 2, 3, 4, 7, 8, 9, 10, 11],
    Moon: [2, 5, 7, 9, 11],
    Mars: [1, 2, 4, 7, 8, 10, 11],
    Mercury: [1, 2, 4, 5, 6, 9, 10, 11],
    Jupiter: [1, 2, 3, 4, 7, 8, 10, 11],
    Venus: [2, 5, 6, 9, 10, 11],
    Saturn: [3, 5, 6, 12],
    Lagna: [1, 2, 4, 5, 6, 7, 9, 10, 11],
  },
  Venus: {
    Sun: [8, 11, 12],
    Moon: [1, 2, 3, 4, 5, 8, 9, 11, 12],
    Mars: [3, 5, 6, 9, 11, 12],
    Mercury: [3, 5, 6, 9, 11],
    Jupiter: [5, 8, 9, 10, 11],
    Venus: [1, 2, 3, 4, 5, 8, 9, 10, 11],
    Saturn: [3, 4, 5, 8, 9, 10, 11],
    Lagna: [1, 2, 3, 4, 5, 8, 9, 11],
  },
  Saturn: {
    Sun: [1, 2, 4, 7, 8, 10, 11],
    Moon: [3, 6, 11],
    Mars: [3, 5, 6, 10, 11, 12],
    Mercury: [6, 8, 9, 10, 11, 12],
    Jupiter: [5, 6, 11, 12],
    Venus: [6, 11, 12],
    Saturn: [3, 5, 6, 11],
    Lagna: [1, 3, 4, 6, 10, 11],
  },
};

const mod12 = (n) => ((n % 12) + 12) % 12;

// House (1..12) of target sign counted from a contributor's sign (inclusive).
function houseFrom(contributorSign, targetSign) {
  return mod12(targetSign - contributorSign) + 1;
}

// bhinnashtakavarga(signs)
//   signs: { Sun, Moon, Mars, Mercury, Jupiter, Venus, Saturn, Lagna } -> sign index 0..11
//   returns: { Sun:[12], Moon:[12], ... } bindus per sign (index 0 = Aries)
export function bhinnashtakavarga(signs) {
  const result = {};
  for (const planet of AV_PLANETS) {
    const row = new Array(12).fill(0);
    for (let s = 0; s < 12; s++) {
      let bindus = 0;
      for (const contributor of CONTRIBUTORS) {
        const cSign = signs[contributor];
        if (cSign == null) continue;
        const house = houseFrom(cSign, s);
        if (BENEFIC[planet][contributor].includes(house)) bindus += 1;
      }
      row[s] = bindus;
    }
    result[planet] = row;
  }
  return result;
}

// sarvashtakavarga(bav) -> [12] total bindus per sign
export function sarvashtakavarga(bav) {
  const sav = new Array(12).fill(0);
  for (const planet of AV_PLANETS) {
    for (let s = 0; s < 12; s++) sav[s] += bav[planet][s];
  }
  return sav;
}

// Classical totals for validation.
export const CLASSICAL_TOTALS = {
  Sun: 48, Moon: 49, Mars: 39, Mercury: 54, Jupiter: 56, Venus: 52, Saturn: 39,
};
export const SAV_TOTAL = 337;

// validateTables() — structural self-check independent of any chart.
// Confirms every planet's benefic table sums to its classical total and that
// house numbers are well-formed (1..12, no duplicates).
export function validateTables() {
  const report = { ok: true, planets: {}, savTotal: 0 };
  for (const planet of AV_PLANETS) {
    let total = 0;
    let wellFormed = true;
    for (const contributor of CONTRIBUTORS) {
      const houses = BENEFIC[planet][contributor];
      const set = new Set(houses);
      if (set.size !== houses.length) wellFormed = false;
      for (const h of houses) if (h < 1 || h > 12) wellFormed = false;
      total += houses.length;
    }
    const expected = CLASSICAL_TOTALS[planet];
    const pass = total === expected && wellFormed;
    report.planets[planet] = { total, expected, pass };
    report.savTotal += total;
    if (!pass) report.ok = false;
  }
  if (report.savTotal !== SAV_TOTAL) report.ok = false;
  return report;
}
