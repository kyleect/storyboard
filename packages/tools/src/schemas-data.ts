import { z } from "zod";
import {
  applySelection,
  changesBetween,
  DataError,
  defineTool,
  MAX_DATA_DESCRIPTION,
  MAX_DATA_NAME,
  type DataPlan,
  type DataScope,
  type SchemaScope,
  type DataSnapshot,
  type DataView,
  type Review,
  type ReviewItem,
  type ReviewPlan,
  type SchemaInfo,
  type SchemaPlan,
  type SchemaSnapshot,
  type Selection,
  type ToolContext,
  type ToolOutput,
} from "@harness/core";
import { fail } from "./results.js";

/*
 * Schema and data tools (schemas and data design, decision 43). Writes ask
 * before running and reads don't (decision 36); the user can switch each
 * one. Which ones a session gets follows its agent's selection, as for
 * ordinary tools.
 *
 * Session schemas and data are recorded in the transcript with each call's
 * result (decision 4). A piece of data on an older schema version that does
 * not pass the latest one comes with a warning and the problems (decisions
 * 7, 8, 23).
 */

const SCOPES = ["global", "project", "agent", "session"] as const;
const SCOPE_HELP =
  "global: every conversation. project: every conversation in this project. agent: every conversation with this agent. session: this conversation only.";

const Scope = z.enum(SCOPES);
/** Where schemas live: the data scopes and the built-in ones (plan P6). */
const SchemaScopeArg = z.enum([...SCOPES, "builtin"]);
const Id = z.string().min(1).max(100);
const Name = z.string().min(1).max(MAX_DATA_NAME);
const Description = z.string().min(1).max(MAX_DATA_DESCRIPTION);
/** Schema versions; bounded (tools design 6.2). */
const Version = z.int().min(1).max(100000);

/** A `DataError` (a refused change) as an error result. */
const refusal = (
  err: DataError,
  target: Record<string, string | undefined>,
): ToolOutput =>
  fail(
    err.message,
    /No (schema|data) with the id/.test(err.message) ? "not_found" : "rejected",
    target,
  );

/** A `DataError` (a refused change) becomes an error result. */
function guarded(
  target: Record<string, string | undefined>,
  run: () => ToolOutput,
): ToolOutput {
  try {
    return run();
  } catch (err) {
    if (err instanceof DataError) return refusal(err, target);
    throw err;
  }
}

/** A schema as the model sees it. */
const shownSchema = (s: SchemaInfo) => ({
  id: s.id,
  name: s.name,
  scope: s.scope,
  description: s.description,
  version: s.version,
  ...(s.copiedFrom ? { copiedFrom: s.copiedFrom } : {}),
});

/** Why the model should look again, when data is out of date or stuck. */
function warning(d: Omit<DataView, "value">): string | undefined {
  if (!d.schemaInScope) {
    return "Its schema is not available in this conversation now, so this data can be viewed and deleted, not changed.";
  }
  if (!d.outOfDate) return undefined;
  const problems =
    d.latestErrors.length > 0
      ? ` Against version ${d.latestVersion}: ${d.latestErrors.join(" ")}`
      : "";
  return `Out of date: made for version ${d.schemaVersion} of its schema, which is now at version ${d.latestVersion}, and it does not pass the latest.${problems} Fix it with data_migrate (or data_migrate_many for several).`;
}

/** A piece of data as `data_list` shows it: no value (decision 29). */
const shownInfo = (
  d: Omit<DataView, "value" | "latestErrors"> & { latestErrors?: string[] },
) => {
  const w = warning({ ...d, latestErrors: d.latestErrors ?? [] });
  return {
    id: d.id,
    name: d.name,
    scope: d.scope,
    description: d.description,
    schemaId: d.schemaId,
    schemaVersion: d.schemaVersion,
    ...(d.outOfDate ? { outOfDate: true } : {}),
    ...(!d.schemaInScope ? { schemaInScope: false } : {}),
    ...(w ? { warning: w } : {}),
  };
};

/** A piece of data with its value. */
const shownData = (d: DataView) => ({ ...shownInfo(d), value: d.value });

const scopeArg = (description: string) =>
  Scope.describe(`${description} ${SCOPE_HELP}`);

// ---- Reviews (plan P5; decisions 31 to 35) ---------------------------------

/** Turns a `DataError` while working out a review into the call's result. */
function reviewGuarded(
  target: Record<string, string | undefined>,
  run: () => ReviewPlan,
): ReviewPlan | ToolOutput {
  try {
    return run();
  } catch (err) {
    if (err instanceof DataError) return refusal(err, target);
    throw err;
  }
}

const dataLabel = (plan: DataPlan) =>
  `${plan.schemaName} "${(plan.before ?? plan.after).name}"`;

function dataItem(ctx: ToolContext, key: string, plan: DataPlan): ReviewItem {
  return {
    key,
    label: dataLabel(plan),
    ...(plan.before ? { before: plan.before } : {}),
    after: plan.after,
    changes: changesBetween(plan.before, plan.after),
    ...(plan.kind === "create" ? { showValue: true } : {}),
    ...(plan.kind === "migrate" && plan.fromVersion !== undefined
      ? {
          schema: {
            fromVersion: plan.fromVersion,
            toVersion: plan.version,
            changes: changesBetween(
              ctx.data.schemaBody(plan.schemaId, plan.fromVersion),
              ctx.data.schemaBody(plan.schemaId, plan.version),
            ),
          },
        }
      : {}),
  };
}

/** What a selection keeps of one item: undefined when nothing of it is. */
function selected<T>(
  item: ReviewItem,
  selection: Selection | undefined,
): T | undefined {
  if (selection === undefined) return item.after as T;
  const paths = selection[item.key];
  if (paths === undefined) return undefined;
  return applySelection(item.before, item.after, new Set(paths)) as
    T | undefined;
}

/** The review of data plans, keyed by item. */
function dataReview(
  ctx: ToolContext,
  plans: readonly { key: string; plan: DataPlan }[],
): ReviewPlan {
  const review: Review = {
    items: plans.map(({ key, plan }) => dataItem(ctx, key, plan)),
  };
  return {
    review,
    check: (selection) =>
      plans.flatMap(({ plan }, i) => {
        const item = review.items[i] as ReviewItem;
        const snap = selected<DataSnapshot>(item, selection);
        if (snap === undefined) return [];
        return ctx.data.checkPlan(plan, snap).map((e) => `${item.label}: ${e}`);
      }),
    stale: () => plans.some(({ plan }) => ctx.data.planIsStale(plan)),
  };
}

/** What the model is told about an approval with picked changes (35). */
function picked(item: ReviewItem, selection: Selection | undefined) {
  if (selection === undefined) return {};
  const approved = new Set(selection[item.key] ?? []);
  const all = item.changes.map((c) => c.path);
  return {
    applied: all.filter((p) => approved.has(p)),
    rejected: all.filter((p) => !approved.has(p)),
  };
}

const CHANGED_SINCE =
  "Not applied: the data changed after the user approved this call. Look at it again and propose the change anew.";

/**
 * Saves data plans as the user approved them. Without an approval (the tool
 * didn't ask) every plan is saved whole.
 */
function commitData(
  ctx: ToolContext,
  plans: readonly { key: string; plan: DataPlan }[],
): { key: string; result: Record<string, unknown> }[] {
  const approval = ctx.approval;
  return plans.map(({ key, plan }) => {
    if (!approval)
      return {
        key,
        result: { saved: shownData(ctx.data.commitPlan(plan, plan.after)) },
      };
    const item = approval.review.items.find((i) => i.key === key);
    if (!item || JSON.stringify(item.before) !== JSON.stringify(plan.before)) {
      return { key, result: { error: CHANGED_SINCE } };
    }
    const snap = selected<DataSnapshot>(item, approval.selection);
    if (snap === undefined) {
      return {
        key,
        result: {
          notApplied: "The user approved none of these changes.",
          ...picked(item, approval.selection),
        },
      };
    }
    return {
      key,
      result: {
        saved: shownData(ctx.data.commitPlan(plan, snap)),
        ...picked(item, approval.selection),
      },
    };
  });
}

/** One plan's result as a tool output. */
function single(
  label: string,
  out: { key: string; result: Record<string, unknown> } | undefined,
): ToolOutput {
  const result = out?.result ?? {};
  if ("error" in result) {
    return fail(String(result.error), "rejected", {});
  }
  if ("saved" in result) {
    const { saved, ...rest } = result;
    return { data: { [label]: saved, ...rest } };
  }
  return { data: result };
}

// ---- Schemas ----------------------------------------------------------------

export const schemasList = defineTool({
  name: "schemas_list",
  description:
    "Lists the schemas available in this conversation: each has an id, name, scope, description and latest version. Built-in schemas (scope builtin) come with the app and can't be changed; copy one with schema_copy to change it. Data is made from a schema with data_create.",
  input: z.object({
    scope: SchemaScopeArg.optional().describe(
      `Leave out for every scope. ${SCOPE_HELP} builtin: the schemas that come with the app.`,
    ),
  }),
  approval: "never",
  execute: (input, ctx) =>
    guarded({ scope: input.scope }, () => ({
      data: { schemas: ctx.data.listSchemas(input.scope).map(shownSchema) },
    })),
});

export const schemaView = defineTool({
  name: "schema_view",
  description:
    "Shows a schema: its name, scope, description, latest version and the JSON Schema of the latest version, or of an earlier one.",
  input: z.object({
    id: Id.describe("The schema's id, from schemas_list."),
    version: Version.optional().describe("Leave out for the latest."),
  }),
  approval: "never",
  execute: (input, ctx) =>
    guarded({ id: input.id }, () => {
      const s = ctx.data.getSchema(input.id);
      const version = input.version ?? s.version;
      return {
        data: {
          ...shownSchema(s),
          shownVersion: version,
          schema: ctx.data.schemaBody(input.id, version),
        },
      };
    }),
});

const SchemaBody = z
  .record(z.string(), z.unknown())
  .describe(
    'A JSON Schema (2020-12). Supported: type (string, number, integer, boolean, array, object), title, description, enum, default, minLength, maxLength, pattern, format (date, date-time, time, email, uri), minimum, maximum, items, minItems, maxItems, properties, required. Objects, lists of objects and a top-level scalar are allowed. For example {"type": "object", "properties": {"title": {"type": "string"}, "done": {"type": "boolean"}}, "required": ["title"]}.',
  );

export const schemaCreate = defineTool({
  name: "schema_create",
  description:
    "Creates a schema: a named JSON Schema that data can be made from. The name is unique within its scope. The description tells you and other agents what the schema is for. Check schemas_list first so you don't make one that exists.",
  input: z.object({
    scope: scopeArg("Where the schema lives."),
    name: Name,
    description: Description,
    schema: SchemaBody,
  }),
  approval: "ask",
  execute: (input, ctx) =>
    guarded({ scope: input.scope, name: input.name }, () => ({
      data: {
        created: shownSchema(
          ctx.data.createSchema({
            scope: input.scope,
            name: input.name,
            description: input.description,
            body: input.schema,
          }),
        ),
      },
    })),
});

const schemaChanges = (input: {
  name?: string | undefined;
  description?: string | undefined;
  schema?: Record<string, unknown> | undefined;
}) => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.description !== undefined
    ? { description: input.description }
    : {}),
  ...(input.schema !== undefined ? { body: input.schema } : {}),
});

const schemaItem = (plan: SchemaPlan): ReviewItem => ({
  key: "schema",
  label: `Schema "${plan.before.name}"`,
  before: plan.before,
  after: plan.after,
  changes: changesBetween(plan.before, plan.after),
});

export const schemaUpdate = defineTool({
  name: "schema_update",
  description:
    "Changes a schema's name, description or JSON Schema. Only a change to the JSON Schema makes a new version. Data that passes the new version moves to it; data that doesn't stays on its version and is out of date until migrated.",
  input: z.object({
    id: Id.describe("The schema's id."),
    name: Name.optional(),
    description: Description.optional(),
    schema: SchemaBody.optional().describe(
      "The whole new JSON Schema. Leave out to keep it.",
    ),
  }),
  approval: "ask",
  review: (input, ctx) =>
    reviewGuarded({ id: input.id }, () => {
      const plan = ctx.data.planSchemaUpdate(input.id, schemaChanges(input));
      const item = schemaItem(plan);
      return {
        review: { items: [item] },
        check: (selection) => {
          const snap = selected<SchemaSnapshot>(item, selection);
          return snap === undefined ? [] : ctx.data.checkSchemaPlan(plan, snap);
        },
        stale: () => ctx.data.schemaPlanIsStale(plan),
      };
    }),
  execute: (input, ctx) =>
    guarded({ id: input.id }, () => {
      if (
        input.name === undefined &&
        input.description === undefined &&
        input.schema === undefined
      ) {
        return fail(
          "Give a name, a description or a schema to change.",
          "rejected",
          { id: input.id },
        );
      }
      const plan = ctx.data.planSchemaUpdate(input.id, schemaChanges(input));
      const approval = ctx.approval;
      let snap: SchemaSnapshot | undefined = plan.after;
      let pickedPaths = {};
      if (approval) {
        const item = approval.review.items[0];
        if (
          !item ||
          JSON.stringify(item.before) !== JSON.stringify(plan.before)
        ) {
          return fail(CHANGED_SINCE.replace("data", "schema"), "rejected", {
            id: input.id,
          });
        }
        snap = selected<SchemaSnapshot>(item, approval.selection);
        pickedPaths = picked(item, approval.selection);
      }
      if (snap === undefined) {
        return {
          data: {
            notApplied: "The user approved none of these changes.",
            ...pickedPaths,
          },
        };
      }
      const updated = ctx.data.commitSchemaPlan(plan, snap);
      const outOfDate = updated.saved
        ? ctx.data.listData({ schemaId: input.id }).filter((d) => d.outOfDate)
            .length
        : 0;
      return {
        data: {
          updated: shownSchema(updated),
          ...(updated.saved ? { newVersion: updated.saved.version } : {}),
          ...pickedPaths,
          ...(outOfDate > 0
            ? {
                outOfDate,
                note: "Some data does not pass the new version. Find it with data_list and fix it with data_migrate or data_migrate_many.",
              }
            : {}),
        },
      };
    }),
});

export const schemaCopy = defineTool({
  name: "schema_copy",
  description:
    "Copies a schema's latest version into a scope as a new schema at version 1. Its data stays with the original. Give a new name when copying into the same scope.",
  input: z.object({
    id: Id.describe("The schema to copy."),
    scope: scopeArg("Where the copy goes."),
    name: Name.optional().describe("Leave out to keep the name."),
  }),
  approval: "ask",
  execute: (input, ctx) =>
    guarded({ id: input.id, scope: input.scope }, () => ({
      data: {
        copied: shownSchema(
          ctx.data.copySchema(input.id, input.scope, input.name),
        ),
      },
    })),
});

export const schemaDelete = defineTool({
  name: "schema_delete",
  description:
    "Deletes a schema together with all the data made from it. The user can restore them together.",
  input: z.object({ id: Id.describe("The schema to delete.") }),
  approval: "ask",
  execute: (input, ctx) =>
    guarded({ id: input.id }, () => {
      const { data } = ctx.data.deleteSchema(input.id);
      return { data: { deleted: input.id, dataDeleted: data } };
    }),
});

// ---- Data -------------------------------------------------------------------

/** A value or patch argument: any JSON. */
const Json = (description: string) => z.unknown().describe(description);

const MERGE_PATCH =
  'A JSON Merge Patch: only the fields to change, for example {"status": "done"}. A field set to null is removed. Lists are replaced whole, so send the full new list. A patch that is not an object replaces the whole value.';

export const dataList = defineTool({
  name: "data_list",
  description:
    "Lists data in this conversation without values: each has an id, name, scope, description, schema id and the schema version it is on. Open one with data_view. Check here before creating data that may already exist.",
  input: z.object({
    scope: Scope.optional().describe(
      `Leave out for every scope. ${SCOPE_HELP}`,
    ),
    schemaId: Id.optional().describe("Only data made from this schema."),
  }),
  approval: "never",
  execute: (input, ctx) =>
    guarded({ scope: input.scope, schemaId: input.schemaId }, () => ({
      data: {
        data: ctx.data
          .listData({
            ...(input.scope ? { scope: input.scope } : {}),
            ...(input.schemaId ? { schemaId: input.schemaId } : {}),
          })
          .map((d) => shownInfo(d)),
      },
    })),
});

export const dataView = defineTool({
  name: "data_view",
  description:
    "Shows a piece of data with its value, the schema version it is on, and a warning when it is out of date.",
  input: z.object({ id: Id.describe("The data's id, from data_list.") }),
  approval: "never",
  execute: (input, ctx) =>
    guarded({ id: input.id }, () => ({
      data: shownData(ctx.data.getData(input.id)),
    })),
});

const createInput = (input: {
  schemaId: string;
  scope: DataScope;
  name: string;
  description: string;
  value: unknown;
}) => ({
  scope: input.scope,
  schemaId: input.schemaId,
  name: input.name,
  description: input.description,
  value: input.value,
});

const updateChanges = (input: {
  patch?: unknown;
  name?: string | undefined;
  description?: string | undefined;
}) => ({
  ...(input.patch !== undefined ? { patch: input.patch } : {}),
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.description !== undefined
    ? { description: input.description }
    : {}),
});

export const dataCreate = defineTool({
  name: "data_create",
  description:
    "Creates a piece of data from a schema's latest version. The value must match the schema. Data from a session schema can only be saved in the session scope; data from a project or agent schema in that scope or the session.",
  input: z.object({
    schemaId: Id.describe("The schema to make it from, from schemas_list."),
    scope: scopeArg("Where the data lives."),
    name: Name,
    description: Description.describe(
      "What this piece of data is, for you and other agents.",
    ),
    value: Json("The value, matching the schema."),
  }),
  approval: "ask",
  review: (input, ctx) =>
    reviewGuarded({ schemaId: input.schemaId }, () =>
      dataReview(ctx, [
        { key: "data", plan: ctx.data.planCreate(createInput(input)) },
      ]),
    ),
  execute: (input, ctx) => {
    const target = { schemaId: input.schemaId, scope: input.scope };
    if (input.value === undefined) {
      return fail("Give the value.", "rejected", target);
    }
    return guarded(target, () =>
      single(
        "created",
        commitData(ctx, [
          { key: "data", plan: ctx.data.planCreate(createInput(input)) },
        ])[0],
      ),
    );
  },
});

export const dataUpdate = defineTool({
  name: "data_update",
  description:
    "Changes a piece of data with a merge patch, and its name or description. The result must match the schema version the data is on; that version does not change. To move data to a newer version, use data_migrate.",
  input: z.object({
    id: Id.describe("The data's id."),
    patch: Json(`${MERGE_PATCH} Leave out to keep the value.`).optional(),
    name: Name.optional(),
    description: Description.optional(),
  }),
  approval: "ask",
  review: (input, ctx) =>
    reviewGuarded({ id: input.id }, () =>
      dataReview(ctx, [
        {
          key: "data",
          plan: ctx.data.planUpdate(input.id, updateChanges(input)),
        },
      ]),
    ),
  execute: (input, ctx) =>
    guarded({ id: input.id }, () => {
      if (
        input.patch === undefined &&
        input.name === undefined &&
        input.description === undefined
      ) {
        return fail(
          "Give a patch, a name or a description to change.",
          "rejected",
          { id: input.id },
        );
      }
      return single(
        "updated",
        commitData(ctx, [
          {
            key: "data",
            plan: ctx.data.planUpdate(input.id, updateChanges(input)),
          },
        ])[0],
      );
    }),
});

export const dataMigrate = defineTool({
  name: "data_migrate",
  description:
    "Moves a piece of data to a newer version of its schema. The new version's defaults are filled in first, then the merge patch is applied; the result must match the new version.",
  input: z.object({
    id: Id.describe("The data's id."),
    toVersion: Version.optional().describe("Leave out for the latest."),
    patch: Json(
      `${MERGE_PATCH} Leave out when the defaults are enough.`,
    ).optional(),
  }),
  approval: "ask",
  review: (input, ctx) =>
    reviewGuarded({ id: input.id }, () =>
      dataReview(ctx, [
        {
          key: "data",
          plan: ctx.data.planMigrate(input.id, input.toVersion, input.patch),
        },
      ]),
    ),
  execute: (input, ctx) =>
    guarded({ id: input.id }, () =>
      single(
        "migrated",
        commitData(ctx, [
          {
            key: "data",
            plan: ctx.data.planMigrate(input.id, input.toVersion, input.patch),
          },
        ])[0],
      ),
    ),
});

type ManyItem = { id: string; toVersion?: number | undefined; patch?: unknown };

/** Plans for the items that can be worked out, and errors for the rest. */
function migrationPlans(ctx: ToolContext, items: readonly ManyItem[]) {
  const plans: { key: string; plan: DataPlan }[] = [];
  const errors: { id: string; error: string }[] = [];
  for (const item of items) {
    try {
      plans.push({
        key: item.id,
        plan: ctx.data.planMigrate(item.id, item.toVersion, item.patch),
      });
    } catch (err) {
      if (err instanceof DataError)
        errors.push({ id: item.id, error: err.message });
      else throw err;
    }
  }
  return { plans, errors };
}

export const dataMigrateMany = defineTool({
  name: "data_migrate_many",
  description:
    "Moves several pieces of data to a newer version of their schemas in one call, each as data_migrate would. Each piece succeeds or fails on its own; the result says which.",
  input: z.object({
    items: z
      .array(
        z.object({
          id: Id.describe("The data's id."),
          toVersion: Version.optional().describe("Leave out for the latest."),
          patch: Json(
            `${MERGE_PATCH} Leave out when the defaults are enough.`,
          ).optional(),
        }),
      )
      .min(1)
      .max(100),
  }),
  approval: "ask",
  review: (input, ctx) => {
    const { plans, errors } = migrationPlans(ctx, input.items);
    // Nothing to ask about: every item is refused as it stands.
    if (plans.length === 0) {
      return {
        data: { results: errors },
        isError: true,
        details: { reason: "rejected", failed: errors.length },
      };
    }
    return dataReview(ctx, plans);
  },
  execute: (input, ctx) => {
    const { plans, errors } = migrationPlans(ctx, input.items);
    const saved = new Map(
      commitData(ctx, plans).map(({ key, result }) => [key, result]),
    );
    const results = input.items.map((item) => {
      const r = saved.get(item.id);
      if (r) {
        const { saved: value, ...rest } = r;
        return {
          id: item.id,
          ...(value !== undefined ? { migrated: value } : {}),
          ...rest,
        };
      }
      return (
        errors.find((e) => e.id === item.id) ?? {
          id: item.id,
          error: "Not found.",
        }
      );
    });
    const failed = results.filter((r) => "error" in r).length;
    return {
      data: { results },
      ...(failed === results.length
        ? { isError: true, details: { reason: "rejected", failed } }
        : {}),
    };
  },
});

export const dataDelete = defineTool({
  name: "data_delete",
  description: "Deletes a piece of data. The user can restore it.",
  input: z.object({ id: Id.describe("The data to delete.") }),
  approval: "ask",
  execute: (input, ctx) =>
    guarded({ id: input.id }, () => {
      ctx.data.deleteData(input.id);
      return { data: { deleted: input.id } };
    }),
});

export const schemaDataTools = [
  schemasList,
  schemaView,
  schemaCreate,
  schemaUpdate,
  schemaCopy,
  schemaDelete,
  dataList,
  dataView,
  dataCreate,
  dataUpdate,
  dataMigrate,
  dataMigrateMany,
  dataDelete,
];

// ---- The system message -----------------------------------------------------

/** A schema as the system message lists it (decision 37). */
export interface ListedSchema {
  id: string;
  name: string;
  scope: SchemaScope;
  description: string;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The schemas in scope, one per line with name and description (decision
 * 37); a scope is shown only for a name that is in more than one scope, as
 * for skills. It is what `{{schemas}}` expands to (decision 39). Ids are not
 * listed: `schemas_list` gives them. Empty when there are none.
 */
export function schemasText(schemas: readonly ListedSchema[]): string {
  const counts = new Map<string, number>();
  for (const s of schemas) counts.set(s.name, (counts.get(s.name) ?? 0) + 1);
  return schemas
    .map((s) => {
      const label =
        (counts.get(s.name) ?? 0) > 1 ? `${s.name} (${s.scope})` : s.name;
      return `- ${label}: ${oneLine(s.description)}`;
    })
    .join("\n");
}

/** A piece of data as the system message lists it. */
export interface ListedData {
  /** The name of the schema the data is made from. */
  schema: string;
  name: string;
  description: string;
}

/**
 * The data in scope, one per line with its schema's name, its own name and
 * its description (left out when empty). It is what `{{data}}` expands to.
 * Ids and values are not listed: `data_list` and `data_view` give them.
 * Empty when there is none.
 */
export function dataText(data: readonly ListedData[]): string {
  return data
    .map((d) => {
      const description = oneLine(d.description);
      return `- ${oneLine(d.schema)}: ${oneLine(d.name)}${description ? ` - ${description}` : ""}`;
    })
    .join("\n");
}

/**
 * The schema list with its instruction (decision 38), or undefined when no
 * schema is in scope. It goes after the prompts when none has `{{schemas}}`
 * (decision 41). The wording is Claude's draft, for review.
 */
export function schemasInstruction(
  schemas: readonly ListedSchema[],
): string | undefined {
  if (schemas.length === 0) return undefined;
  return [
    "You have schemas: named shapes for structured state, such as tasks or decisions. Data made from them is reached with the data tools: data_list to see what exists (check it before creating something new), data_view to read a piece, and data_create, data_update and data_migrate to change it. schema_view shows a schema's fields.",
    "",
    schemasText(schemas),
  ].join("\n");
}
