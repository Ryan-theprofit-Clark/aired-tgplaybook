/**
 * The Mirror diagnostic quiz — mirror.marketmessiahmethod.com
 *
 * Enabled only on workers whose config sets MIRROR_QUIZ = "1"
 * (wrangler.mirror.toml). On every other tenant these routes call next()
 * and pass through untouched, so the shared codebase stays multi-tenant.
 *
 *   GET  /d/:slug              — slugged quiz: greets by name, prefills the
 *                                gate from KV `prospect:<slug>` (seeded by
 *                                the-mirror-outreach/engine/seed_prospects.py).
 *                                Unknown slug falls back to the generic quiz.
 *   GET  /start                — generic quiz (organic / shared-link path).
 *   GET  /                     — 302 -> /start
 *   POST /api/mirror/capture   — partial capture fired on every screen
 *                                transition. Upserts KV `mirror:<sid>` with the
 *                                full snapshot; latest snapshot wins, so a
 *                                killed tab still leaves a lead with whatever
 *                                answers it had (stage: started/gated/completed).
 *   GET  /api/mirror/leads?key=  — dump lead snapshots (CLICK_LOG_KEY guard,
 *                                same scheme as /api/clicks). Pulled by
 *                                pull_leads.py into mirror_leads.json.
 *   GET  /api/mirror/views?key=  — dump quiz page views: the funnel's
 *                                "link tap" row, with dm_variant from ?v=
 *                                (Wally's UTM attribution pattern).
 */
import { Hono } from "hono";
import type { AppBindings } from "../types.js";
import { QUIZ_HTML } from "../quiz/mirror-quiz.js";

const mirror = new Hono<AppBindings>();

const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.slice(0, max) : "";

// Double-stringify -> a JS string literal holding JSON; the page JSON.parses
// it. <-escape so "</script>" inside prospect data can't break out.
function bootLiteral(boot: Record<string, unknown>): string {
  return JSON.stringify(JSON.stringify(boot)).replace(/</g, "\\u003c");
}

// DM variant (A/B cell) — from the path (/d/:slug/m1) or the ?v= query fallback.
function sanitizeVariant(pathVariant: string | undefined | null, url: URL): string {
  const raw = pathVariant || url.searchParams.get("v") || "";
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
}

async function serveQuiz(c: any, boot: Record<string, unknown>, viewSlug: string): Promise<Response> {
  // View log — the funnel's "link tap" row. Fire-and-forget like click logging.
  const ts = new Date().toISOString();
  const entry = {
    slug: viewSlug,
    dm_variant: (boot.dm_variant as string) || "",
    timestamp: ts,
    referer: c.req.header("referer") ?? "",
    user_agent: c.req.header("user-agent") ?? "",
    country: c.req.header("cf-ipcountry") ?? "",
  };
  c.executionCtx.waitUntil(
    c.env.PAGES_KV.put(`mirrorview:${ts}:${viewSlug || "start"}`, JSON.stringify(entry))
      .catch((err: unknown) => console.error({ event: "mirror_view_log_failed", error: String(err) })),
  );

  const html = QUIZ_HTML.replace("'__MIRROR_BOOT__'", bootLiteral(boot));
  return c.html(html);
}

mirror.get("/", async (c, next) => {
  if (c.env.MIRROR_QUIZ !== "1") return next();
  return c.redirect("/start", 302);
});

mirror.get("/start", async (c, next) => {
  if (c.env.MIRROR_QUIZ !== "1") return next();
  const variant = sanitizeVariant(null, new URL(c.req.url));
  return serveQuiz(c, { mode: "generic", slug: "", first: "", name: "", linkedin: "", dm_variant: variant }, "");
});

async function serveSlugged(c: any, rawSlug: string, variant: string): Promise<Response> {
  const slug = rawSlug.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64);
  let boot: Record<string, unknown> = { mode: "generic", slug, first: "", name: "", linkedin: "", dm_variant: variant };
  if (slug) {
    const raw = await c.env.PAGES_KV.get(`prospect:${slug}`);
    if (raw !== null) {
      try {
        const p = JSON.parse(raw) as Record<string, unknown>;
        boot = {
          mode: "slugged",
          slug,
          first: str(p.first, 80),
          name: str(p.name, 160),
          linkedin: str(p.linkedin, 300),
          dm_variant: variant,
        };
      } catch {
        // corrupt prospect row -> generic quiz, keep the slug + variant for attribution
      }
    }
  }
  return serveQuiz(c, boot, slug);
}

// Variant in the PATH (/d/:slug/m1) is the primary A/B form — cleaner in DMs and
// survives LinkedIn's linkifier better than a ?v= query string. ?v= still works.
mirror.get("/d/:slug/:variant", async (c, next) => {
  if (c.env.MIRROR_QUIZ !== "1") return next();
  return serveSlugged(c, c.req.param("slug"), sanitizeVariant(c.req.param("variant"), new URL(c.req.url)));
});

mirror.get("/d/:slug", async (c, next) => {
  if (c.env.MIRROR_QUIZ !== "1") return next();
  return serveSlugged(c, c.req.param("slug"), sanitizeVariant(null, new URL(c.req.url)));
});

mirror.post("/api/mirror/capture", async (c, next) => {
  if (c.env.MIRROR_QUIZ !== "1") return next();

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const b = body as Record<string, unknown>;

  const sid = str(b.sid, 64);
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(sid)) {
    return c.json({ error: "sid is required" }, 400);
  }
  const stage = b.stage === "gated" || b.stage === "completed" ? b.stage : "started";

  const entry = {
    sid,
    slug: str(b.slug, 64),
    dm_variant: str(b.dm_variant, 32),
    stage,
    q1: str(b.q1, 200),
    q2: str(b.q2, 200),
    q3: Array.isArray(b.q3)
      ? b.q3.filter((x) => typeof x === "string").slice(0, 8).map((x) => String(x).slice(0, 120))
      : [],
    q4: str(b.q4, 200),
    q5: str(b.q5, 1200),
    name: str(b.name, 160),
    email: str(b.email, 200),
    linkedin: str(b.linkedin, 300),
    profile: str(b.profile, 80),
    started_ts: typeof b.started_ts === "number" ? b.started_ts : null,
    ts: new Date().toISOString(),
    referer: c.req.header("referer") ?? "",
    user_agent: c.req.header("user-agent") ?? "",
    country: c.req.header("cf-ipcountry") ?? "",
  };

  c.executionCtx.waitUntil(
    c.env.PAGES_KV.put(`mirror:${sid}`, JSON.stringify(entry))
      .catch((err) => console.error({ event: "mirror_capture_write_failed", sid, error: String(err) })),
  );

  return c.json({ ok: true });
});

// Shared dump helper for the two KV prefixes.
async function dumpPrefix(c: any, prefix: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page: KVNamespaceListResult<unknown, string> = await c.env.PAGES_KV.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await c.env.PAGES_KV.get(k.name);
      if (raw !== null) {
        try { entries.push(JSON.parse(raw)); } catch { /* skip corrupt */ }
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  entries.sort((a: any, b: any) => ((b?.ts ?? b?.timestamp ?? "") as string).localeCompare((a?.ts ?? a?.timestamp ?? "") as string));
  return entries;
}

mirror.get("/api/mirror/leads", async (c, next) => {
  if (c.env.MIRROR_QUIZ !== "1") return next();
  const provided = c.req.query("key") ?? "";
  const expected = c.env.CLICK_LOG_KEY ?? "";
  if (!expected || provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const leads = await dumpPrefix(c, "mirror:");
  return c.json({ count: leads.length, leads });
});

mirror.get("/api/mirror/views", async (c, next) => {
  if (c.env.MIRROR_QUIZ !== "1") return next();
  const provided = c.req.query("key") ?? "";
  const expected = c.env.CLICK_LOG_KEY ?? "";
  if (!expected || provided !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const views = await dumpPrefix(c, "mirrorview:");
  return c.json({ count: views.length, views });
});

// GET /api/mirror/artifact-views?key=<CLICK_LOG_KEY>[&bots=1]
// Opens of the published Mirror pages (`mview:` rows written by routes/viewer.ts)
// — the Mirror-first funnel's "link tap", replacing the retired quiz view log.
// Reads straight out of KV list() metadata, so it stays one request per 1000
// rows instead of one per row (see dumpPrefix above, which does the latter).
// Bot hits (LinkedIn's link-preview fetch, curl, crawlers) are excluded unless
// bots=1 — otherwise every prospect shows a phantom open the moment the DM sends.
mirror.get("/api/mirror/artifact-views", async (c, next) => {
  if (c.env.MIRROR_QUIZ !== "1") return next();
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
      await c.env.PAGES_KV.list({ prefix: "mview:", cursor, limit: 1000 });
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

export { mirror };
