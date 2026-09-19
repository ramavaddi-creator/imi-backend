import { XMLParser } from 'fast-xml-parser';

export interface Env {
  DB: D1Database;
  API_SECRET: string;
  // CHANGE: both optional -- AI Assist works with either, neither, or both
  // configured, per explicit direction not to force a specific provider.
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function parseJsonField<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// ---------- Inbox ----------

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
    verificationStatus: row.verification_status || undefined,
    evidenceWeight: row.evidence_weight || undefined,
    commercialRelevance: row.commercial_relevance || undefined,
  };
}

// ---------- Intelligence Records ----------

function rowToRecord(row: any) {
  return {
    id: row.id,
    code: row.code,
    domain: row.domain,
    recordType: row.record_type,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    author: row.author,
    authorRole: row.author_role,
    observation: JSON.parse(row.observation_json),
    interpretation: parseJsonField(row.interpretation_json, undefined),
    linkedEvidence: parseJsonField(row.linked_evidence_json, []),
    assumptions: parseJsonField(row.assumptions_json, []),
    openQuestions: parseJsonField(row.open_questions_json, []),
    learningStrength: row.learning_strength,
    verificationFlag: row.verification_flag || undefined,
    sourceCategory: row.source_category || undefined,
    sourceType: row.source_type || undefined,
    evidenceWeight: row.evidence_weight || undefined,
    commercialRelevance: row.commercial_relevance || undefined,
    verificationStatus: row.verification_status || undefined,
  };
}

// ---------- Decisions ----------

function rowToDecision(row: any) {
  return {
    id: row.id,
    code: row.code,
    domain: row.domain,
    title: row.title,
    problemStatement: row.problem_statement,
    associatedRecordCode: row.associated_record_code,
    approvalClass: row.approval_class,
    approvalStatus: row.approval_status,
    approverRequired: row.approver_required,
    approvedBy: row.approved_by || undefined,
    approvedAt: row.approved_at || undefined,
    retrospective: row.retrospective,
    optionsConsidered: JSON.parse(row.options_considered_json),
    selectedOption: row.selected_option,
    rationale: row.rationale,
    confidence: { level: row.confidence_level, reason: row.confidence_reason },
    actionsDeliberatelyAvoided: parseJsonField(row.actions_avoided_json, []),
    risks: parseJsonField(row.risks_json, []),
    schemaFitNote: row.schema_fit_note || undefined,
    expectedOutcome: row.expected_outcome || undefined,
    measurementCriteria: row.measurement_criteria || undefined,
  };
}

// ---------- Outcomes ----------

function rowToOutcome(row: any) {
  return {
    id: row.id,
    code: row.code,
    domain: row.domain,
    decisionCode: row.decision_code,
    actionTaken: row.action_taken,
    actualOutcome: row.actual_outcome,
    dateEvaluated: row.date_evaluated,
    evaluator: row.evaluator,
    retrospective: row.retrospective,
    quantitativeResults: parseJsonField(row.quantitative_results_json, []),
    qualitativeResults: parseJsonField(row.qualitative_results_json, []),
    attributionConfidence: { level: row.attribution_confidence_level, reason: row.attribution_confidence_reason },
    unexpectedEffects: parseJsonField(row.unexpected_effects_json, []),
    resultingLearning: JSON.parse(row.resulting_learning_json),
  };
}

async function nextCode(env: Env, table: string, prefix: string): Promise<string> {
  const countRow = await env.DB.prepare(`SELECT COUNT(*) as n FROM ${table}`).first<{ n: number }>();
  const seq = (countRow?.n ?? 0) + 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // CHANGE: shared-secret auth, required before any public deployment.
    // Set via `wrangler secret put API_SECRET` -- never committed to the
    // repo. The frontend sends the same value via VITE_API_KEY, itself set
    // in .env.production, not committed either. This is a minimal gate
    // appropriate for a single-tenant internal tool, not a full user-auth
    // system -- it stops casual/automated discovery of the URL from reading
    // or writing data, which is what an unauthenticated public Worker
    // cannot prevent at all.
    const providedKey = request.headers.get('X-API-Key');
    if (!env.API_SECRET || providedKey !== env.API_SECRET) {
      return json({ error: 'Unauthorized' }, 401);
    }

    // ============================================================
    // NEWS / RSS -- new: reads a small, curated set of Google News RSS
    // search feeds (public, no API key) relevant to Iddav's context.
    // Read-only, server-side (RSS feeds generally don't support CORS for
    // direct browser fetches, which is why this lives in the backend).
    // ============================================================
    if (request.method === 'GET' && path === '/api/news/feed') {
      // CHANGE: switched from Google News RSS (confirmed blocked with a 503
      // for any Cloudflare-Workers-origin request, regardless of headers) to
      // real publisher feeds. Mongabay is a genuine environmental journalism
      // outlet whose RSS feeds are meant to be consumed programmatically.
      const feeds = [
        { url: 'https://india.mongabay.com/feed/', label: 'Mongabay India' },
        { url: 'https://news.mongabay.com/feed/', label: 'Mongabay Global' },
      ];

      const parser = new XMLParser({ ignoreAttributes: false });
      const allItems: { title: string; link: string; pubDate: string; source: string }[] = [];

      for (const feed of feeds) {
        try {
          const res = await fetch(feed.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          });
          if (!res.ok) continue;
          const xml = await res.text();
          const parsed = parser.parse(xml);
          const rawItems = parsed?.rss?.channel?.item;
          if (!rawItems) continue;
          const itemsArray = Array.isArray(rawItems) ? rawItems : [rawItems];
          for (const item of itemsArray.slice(0, 10)) {
            if (!item.title || !item.link) continue;
            allItems.push({
              title: String(item.title),
              link: String(item.link),
              pubDate: String(item.pubDate || ''),
              source: feed.label,
            });
          }
        } catch (err) {
          continue;
        }
      }

      allItems.sort((a, b) => {
        const da = new Date(a.pubDate).getTime() || 0;
        const db = new Date(b.pubDate).getTime() || 0;
        return db - da;
      });

      return json({ items: allItems.slice(0, 20) });
    }

    // ============================================================
    // AI ASSIST -- new: lets capture forms offer an optional, human-
    // reviewed draft improvement. Never runs automatically, never submits
    // on your behalf -- returns a suggestion the person explicitly accepts,
    // edits, or discards.
    // ============================================================
    if (request.method === 'GET' && path === '/api/ai/providers') {
      return json({
        claude: Boolean(env.ANTHROPIC_API_KEY),
        chatgpt: Boolean(env.OPENAI_API_KEY),
      });
    }

    if (request.method === 'POST' && path === '/api/ai/assist') {
      const body = await request.json<any>();
      const text = (body.text || '').trim();
      const provider = body.provider;
      if (!text) return json({ error: 'text is required' }, 400);
      if (provider !== 'claude' && provider !== 'chatgpt') return json({ error: 'provider must be "claude" or "chatgpt"' }, 400);

      const prompt = `You are helping polish a short piece of operational/field-observation text for a wildlife tourism business (Iddav WildStay / Sri Antra, near Tadoba Tiger Reserve, India). Improve clarity, fix grammar and typos, and remove or soften any inappropriate or unprofessional language. Preserve the original meaning and roughly the same length -- do not invent new facts, claims, or details that weren't in the original. Return ONLY the improved text, with no preamble, no quotation marks, and no explanation.\n\nOriginal text:\n${text}`;

      if (provider === 'claude') {
        if (!env.ANTHROPIC_API_KEY) return json({ error: 'Claude is not configured on this backend' }, 400);
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-5',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        if (!res.ok) {
          const errText = await res.text();
          return json({ error: `Claude API error: ${res.status} ${errText}` }, 502);
        }
        const data = await res.json<any>();
        const improved = data.content?.[0]?.text?.trim() || text;
        return json({ improved });
      }

      if (!env.OPENAI_API_KEY) return json({ error: 'ChatGPT is not configured on this backend' }, 400);
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        return json({ error: `ChatGPT API error: ${res.status} ${errText}` }, 502);
      }
      const data = await res.json<any>();
      const improved = data.choices?.[0]?.message?.content?.trim() || text;
      return json({ improved });
    }

    // ============================================================
    // INBOX
    // ============================================================
    if (request.method === 'GET' && path === '/api/inbox') {
      const { results } = await env.DB.prepare('SELECT * FROM inbox_items ORDER BY created_at DESC').all();
      return json((results || []).map(rowToInboxItem));
    }

    if (request.method === 'POST' && path === '/api/inbox') {
      const body = await request.json<any>();
      const id = `inbox-${Date.now()}`;
      const code = await nextCode(env, 'inbox_items', 'INB');

      await env.DB.prepare(
        `INSERT INTO inbox_items
           (id, code, domain, type, date, summary, origin, submitted_by, submitter_role,
            confidence_level, confidence_reason, retrospective, status, full_text,
            source_reference, attachments_json, source_category, source_type, verification_status,
            evidence_weight, commercial_relevance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id, code, 'iddav-marketing-intelligence', body.type, body.date, body.summary, body.origin,
          body.submittedBy, body.submitterRole, body.confidence?.level ?? null, body.confidence?.reason ?? null,
          body.retrospective, body.status ?? 'pending', body.fullText, body.sourceReference ?? null,
          body.attachments ? JSON.stringify(body.attachments) : null, body.sourceCategory ?? null, body.sourceType ?? null,
          body.verificationStatus ?? 'unverified', body.evidenceWeight ?? null, body.commercialRelevance ?? null
        )
        .run();

      const row = await env.DB.prepare('SELECT * FROM inbox_items WHERE id = ?').bind(id).first();
      return json(rowToInboxItem(row), 201);
    }

    const inboxPatchMatch = path.match(/^\/api\/inbox\/([^/]+)$/);
    if (request.method === 'PATCH' && inboxPatchMatch) {
      const id = inboxPatchMatch[1];
      const body = await request.json<any>();
      // CHANGE: status and verificationStatus now update independently --
      // a triage action never has to touch both, matching the same pattern
      // already used for /api/records.
      const fields: string[] = [];
      const values: any[] = [];
      if (body.status) { fields.push('status = ?'); values.push(body.status); }
      if (body.verificationStatus) { fields.push('verification_status = ?'); values.push(body.verificationStatus); }
      if (fields.length === 0) return json({ error: 'status or verificationStatus is required' }, 400);
      values.push(id);
      await env.DB.prepare(`UPDATE inbox_items SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
      const row = await env.DB.prepare('SELECT * FROM inbox_items WHERE id = ?').bind(id).first();
      if (!row) return json({ error: 'not found' }, 404);
      return json(rowToInboxItem(row));
    }

    // ============================================================
    // INTELLIGENCE RECORDS
    // ============================================================
    if (request.method === 'GET' && path === '/api/records') {
      const { results } = await env.DB.prepare('SELECT * FROM intelligence_records ORDER BY created_at DESC').all();
      return json((results || []).map(rowToRecord));
    }

    if (request.method === 'POST' && path === '/api/records') {
      const body = await request.json<any>();
      const id = `rec-${Date.now()}`;
      const code = await nextCode(env, 'intelligence_records', 'INT');
      const now = new Date().toISOString().replace('T', ' ').slice(0, 16);

      await env.DB.prepare(
        `INSERT INTO intelligence_records
           (id, code, domain, record_type, title, status, created_at, updated_at, author, author_role,
            observation_json, interpretation_json, linked_evidence_json, assumptions_json, open_questions_json,
            learning_strength, verification_flag, source_category, source_type, evidence_weight,
            commercial_relevance, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id, code, 'iddav-marketing-intelligence', body.recordType, body.title, body.status ?? 'under_review',
          body.createdAt ?? now, body.updatedAt ?? now, body.author, body.authorRole,
          JSON.stringify(body.observation), body.interpretation ? JSON.stringify(body.interpretation) : null,
          body.linkedEvidence ? JSON.stringify(body.linkedEvidence) : null,
          body.assumptions ? JSON.stringify(body.assumptions) : null,
          body.openQuestions ? JSON.stringify(body.openQuestions) : null,
          body.learningStrength ?? 'provisional', body.verificationFlag ?? null, body.sourceCategory ?? null,
          body.sourceType ?? null, body.evidenceWeight ?? null, body.commercialRelevance ?? null,
          body.verificationStatus ?? 'unverified'
        )
        .run();

      const row = await env.DB.prepare('SELECT * FROM intelligence_records WHERE id = ?').bind(id).first();
      return json(rowToRecord(row), 201);
    }

    const recordPatchMatch = path.match(/^\/api\/records\/([^/]+)$/);
    if (request.method === 'PATCH' && recordPatchMatch) {
      const id = recordPatchMatch[1];
      const body = await request.json<any>();
      const fields: string[] = [];
      const values: any[] = [];
      if (body.status) { fields.push('status = ?'); values.push(body.status); }
      if (body.verificationStatus) { fields.push('verification_status = ?'); values.push(body.verificationStatus); }
      if (body.interpretation) { fields.push('interpretation_json = ?'); values.push(JSON.stringify(body.interpretation)); }
      if (fields.length === 0) return json({ error: 'no updatable fields provided' }, 400);
      fields.push('updated_at = ?');
      values.push(new Date().toISOString().replace('T', ' ').slice(0, 16));
      values.push(id);
      await env.DB.prepare(`UPDATE intelligence_records SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
      const row = await env.DB.prepare('SELECT * FROM intelligence_records WHERE id = ?').bind(id).first();
      if (!row) return json({ error: 'not found' }, 404);
      return json(rowToRecord(row));
    }

    // ============================================================
    // DECISIONS
    // ============================================================
    if (request.method === 'GET' && path === '/api/decisions') {
      const { results } = await env.DB.prepare('SELECT * FROM decision_items ORDER BY inserted_at DESC').all();
      return json((results || []).map(rowToDecision));
    }

    if (request.method === 'POST' && path === '/api/decisions') {
      const body = await request.json<any>();
      const id = `dec-${Date.now()}`;
      const code = await nextCode(env, 'decision_items', 'DEC');

      await env.DB.prepare(
        `INSERT INTO decision_items
           (id, code, domain, title, problem_statement, associated_record_code, approval_class, approval_status,
            approver_required, approved_by, approved_at, retrospective, options_considered_json, selected_option,
            rationale, confidence_level, confidence_reason, actions_avoided_json, risks_json, schema_fit_note,
            expected_outcome, measurement_criteria)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id, code, 'iddav-marketing-intelligence', body.title, body.problemStatement, body.associatedRecordCode,
          body.approvalClass, body.approvalStatus ?? 'pending', body.approverRequired, body.approvedBy ?? null,
          body.approvedAt ?? null, body.retrospective, JSON.stringify(body.optionsConsidered), body.selectedOption,
          body.rationale, body.confidence?.level, body.confidence?.reason,
          body.actionsDeliberatelyAvoided ? JSON.stringify(body.actionsDeliberatelyAvoided) : null,
          body.risks ? JSON.stringify(body.risks) : null, body.schemaFitNote ?? null,
          body.expectedOutcome ?? null, body.measurementCriteria ?? null
        )
        .run();

      const row = await env.DB.prepare('SELECT * FROM decision_items WHERE id = ?').bind(id).first();
      return json(rowToDecision(row), 201);
    }

    const decisionPatchMatch = path.match(/^\/api\/decisions\/([^/]+)$/);
    if (request.method === 'PATCH' && decisionPatchMatch) {
      const id = decisionPatchMatch[1];
      const body = await request.json<any>();
      if (!body.approvalStatus) return json({ error: 'approvalStatus is required' }, 400);
      await env.DB.prepare(
        'UPDATE decision_items SET approval_status = ?, approved_by = ?, approved_at = ? WHERE id = ?'
      )
        .bind(body.approvalStatus, body.approvedBy ?? null, body.approvedAt ?? null, id)
        .run();
      const row = await env.DB.prepare('SELECT * FROM decision_items WHERE id = ?').bind(id).first();
      if (!row) return json({ error: 'not found' }, 404);
      return json(rowToDecision(row));
    }

    // ============================================================
    // OUTCOMES
    // ============================================================
    if (request.method === 'GET' && path === '/api/outcomes') {
      const { results } = await env.DB.prepare('SELECT * FROM outcome_items ORDER BY inserted_at DESC').all();
      return json((results || []).map(rowToOutcome));
    }

    if (request.method === 'POST' && path === '/api/outcomes') {
      const body = await request.json<any>();
      const id = `out-${Date.now()}`;
      const code = await nextCode(env, 'outcome_items', 'OUT');

      await env.DB.prepare(
        `INSERT INTO outcome_items
           (id, code, domain, decision_code, action_taken, actual_outcome, date_evaluated, evaluator, retrospective,
            quantitative_results_json, qualitative_results_json, attribution_confidence_level,
            attribution_confidence_reason, unexpected_effects_json, resulting_learning_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          id, code, 'iddav-marketing-intelligence', body.decisionCode, body.actionTaken, body.actualOutcome,
          body.dateEvaluated, body.evaluator, body.retrospective,
          body.quantitativeResults ? JSON.stringify(body.quantitativeResults) : null,
          body.qualitativeResults ? JSON.stringify(body.qualitativeResults) : null,
          body.attributionConfidence?.level, body.attributionConfidence?.reason,
          body.unexpectedEffects ? JSON.stringify(body.unexpectedEffects) : null,
          JSON.stringify(body.resultingLearning)
        )
        .run();

      const row = await env.DB.prepare('SELECT * FROM outcome_items WHERE id = ?').bind(id).first();
      return json(rowToOutcome(row), 201);
    }

    return json({ error: 'not found' }, 404);
  },
};
