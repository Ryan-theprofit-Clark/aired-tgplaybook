/**
 * Workshop sign-up from a page on this worker straight into the client's systeme.io account.
 * First for Wendy Rosenthal's Sovereign Executive Advantage workshop (Ryan, 2026-11-06: "create a webpage for the
 * workshop, and host it on the domain we use for the invitations, and link that to systeme so that the sign up for
 * there works").
 *
 *   POST /api/signup   JSON { first, last, email, page, utm?: {utm_source, ...}, company (hidden field), ms }
 *
 * 1. Creates the contact with systeme's Public API (first_name, surname, email), or finds it when the email is
 *    already a contact (systeme answers 422).
 * 2. Adds the tag SYSTEME_SIGNUP_TAG_ID. An automation rule on that tag, inside systeme, then does what the client's
 *    own systeme form does (Wendy: the "October Lead" tag and the pre-webinar email sequence). Her page's reCAPTCHA
 *    form can't take posts from another site, so the tag is the hand-off.
 * 3. Logs every attempt in KV as `signup:<iso>:<rand>` with where it came from (utm, page), readable at
 *    GET /api/signups?key=<CLICK_LOG_KEY>. systeme's API keeps no source URL, so this log is the attribution.
 *
 * Off unless the worker has both SYSTEME_API_KEY (a wrangler secret) and SYSTEME_SIGNUP_TAG_ID (a var): every other
 * worker sharing this code answers 404. A hidden "company" field or a form sent under 2.5 seconds after the page
 * loaded is treated as a bot: logged, answered ok, nothing sent to systeme. Eight tries per IP per hour.
 */
import { Hono } from "hono";
import type { AppBindings } from "../types.js";

const SYSTEME = "https://api.systeme.io/api";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"];

const signup = new Hono<AppBindings>();

function clean(v: unknown, max = 80): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

async function systeme(key: string, method: string, path: string, body?: unknown) {
  const res = await fetch(SYSTEME + path, {
    method,
    headers: {
      "X-API-Key": key,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

signup.post("/signup", async (c) => {
  const key = c.env.SYSTEME_API_KEY;
  const tagId = Number(c.env.SYSTEME_SIGNUP_TAG_ID || 0);
  if (!key || !tagId) return c.json({ error: "Not found" }, 404);

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "bad_request" }, 400); }

  const first = clean(body?.first);
  const last = clean(body?.last);
  const email = clean(body?.email, 160).toLowerCase();
  const page = clean(body?.page, 120);
  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = clean(body?.utm?.[k], 200);
    if (v) utm[k] = v;
  }
  const ts = new Date().toISOString();
  const entry: Record<string, unknown> = {
    timestamp: ts, first, last, email, page, ...utm,
    country: c.req.header("cf-ipcountry") ?? "",
    user_agent: (c.req.header("user-agent") ?? "").slice(0, 200),
  };
  const log = (status: string, extra: Record<string, unknown> = {}) =>
    c.executionCtx.waitUntil(
      c.env.PAGES_KV.put(`signup:${ts}:${crypto.randomUUID().slice(0, 8)}`, JSON.stringify({ ...entry, status, ...extra }))
        .catch((err) => console.error({ event: "signup_log_write_failed", error: String(err) })),
    );

  // Bots: the hidden field filled in, or the form sent faster than a person can type a name and an email.
  if (clean(body?.company) || Number(body?.ms ?? 0) < 2500) {
    log("bot");
    return c.json({ ok: true });
  }
  if (!first || !last || !EMAIL_RE.test(email)) return c.json({ ok: false, error: "invalid" }, 400);

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const rlKey = `srl:${ip}`;
  const tries = Number((await c.env.PAGES_KV.get(rlKey)) ?? 0);
  if (tries >= 8) {
    log("rate_limited");
    return c.json({ ok: false, error: "slow_down" }, 429);
  }
  c.executionCtx.waitUntil(c.env.PAGES_KV.put(rlKey, String(tries + 1), { expirationTtl: 3600 }).catch(() => {}));

  try {
    let id: number | undefined;
    let existed = false;
    const made = await systeme(key, "POST", "/contacts", {
      email, locale: "en",
      fields: [{ slug: "first_name", value: first }, { slug: "surname", value: last }],
    });
    if (made.status === 201) {
      id = made.data?.id;
    } else if (made.status === 422) {
      // Already a contact (an earlier workshop, a newsletter): find them and tag them for this one.
      const found = await systeme(key, "GET", `/contacts?email=${encodeURIComponent(email)}&limit=10`);
      id = found.data?.items?.[0]?.id;
      existed = true;
    }
    if (!id) {
      log("systeme_error", { step: "contact", systeme_status: made.status, detail: JSON.stringify(made.data).slice(0, 300) });
      return c.json({ ok: false, error: "try_again" }, 502);
    }
    const tagged = await systeme(key, "POST", `/contacts/${id}/tags`, { tagId });
    // 204 = tagged now. 422 = they already carry the tag (they signed up before): still signed up, nothing re-sent.
    if (tagged.status !== 204 && tagged.status !== 200 && tagged.status !== 422) {
      log("systeme_error", { step: "tag", systeme_contact_id: id, systeme_status: tagged.status,
                             detail: JSON.stringify(tagged.data).slice(0, 300) });
      return c.json({ ok: false, error: "try_again" }, 502);
    }
    log(tagged.status === 422 ? "already_signed_up" : "ok", { systeme_contact_id: id, existed });
    return c.json({ ok: true });
  } catch (err) {
    log("worker_error", { detail: String(err).slice(0, 300) });
    return c.json({ ok: false, error: "try_again" }, 502);
  }
});

// GET /api/signups?key=<CLICK_LOG_KEY> — every sign-up attempt, newest first.
signup.get("/signups", async (c) => {
  const expected = c.env.CLICK_LOG_KEY ?? "";
  if (!expected || (c.req.query("key") ?? "") !== expected) return c.json({ error: "Unauthorized" }, 401);
  const rows: unknown[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page: KVNamespaceListResult<unknown, string> = await c.env.PAGES_KV.list({ prefix: "signup:", cursor });
    for (const k of page.keys) {
      const raw = await c.env.PAGES_KV.get(k.name);
      if (raw !== null) { try { rows.push(JSON.parse(raw)); } catch { /* skip */ } }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  rows.sort((a: any, b: any) => String(b?.timestamp ?? "").localeCompare(String(a?.timestamp ?? "")));
  return c.json({ count: rows.length, signups: rows });
});

export { signup };
