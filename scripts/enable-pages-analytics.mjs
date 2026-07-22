/**
 * Portable Cloudflare Pages Web Analytics token fetcher.
 * Copy to any Pages repo as scripts/enable-pages-analytics.mjs
 *
 * Env:
 *   CF_ACCOUNT_ID       — Cloudflare account ID (optional if wrangler whoami parsed)
 *   CF_PAGES_PROJECT    — Pages project name (required)
 *   CF_ANALYTICS_CONFIG — output JSON path (default: static/config/cf-web-analytics.json)
 *   CLOUDFLARE_API_TOKEN — optional API token override
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();

const PROJECT = process.env.CF_PAGES_PROJECT || "";
const ACCOUNT_ID = process.env.CF_ACCOUNT_ID || "";
const configOut = path.resolve(
  root,
  process.env.CF_ANALYTICS_CONFIG || "static/config/cf-web-analytics.json",
);

function wranglerConfigPaths() {
  return [
    path.join(homedir(), "AppData/Roaming/xdg.config/.wrangler/config/default.toml"),
    path.join(homedir(), ".config/.wrangler/config/default.toml"),
    path.join(homedir(), ".wrangler/config/default.toml"),
  ];
}

function wranglerOAuthToken() {
  for (const p of wranglerConfigPaths()) {
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    const match = raw.match(/oauth_token = "([^"]+)"/);
    if (match) return match[1];
  }
  throw new Error("No wrangler oauth_token. Run: npx wrangler login");
}

async function cfApi(method, apiPath, body, accountId) {
  const token = process.env.CLOUDFLARE_API_TOKEN || wranglerOAuthToken();
  const res = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.success) {
    throw new Error(JSON.stringify(json.errors || json, null, 2));
  }
  return json.result;
}

function writeConfig(hostname, token, tag) {
  mkdirSync(path.dirname(configOut), { recursive: true });
  writeFileSync(
    configOut,
    JSON.stringify(
      {
        hostname,
        token,
        site_tag: tag || null,
        updated: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(`Wrote ${configOut}`);
}

function extractAnalytics(project) {
  const token =
    project.deployment_configs?.production?.web_analytics_token ||
    project.build_config?.web_analytics_token;
  const tag =
    project.deployment_configs?.production?.web_analytics_tag ||
    project.build_config?.web_analytics_tag;
  return { token, tag };
}

async function main() {
  if (!PROJECT) {
    console.error("Set CF_PAGES_PROJECT (Pages project name).");
    process.exit(1);
  }

  const accountId = ACCOUNT_ID;
  if (!accountId) {
    console.error(
      "Set CF_ACCOUNT_ID (run: npx wrangler whoami).",
    );
    process.exit(1);
  }

  const hostname = `${PROJECT}.pages.dev`;
  console.log(`Pages Web Analytics: ${PROJECT} (${accountId})`);

  let project = await cfApi(
    "GET",
    `/accounts/${accountId}/pages/projects/${PROJECT}`,
    null,
    accountId,
  );

  let { token, tag } = extractAnalytics(project);
  console.log("Token:", token ? "(set)" : "(missing)");
  console.log("Tag:", tag || "(missing)");

  if (!token) {
    console.log("Trying RUM site_info API...");
    try {
      const rum = await cfApi(
        "POST",
        `/accounts/${accountId}/rum/site_info`,
        { host: hostname, auto_install: false },
        accountId,
      );
      token = rum.token || rum.site_token;
      tag = rum.site_tag || tag;
      console.log("RUM token:", token ? "(set)" : "(missing)");
    } catch (err) {
      console.log("RUM API unavailable:", err.message || err);
    }
  }

  if (!token) {
    console.log(`
Token not provisioned yet.

Dashboard (one click):
  1. https://dash.cloudflare.com/${accountId}/workers-and-pages
  2. Open project: ${PROJECT}
  3. Metrics tab → Enable Web Analytics
  4. Re-run this script
`);
    process.exit(1);
  }

  writeConfig(hostname, token, tag);
  console.log("\nNext: npm run build && npm run deploy");
  console.log(
    `Metrics: https://dash.cloudflare.com/${accountId}/workers-and-pages (open ${PROJECT} → Metrics)`,
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
