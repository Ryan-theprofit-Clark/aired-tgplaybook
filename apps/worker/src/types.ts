export type Env = {
  PAGES_BUCKET: R2Bucket;
  PAGES_KV: KVNamespace;
  // Cloudflare Workers static assets binding (populated by [assets] in wrangler.toml)
  ASSETS: Fetcher;
  // Per-worker click-tracking config. Both are optional so older worker configs
  // (e.g. wrangler.flowingfounder.toml before its vars/secrets were added) keep
  // working — redirect.ts falls back to the hardcoded Michela URL when unset.
  CLICK_LOG_KEY?: string;
  REDIRECT_DESTINATION?: string;
  // Optional utm_campaign value stamped onto the CTA redirect for attribution.
  // Falls back to "workshop_invitation" when unset.
  REDIRECT_UTM_CAMPAIGN?: string;
  // "1" enables the Mirror diagnostic quiz routes (wrangler.mirror.toml only).
  MIRROR_QUIZ?: string;
  // Page tracking: when set, every served page loads seen.js with this data-kind (routes/viewer.ts injectSeen).
  SEEN_KIND?: string;
  // Workshop sign-up into systeme.io (routes/signup.ts). The key is a wrangler secret; the tag id is a var.
  // Both unset on every worker except the ones hosting a sign-up page, which keeps /api/signup off there.
  SYSTEME_API_KEY?: string;
  SYSTEME_SIGNUP_TAG_ID?: string;
};

export type AppBindings = {
  Bindings: Env;
};

/** Merged stats blob — single KV key "stats:live" replaces separate counters */
export type StatsLive = {
  publishes: number;
  views: number;
  geo: Record<string, number>;
  recent: { title: string; country: string; ts: number }[];
};
