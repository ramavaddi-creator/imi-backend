// IMI ONE round 12: Build 3 completion (design 4.5 g and h).
//
//   Season and demand calendar: dates that move demand, each with where it came from (for example the
//   official Tadoba notice for the monsoon closure). Today reminds 30, 14 and 7 days ahead.
//   Baseline: an owner starts it once; every Monday the previous week's funnel is kept as a snapshot,
//   so changes to the website or ads can later be compared with four ordinary weeks before them.

import type { Env } from './env';
import { HttpError } from './http';
import type { Role } from './tenancy';
import { funnel } from './search';

const iso = () => new Date().toISOString();
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['season', 'closure', 'holiday', 'long_weekend', 'other'] as const;
const todayUtc = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);

// ---------------------------------------------------------------- season and demand calendar

export async function listEvents(env: Env, ws: string, from?: string | null, to?: string | null) {
  const { results } = await env.DB.prepare(`SELECT id, title, kind, start_date, end_date, source, remind_days_json, created_by, created_at FROM brand_events
    WHERE workspace_id = ? AND retired_at IS NULL AND (? IS NULL OR end_date >= ?) AND (? IS NULL OR start_date <= ?) ORDER BY start_date LIMIT 200`)
    .bind(ws, from ?? null, from ?? null, to ?? null, to ?? null).all<any>();
  return (results ?? []).map((e) => ({ ...e, remindDays: JSON.parse(e.remind_days_json || '[]'), remind_days_json: undefined }));
}

export async function addEvent(env: Env, ws: string, who: string, body: any) {
  const title = clip(body?.title, 120);
  if (title.length < 3) throw new HttpError(400, 'Give the date a short name, for example "Core zone closes for monsoon".');
  const kind = String(body?.kind ?? '');
  if (!(KINDS as readonly string[]).includes(kind)) throw new HttpError(400, 'Choose what kind of date this is.');
  const start = String(body?.startDate ?? ''), end = String(body?.endDate || body?.startDate || '');
  if (!DATE.test(start) || !DATE.test(end) || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) throw new HttpError(400, 'Dates as YYYY-MM-DD.');
  if (end < start) throw new HttpError(400, 'The end date is before the start date.');
  if (daysBetween(start, end) > 366) throw new HttpError(400, 'A date range can be at most a year.');
  const remind = (Array.isArray(body?.remindDays) ? body.remindDays : [30, 14, 7]).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n <= 120).slice(0, 5);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO brand_events (id, workspace_id, title, kind, start_date, end_date, source, remind_days_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, ws, title, kind, start, end, clip(body?.source, 200) || null, JSON.stringify(remind.length ? remind : [30, 14, 7]), who, iso()).run();
  return listEvents(env, ws);
}

export async function retireEvent(env: Env, ws: string, who: string, id: string) {
  const r = await env.DB.prepare('UPDATE brand_events SET retired_by = ?, retired_at = ? WHERE id = ? AND workspace_id = ? AND retired_at IS NULL').bind(who, iso(), id, ws).run();
  if (!(r as any).meta?.changes) throw new HttpError(404, 'Date not found');
  return listEvents(env, ws);
}

// Today: from the first reminder day until the date itself, one line per upcoming date (soonest first).
// The wording names the next reminder step it has passed (30, 14 or 7 days), so it changes as the date nears.
export async function seasonReminders(env: Env, ws: string, now = todayUtc()) {
  const { results } = await env.DB.prepare(`SELECT id, title, kind, start_date, end_date, source, remind_days_json FROM brand_events
    WHERE workspace_id = ? AND retired_at IS NULL AND start_date >= ? ORDER BY start_date LIMIT 20`).bind(ws, now).all<any>();
  const out: any[] = [];
  for (const e of results ?? []) {
    const left = daysBetween(now, e.start_date);
    const steps = (JSON.parse(e.remind_days_json || '[30,14,7]') as number[]).sort((a, b) => b - a);
    if (!steps.length || left > steps[0]) continue;
    const step = steps.filter((s) => left <= s).at(-1)!;
    const prepare = e.kind === 'closure' ? 'Plan around it: tell guests, move offers to the buffer zone.' : e.kind === 'season' ? 'Prepare offers and posts now.' : 'A chance for a timely offer or post.';
    out.push({ id: `season-${e.id}`, kind: 'prepare_season', subject: e.title,
      title: left === 0 ? `${e.title}: today` : `${e.title}: in ${left} day${left === 1 ? '' : 's'}`,
      why: `${prepare}${e.source ? ` Source: ${e.source}.` : ''} (${step}-day reminder)`, action: { label: 'Open the calendar', screen: 'create', ref: 'calendar' } });
  }
  return out;
}

// ---------------------------------------------------------------- baseline

const monday = (d: Date) => { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; };
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export async function startBaseline(env: Env, ws: string, who: string, body: any) {
  const existing = await env.DB.prepare('SELECT * FROM baselines WHERE workspace_id = ?').bind(ws).first();
  if (existing) throw new HttpError(409, 'The baseline has already started. It is never restarted, so the comparison stays honest.');
  const weeks = body?.weeks === undefined ? 4 : Number(body.weeks);
  if (!Number.isInteger(weeks) || weeks < 2 || weeks > 12) throw new HttpError(400, 'Weeks: a whole number from 2 to 12.');
  await env.DB.prepare('INSERT INTO baselines (workspace_id, started_at, started_by, weeks, note) VALUES (?, ?, ?, ?, ?)').bind(ws, iso(), who, weeks, clip(body?.note, 300) || null).run();
  return baseline(env, ws);
}

// The week that ended most recently (Monday to Sunday), taken once; a second attempt changes nothing.
export async function takeSnapshot(env: Env, ws: string, by: string | null, now = new Date()) {
  const b = await env.DB.prepare('SELECT * FROM baselines WHERE workspace_id = ?').bind(ws).first<any>();
  if (!b) throw new HttpError(409, 'Start the baseline first.');
  const thisMonday = monday(now);
  const ws0 = new Date(thisMonday); ws0.setUTCDate(ws0.getUTCDate() - 7);
  const we = new Date(thisMonday); we.setUTCDate(we.getUTCDate() - 1);
  const weekStart = ymd(ws0), weekEnd = ymd(we);
  if (await env.DB.prepare('SELECT 1 FROM funnel_snapshots WHERE workspace_id = ? AND week_start = ?').bind(ws, weekStart).first()) return { taken: false, weekStart, weekEnd };
  const f = await funnel(env, ws, 'owner' as Role, null, { start: weekStart, end: weekEnd });
  const figures = Object.fromEntries(f.stages.map((s: any) => [s.key, { value: s.value, status: s.status, source: s.source, ...(s.attribution?.attributedGoogle !== undefined ? { google: s.attribution.attributedGoogle } : {}) }]));
  await env.DB.prepare('INSERT INTO funnel_snapshots (id, workspace_id, week_start, week_end, figures_json, taken_at, taken_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), ws, weekStart, weekEnd, JSON.stringify(figures), iso(), by).run();
  return { taken: true, weekStart, weekEnd };
}

export async function baseline(env: Env, ws: string) {
  const b = await env.DB.prepare('SELECT * FROM baselines WHERE workspace_id = ?').bind(ws).first<any>();
  if (!b) return { started: false, weeks: 4, snapshots: [], comparison: null, note: 'Not started. Start it before changing the website or running ads, so the change can be measured.' };
  const { results } = await env.DB.prepare('SELECT week_start, week_end, figures_json, taken_at, taken_by FROM funnel_snapshots WHERE workspace_id = ? ORDER BY week_start').bind(ws).all<any>();
  const snaps = (results ?? []).map((r) => ({ weekStart: r.week_start, weekEnd: r.week_end, figures: JSON.parse(r.figures_json), takenAt: r.taken_at, takenBy: r.taken_by }));
  // Only whole weeks after the start count: the first Monday on or after the start date.
  const startDay = b.started_at.slice(0, 10), m0 = monday(new Date(`${startDay}T00:00:00Z`));
  if (ymd(m0) < startDay) m0.setUTCDate(m0.getUTCDate() + 7);
  const firstWeek = ymd(m0);
  const base = snaps.filter((s) => s.weekStart >= firstWeek).slice(0, b.weeks);
  const after = snaps.filter((s) => s.weekStart >= firstWeek).slice(b.weeks);
  // Average per stage over the baseline weeks; a stage with any missing week is "incomplete", never guessed.
  const avg = (rows: any[], key: string) => {
    const vals = rows.map((s) => s.figures[key]?.value);
    if (!rows.length || vals.some((v) => typeof v !== 'number')) return null;
    return Math.round((vals.reduce((a: number, v: number) => a + v, 0) / vals.length) * 10) / 10;
  };
  const keys = [...new Set(snaps.flatMap((s) => Object.keys(s.figures)))];
  const ready = base.length >= b.weeks;
  const comparison = ready ? keys.map((k) => ({ stage: k, baselineWeeklyAverage: avg(base, k), latestWeek: after.length ? (typeof after.at(-1)!.figures[k]?.value === 'number' ? after.at(-1)!.figures[k].value : null) : null,
    weeksAfter: after.length })) : null;
  return {
    started: true, startedAt: b.started_at, startedBy: b.started_by, weeks: b.weeks, collected: base.length, ready, snapshots: snaps, comparison,
    note: ready ? 'Baseline complete. Changes from here are compared with the average of the baseline weeks.'
      : `Collecting: ${base.length} of ${b.weeks} weeks. Avoid big changes (website, ads, prices) until it is complete.`,
    caveat: 'Each snapshot is taken on Monday for the week before. CRM figures count from the start of that week to when the snapshot was taken, so a Monday enquiry can appear in the previous week.',
  };
}

// The Monday run (from the daily schedule): one snapshot per brand with a baseline.
export async function weeklySnapshots(env: Env, now = new Date()) {
  if (now.getUTCDay() !== 1) return [];
  const { results } = await env.DB.prepare('SELECT workspace_id FROM baselines').all<{ workspace_id: string }>();
  const out: unknown[] = [];
  for (const r of results ?? []) {
    try { out.push({ ws: r.workspace_id, ...(await takeSnapshot(env, r.workspace_id, null, now)) }); }
    catch (e) { out.push({ ws: r.workspace_id, error: e instanceof Error ? e.message : 'failed' }); }
  }
  return out;
}
