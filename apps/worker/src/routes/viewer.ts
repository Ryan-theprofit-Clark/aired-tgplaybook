import { Hono } from "hono";
import type { AppBindings } from "../types.js";
import { parseMetadata, serializeMetadata } from "@aired/core";
import { applyPageHeaders } from "../middleware/security.js";
import { loadStats, saveStats } from "../lib/stats.js";

const viewer = new Hono<AppBindings>();

// Paths reserved by the worker — never treat these as page slugs on the
// clean-URL hostname. Anything with a file extension is also reserved.
const RESERVED_ROOT_SLUGS = new Set([
  "health", "mcp", "p", "r", "api", "og",
  "start", "d", // Mirror diagnostic quiz routes (routes/mirror.ts)
  "favicon.ico", "robots.txt", "index.html", "app.js", "style.css",
]);

// Hosts on which a bare `/:slug` request serves a published page directly
// (i.e. without the `/p/` prefix). All other hosts keep the original
// `/p/:id` behavior so static assets at root paths still resolve.
function isCleanUrlHost(host: string | undefined | null): boolean {
  if (!host) return false;
  return (
    host.startsWith("mmi.") ||
    // Client proposals, served at bare /<client-slug>. Same worker, KV and R2
    // as mmi.*, so a page published via mmi. is reachable on both hosts.
    host.startsWith("proposal.") ||
    // Client project roadmaps (engagement timeline, deliverables, ownership).
    // Own host because a roadmap is a different asset type from a proposal, but
    // the same worker, KV and R2 (Ryan, 2026-09-03), so one slug namespace is
    // shared with mmi.* and proposal.* — roadmap slugs are `<client>-phase-<n>`.
    host.startsWith("roadmap.") ||
    // The Introduction: referral + reoffer pages for Ryan's coffee chats and
    // clients (Ryan, 2026-09-07). Same worker, KV and R2 — one slug namespace.
    host.startsWith("intro.") ||
    // The Playbook: podcast guest invitations (V2, 2026-09-03) publish with a
    // first-last slug and serve at bare /<first-last>. The 51 May-2026 pages at
    // /p/<id> keep working; /p/<slug> also still resolves.
    host.startsWith("podcast.") ||
    host === "invitation.milliondollarproducersession.com" ||
    // Bob Mathers "Your Next Five Moves" invitations, served at bare
    // /<first-last> (Ryan, 2026-08-14). /p/:slug still works as a fallback.
    host === "invitation.fivemovesworkshop.com" ||
    // Michela Quilici's Flowing Founder assets (referral partner page, workshop
    // invitations) serve at bare /<slug> (Ryan, 2026-08-20). The apex only hosts
    // the generic aired landing page, so nothing at root collides with a slug.
    // /p/:slug keeps working, so every link already sent stays valid.
    host === "flowingfounder.com" ||
    host === "www.flowingfounder.com" ||
    host === "invitation.flowingfounder.com" ||
    // Published Mirror artifacts serve at bare /<first-last> (P3 pipeline);
    // the diagnostic quiz owns /d/:slug and /start via routes/mirror.ts.
    host === "mirror.marketmessiahmethod.com" ||
    // The Prophecy (email funnel second asset) serves at bare /<first-last>
    // on its OWN tenant (wrangler.prophecy.toml, own KV+R2) so short slugs
    // cannot collide with the Mirror tenant's pages (Ryan, 2026-09-01).
    host === "prophecy.marketmessiahmethod.com" ||
    // O Espelho: the Brazilian Portuguese Mirror, serving at bare /<first-last>
    // on its OWN tenant (wrangler.espelho.toml, own KV+R2) so a Brazilian
    // prospect's slug cannot overwrite an English-campaign Mirror with the same
    // name (Ryan, 2026-09-21) — same reasoning as the Prophecy tenant above.
    host === "espelho.marketmessiahmethod.com" ||
    // John Whitt's Freedom Gambit invitations serve at bare /<first-last>
    // (Ryan, 2026-09-03). The 2,058 pages already sent in the June and August
    // rounds carry /p/<slug> links, and /p/:slug keeps working, so every link
    // already in someone's inbox stays valid.
    host === "invitation.thefreedomgambit.com" ||
    // Wendy Rosenthal's Sovereign Executive Advantage invitations serve at bare
    // /<first-last> from the Nov 5 round (Ryan, 2026-10-27). The June pages went
    // out as /p/<slug>, and /p/:slug keeps working, so those links stay valid.
    host === "invitation.the-sovereign-executive.com"
  );
}

// Mirror artifact view log — one row per page open, on the Mirror host only.
// The slug IS the prospect, so logging the slug alone is enough to attribute an
// open to a person and (offline, via mirror-send-list-v2.csv) to the A/B CTA
// version their page shipped with. Nothing needs to ride in the URL.
//
// The payload lives in KV *metadata*, not the value, so the dump endpoint can
// page through with list() alone — no get() per key. That per-key read is what
// makes the legacy `mirrorview:` dump (routes/mirror.ts dumpPrefix) time out.
//
// Bots are flagged, not dropped: LinkedIn fetches the page to build the DM link
// preview, so every prospect would otherwise show a phantom open at send time.
const VIEW_BOTS =
  /bot|crawler|spider|preview|facebookexternalhit|slackbot|whatsapp|telegram|discord|embedly|curl|wget|python-requests|headless/i;

function logArtifactView(c: any, slug: string): Promise<unknown> {
  const host = c.req.header("Host") ?? "";
  const ua = c.req.header("user-agent") ?? "";
  const ts = new Date().toISOString();
  if (host === "mirror.marketmessiahmethod.com") {
    return c.env.PAGES_KV.put(
      `mview:${ts}:${slug}:${Math.random().toString(36).slice(2, 8)}`,
      "",
      {
        expirationTtl: 60 * 60 * 24 * 180,
        metadata: {
          slug,
          ts,
          country: (c.req.header("cf-ipcountry") ?? "XX").toUpperCase(),
          ref: (c.req.header("referer") ?? "").slice(0, 120),
          ua: ua.slice(0, 180),
          bot: VIEW_BOTS.test(ua) || ua === "",
        },
      },
    ).catch(() => {});
  }
  // Five Moves invitation views (fmview:) — same KV-metadata pattern as the
  // Mirror. `v` attributes the click to the DM variation that carried the
  // link: the A DM links ?v=a, the B DM links ?v=b, anything without the
  // param (preview page, shares) is "direct" and stays out of the A/B math.
  // Bots are flagged, not dropped: LinkedIn fetches the page to build the DM
  // link preview, so every lead would otherwise show a phantom open at send.
  if (host === "invitation.fivemovesworkshop.com") {
    const q = c.req.query("v");
    return c.env.PAGES_KV.put(
      `fmview:${ts}:${slug}:${Math.random().toString(36).slice(2, 8)}`,
      "",
      {
        expirationTtl: 60 * 60 * 24 * 180,
        metadata: {
          slug,
          ts,
          v: q === "a" ? "a" : q === "b" ? "b" : "direct",
          country: (c.req.header("cf-ipcountry") ?? "XX").toUpperCase(),
          ua: ua.slice(0, 180),
          bot: VIEW_BOTS.test(ua) || ua === "",
        },
      },
    ).catch(() => {});
  }
  // Sovereign Executive Advantage invitation opens (sview:), Wendy's Nov 5 round
  // (Ryan, 2026-10-27: "who has clicked the link for their invitation and how many
  // times"). Same KV-metadata pattern; bots flagged, not dropped, because LinkedIn
  // fetches every DM link once to draw the preview. /api/invite-views reads them.
  if (host === "invitation.the-sovereign-executive.com") {
    return c.env.PAGES_KV.put(
      `sview:${ts}:${slug}:${Math.random().toString(36).slice(2, 8)}`,
      "",
      {
        expirationTtl: 60 * 60 * 24 * 180,
        metadata: {
          slug,
          ts,
          country: (c.req.header("cf-ipcountry") ?? "XX").toUpperCase(),
          ref: (c.req.header("referer") ?? "").slice(0, 120),
          ua: ua.slice(0, 180),
          bot: VIEW_BOTS.test(ua) || ua === "",
        },
      },
    ).catch(() => {});
  }
  return Promise.resolve();
}

// Page tracking ("seen", ~/page-tracking): on a worker whose config sets SEEN_KIND, every page it serves loads the
// tracker, unless the page already carries it (the Astrolabe Mirrors do). The tracker names any Calendly link "book",
// so a click on a page's Book a call button is counted. Ryan's go for the Mirror worker, 2026-10-21.
const SEEN = "https://seen.marketmessiahmethod.com";
function injectSeen(html: string, kind: string): string {
  if (html.includes(`${SEEN}/seen.js`)) return html;
  const tag = `<script defer src="${SEEN}/seen.js" data-url="${SEEN}/e" data-kind="${kind}" data-ver="served"></script>`;
  const i = html.toLowerCase().lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
}

// MMI breakdowns and walkthroughs (Ryan, 2026-11-10: "Yes, add tracking", after asking whether Sharon Lewis had opened
// hers). Only the mmi. host: proposal., roadmap., intro., and playbook. share this worker and stay untracked. Slugs
// starting walkthrough-for- are "mmi-walkthrough" (the tracker reads the video: played, how far); everything else on
// the host is "mmi". The ids both builders already write become the tracker's sections, and the walkthrough's two
// breakdown buttons get click names, so every page already published is covered without a republish.
const MMI_SECTION = /<(?:section|div|header|footer|main|nav)\b[^>]*?\sid="(top|map|documents|prologue|gears|sec-0[1-8]|bottom-line|case|open)"/g;
const MMI_CLICK: Record<string, string> = { "wt-btn": "breakdown", "wt-dock": "breakdown-dock" };
function seenKindFor(c: any, id: string): string | null {
  if (c.env.SEEN_KIND) return c.env.SEEN_KIND;
  if ((c.req.header("Host") ?? "") !== "mmi.marketmessiahmethod.com") return null;
  return id.startsWith("walkthrough-for-") ? "mmi-walkthrough" : "mmi";
}
function markMmi(html: string): string {
  return html
    .replace(MMI_SECTION, (m: string, name: string) => (m.includes("data-seen=") ? m : `${m} data-seen="${name}"`))
    .replace(/<a\b[^>]*?\sid="(wt-btn|wt-dock)"/g, (m: string, name: string) =>
      m.includes("data-seen-click=") ? m : `${m} data-seen-click="${MMI_CLICK[name]}"`);
}

// Core page-serving logic — shared by `/p/:id` and the clean-URL `/:slug` route.
async function servePage(c: any, id: string): Promise<Response> {
  const raw = await c.env.PAGES_KV.get(`page:${id}`);
  if (raw === null) {
    return c.text("Page not found", 404);
  }

  const metadata = parseMetadata(raw);
  if (metadata === null) {
    return c.text("Page metadata is corrupted", 500);
  }

  // Check read limit
  if (metadata.reads !== null && metadata.readCount >= metadata.reads) {
    return new Response(
      `<!DOCTYPE html><html><head><title>Gone</title></head><body>
      <h1>410 Gone</h1>
      <p>This page has reached its maximum view limit and is no longer available.</p>
      </body></html>`,
      {
        status: 410,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      },
    );
  }

  // Check PIN protection
  if (metadata.pin !== null) {
    const pinCookie = getCookie(c.req.header("Cookie"), `pin_${id}`);
    if (pinCookie !== metadata.pin) {
      return new Response(renderPinPage(id), {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
  }

  // Fetch HTML from R2
  const obj = await c.env.PAGES_BUCKET.get(`pages/${id}/index.html`);
  if (obj === null) {
    return c.text("Page content not found", 404);
  }

  const html = await obj.text();

  // Increment read count (eventually consistent — slight inaccuracy is acceptable)
  const newReadCount = metadata.readCount + 1;
  const updated = { ...metadata, readCount: newReadCount };
  const kvOptions: KVNamespacePutOptions = {};
  if (!metadata.permanent && metadata.expiresAt !== null) {
    const remaining = Math.floor(
      (new Date(metadata.expiresAt).getTime() - Date.now()) / 1000,
    );
    if (remaining > 0) {
      kvOptions.expirationTtl = remaining;
    }
  }
  // Fire-and-forget — don't block response
  // Two KV writes: page metadata (readCount) + merged stats blob
  const country = (c.req.header("CF-IPCountry") ?? "XX").toUpperCase();
  c.executionCtx.waitUntil(
    Promise.all([
      c.env.PAGES_KV.put(`page:${id}`, serializeMetadata(updated), kvOptions),
      (async () => {
        const stats = await loadStats(c.env.PAGES_KV);
        stats.views += 1;
        stats.geo[country] = (stats.geo[country] ?? 0) + 1;
        stats.recent.unshift({
          title: metadata.title ?? "Untitled",
          country,
          ts: Date.now(),
        });
        if (stats.recent.length > 20) stats.recent.length = 20;
        await saveStats(c.env.PAGES_KV, stats);
      })(),
      logArtifactView(c, id),
    ]).catch(() => {}),
  );

  const headers = new Headers();
  applyPageHeaders(headers);

  // Extract title from HTML for OG tags
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const pageTitle = titleMatch?.[1]?.trim() || metadata.title || "Shared page";

  const wrappedHtml = injectAiredBar(html, {
    id,
    title: pageTitle,
    readCount: newReadCount,
  });

  const kind = seenKindFor(c, id);
  const finalHtml = kind ? injectSeen(kind.startsWith("mmi") ? markMmi(wrappedHtml) : wrappedHtml, kind) : wrappedHtml;
  return new Response(finalHtml, { status: 200, headers });
}

// GET /p/:id — serve the published HTML page (original URL scheme)
viewer.get("/p/:id", async (c) => {
  return servePage(c, c.req.param("id"));
});

// GET /:slug — clean-URL serve (e.g. mmi.marketmessiahmethod.com/vincent).
// Only enabled on hostnames that opt in (see isCleanUrlHost). Reserved root
// paths and anything with a file extension fall through to other routes
// or the static asset handler.
viewer.get("/:slug", async (c) => {
  if (!isCleanUrlHost(c.req.header("Host"))) {
    return c.notFound();
  }
  const slug = c.req.param("slug");
  if (RESERVED_ROOT_SLUGS.has(slug) || slug.includes(".")) {
    return c.notFound();
  }
  return servePage(c, slug);
});

// POST /p/:id/verify-pin — verify PIN, set cookie, redirect
viewer.post("/p/:id/verify-pin", async (c) => {
  const id = c.req.param("id");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // Try form data fallback
    try {
      const form = await c.req.formData();
      body = { pin: form.get("pin") };
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }
  }

  if (typeof body !== "object" || body === null) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }

  const { pin } = body as Record<string, unknown>;
  if (typeof pin !== "string") {
    return c.json({ error: "pin is required" }, 400);
  }

  const raw = await c.env.PAGES_KV.get(`page:${id}`);
  if (raw === null) {
    return c.json({ error: "Page not found" }, 404);
  }

  const metadata = parseMetadata(raw);
  if (metadata === null) {
    return c.json({ error: "Page metadata is corrupted" }, 500);
  }

  if (metadata.pin === null) {
    return c.json({ error: "Page is not PIN protected" }, 400);
  }

  if (pin !== metadata.pin) {
    return c.json({ error: "Incorrect PIN" }, 403);
  }

  // Set a cookie and return success — client handles redirect
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  // HttpOnly so JS can't read it; SameSite=Strict for security
  headers.set(
    "Set-Cookie",
    `pin_${id}=${metadata.pin}; Path=/p/${id}; HttpOnly; SameSite=Strict; Max-Age=3600`,
  );

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
});

// --- Helpers ---

/**
 * Injects OG meta tags into <head> and appends a floating "Aired bar" before </body>.
 * The bar is minimal: "Powered by aired · Report · Views: N"
 */
function injectAiredBar(
  html: string,
  opts: { id: string; title: string; readCount: number },
): string {
  const { id, title, readCount } = opts;

  const ogImageUrl = `https://aired.sh/og/${id}`;
  const ogTags = `
  <!-- aired OG tags -->
  <meta property="og:title" content="${escapeAttr(title)}" />
  <meta property="og:description" content="Shared via aired.sh. Publish HTML artifacts instantly." />
  <meta property="og:type" content="website" />
  <meta property="og:image" content="${ogImageUrl}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${ogImageUrl}" />`;

  // Inject default OG tags before </head>, but only if the page does not
  // already define its own og:title. Pages that bring their own Open Graph
  // metadata (e.g. personalized invitation pages) keep full control of their
  // link preview instead of getting the generic aired defaults.
  let out = html;
  if (!/property=["']og:title["']/i.test(html)) {
    out = html.replace(/<\/head>/i, `${ogTags}\n</head>`);
    // If no </head>, prepend at the top (best-effort)
    if (out === html) {
      out = ogTags + "\n" + html;
    }
  }

  const bar = `
<!-- aired bar -->
<style>
  #__aired-bar {
    position: fixed;
    bottom: 14px;
    right: 14px;
    display: inline-flex;
    align-items: center;
    gap: 0;
    padding: 5px 10px;
    background: rgba(10, 10, 10, 0.8);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 20px;
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', system-ui, sans-serif;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: rgba(255,255,255,0.4);
    z-index: 2147483647;
    white-space: nowrap;
    pointer-events: auto;
    line-height: 1;
    transition: color 180ms ease, background 180ms ease, border-color 180ms ease;
  }
  #__aired-bar:hover {
    color: rgba(255,255,255,0.7);
    background: rgba(10, 10, 10, 0.9);
    border-color: rgba(255,255,255,0.15);
  }
  #__aired-bar a {
    color: inherit;
    text-decoration: none;
  }
  #__aired-bar .__aired-meta {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 0;
    overflow: hidden;
    opacity: 0;
    transition: max-width 250ms cubic-bezier(0.25, 0.1, 0.25, 1),
                opacity 200ms ease,
                margin 250ms ease;
    margin-left: 0;
  }
  #__aired-bar:hover .__aired-meta {
    max-width: 200px;
    opacity: 1;
    margin-left: 8px;
  }
  #__aired-bar .__aired-dot {
    width: 2px;
    height: 2px;
    border-radius: 50%;
    background: rgba(255,255,255,0.2);
    flex-shrink: 0;
  }
</style>
<div id="__aired-bar" role="complementary" aria-label="aired attribution">
  <a href="https://aired.sh" target="_blank" rel="noopener">aired</a>
  <span class="__aired-meta">
    <span class="__aired-dot"></span>
    <span>${readCount} view${readCount !== 1 ? 's' : ''}</span>
    <span class="__aired-dot"></span>
    <a href="#" onclick="(function(e){e.preventDefault();if(confirm('Report this page as inappropriate?')){fetch('/api/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'${id}',reason:'reported via viewer bar'})}).then(function(){alert('Reported. Thank you.')}).catch(function(){alert('Failed to report. Try again.')})}})(event);return false">report</a>
  </span>
</div>`;

  // Inject bar before </body>
  const barOut = out.replace(/<\/body>/i, `${bar}\n</body>`);
  // If no </body>, append at end
  return barOut === out ? out + bar : barOut;
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [key, ...valueParts] = cookie.trim().split("=");
    if (key?.trim() === name) {
      return valueParts.join("=").trim() || null;
    }
  }
  return null;
}

function renderPinPage(id: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PIN Required — aired.sh</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      padding: 2rem;
      max-width: 360px;
      width: 100%;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 0.5rem;
    }
    p {
      color: #888;
      font-size: 0.875rem;
      margin-bottom: 1.5rem;
    }
    input {
      width: 100%;
      padding: 0.75rem 1rem;
      font-size: 1rem;
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 6px;
      color: #e5e5e5;
      text-align: center;
      letter-spacing: 0.25em;
      outline: none;
      margin-bottom: 1rem;
    }
    input:focus { border-color: #555; }
    button {
      width: 100%;
      padding: 0.75rem;
      font-size: 0.9rem;
      font-weight: 500;
      background: #e5e5e5;
      color: #0a0a0a;
      border: none;
      border-radius: 6px;
      cursor: pointer;
    }
    button:hover { background: #fff; }
    .error {
      color: #f87171;
      font-size: 0.8rem;
      margin-top: 0.5rem;
      display: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>PIN Required</h1>
    <p>This page is protected. Enter the PIN to view it.</p>
    <form id="pin-form">
      <input
        type="password"
        id="pin-input"
        name="pin"
        inputmode="numeric"
        placeholder="Enter PIN"
        autocomplete="off"
        maxlength="20"
        autofocus
      />
      <button type="submit">Unlock</button>
      <p class="error" id="error-msg">Incorrect PIN. Try again.</p>
    </form>
  </div>
  <script>
    const form = document.getElementById('pin-form');
    const input = document.getElementById('pin-input');
    const errorMsg = document.getElementById('error-msg');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errorMsg.style.display = 'none';
      const pin = input.value.trim();
      if (!pin) return;

      const res = await fetch('/p/${id}/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
        credentials: 'same-origin',
      });

      if (res.ok) {
        window.location.reload();
      } else {
        errorMsg.style.display = 'block';
        input.value = '';
        input.focus();
      }
    });
  </script>
</body>
</html>`;
}

export { viewer };
