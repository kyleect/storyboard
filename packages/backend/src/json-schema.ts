import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { checkSchemaFeatures, type SchemaChecker } from "@harness/core";

/*
 * Checks schemas and data against JSON Schema 2020-12 with Ajv (schemas and
 * data design, decision 18; plan P2, P3). Ajv compiles each schema into a
 * function, so it runs here in the backend only. A schema must be valid
 * JSON Schema (strict mode) and use only the supported features (decision
 * 17); every default must match its own part of the schema.
 */

const ajv = new Ajv2020({ allErrors: true, strict: true });
// Loaded as ESM, the package's default import is the CommonJS module, whose
// `default` is the plugin (its types describe only that).
addFormats.default(ajv);

/** Compiled schemas, by their JSON text. */
const compiled = new Map<string, ReturnType<Ajv2020["compile"]>>();
const COMPILED_LIMIT = 500;

function compile(body: unknown) {
  const key = JSON.stringify(body);
  let validate = compiled.get(key);
  if (!validate) {
    validate = ajv.compile(body as object);
    if (compiled.size >= COMPILED_LIMIT) compiled.clear();
    compiled.set(key, validate);
  }
  return validate;
}

/** An Ajv error as "path: message". */
function describe(e: ErrorObject): string {
  const path = e.instancePath === "" ? "(value)" : e.instancePath;
  switch (e.keyword) {
    case "required":
      return `${path}: missing required property '${String(e.params.missingProperty)}'.`;
    case "enum":
      return `${path}: must be one of ${(e.params.allowedValues as unknown[])
        .map((v) => JSON.stringify(v))
        .join(", ")}.`;
    default:
      return `${path}: ${e.message ?? "is not valid"}.`;
  }
}

/** Every `default` in the schema, with the part of the schema it is in. */
function defaults(
  node: unknown,
  path: string,
): { path: string; node: object }[] {
  if (!node || typeof node !== "object") return [];
  const o = node as Record<string, unknown>;
  const own = "default" in o ? [{ path: path || "(schema)", node: o }] : [];
  const children: { path: string; node: object }[] = [];
  if (o.items)
    children.push(...defaults(o.items, `${path ? path + "." : ""}items`));
  if (o.properties && typeof o.properties === "object") {
    for (const [k, v] of Object.entries(o.properties)) {
      children.push(...defaults(v, `${path ? path + "." : ""}properties.${k}`));
    }
  }
  return [...own, ...children];
}

export const schemaChecker: SchemaChecker = {
  checkSchema(body) {
    const features = checkSchemaFeatures(body);
    if (features.length > 0) return features;
    try {
      compile(body);
    } catch (err) {
      return [`(schema): ${(err as Error).message}`];
    }
    const errors: string[] = [];
    for (const d of defaults(body, "")) {
      const { default: value, ...rest } = d.node as Record<string, unknown>;
      const ok = compile(rest);
      if (!ok(value)) {
        errors.push(
          `${d.path}: the default does not match: ${(ok.errors ?? []).map(describe).join(" ")}`,
        );
      }
    }
    return errors;
  },

  checkData(body, value) {
    let validate;
    try {
      validate = compile(body);
    } catch (err) {
      return [`(schema): ${(err as Error).message}`];
    }
    return validate(value) ? [] : (validate.errors ?? []).map(describe);
  },
};
