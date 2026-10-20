import { fail } from "./errors.js";
export function validate(value, schema, query = false) {
  if (schema.type === "object") {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => !Object.hasOwn(schema.properties, k))
    )
      throw fail("invalid_input");
    for (const k of schema.required ?? [])
      if (value[k] === undefined) throw fail("invalid_input");
    return Object.fromEntries(
      Object.entries(schema.properties).flatMap(([k, s]) =>
        value[k] === undefined
          ? s.default === undefined
            ? []
            : [[k, s.default]]
          : [[k, validateField(k, value[k], s, query)]],
      ),
    );
  }
  if (
    query &&
    schema.type === "integer" &&
    typeof value === "string" &&
    /^[0-9]+$/.test(value)
  )
    value = Number(value);
  if (query && schema.type === "boolean" && ["true", "false"].includes(value))
    value = value === "true";
  if (schema.enum && !schema.enum.includes(value)) throw fail("invalid_input");
  if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? 100) ||
      (schema.uniqueItems && new Set(value).size !== value.length)
    )
      throw fail("invalid_input");
    return value.map((v) => validate(v, schema.items));
  }
  if (
    schema.type === "string" &&
    (typeof value !== "string" ||
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? 2000) ||
      (schema.pattern && !new RegExp(schema.pattern).test(value)) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
  )
    throw fail("invalid_input");
  if (
    schema.type === "integer" &&
    (!Number.isSafeInteger(value) ||
      value < (schema.minimum ?? 0) ||
      value > (schema.maximum ?? Number.MAX_SAFE_INTEGER))
  )
    throw fail("invalid_input");
  if (schema.type === "boolean" && typeof value !== "boolean")
    throw fail("invalid_input");
  return value;
}

function validateField(name, value, schema, query) {
  try {
    return validate(value, schema, query);
  } catch (error) {
    if (error.code === "invalid_input" && !error.field) {
      error.field = name;
      error.message = `Invalid ${name}. ${schema.description ?? "Check the required type and format."}`;
    }
    throw error;
  }
}
