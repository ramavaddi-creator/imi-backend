// Varga.js — Divisional chart (varga) computation for Antardrishti
// Pure functions. No React, no engine dependency.
// Input is always an absolute sidereal longitude in [0, 360).
// Output sign index: 0 = Aries (Mesha) ... 11 = Pisces (Meena).
//
// Classical Parashari rules. Validated for D9 (Navamsa) and D10 (Dasamsa);
// D2/D3/D7/D12/D16/D24/D60 added with their classical start-sign rules.
export const SIGNS = [
  'Aries', 'Taurus', 'Gemini', 'Cancer', 'Leo', 'Virgo',
  'Libra', 'Scorpio', 'Sagittarius', 'Capricorn', 'Aquarius', 'Pisces',
];
export const SIGNS_SA = [
  'Meṣa', 'Vṛṣabha', 'Mithuna', 'Karka', 'Siṃha', 'Kanyā',
  'Tulā', 'Vṛścika', 'Dhanu', 'Makara', 'Kumbha', 'Mīna',
];
const mod12 = (n) => ((n % 12) + 12) % 12;
// Element/modality of a sign by 0-based index.
//  movable (chara):   0,3,6,9   -> Aries, Cancer, Libra, Capricorn
//  fixed   (sthira):  1,4,7,10  -> Taurus, Leo, Scorpio, Aquarius
//  dual    (dvi):     2,5,8,11  -> Gemini, Virgo, Sagittarius, Pisces
const modality = (sign) => sign % 3; // 0 movable, 1 fixed, 2 dual
const isOddSign = (sign) => sign % 2 === 0; // 0-based even == 1-based odd (Aries, Gemini...)
// --- The general entry point -------------------------------------------------
// vargaSign(longitude, D) -> sign index for the requested divisional chart.
export function vargaSign(longitude, D) {
  const L = ((longitude % 360) + 360) % 360;
  const sign = Math.floor(L / 30);        // 0..11
  const pos = L - sign * 30;              // 0..30 within the sign
  switch (D) {
    case 1:
      return sign;

    case 2: { // Horā: 2 parts of 15°. Odd sign -> 1st half Leo(Sun), 2nd half Cancer(Moon).
              //                       Even sign -> 1st half Cancer, 2nd half Leo.
      const firstHalf = pos < 15;
      if (isOddSign(sign)) return firstHalf ? 4 : 3;   // Leo : Cancer
      return firstHalf ? 3 : 4;                        // Cancer : Leo
    }

    case 3: { // Drekkana: 3 parts of 10°. 0->same, 1->5th, 2->9th from sign.
      const part = Math.floor(pos / 10);  // 0..2
      return mod12(sign + part * 4);
    }

    case 7: { // Saptamsa: 7 parts of 4°17'8.57". Odd: from the sign. Even: from the 7th.
      const part = Math.floor(pos / (30 / 7)); // 0..6
      const start = isOddSign(sign) ? sign : mod12(sign + 6);
      return mod12(start + part);
    }

    case 9: { // Navamsa: 9 parts of 3°20'. Start sign by modality.
      const part = Math.floor(pos / (30 / 9)); // 0..8
      let start;
      if (modality(sign) === 0) start = sign;            // movable: from itself
      else if (modality(sign) === 1) start = mod12(sign + 8); // fixed: 9th from it
      else start = mod12(sign + 4);                      // dual: 5th from it
      return mod12(start + part);
    }

    case 10: { // Dasamsa: 10 parts of 3°. Odd sign: from itself. Even: 9th from it.
      const part = Math.floor(pos / 3); // 0..9
      const start = isOddSign(sign) ? sign : mod12(sign + 8);
      return mod12(start + part);
    }

    case 12: { // Dwadasamsa: 12 parts of 2°30'. Always counted from the sign itself.
      const part = Math.floor(pos / (30 / 12)); // 0..11
      return mod12(sign + part);
    }

    case 16: { // Shodasamsa (Kalamsa): 16 parts of 1°52'30".
               // Start: movable -> Aries, fixed -> Leo, dual -> Sagittarius.
      const part = Math.floor(pos / (30 / 16)); // 0..15
      const start = modality(sign) === 0 ? 0 : modality(sign) === 1 ? 4 : 8;
      return mod12(start + part);
    }

    case 24: { // Chaturvimshamsa (Siddhamsa): 24 parts of 1°15'.
               // Odd sign -> from Leo. Even sign -> from Cancer.
      const part = Math.floor(pos / (30 / 24)); // 0..23
      const start = isOddSign(sign) ? 4 : 3;    // Leo : Cancer
      return mod12(start + part);
    }

    case 60: { // Shashtyamsa: 60 parts of 0°30'. Counted from the sign itself.
               // BPHS shortcut: floor(deg-in-sign * 2) signs from the sign.
      const part = Math.floor(pos * 2); // 0..59
      return mod12(sign + part);
    }

    case 30: { // Trimsamsa: 5 UNEQUAL parts ruled by Mars/Saturn/Jupiter/Mercury/Venus.
               // Never lands in Cancer or Leo (the luminaries' signs) — a classical signature.
               // Odd sign:  Mars 0-5° (Aries), Saturn 5-10° (Aquarius), Jupiter 10-18° (Sagittarius),
               //            Mercury 18-25° (Gemini), Venus 25-30° (Libra).
               // Even sign: Venus 0-5° (Taurus), Mercury 5-12° (Virgo), Jupiter 12-20° (Pisces),
               //            Saturn 20-25° (Capricorn), Mars 25-30° (Scorpio).
      if (isOddSign(sign)) {
        if (pos < 5) return 0;    // Aries     (Mars)
        if (pos < 10) return 10;  // Aquarius  (Saturn)
        if (pos < 18) return 8;   // Sagittarius (Jupiter)
        if (pos < 25) return 2;   // Gemini    (Mercury)
        return 6;                 // Libra     (Venus)
      }
      if (pos < 5) return 1;      // Taurus    (Venus)
      if (pos < 12) return 5;     // Virgo     (Mercury)
      if (pos < 20) return 11;    // Pisces    (Jupiter)
      if (pos < 25) return 9;     // Capricorn (Saturn)
      return 7;                   // Scorpio   (Mars)
    }

    default:
      throw new Error(`Varga D${D} not implemented yet`);
  }
}
// computeVargaChart(positions, D)
//   positions: { Sun: lon, Moon: lon, ..., Lagna: lon }  (absolute sidereal longitudes)
//   returns:   { Sun: signIndex, ..., Lagna: signIndex }
export function computeVargaChart(positions, D) {
  const out = {};
  for (const body of Object.keys(positions)) {
    if (positions[body] == null) continue;
    out[body] = vargaSign(positions[body], D);
  }
  return out;
}
export const VARGA_LABELS = {
  1: { code: 'D1', name: 'Rāśi', domain: 'The body, the whole life' },
  2: { code: 'D2', name: 'Horā', domain: 'Wealth, resources' },
  3: { code: 'D3', name: 'Drekkāṇa', domain: 'Siblings, courage, effort' },
  7: { code: 'D7', name: 'Saptāṃśa', domain: 'Children, progeny, legacy' },
  9: { code: 'D9', name: 'Navāṃśa', domain: 'Marriage, dharma, inner strength' },
  10: { code: 'D10', name: 'Daśāṃśa', domain: 'Career, action, status' },
  12: { code: 'D12', name: 'Dvādaśāṃśa', domain: 'Parents, lineage' },
  16: { code: 'D16', name: 'Ṣoḍaśāṃśa', domain: 'Vehicles, comforts, inner happiness' },
  24: { code: 'D24', name: 'Caturviṃśāṃśa', domain: 'Education, learning, knowledge' },
  30: { code: 'D30', name: 'Triṃśāṃśa', domain: 'Misfortunes, weaknesses, character' },
  60: { code: 'D60', name: 'Ṣaṣṭyāṃśa', domain: 'Sum of all karma (birth-time sensitive)' },
};
