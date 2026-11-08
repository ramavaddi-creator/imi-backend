// Types for the vendored jyotisha-core Panchangam (the .js file is the source of truth).
export const CORE_VERSION: string;
export interface DailyPanchang {
  kind: 'calculation'; date: string; place: string; vara: string; tithi: number; tithiName: string; paksha: string;
  nakshatra: string; nakshatraNumber: number; pada: number; yoga: string; karana: string;
  sunrise: string | null; sunset: string | null; moonrise: string | null; moonset: string | null;
  rahuKalam: { start: string; end: string } | null; yamagandam: { start: string; end: string } | null; gulika: { start: string; end: string } | null; abhijit: { start: string; end: string } | null;
  provenance: Record<string, unknown>;
}
export function dailyPanchang(a: { date: string; lat: number; lng: number; tz: string; place: string }): DailyPanchang;
export function localMidnight(date: string, tz: string): Date;
