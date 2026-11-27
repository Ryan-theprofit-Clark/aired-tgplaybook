import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppBindings } from "./types.js";
import { api } from "./routes/api.js";
import { viewer } from "./routes/viewer.js";
import { report } from "./routes/report.js";
import { handleMcp } from "./routes/mcp.js";
import { og } from "./routes/og.js";
import { redirect } from "./routes/redirect.js";
import { mirror } from "./routes/mirror.js";
import { signup } from "./routes/signup.js";

const app = new Hono<AppBindings>();

// Error handler
app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error({
    event: "unhandled_error",
    timestamp: new Date().toISOString(),
    method: c.req.method,
    url: c.req.url,
    error: err.message,
    stack: err.stack,
  });
  return c.json({ error: "Internal Server Error" }, 500);
});

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Favicon: Market Messiah hosts get the agency mark (web/mm-favicon.png).
// Every other host keeps the aired product icon (web/favicon.ico). Safari
// ignores the data-URI icon inlined in published pages and falls back to
// this root path, so without the host check MM pages show the aired icon.
app.get("/favicon.ico", (c) => {
  if (!c.env.ASSETS) return c.json({ error: "Not found" }, 404);
  const host = c.req.header("host") ?? "";
  if (host.endsWith(".marketmessiahmethod.com")) {
    const url = new URL(c.req.url);
    url.pathname = "/mm-favicon.png";
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

// MCP Streamable HTTP endpoint
app.all("/mcp", handleMcp);

// OG image route
app.route("/", og);

// Mount API routes
app.route("/api", api);
app.route("/api", report);
// Workshop sign-up into the client's systeme.io (off unless SYSTEME_API_KEY and SYSTEME_SIGNUP_TAG_ID are set).
app.route("/api", signup);

// Tracked redirect: /r/:slug logs the click and 302s to Michela's registration page
app.route("/", redirect);

// The Mirror diagnostic quiz (no-ops unless MIRROR_QUIZ = "1" in the config).
// Mounted before the viewer so /start and /d/:slug win on the mirror host.
app.route("/", mirror);

// Mount viewer routes
app.route("/", viewer);

// Static assets fallback — serve web/ files (index.html, style.css, app.js)
// Cloudflare ASSETS binding handles routing to the correct file.
app.notFound(async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ error: "Not found" }, 404);
});

export default app;
