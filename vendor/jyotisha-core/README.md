# jyotisha-core 2026.11.0

The one shared Jyotisha calculation engine for Antardrishti and IMI ONE.
**Astronomical calculation only.** It states positions and the traditional day-divisions
that follow from them. It does not interpret, predict or claim effects.

## What is in it

| File | Origin | Changed? |
|---|---|---|
| `src/lib/engine.js` | Antardrishti `src/lib/engine.js` | No: byte-identical (see MANIFEST.sha256) |
| `src/lib/muhurta.js`, `src/lib/consult.js` | Antardrishti | No: byte-identical |
| `src/Ashtakavarga.js`, `src/Evidence.js`, `src/Varga.js` | Antardrishti (engine imports) | No: byte-identical |
| `src/panchang.js` | New | Daily Panchangam for a place |

## Tests (`npm test`): 15

- 8 engine tests carried over unchanged from Antardrishti's reliability suite (T01 to T04):
  68-chart positions against Swiss Ephemeris reference values, the C-01 Venus regression,
  dasha order, continuity and dates, Saturn returns, Ashtakavarga total 337.
- 7 new: IANA time zones (including a daylight-saving change), karana cycle, exact
  tithi/nakshatra/pada/karana boundaries, forward-only nakshatra over a day, a real
  retrograde sign crossing, the daily Panchangam's completeness and provenance, and
  sunrise cross-checked against an independent NOAA formula (within 3 minutes, 3 places).

## Accuracy matrix

| Quantity | Method | Validated against | Result | Status |
|---|---|---|---|---|
| Sun, Moon, planets (sidereal) | Meeus Sun/Moon; astronomy-engine planets; linear Lahiri | Swiss Ephemeris 2.10.03, 68 charts 1930–2045 | worst 1.24′ (Moon) | Validated in range |
| Sign, nakshatra, D9 placement | from the positions | same 612 placements | 0 disagreements | Validated in range; boundary-exact cases still need reference times |
| Rahu/Ketu | mean node | Swiss Ephemeris mean node | worst 0.29′ | Validated; true node not provided |
| Ascendant | engine | Swiss Ephemeris | worst 0.37′ | Validated in range |
| Vimshottari dasha dates | engine/consult | Swiss-Moon reference | within 2 days | Open: investigate year-length convention before showing exact dates |
| Tithi, nakshatra, yoga, karana at sunrise | from Sun/Moon longitudes | boundary arithmetic tests | exact by construction | Needs independent published Panchang comparison |
| Sunrise/sunset/moonrise/moonset | astronomy-engine SearchRiseSet | independent NOAA formula | within 3 min (sunrise) | Needs comparison with an official table (e.g. Positional Astronomy Centre) |
| Rahu Kalam, Yamagandam, Gulika, Abhijit | day divided per tradition | arithmetic | consistent with muhurta.js tables | Convention, not measurement |
| Time zones | IANA via Intl | known offsets incl. DST change | exact | Validated |

The ayanamsha is a linear Lahiri approximation; it validates within the 1930–2045 range above.
Outside that range it is not validated.

## Licensing

- astronomy-engine 2.1.19: MIT licence.
- Swiss Ephemeris was used once, outside this package, to generate the reference values in
  `tests/fixtures/ephemeris-reference.json`. It is not included or linked, so its AGPL/commercial
  terms do not apply to this package. Re-check with legal advice before any public claim.

## Use

Antardrishti and IMI ONE should both import this package (or a pinned copy verified against
`MANIFEST.sha256`) so the two can never disagree about a position. Do not edit the copied
files in either application; change them here, with tests, and release a new version.
