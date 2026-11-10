import { Hono } from "hono";
import type { AppBindings } from "../types.js";
import { loadStats, saveStats } from "../lib/stats.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import {
  generateId,
  generateToken,
  hashToken,
  verifyToken,
  validateHtml,
  extractTitle,
  parseMetadata,
  serializeMetadata,
  DEFAULT_TTL,
} from "@aired/core";
import type { PageMetadata } from "@aired/core";

const api = new Hono<AppBindings>();

// POST /api/publish — create a new page or update an existing one via update_token
api.post("/publish", rateLimitMiddleware, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }

  const req = body as Record<string, unknown>;
  const { html, title, pin, ttl, reads, permanent, update_token, id: existingId, slug: requestedSlug } = req;

  if (typeof html !== "string") {
    return c.json({ error: "html is required and must be a string" }, 400);
  }

  const validation = validateHtml(html);
  if (!validation.ok) {
    return c.json({ error: validation.error }, 400);
  }

  const resolvedTitle =
    (typeof title === "string" && title.trim() ? title.trim() : null) ??
    extractTitle(html);

  const origin = new URL(c.req.url).origin;

  // Update path: update_token + id provided
  if (typeof update_token === "string" && typeof existingId === "string") {
    const raw = await c.env.PAGES_KV.get(`page:${existingId}`);
    if (raw === null) {
      return c.json({ error: "Page not found" }, 404);
    }

    const metadata = parseMetadata(raw);
    if (metadata === null) {
      return c.json({ error: "Page metadata is corrupted" }, 500);
    }

    const valid = await verifyToken(update_token, metadata.tokenHash);
    if (!valid) {
      return c.json({ error: "Invalid update token" }, 403);
    }

    await c.env.PAGES_BUCKET.put(`pages/${existingId}/index.html`, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });

    const now = new Date();
    const ttlSeconds = metadata.permanent ? null : DEFAULT_TTL;
    const expiresAt = ttlSeconds !== null
      ? new Date(now.getTime() + ttlSeconds * 1000).toISOString()
      : null;

    const updated: PageMetadata = {
      ...metadata,
      title: resolvedTitle ?? metadata.title,
      size: new TextEncoder().encode(html).byteLength,
      expiresAt,
    };

    const kvOptions: KVNamespacePutOptions = {};
    if (ttlSeconds !== null) {
      kvOptions.expirationTtl = ttlSeconds;
    }
    await c.env.PAGES_KV.put(`page:${existingId}`, serializeMetadata(updated), kvOptions);

    return c.json({
      id: existingId,
      url: `${origin}/p/${existingId}`,
      update_token,
      expiresAt,
    });
  }

  // Create path: new page
  // Optional custom slug — sanitized to [a-z0-9-], max 64 chars, must not collide.
  let id: string;
  if (typeof requestedSlug === "string" && requestedSlug.length > 0) {
    const sanitized = requestedSlug
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (!sanitized) {
      return c.json({ error: "slug must contain at least one alphanumeric character" }, 400);
    }
    const collision = await c.env.PAGES_KV.get(`page:${sanitized}`);
    if (collision !== null) {
      return c.json({ error: `slug "${sanitized}" already exists`, code: "slug_collision" }, 409);
    }
    id = sanitized;
  } else {
    id = generateId();
  }

  const token = generateToken();
  const tokenHash = await hashToken(token);

  const isPermanent = permanent === true;
  const ttlSeconds =
    isPermanent ? null
    : typeof ttl === "number" && ttl > 0 ? Math.floor(ttl)
    : DEFAULT_TTL;

  const now = new Date();
  const expiresAt = ttlSeconds !== null
    ? new Date(now.getTime() + ttlSeconds * 1000).toISOString()
    : null;

  const metadata: PageMetadata = {
    id,
    title: resolvedTitle,
    size: new TextEncoder().encode(html).byteLength,
    tokenHash,
    pin: typeof pin === "string" && pin.length > 0 ? pin : null,
    reads: typeof reads === "number" && reads > 0 ? Math.floor(reads) : null,
    readCount: 0,
    permanent: isPermanent,
    createdAt: now.toISOString(),
    expiresAt,
  };

  try {
    await c.env.PAGES_BUCKET.put(`pages/${id}/index.html`, html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("limit exceeded")) {
      return c.json({ error: "Service temporarily unavailable — storage write limit reached. Try again later." }, 503);
    }
    throw err;
  }

  const kvOptions: KVNamespacePutOptions = {};
  if (ttlSeconds !== null) {
    kvOptions.expirationTtl = ttlSeconds;
  }

  try {
    await c.env.PAGES_KV.put(`page:${id}`, serializeMetadata(metadata), kvOptions);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("limit exceeded")) {
      // HTML is in R2 but metadata failed — clean up
      await c.env.PAGES_BUCKET.delete(`pages/${id}/index.html`).catch(() => {});
      return c.json({ error: "Service temporarily unavailable — storage write limit reached. Try again later." }, 503);
    }
    throw err;
  }

  // Increment publish counter (fire-and-forget)
  c.executionCtx.waitUntil(
    (async () => {
      const stats = await loadStats(c.env.PAGES_KV);
      stats.publishes += 1;
      await saveStats(c.env.PAGES_KV, stats);
    })().catch(() => {}),
  );

  return c.json({
    id,
    url: `${origin}/p/${id}`,
    update_token: token,
    expiresAt,
  });
});

// PUT /api/pages/:id — update by token
api.put("/pages/:id", async (c) => {
  const id = c.req.param("id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }

  const { html, title, update_token } = body as Record<string, unknown>;

  if (typeof html !== "string") {
    return c.json({ error: "html is required and must be a string" }, 400);
  }
  if (typeof update_token !== "string") {
    return c.json({ error: "update_token is required" }, 400);
  }

  const validation = validateHtml(html);
  if (!validation.ok) {
    return c.json({ error: validation.error }, 400);
  }

  const resolvedTitle =
    (typeof title === "string" && title.trim() ? title.trim() : null) ??
    extractTitle(html);

  const raw = await c.env.PAGES_KV.get(`page:${id}`);
  if (raw === null) {
    return c.json({ error: "Page not found" }, 404);
  }

  const metadata = parseMetadata(raw);
  if (metadata === null) {
    return c.json({ error: "Page metadata is corrupted" }, 500);
  }

  const valid = await verifyToken(update_token, metadata.tokenHash);
  if (!valid) {
    return c.json({ error: "Invalid update token" }, 403);
  }

  await c.env.PAGES_BUCKET.put(`pages/${id}/index.html`, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });

  const now = new Date();
  const ttlSeconds = metadata.permanent ? null : DEFAULT_TTL;
  const expiresAt = ttlSeconds !== null
    ? new Date(now.getTime() + ttlSeconds * 1000).toISOString()
    : null;

  const updated: PageMetadata = {
    ...metadata,
    title: resolvedTitle ?? metadata.title,
    size: new TextEncoder().encode(html).byteLength,
    expiresAt,
  };

  const kvOptions: KVNamespacePutOptions = {};
  if (ttlSeconds !== null) {
    kvOptions.expirationTtl = ttlSeconds;
  }
  await c.env.PAGES_KV.put(`page:${id}`, serializeMetadata(updated), kvOptions);

  const origin = new URL(c.req.url).origin;

  return c.json({
    id,
    url: `${origin}/p/${id}`,
    update_token,
    expiresAt,
  });
});

// DELETE /api/pages/:id — delete by token in Authorization header
api.delete("/pages/:id", async (c) => {
  const id = c.req.param("id");
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Authorization: Bearer <token> is required" }, 401);
  }

  const token = authHeader.slice("Bearer ".length).trim();

  const raw = await c.env.PAGES_KV.get(`page:${id}`);
  if (raw === null) {
    return c.json({ error: "Page not found" }, 404);
  }

  const metadata = parseMetadata(raw);
  if (metadata === null) {
    return c.json({ error: "Page metadata is corrupted" }, 500);
  }

  const valid = await verifyToken(token, metadata.tokenHash);
  if (!valid) {
    return c.json({ error: "Invalid token" }, 403);
  }

  await Promise.all([
    c.env.PAGES_BUCKET.delete(`pages/${id}/index.html`),
    c.env.PAGES_KV.delete(`page:${id}`),
  ]);

  return c.json({ ok: true });
});

// GET /api/pages/:id — public metadata (no token required)
api.get("/pages/:id", async (c) => {
  const id = c.req.param("id");

  const raw = await c.env.PAGES_KV.get(`page:${id}`);
  if (raw === null) {
    return c.json({ error: "Page not found" }, 404);
  }

  const metadata = parseMetadata(raw);
  if (metadata === null) {
    return c.json({ error: "Page metadata is corrupted" }, 500);
  }

  return c.json({
    id: metadata.id,
    title: metadata.title,
    size: metadata.size,
    readCount: metadata.readCount,
    expiresAt: metadata.expiresAt,
  });
});

// GET /api/stats — public stats
api.get("/stats", async (c) => {
  const stats = await loadStats(c.env.PAGES_KV);
  return c.json({
    publishes: stats.publishes,
    views: stats.views,
    recent: stats.recent,
    geo: stats.geo,
  });
});

// GET /api/clicks — dump every click logged by the /r/:slug redirect.
// Protected by a query-string key (CLICK_LOG_KEY env var on the worker).
// Used by dump_clicks.py to produce attribution CSVs.
api.get("/clicks", async (c) => {
  const provided = c.req.query("key") ?? "";
  const expected = c.env.CLICK_LOG_KEY ?? "";
  if (!expected || provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // KV list pagination — fetch all keys under the "click:" prefix.
  const entries: unknown[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page: KVNamespaceListResult<unknown, string> = await c.env.PAGES_KV.list({ prefix: "click:", cursor });
    for (const k of page.keys) {
      const raw = await c.env.PAGES_KV.get(k.name);
      if (raw !== null) {
        try { entries.push(JSON.parse(raw)); } catch { /* skip corrupt */ }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  // Sort newest first for convenience
  entries.sort((a: any, b: any) => (b?.timestamp ?? "").localeCompare(a?.timestamp ?? ""));

  return c.json({ count: entries.length, clicks: entries });
});

// GET /api/invite-views?key=<CLICK_LOG_KEY>[&bots=1] — every open of a Sovereign
// Executive Advantage invitation (`sview:` rows written by routes/viewer.ts), read
// from KV list() metadata so it is one request per 1000 rows. Bot hits (LinkedIn's
// link-preview fetch, crawlers) are left out unless bots=1.
api.get("/invite-views", async (c) => {
  const provided = c.req.query("key") ?? "";
  const expected = c.env.CLICK_LOG_KEY ?? "";
  if (!expected || provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const includeBots = c.req.query("bots") === "1";
  const views: unknown[] = [];
  let bots = 0;
  let cursor: string | undefined = undefined;
  do {
    const page: KVNamespaceListResult<Record<string, unknown>, string> =
      await c.env.PAGES_KV.list({ prefix: "sview:", cursor, limit: 1000 });
    for (const k of page.keys) {
      const m = k.metadata;
      if (!m) continue;
      if (m.bot) {
        bots += 1;
        if (!includeBots) continue;
      }
      views.push(m);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  views.sort((a: any, b: any) => String(b?.ts ?? "").localeCompare(String(a?.ts ?? "")));
  return c.json({ count: views.length, botsExcluded: includeBots ? 0 : bots, views });
});

// POST /api/quiz — log a diagnostic-quiz completion from an invitation page.
// Public (same-origin from the page), fire-and-forget, mirrors click logging.
// Body: { slug, pattern, answers?: string[] }. Stored under `quiz:<ts>:<slug>`.
api.post("/quiz", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const { slug, pattern, answers } = body as Record<string, unknown>;
  if (typeof slug !== "string" || slug.trim().length === 0) {
    return c.json({ error: "slug is required" }, 400);
  }
  if (typeof pattern !== "string" || pattern.trim().length === 0) {
    return c.json({ error: "pattern is required" }, 400);
  }

  const ts = new Date().toISOString();
  const entry = {
    slug: slug.trim().slice(0, 200),
    pattern: pattern.trim().slice(0, 120),
    // Keep answers small and defensive: strings only, capped length and count.
    answers: Array.isArray(answers)
      ? answers.filter((a) => typeof a === "string").slice(0, 20).map((a) => String(a).slice(0, 200))
      : [],
    timestamp: ts,
    referer: c.req.header("referer") ?? "",
    user_agent: c.req.header("user-agent") ?? "",
    country: c.req.header("cf-ipcountry") ?? "",
  };

  c.executionCtx.waitUntil(
    c.env.PAGES_KV.put(`quiz:${ts}:${entry.slug}`, JSON.stringify(entry))
      .catch((err) => console.error({ event: "quiz_log_write_failed", slug: entry.slug, error: String(err) })),
  );

  return c.json({ ok: true });
});

// GET /api/quiz-results — dump every quiz completion logged by POST /api/quiz.
// Protected by the same CLICK_LOG_KEY as /api/clicks. Used by dump_quiz.py.
api.get("/quiz-results", async (c) => {
  const provided = c.req.query("key") ?? "";
  const expected = c.env.CLICK_LOG_KEY ?? "";
  if (!expected || provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const entries: unknown[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page: KVNamespaceListResult<unknown, string> = await c.env.PAGES_KV.list({ prefix: "quiz:", cursor });
    for (const k of page.keys) {
      const raw = await c.env.PAGES_KV.get(k.name);
      if (raw !== null) {
        try { entries.push(JSON.parse(raw)); } catch { /* skip corrupt */ }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  entries.sort((a: any, b: any) => (b?.timestamp ?? "").localeCompare(a?.timestamp ?? ""));
  return c.json({ count: entries.length, results: entries });
});

export { api };
