/**
 * Per-prospect tracked redirect for the Flowing Founder Masterclass campaign.
 *
 *   GET /r/:slug?utm_source=...&utm_medium=...&name=...
 *
 * Logs the click to PAGES_KV under key `click:<isoTimestamp>:<slug>` and
 * issues a 302 to Michela's registration page with all incoming query
 * parameters preserved (so any UTMs land at the destination too).
 *
 * The dump endpoint:
 *
 *   GET /api/clicks?key=<CLICK_LOG_KEY>
 *
 * Returns the click log as a JSON array. `key` must match the
 * CLICK_LOG_KEY env var on the worker.
 */
import { Hono } from "hono";
import type { AppBindings } from "../types.js";

// Fallback destination for older worker configs that don't set
// REDIRECT_DESTINATION in [vars]. Keeps Michela's flowingfounder worker working
// without any toml change. New deployments (talentgreenhouse, future ones)
// should set REDIRECT_DESTINATION explicitly so this fallback never fires for
// them.
const REDIRECT_DESTINATION_FALLBACK = "https://michelaquilici.aweb.page/scaling";

const redirect = new Hono<AppBindings>();

redirect.get("/r/:slug", async (c) => {
  const slug = c.req.param("slug");
  const url = new URL(c.req.url);
  const destination = c.env.REDIRECT_DESTINATION ?? REDIRECT_DESTINATION_FALLBACK;

  // Log the click. Eventual consistency is fine for a tracking log.
  const now = new Date();
  const ts = now.toISOString();
  const params: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { params[k] = v; });

  const entry = {
    slug,
    timestamp: ts,
    stage: "landing",                       // this hop = clicked through to the landing page
    variant: params.v ?? "",                // usually blank here; inferred by joining to the /o open
    utm_source: params.utm_source ?? "",
    utm_medium: params.utm_medium ?? "",
    utm_campaign: params.utm_campaign ?? "",
    utm_content: params.utm_content ?? "",
    name: params.name ?? "",
    referer: c.req.header("referer") ?? "",
    user_agent: c.req.header("user-agent") ?? "",
    country: c.req.header("cf-ipcountry") ?? "",
  };

  // Fire-and-forget write so the redirect isn't blocked on KV latency.
  c.executionCtx.waitUntil(
    c.env.PAGES_KV.put(`click:${ts}:${slug}`, JSON.stringify(entry))
      .catch((err) => console.error({ event: "click_log_write_failed", slug, error: String(err) })),
  );

  // Build the destination URL with attribution UTMs so the landing page can tie
  // a registration back to this exact prospect. Start from the real destination
  // (which may already carry its own query), merge any params that came in on
  // the /r/ link (those win), then fill in campaign defaults for anything still
  // unset. utm_content is the per-prospect slug — the join key for the funnel's
  // "registered" row. This attributes every published page, including the ones
  // published before UTMs existed, with no re-render.
  const out = new URL(destination);
  url.searchParams.forEach((v, k) => { out.searchParams.set(k, v); });
  const defaults: Record<string, string> = {
    utm_source: "linkedin",
    utm_medium: "dm",
    utm_campaign: c.env.REDIRECT_UTM_CAMPAIGN ?? "workshop_invitation",
    utm_content: slug,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (!out.searchParams.has(k)) out.searchParams.set(k, v);
  }

  // 303 See Other — explicitly tells the client to GET the new URL. Cleaner
  // semantics than 302 for "this is a tracking shim, here's the real page."
  return c.redirect(out.toString(), 303);
});

// GET /o/:slug — tracked "open" of a personalized invitation. Logs who opened
// and which DM version (?v=a|b), then 302s to their invitation page /p/:slug.
// Use it by pointing the DM link at /o/:slug?v=a instead of /p/:slug directly:
// invitation opens become attributable per prospect + variant. The /r hop still
// tracks the click through to the landing page; join a /r click to this /o open
// by slug to recover the variant (one prospect = one version). Logged under the
// same `click:` prefix with stage:"open" so /api/clicks returns both.
redirect.get("/o/:slug", async (c) => {
  const slug = c.req.param("slug");
  const url = new URL(c.req.url);
  const ts = new Date().toISOString();
  const entry = {
    slug,
    timestamp: ts,
    stage: "open",
    variant: url.searchParams.get("v") ?? "",
    utm_content: slug,
    referer: c.req.header("referer") ?? "",
    user_agent: c.req.header("user-agent") ?? "",
    country: c.req.header("cf-ipcountry") ?? "",
  };
  c.executionCtx.waitUntil(
    c.env.PAGES_KV.put(`click:${ts}:${slug}`, JSON.stringify(entry))
      .catch((err) => console.error({ event: "open_log_write_failed", slug, error: String(err) })),
  );
  return c.redirect(new URL(`/p/${encodeURIComponent(slug)}`, url.origin).toString(), 302);
});

export { redirect };
