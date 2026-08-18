import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_ORIGIN } from "./allowlist.js";
import { CurseForgeError } from "./errors.js";

/**
 * Runtime configuration.
 *
 * NOTE WHAT IS ABSENT, because the absence is a control rather than an oversight
 * (ADR-002 §9): there is no `NITRADO_*` variable in this surface and there must
 * never be one. This server makes no Nitrado call, holds no Nitrado token, and
 * reads no Nitrado config. A credential that is not read cannot be leaked,
 * logged, or blast-radiused. Two credentials in one process would mean one .env,
 * one revocation story for two revocation authorities, and one compromise
 * reaching both.
 *
 * Note also what is absent from the sibling repo's config: there is no `mode`,
 * no `allowDestructive`, and no `enabledTools`. Those exist there to ration a
 * write path. This repo has none, and §11 makes that structural with a five-line
 * boot assertion rather than a subsystem — a mode variable here would be a
 * switch with nothing behind it, which is worse than no switch at all.
 */
export interface Config {
  /**
   * The CurseForge API key, sent as the `x-api-key` header. Never logged, never
   * echoed, never placed in a query string, and never reported by length.
   */
  apiKey: string;
  /**
   * Always the pinned origin. Present as a field so the client can assert on it
   * rather than closing over a constant, and deliberately NOT settable from the
   * environment: an overridable base URL is an unpinned host with extra steps.
   */
  apiBase: string;
  /**
   * An explicit game slug for §5's runtime resolution, or null to use the
   * built-in candidate list. Not a gameId — a gameId cannot be set here at all,
   * because a hardcoded one is exactly what §5 forbids.
   */
  gameSlug: string | null;
  /** Self-imposed pacing. CurseForge publishes no rate limit (§14.3 U11), so this is ours. */
  requestsPerSecond: number;
  requestTimeoutMs: number;
}

export interface EnvSourceInfo {
  /** Absolute path we looked for / loaded a .env from, or null if none was found. */
  envFilePath: string | null;
  /** True if a .env was actually read into process.env by bootstrapEnv(). */
  envFileLoaded: boolean;
}

const KEY_VARIABLE = "CURSEFORGE_API_KEY";

/**
 * Locate the server's own .env.
 *
 * Resolved relative to THIS MODULE, walking up, never relative to
 * process.cwd(). An MCP client launches the server from an arbitrary working
 * directory, so a cwd-relative lookup fails silently and produces a confusing
 * 401 later. Walking up covers both layouts without special-casing: source at
 * <repo>/src/config.ts and build output at <repo>/dist/src/config.js both find
 * <repo>/.env.
 */
export function findEnvFile(startDir: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let current = resolve(startDir);
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Credential resolution, in precedence order:
 *
 *   1. process.env  (the MCP client's own env block)
 *   2. a gitignored .env beside the server's code
 *
 * Supporting both means nobody is forced to keep two copies of the same secret.
 * If the environment already carries a key we do not touch the file at all.
 */
export function bootstrapEnv(): EnvSourceInfo {
  const envFilePath = findEnvFile();

  const fromEnv = process.env[KEY_VARIABLE];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { envFilePath, envFileLoaded: false };
  }
  if (envFilePath === null) {
    return { envFilePath: null, envFileLoaded: false };
  }

  try {
    // Node 20.12+/21.7+ builtin. Deliberately not the `dotenv` package: this
    // repo keeps its dependency tree shallow and reviewable by hand.
    process.loadEnvFile(envFilePath);
    return { envFilePath, envFileLoaded: true };
  } catch (cause) {
    throw new CurseForgeError("CONFIG", `Found ${envFilePath} but could not parse it: ${String(cause)}`, {
      detail: { env_file: envFilePath },
      cause,
    });
  }
}

/**
 * REFUSE TO START WITHOUT A KEY (ADR-002 §2).
 *
 * Ported from the sibling repo's reasoning, which applies here unchanged: a
 * stdio MCP server that starts cleanly and then throws on all seven tools is a
 * miserable thing to debug.
 *
 * The message names BOTH locations checked, the exact variable name, and the one
 * fact that makes this credential different from every other API key the reader
 * has ever configured — it is not self-service. There is no console to click
 * "generate". You apply to Overwolf and wait.
 */
export function missingKeyError(sources: EnvSourceInfo): CurseForgeError {
  const checked = [
    "process.env (your MCP client's env block)",
    sources.envFilePath === null
      ? "a .env beside the server code (none found; searched upward from the module directory)"
      : `${sources.envFilePath} (${sources.envFileLoaded ? "loaded" : "present but not used, env already had a key"})`,
  ];
  return new CurseForgeError(
    "CONFIG",
    `${KEY_VARIABLE} is not set, so the server will not start. Checked, in order: 1) ${checked[0]}; ` +
      `2) ${checked[1]}. Set it to your CurseForge API key, which this server sends as the \`x-api-key\` ` +
      `header. IMPORTANT: this key is NOT self-service — it is granted by application to Overwolf, and it is ` +
      `non-transferable, so there is nothing to generate in a dashboard and a colleague cannot lend you ` +
      `theirs. If you do not have one yet, the server cannot run at all; \`npm run smoke\` will tell you what ` +
      `it would have probed once you do. See .env.example and the README.`,
    { detail: { variable: KEY_VARIABLE, checked_sources: checked } },
  );
}

function numberVar(name: string, env: NodeJS.ProcessEnv, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new CurseForgeError("CONFIG", `${name} must be a number, got ${JSON.stringify(raw)}.`, {
      detail: { variable: name },
    });
  }
  return Math.min(max, Math.max(min, parsed));
}

const NO_ENV_FILE: EnvSourceInfo = { envFilePath: null, envFileLoaded: false };

/** Validate the whole environment at startup and fail loudly. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, sources: EnvSourceInfo = NO_ENV_FILE): Config {
  const raw = env[KEY_VARIABLE];
  if (raw === undefined || raw.trim() === "") throw missingKeyError(sources);
  const apiKey = raw.trim();

  // A key this short cannot be a CurseForge key, and it would defeat scrubKey()
  // (which floors at 8 characters so a short value cannot match everywhere).
  // Refusing here means the scrub's floor can never be the reason a key leaks.
  if (apiKey.length < 8) {
    throw new CurseForgeError(
      "CONFIG",
      `${KEY_VARIABLE} is set but is only ${apiKey.length} characters, which is too short to be a CurseForge ` +
        `key. Refused at startup rather than sent, because the key-scrubbing in src/scrub.ts deliberately ` +
        `ignores values under 8 characters (a shorter one would match everywhere and shred every message), ` +
        `so a key this short would be the one value that could survive into an error string.`,
      { detail: { variable: KEY_VARIABLE, length: apiKey.length } },
    );
  }

  const slugRaw = (env["CURSEFORGE_GAME_SLUG"] ?? "").trim();

  return {
    apiKey,
    apiBase: PINNED_ORIGIN,
    gameSlug: slugRaw === "" ? null : slugRaw,
    requestsPerSecond: numberVar("CURSEFORGE_MAX_RPS", env, 2, 0.1, 10),
    requestTimeoutMs: numberVar("CURSEFORGE_TIMEOUT_MS", env, 20_000, 1_000, 120_000),
  };
}
