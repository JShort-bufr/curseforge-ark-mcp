import { z } from "zod";
import { CurseForgeError } from "../errors.js";
import { asArray } from "../coerce.js";
import type { ToolDef } from "../registry.js";
import { shapeCategory, verificationBlock, type ToolContext } from "./context.js";

/**
 * `list_categories` — E8, GET /v1/categories.
 *
 * Founder 2026-08-19: gameplay screening needs named class/category ids.
 * DEC-002 §11.2 had deferred this endpoint; Amendment 5 un-deferred it.
 * gameId is resolved at runtime, never passed, for the same reason as search.
 */
export function categoryTools(ctx: ToolContext): ToolDef[] {
  return [
    {
      name: "list_categories",
      title: "List ARK: Survival Ascended classes and categories",
      tier: 1,
      description:
        "List CurseForge classes and categories for ARK: Survival Ascended. Use this BEFORE search_mods " +
        "when you need class_id, category_id, or exclude_category_ids — those integers are discovered " +
        "here, never hardcoded. gameId is resolved at runtime and is not a parameter. Optional class_id " +
        "narrows to categories under one class; classes_only returns only top-level classes. The documented " +
        "response is a single array (no pagination object). Read-only.",
      inputSchema: {
        class_id: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Restrict to categories under this class id. Discoverable from a classes_only call."),
        classes_only: z
          .boolean()
          .optional()
          .describe("When true, return only top-level classes for the game, not every nested category."),
      },
      handler: async (args) => {
        const game = await ctx.games.resolve();
        const classId = args["class_id"] as number | undefined;
        const classesOnly = args["classes_only"] as boolean | undefined;

        const { data, page } = await ctx.client.request<unknown>({
          path: "v1/categories",
          query: {
            gameId: game.game_id,
            classId,
            classesOnly,
          },
          tool: "list_categories",
        });

        const categories = asArray(data);
        if (categories === null) {
          throw new CurseForgeError(
            "UPSTREAM_SHAPE",
            "GET /v1/categories returned a `data` value that is not an array, so the taxonomy could not be " +
              "read. This is an error rather than an empty list: an empty taxonomy is a real answer and must " +
              "not be confused with a shape this client cannot parse.",
            { detail: { game_id: game.game_id } },
          );
        }

        return {
          query_echo: {
            game_id: game.game_id,
            game_resolved_by: game.matched_by,
            class_id: classId ?? null,
            classes_only: classesOnly ?? null,
          },
          result_count: categories.length,
          categories: categories.map(shapeCategory),
          screening_note:
            "Gameplay-only search: find the Custom Cosmetics category in this list, then pass its id as " +
            "exclude_category_ids on search_mods. Include filters (class_id / category_id) go to CurseForge; " +
            "exclude is applied locally on the returned page. This server does not hardcode those ids.",
          pagination: page,
          verification: verificationBlock(),
        };
      },
    },
  ];
}
