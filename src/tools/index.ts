import type { ToolDef } from "../registry.js";
import type { ToolContext } from "./context.js";
import { categoryTools } from "./categories.js";
import { dependencyTools } from "./dependencies.js";
import { diagnosticsTools } from "./diagnostics.js";
import { latestFileTools } from "./latest.js";
import { modTools } from "./mods.js";
import { searchTools } from "./search.js";

/**
 * THE COMPLETE TOOL SURFACE: eight tools, all tier 1.
 *
 * DEC-002 §11.1 fixed seven. Amendment 5 (founder 2026-08-19) added
 * `list_categories` so screening can name class/category ids. The count is
 * asserted in the test suite rather than only stated here.
 *
 * There is no filtering here and no mode variable — see src/registry.ts. What
 * enforces the surface is `assertAllToolsAreReadOnly`, which refuses to start
 * the process if any tool declares a tier other than 1 (ADR-002 §11).
 */
export const V1_TOOL_NAMES: readonly string[] = [
  "search_mods",
  "list_categories",
  "get_mod",
  "list_mod_files",
  "get_mod_file",
  "get_latest_file",
  "resolve_mod_dependencies",
  "get_api_diagnostics",
];

export function allTools(ctx: ToolContext): ToolDef[] {
  return [
    ...searchTools(ctx),
    ...categoryTools(ctx),
    ...modTools(ctx),
    ...latestFileTools(ctx),
    ...dependencyTools(ctx),
    ...diagnosticsTools(ctx),
  ];
}
