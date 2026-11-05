import { z } from "zod";

/*
 * The JSON Schema features a data schema may use (schemas and data design,
 * decision 17): the ones the forms and the builder can draw. Ajv checks
 * that a schema is valid JSON Schema (decision 18, in the backend); this
 * checks that it uses only these features. Unknown keywords are refused, so
 * a typo such as "requird" is an error rather than a rule that is never
 * applied.
 */

/** The JSON Schema draft schemas are written in (plan P2). */
export const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** The `format` values the forms can draw (decision 17). */
export const SCHEMA_FORMATS = [
  "date",
  "date-time",
  "time",
  "email",
  "uri",
] as const;

/** A JSON Schema node within the supported features. */
export type SchemaNode =
  | ({ type: "string" } & Annotations & {
        enum?: string[];
        default?: string;
        minLength?: number;
        maxLength?: number;
        pattern?: string;
        format?: (typeof SCHEMA_FORMATS)[number];
      })
  | ({ type: "number" | "integer" } & Annotations & {
        enum?: number[];
        default?: number;
        minimum?: number;
        maximum?: number;
      })
  | ({ type: "boolean" } & Annotations & { default?: boolean })
  | ({ type: "array" } & Annotations & {
        items: SchemaNode;
        default?: unknown[];
        minItems?: number;
        maxItems?: number;
      })
  | ({ type: "object" } & Annotations & {
        properties: Record<string, SchemaNode>;
        required?: string[];
        default?: Record<string, unknown>;
      });

interface Annotations {
  title?: string;
  description?: string;
}

const count = z.int().min(0);
const annotations = {
  title: z.string().optional(),
  description: z.string().optional(),
};

const Node: z.ZodType<SchemaNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("string"),
      ...annotations,
      enum: z.array(z.string()).min(1).optional(),
      default: z.string().optional(),
      minLength: count.optional(),
      maxLength: count.optional(),
      pattern: z.string().optional(),
      format: z.enum(SCHEMA_FORMATS).optional(),
    }),
    z.strictObject({
      type: z.enum(["number", "integer"]),
      ...annotations,
      enum: z.array(z.number()).min(1).optional(),
      default: z.number().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    }),
    z.strictObject({
      type: z.literal("boolean"),
      ...annotations,
      default: z.boolean().optional(),
    }),
    z.strictObject({
      type: z.literal("array"),
      ...annotations,
      items: Node,
      default: z.array(z.unknown()).optional(),
      minItems: count.optional(),
      maxItems: count.optional(),
    }),
    z.strictObject({
      type: z.literal("object"),
      ...annotations,
      properties: z.record(z.string(), Node),
      required: z.array(z.string()).optional(),
      default: z.record(z.string(), z.unknown()).optional(),
    }),
  ]),
) as z.ZodType<SchemaNode>;

const KEYWORDS =
  "type, title, description, enum, default, minLength, maxLength, pattern, format, minimum, maximum, items, minItems, maxItems, properties, required";

/**
 * Problems with a schema's use of features, as "path: message" lines; empty
 * when it uses only the supported ones. A top-level `$schema` is allowed
 * when it names the supported draft. Checks that need a JSON Schema engine
 * (a valid pattern, a default that matches) are left to Ajv.
 */
export function checkSchemaFeatures(body: unknown): string[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return ["(schema): must be an object."];
  }
  const { $schema, ...rest } = body as Record<string, unknown>;
  const errors: string[] = [];
  if ($schema !== undefined && $schema !== SCHEMA_DIALECT) {
    errors.push(`$schema: only ${SCHEMA_DIALECT} is supported.`);
  }
  const result = Node.safeParse(rest);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(schema)";
      errors.push(`${path}: ${featureMessage(issue)}`);
    }
  }
  if (result.success) errors.push(...semanticErrors(result.data, ""));
  return errors;
}

function featureMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    return `unsupported keyword${issue.keys.length > 1 ? "s" : ""} ${issue.keys
      .map((k) => `"${k}"`)
      .join(", ")}. Supported: ${KEYWORDS}.`;
  }
  if (issue.code === "invalid_union") {
    return 'needs "type": one of string, number, integer, boolean, array, object.';
  }
  return issue.message;
}

/** Rules the shape alone does not express. */
function semanticErrors(node: SchemaNode, path: string): string[] {
  const at = path === "" ? "(schema)" : path;
  const out: string[] = [];
  const range = (
    low: number | undefined,
    high: number | undefined,
    what: string,
  ) => {
    if (low !== undefined && high !== undefined && low > high) {
      out.push(`${at}: ${what} minimum is above its maximum.`);
    }
  };
  switch (node.type) {
    case "string":
      range(node.minLength, node.maxLength, "length");
      break;
    case "number":
    case "integer":
      range(node.minimum, node.maximum, "the");
      break;
    case "array":
      range(node.minItems, node.maxItems, "item count");
      out.push(...semanticErrors(node.items, `${path ? path + "." : ""}items`));
      break;
    case "object": {
      const names = Object.keys(node.properties);
      for (const r of node.required ?? []) {
        if (!names.includes(r)) {
          out.push(`${at}: "${r}" is required but is not a property.`);
        }
      }
      if (new Set(node.required ?? []).size !== (node.required ?? []).length) {
        out.push(`${at}: a name is repeated in "required".`);
      }
      for (const [name, child] of Object.entries(node.properties)) {
        out.push(
          ...semanticErrors(
            child,
            `${path ? path + "." : ""}properties.${name}`,
          ),
        );
      }
      break;
    }
    case "boolean":
      break;
  }
  return out;
}
