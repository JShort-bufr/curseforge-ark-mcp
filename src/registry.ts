import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape } from "zod";
import { POST_CAPABLE_TOOLS } from "./allowlist.js";
import { CurseForgeError } from "./errors.js";

/**
 * Blast-radius tier.
 *
 *   1 = read-only. No side effects.
 *   2 = mutating but reversible.
 *   3 = destructive / high blast radius.
 *
 * PORTED FROM THE SIBLING REPO, AND DELIBERATELY NOT VERBATIM — DEC-002 §9.1
 * says port `registry.ts` verbatim, and ADR-002 §11 and open question 8 record
 * why it cannot be. The sibling's tier machinery is a filter
 * (`isTierEnabled`, `isNameEnabled`, a mode variable, an enabled-tools list),
 * and here it would have NOTHING TO FILTER: every tool is tier 1 and every
 * endpoint is a read. A mode variable with nothing behind it is worse than no
 * variable, because it advertises a control that does not exist.
 *
 * So the type keeps `tier`, the machinery is dropped, and one assertion replaces
 * a subsystem. Tiers 2 and 3 remain spellable in the type on purpose: the value
 * of `assertAllToolsAreReadOnly` comes from there being something for it to
 * catch.
 */
export type Tier = 1 | 2 | 3;

export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  tier: Tier;
  inputSchema: Shape;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/** Minimal shape the boot assertion needs. Deliberately not ToolDef: this check reads two fields. */
export interface TieredTool {
  name: string;
  tier: Tier;
}

/**
 * THE BOOT ASSERTION (ADR-002 §11).
 *
 * Mod AUTHORING is refused outright by DEC-002 Ruling 2, and this is the five
 * lines that make the refusal STRUCTURAL rather than a promise. Adding a
 * mutating tool to this repo is not a code change that works — it is a process
 * that will not start, which forces the conversation to happen at the ADR level
 * where it belongs.
 *
 * IT READS NO ENVIRONMENT VARIABLE, and that is the load-bearing property,
 * ported from ADR-001 §2's reasoning: TWO CONTROLS THAT FAIL FOR THE SAME REASON
 * ARE ONE CONTROL. The sibling repo's registry gate and its old transport gate
 * both consulted `config.mode`, so a single wrong variable defeated both at
 * once — defence in depth drawn twice. This function takes no Config and cannot
 * consult one. It compares declarations to a constant and nothing else.
 *
 * The second check is §8 made structural in the same breath: the POST-capable
 * tool list must name tools that exist, or the list is guarding a ghost while a
 * real tool goes unguarded.
 */
export function assertAllToolsAreReadOnly(
  tools: readonly TieredTool[],
  postCapableTools: readonly string[] = POST_CAPABLE_TOOLS,
): void {
  const problems: string[] = [];

  for (const tool of tools) {
    if (tool.tier !== 1) {
      problems.push(
        `Tool "${tool.name}" declares tier ${tool.tier}. This server is read-only by construction: DEC-002 ` +
          `§11.1 started the v1 surface at seven tier-1 tools (Amendment 5 added list_categories), DEC-002 Ruling 2 refuses mod authoring outright, ` +
          `and ADR-002 §10 refuses any update-then-deploy loop. There is no allow-list entry a mutating tool ` +
          `could use — the endpoints in src/allowlist.ts are all reads — so a tier-2 tool here would ` +
          `register successfully and then be refused at the transport on every call. Registering it is refused ` +
          `at startup instead, because the honest place to have this argument is a board record and a new ADR, ` +
          `not a stack trace.`,
      );
    }
  }

  const names = new Set(tools.map((tool) => tool.name));
  for (const name of postCapableTools) {
    if (!names.has(name)) {
      problems.push(
        `POST_CAPABLE_TOOLS names "${name}", which is not a registered tool. ADR-002 §8 permits exactly one ` +
          `tool to reach the two bulk-read POST entries, and a list naming a tool that does not exist is a ` +
          `control guarding a ghost — most likely the tool was renamed and this list was not.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new CurseForgeError(
      "CONFIG",
      `The tool registry declares something this server is not permitted to be, so it will not start. This ` +
        `check reads no environment variable on purpose: two controls that fail for the same reason are one ` +
        `control. ${problems.length} problem(s):\n` +
        problems.map((problem, i) => `  ${i + 1}. ${problem}`).join("\n"),
      { detail: { problems } },
    );
  }
}

export interface RegistrationReport {
  registered: string[];
}

/**
 * Register the tools.
 *
 * No filtering, and the absence is deliberate — see the `Tier` docstring. Every
 * tool this server has is tier 1, the boot assertion above has already refused
 * to start if that is not true, and a gate whose answer is always "yes" is not a
 * gate.
 */
export function registerTools(server: McpServer, tools: readonly ToolDef[]): RegistrationReport {
  const report: RegistrationReport = { registered: [] };

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(args ?? {});
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          const payload =
            error instanceof CurseForgeError
              ? error.toPayload()
              : { error: true, code: "UPSTREAM", message: String(error) };
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          };
        }
      },
    );
    report.registered.push(tool.name);
  }

  return report;
}
