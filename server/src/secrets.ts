// fill_secret support: resolve a NAMED secret from the macOS login Keychain and bind it to
// the hosts it may be filled into. The whole point of the tool is that the secret VALUE
// never appears in the MCP transcript — only its name does — so nothing in this module may
// put the value into an error message, a log line, or a returned string other than the
// payload handed to the fill RPC.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { normalizeHost } from "@zen-mcp/shared/nav-redact";
import { ZenToolError } from "./errors.js";

// Secrets-kit convention: env-var-shaped names in the cx-secret Keychain service.
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const KEYCHAIN_SERVICE = "cx-secret";
const KEYCHAIN_TIMEOUT_MS = 30_000;

export interface SecretBindings {
  path: string;
  loaded: boolean;
  /** secret NAME -> normalized hosts it may be filled into */
  bindings: Map<string, string[]>;
  error: string | null;
}

export function secretsConfigPath(): string {
  const override = process.env.ZEN_MCP_SECRETS;
  if (override && override.length > 0) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "zen-mcp", "secrets.json");
}

/**
 * Read fresh on every call: fill_secret is rare, and a stale cache would turn "I just added
 * the host" into a confusing second failure. Mirrors the route table's load semantics — an
 * absent file is the default state, a malformed file is a reported error, and the two must
 * never look alike (a broken config silently meaning "no secrets" would send the caller off
 * to rewrite a file that was fine except for a comma).
 */
export function loadSecretBindings(): SecretBindings {
  const path = secretsConfigPath();
  const empty: SecretBindings = { path, loaded: false, bindings: new Map(), error: null };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return empty;
    return { ...empty, error: `could not read ${path}: ${(err as Error).message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ...empty, error: `invalid JSON in ${path}: ${(err as Error).message}` };
  }

  try {
    return { path, loaded: true, bindings: compileBindings(parsed), error: null };
  } catch (err) {
    return { ...empty, error: `invalid secrets config in ${path}: ${(err as Error).message}` };
  }
}

// Only the "secrets" key is read; "_readme" and anything else is ignored, same as the route
// table loader. A typo'd top-level key therefore reads as an empty config — still loud,
// because the unknown-name error names the path and how many secrets it found.
function compileBindings(parsed: unknown): Map<string, string[]> {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('top level must be an object with a "secrets" key');
  }
  const section = (parsed as Record<string, unknown>).secrets;
  if (section === undefined) throw new Error('missing "secrets" key');
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new Error('"secrets" must map secret NAMEs to host lists');
  }
  const bindings = new Map<string, string[]>();
  for (const [name, value] of Object.entries(section)) {
    if (!SECRET_NAME_RE.test(name)) {
      throw new Error(`secret name "${name}" must be UPPER_SNAKE_CASE`);
    }
    const list = typeof value === "string" ? [value] : value;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`secret "${name}" must bind at least one host`);
    }
    const hosts = list.map((entry) => {
      if (typeof entry !== "string") throw new Error(`secret "${name}" has a non-string host`);
      const host = normalizeHost(entry);
      if (!host) throw new Error(`secret "${name}" binds invalid host "${entry}"`);
      return host;
    });
    bindings.set(name, hosts);
  }
  return bindings;
}

/**
 * The load-bearing check: a secret may only be filled into a page whose host it is
 * explicitly bound to, and a miss is an ERROR, never a fallback. This is what stops a
 * misread page — or a prompt-injected session — from steering a credential into a
 * lookalike form. Exact host match, deliberately: binding "example.com" does not cover
 * "login.example.com"; list both if both are real fill targets.
 */
export function requireSecretBinding(name: string, host: string): void {
  const table = loadSecretBindings();
  if (table.error) {
    throw new ZenToolError(
      "BAD_INPUT",
      `secrets config failed to load: ${table.error}`,
      "Nothing was filled. Fix the file; a malformed config is never treated as empty.",
    );
  }
  const bound = table.bindings.get(name);
  if (!bound) {
    const known = table.bindings.size;
    throw new ZenToolError(
      "NOT_FOUND",
      `secret "${name}" is not configured in ${table.path} (${known} secret${known === 1 ? "" : "s"} configured)`,
      'Nothing was filled. Add it deliberately: {"secrets": {"NAME": ["exact.host"]}}. The binding is what stops a credential from landing on the wrong page.',
    );
  }
  if (!bound.includes(host)) {
    throw new ZenToolError(
      "BAD_PERMS",
      `secret "${name}" is not bound to host "${host}" — bound hosts: ${bound.join(", ")}`,
      `Nothing was filled. If this page is a legitimate fill target, add "${host}" to ${table.path} yourself; do not weaken this into a fallback — filling a credential into an unbound page is the incident this check exists to prevent.`,
    );
  }
}

/**
 * Resolve the secret VALUE from the login Keychain via `security`(1). Runs in this server
 * process, not through the Bash tool, so the value exists only in process memory and the
 * localhost daemon hop — never in the transcript. ZEN_MCP_SECRET_BIN overrides the binary
 * for tests.
 */
export function resolveSecret(name: string): Promise<string> {
  const bin = process.env.ZEN_MCP_SECRET_BIN ?? "security";
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (err, stdout) => {
        if (err) {
          if ((err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            reject(
              new ZenToolError(
                "TIMEOUT",
                `Keychain lookup for "${name}" timed out after ${KEYCHAIN_TIMEOUT_MS / 1000}s`,
                "Nothing was filled. macOS may be showing a Keychain access dialog waiting for approval — check the screen, then retry.",
              ),
            );
            return;
          }
          reject(
            new ZenToolError(
              "NOT_FOUND",
              `secret "${name}" not found in the login Keychain (service ${KEYCHAIN_SERVICE})`,
              "Nothing was filled. Store it with the 'Save as secret' Alfred action (sk NAME) first. Never paste the value into the conversation.",
            ),
          );
          return;
        }
        const value = stdout.replace(/\n$/, "");
        if (!value) {
          reject(
            new ZenToolError(
              "NOT_FOUND",
              `secret "${name}" resolved to an empty value`,
              "Nothing was filled. Re-store it with sk NAME.",
            ),
          );
          return;
        }
        resolve(value);
      },
    );
  });
}

/**
 * Defense in depth for the transcript: strip every occurrence of the value from outgoing
 * tool text. Today no fill error echoes the value, but this must hold against future
 * handler changes and hostile pages, so it is enforced here rather than assumed there.
 */
export function scrubSecretValue<T extends { content?: Array<{ type: string; text?: string }> }>(
  response: T,
  value: string,
): T {
  if (value.length < 4 || !response.content) return response;
  for (const item of response.content) {
    if (item.type === "text" && typeof item.text === "string" && item.text.includes(value)) {
      item.text = item.text.split(value).join("<secret>");
    }
  }
  return response;
}
