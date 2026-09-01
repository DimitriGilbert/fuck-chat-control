#!/usr/bin/env node
/**
 * Generates the Tauri config overlay that hardens the desktop shell's CSP at
 * build time (verified-report-9 findings R9/F1 + R9/F4). The overlay is passed
 * to the tauri CLI via `--config` (see package.json): the CLI merges it into
 * its in-memory config and exports it as the TAURI_CONFIG env var, which
 * tauri-build then merges over the on-disk tauri.conf.json at cargo time
 * (nested objects merge, string values replace). The committed tauri.conf.json
 * therefore stays the static localhost-only template — generated state lives
 * only in src-tauri/gen/ (gitignored) and never needs committing or restoring.
 *
 * R9/F1 — connect-src: a release build with FCK_BROKER_URL=wss://host/ws bakes
 * that URL into the binary (src-tauri/src/lib.rs), but the template CSP only
 * allows ws(s)://localhost:*, so the signaling dial gets CSP-blocked at
 * runtime. This script derives the broker origin (scheme://host[:port]) from
 * FCK_BROKER_URL and replaces the localhost ws wildcards with exactly that
 * origin. When FCK_BROKER_URL is unset or set-but-empty (dev), the
 * localhost-only directive is kept verbatim.
 *
 * R9/F4 — script-src: the template ships 'unsafe-inline' only because the
 * built shell (apps/web/.output/public/_shell.html) contains two deterministic
 * inline scripts — TanStack Router's tsr-scroll-restoration bootstrap and the
 * $tsr-stream-barrier hydration script. 'unsafe-inline' would let ANY injected
 * inline script run with full page authority, the XSS shape an E2E chat UI
 * must not ship; deleting it outright would break hydration. Instead this
 * script pins the two scripts with 'sha256-<base64>' CSP hash-sources computed
 * over the exact body the browser hashes (leading/trailing HTML whitespace
 * stripped, per CSP3). 'wasm-unsafe-eval' is kept — hash-wasm compiles WASM at
 * runtime. Tauri continues to nonce its own injected scripts automatically.
 *
 * Fail-loudly contract: if either expected inline script is missing, appears
 * more than once, or an unexpected third inline script appears, this script
 * exits non-zero. A TanStack Start upgrade that changes the inline scripts
 * must surface as a build error here — under a hashed CSP a silent change
 * would block hydration in the shipped binary (dead loading spinner).
 *
 * Ordering contract (why package.json's build:desktop runs the web build
 * BEFORE `tauri build`, and why the build overlay pins beforeBuildCommand to
 * the idempotent `node scripts/copy-shell.js`): the $tsr-stream-barrier body
 * embeds a build timestamp and content-hashed asset URLs, so every web build
 * changes it. Hashes must be computed from the SAME shell the binary ships.
 * With the stock beforeBuildCommand tauri would rebuild the web app AFTER this
 * script hashed it, invalidating the hashes — so the chain builds web first,
 * hashes the fresh shell, then starts tauri with the web-build hook replaced
 * by the idempotent copy.
 *
 * `--dev` mode (package.json "dev"): `tauri dev` serves the Vite dev server,
 * not the built shell — there is nothing to hash and devCsp legitimately keeps
 * 'unsafe-inline'/'unsafe-eval' for Vite's runtime-injected scripts. Dev mode
 * only appends the configured broker origin (if any) to devCsp's connect-src
 * so a dev build pointed at a remote broker can still dial it.
 *
 * Run from apps/desktop (or anywhere — paths resolve from this file):
 *   node scripts/gen-tauri-csp.js          # build overlay (csp)
 *   node scripts/gen-tauri-csp.js --dev    # dev overlay (devCsp)
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const confPath = resolve(here, "../src-tauri/tauri.conf.json");
const overlayPath = resolve(here, "../src-tauri/gen/tauri.conf.csp-overlay.json");
const shellPath = resolve(here, "../../web/.output/public/_shell.html");
const devMode = process.argv.includes("--dev");

/** Print a clear reason and exit non-zero — never degrade the CSP silently. */
function fail(message) {
  console.error(`[gen-tauri-csp] ${message}`);
  process.exit(1);
}

async function readRequired(path, hint) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      fail(`${path} not found. ${hint}`);
    }
    throw err;
  }
}

/** Parse a CSP string into ordered [name, tokens] directive pairs. */
function parseCsp(csp) {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive !== "")
    .map((directive) => {
      const [name, ...tokens] = directive.split(/\s+/);
      return [name, tokens];
    });
}

function serializeCsp(directives) {
  return directives.map(([name, tokens]) => [name, ...tokens].join(" ")).join("; ");
}

function findDirective(directives, name, source) {
  const found = directives.find(([directiveName]) => directiveName === name);
  if (!found) {
    fail(`${source} has no ${name} directive — update tauri.conf.json together with this script.`);
  }
  return found;
}

/**
 * Resolve the broker origin (scheme://host[:port]) from FCK_BROKER_URL.
 * Whitespace-only counts as unset, mirroring the Rust-side fallback
 * (broker_url_is_set's trim-aware guard on option_env!("FCK_BROKER_URL") in
 * src-tauri/src/lib.rs). Userinfo (user:pass@host) is rejected here even
 * though `new URL` accepts it — the WebSocket constructor does not, so a
 * URL the shipped binary could never dial must fail the build instead.
 */
function brokerOrigin() {
  const raw = (process.env.FCK_BROKER_URL ?? "").trim();
  if (raw === "") {
    return null;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail(`FCK_BROKER_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return fail(
      `FCK_BROKER_URL must use ws:// or wss:// — browsers only accept WebSocket schemes when dialing the broker: ${raw}`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    return fail(
      `FCK_BROKER_URL must not embed userinfo (user:pass@host) — the WebSocket ` +
        `constructor rejects such URLs at runtime, so the shipped binary could never dial it: ${raw}`,
    );
  }
  if (url.hostname === "") {
    return fail(`FCK_BROKER_URL must include a host: ${raw}`);
  }
  // url.host lowercases the host and keeps the port only when non-default for
  // the scheme — exactly the origin form CSP host-sources expect.
  return `${url.protocol}//${url.host}`;
}

const SCRIPT_TAG_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
// CSP3: hashing strips leading/trailing HTML whitespace from the body.
const LEADING_HTML_WS = /^[ \t\n\r\f]+/;
const TRAILING_HTML_WS = /[ \t\n\r\f]+$/;

/**
 * sha256 hash-sources for the shell's inline scripts, failing loudly on any
 * deviation from the expected two-script shape (see fail-loudly contract).
 */
function inlineScriptHashes(shellHtml) {
  const inline = [];
  for (const match of shellHtml.matchAll(SCRIPT_TAG_RE)) {
    const attrs = match[1] ?? "";
    if (/\bsrc\s*=/.test(attrs)) {
      continue; // external script — 'self' in script-src already covers it
    }
    inline.push({ attrs, body: match[2] ?? "" });
  }

  const pick = (predicate, label) => {
    const hits = inline.filter(predicate);
    if (hits.length !== 1) {
      fail(
        `expected exactly one inline ${label} script in _shell.html, found ${hits.length}. ` +
          "A TanStack Start upgrade changed the inline scripts — update the markers in " +
          "scripts/gen-tauri-csp.js and re-verify the CSP against the new shell before shipping.",
      );
    }
    return hits[0].body;
  };

  const scrollRestoration = pick(
    (script) => script.body.includes("tsr-scroll-restoration"),
    "tsr-scroll-restoration",
  );
  const streamBarrier = pick(
    (script) => script.attrs.includes('id="$tsr-stream-barrier"'),
    "$tsr-stream-barrier",
  );

  const expected = new Set([scrollRestoration, streamBarrier]);
  const unexpected = inline.filter((script) => !expected.has(script.body));
  if (unexpected.length > 0) {
    fail(
      `_shell.html contains ${unexpected.length} unexpected inline script(s), e.g. starting with ` +
        `${JSON.stringify(unexpected[0].body.slice(0, 60))}… — an unknown inline script would be ` +
        "CSP-blocked by the hashed script-src. Inspect it and extend this script's expected set.",
    );
  }

  const hash = (body) =>
    `'sha256-${createHash("sha256")
      .update(body.replace(LEADING_HTML_WS, "").replace(TRAILING_HTML_WS, ""), "utf8")
      .digest("base64")}'`;

  return [hash(scrollRestoration), hash(streamBarrier)];
}

const conf = JSON.parse(
  await readRequired(confPath, "It is the committed template this script derives from."),
);
const security = conf?.app?.security;
if (!security || typeof security.csp !== "string" || typeof security.devCsp !== "string") {
  fail("tauri.conf.json template must define app.security.csp and app.security.devCsp strings.");
}
const origin = brokerOrigin();

let overlay;
if (devMode) {
  const directives = parseCsp(security.devCsp);
  const connectSrc = findDirective(directives, "connect-src", "devCsp");
  if (origin && !connectSrc[1].includes(origin)) {
    connectSrc[1].push(origin);
  }
  overlay = { app: { security: { devCsp: serializeCsp(directives) } } };
  console.log(`[gen-tauri-csp] dev overlay devCsp: ${overlay.app.security.devCsp}`);
} else {
  const directives = parseCsp(security.csp);

  const scriptSrc = findDirective(directives, "script-src", "csp");
  if (!scriptSrc[1].includes("'wasm-unsafe-eval'")) {
    fail("csp script-src must keep 'wasm-unsafe-eval' — hash-wasm compiles WASM at runtime.");
  }
  const unsafeInlineIndex = scriptSrc[1].indexOf("'unsafe-inline'");
  if (unsafeInlineIndex === -1) {
    fail(
      "csp script-src no longer contains 'unsafe-inline' — it is expected to be replaced with " +
        "per-build sha256 hashes here; update tauri.conf.json and this script together.",
    );
  }
  const hashes = inlineScriptHashes(
    await readRequired(
      shellPath,
      'Run "pnpm --filter web build" first (package.json build:desktop does).',
    ),
  );
  scriptSrc[1].splice(unsafeInlineIndex, 1, ...hashes);

  const connectSrc = findDirective(directives, "connect-src", "csp");
  if (origin) {
    // A configured broker replaces the localhost ws wildcards: the shipped
    // binary must dial exactly the configured origin, nothing else.
    connectSrc[1] = connectSrc[1].filter((token) => !/^wss?:\/\/localhost:\*$/.test(token));
    if (!connectSrc[1].includes(origin)) {
      connectSrc[1].push(origin);
    }
  }

  overlay = {
    app: { security: { csp: serializeCsp(directives) } },
    build: { beforeBuildCommand: "node scripts/copy-shell.js" },
  };
  console.log(`[gen-tauri-csp] script-src hashes: ${hashes.join(" ")}`);
  console.log(`[gen-tauri-csp] connect-src broker origin: ${origin ?? "(unset — localhost-only)"}`);
  console.log(`[gen-tauri-csp] effective csp: ${overlay.app.security.csp}`);
}

await mkdir(dirname(overlayPath), { recursive: true });
await writeFile(overlayPath, `${JSON.stringify(overlay, null, 2)}\n`, "utf8");
console.log(`[gen-tauri-csp] overlay written: ${overlayPath}`);
