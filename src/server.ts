#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ENDPOINT_ALLOWLIST } from "./allowlist.js";
import { CurseForgeClient } from "./client.js";
import { bootstrapEnv, loadConfig } from "./config.js";
import { CurseForgeError } from "./errors.js";
import { createGameResolver } from "./game.js";
import { assertAllToolsAreReadOnly, registerTools } from "./registry.js";
import { allTools } from "./tools/index.js";

async function main(): Promise<void> {
  // Resolve the credential before anything else and fail HERE (ADR-002 §2).
  // A stdio MCP server that starts cleanly and then throws on all seven tools is
  // a miserable thing to debug.
  const envSources = bootstrapEnv();
  const config = loadConfig(process.env, envSources);

  const client = new CurseForgeClient(config, globalThis.fetch);
  // Injected, not a module singleton (ADR-002 open question 5). The gameId is
  // cached for the PROCESS LIFETIME and nothing persists it — §10 forbids
  // persisted state, and a stale gameId on disk would outlive the key that could
  // see the game.
  const games = createGameResolver(client, { configuredSlug: config.gameSlug });

  const tools = allTools({ client, config, games });

  // THE BOOT ASSERTION (ADR-002 §11), before registration and before the
  // transport is connected. It reads no environment variable: two controls that
  // fail for the same reason are one control. Adding a mutating tool to this repo
  // is a process that will not start, not a diff that works.
  assertAllToolsAreReadOnly(tools);

  const server = new McpServer({ name: "curseforge-ark-mcp", version: "0.1.0" });
  const report = registerTools(server, tools);

  // stdout is the MCP transport. All human-facing output goes to stderr.
  // `v0` is in the startup line on purpose: it is the honest headline, and the
  // one thing a reader of a log should not have to go looking for.
  console.error(
    `[curseforge-ark-mcp] v0 (field paths UNVERIFIED) tools=${report.registered.length} ` +
      `endpoints=${ENDPOINT_ALLOWLIST.length} writes=0 ` +
      (envSources.envFileLoaded ? `env=${envSources.envFilePath}` : "env=process.env"),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  if (error instanceof CurseForgeError) {
    console.error(`[curseforge-ark-mcp] ${error.code}: ${error.message}`);
  } else {
    console.error(`[curseforge-ark-mcp] fatal: ${String(error)}`);
  }
  process.exit(1);
});
