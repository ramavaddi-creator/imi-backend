export interface Env {
  DB: D1Database;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// CHANGE: maps the D1 row's snake_case columns back to the exact camelCase
// shape IMI's frontend InboxItem type already expects, so the frontend swap
// (a later step) is a data-source change only, not a type change.
function rowToInboxItem(row: any) {
  return {
    id: row.id,
    code: row.code,
    domain: row.domain,
    type: row.type,
    date: row.date,
    summary: row.summary,
    origin: row.origin,
    submittedBy: row.submitted_by,
    submitterRole: row.submitter_role,
    confidence: row.confidence_level ? { level: row.confidence_level, reason: row.confidence_reason } : undefined,
    retrospective: row.retrospective,
    status: row.status,
    fullText: row.full_text,
    sourceReference: row.source_reference || undefined,
    attachments: row.attachments_json ? JSON.parse(row.attachments_json) : undefined,
    sourceCategory: row.source_category || undefined,
    sourceType: row.source_type || undefined,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // GET /api/inbox — list everything, newest first
    if (request.method === 'GET' && url.pathname === '/api/inbox') {
      const { results } = await env.DB.prepare('SELECT * FROM inbox_items ORDER BY created_at DESC').all();
      return json((results || []).map(rowToInboxItem));
    }

    // POST /api/inbox — create a new item (mirrors HomeTodayScreen/InboxScreen's onAddItemToInbox payload)
    if (request.method === 'POST' && url.pathname === '/api/inbox') {
      const body = await request.json<any>();

      const countRow = await env.DB.prepare('SELECT COUNT(*) as n FROM inbox_items').first<{ n: number }>();
      const seq = (countRow?.n ?? 0) + 1;
      const id = `inbox-${Date.now()}`;
      const code = `INB-${String(seq).padStart(4, '0')}`;

      await env.DB.prepare(
        `INSERT INTO inbox_items
           (id, code, domain, type, date, summary, origin, submitted_by, submitter_role,
            confidence_level, confidence_reason, retrospective, status, full_text,
            source_reference, attachments_json, source_category, source_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id,
          code,
          'iddav-marketing-intelligence',
          body.type,
          body.date,
          body.summary,
          body.origin,
          body.submittedBy,
          body.submitterRole,
          body.confidence?.level ?? null,
          body.confidence?.reason ?? null,
          body.retrospective,
          body.status ?? 'pending',
          body.fullText,
          body.sourceReference ?? null,
          body.attachments ? JSON.stringify(body.attachments) : null,
          body.sourceCategory ?? null,
          body.sourceType ?? null
        )
        .run();

      const row = await env.DB.prepare('SELECT * FROM inbox_items WHERE id = ?').bind(id).first();
      return json(rowToInboxItem(row), 201);
    }

    // PATCH /api/inbox/:id — triage action (ignore/archive/verify/promote all just set status)
    const patchMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)$/);
    if (request.method === 'PATCH' && patchMatch) {
      const id = patchMatch[1];
      const body = await request.json<any>();
      if (!body.status) return json({ error: 'status is required' }, 400);

      await env.DB.prepare('UPDATE inbox_items SET status = ? WHERE id = ?').bind(body.status, id).run();
      const row = await env.DB.prepare('SELECT * FROM inbox_items WHERE id = ?').bind(id).first();
      if (!row) return json({ error: 'not found' }, 404);
      return json(rowToInboxItem(row));
    }

    return json({ error: 'not found' }, 404);
  },
};
