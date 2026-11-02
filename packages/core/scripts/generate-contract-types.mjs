// Membangkitkan tipe client kontrak `x207-circle` dari `abi/x207-circle.abi.json` (SD-010).
// Pakai: node scripts/generate-contract-types.mjs            (bangkitkan dari ABI yang dipin)
//        node scripts/generate-contract-types.mjs --pin <abi.json>  (salin ABI baru ke pin, lalu bangkitkan)
// Konstruk JSON Schema di luar yang dipakai ABI 0.0.1 sengaja melempar error, supaya perubahan
// bentuk ABI tidak lolos diam-diam.
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
export const PINNED_ABI_PATH = here("../abi/x207-circle.abi.json");
export const GENERATED_PATH = here("../src/contract/types.generated.ts");

const INTEGER_TS = "number";

function tsType(schema, where) {
  if (schema === true) return "unknown";
  if (typeof schema !== "object" || schema === null) throw new Error(`${where}: schema tidak dikenal`);
  if (schema.$ref !== undefined) {
    const match = /^#\/definitions\/(\w+)$/.exec(schema.$ref);
    if (!match) throw new Error(`${where}: $ref tidak dikenal ${schema.$ref}`);
    return match[1];
  }
  if (schema.anyOf !== undefined) return schema.anyOf.map((s, i) => tsType(s, `${where}.anyOf[${i}]`)).join(" | ");
  if (schema.oneOf !== undefined) return schema.oneOf.map((s, i) => tsType(s, `${where}.oneOf[${i}]`)).join(" | ");
  if (schema.enum !== undefined) {
    if (schema.type !== "string") throw new Error(`${where}: enum non-string`);
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => tsType({ ...schema, type }, where)).join(" | ");
  }
  switch (schema.type) {
    case "string": return "string";
    case "boolean": return "boolean";
    case "null": return "null";
    case "integer": return INTEGER_TS;
    case "array":
      if (schema.items === undefined) throw new Error(`${where}: array tanpa items`);
      return `${wrap(tsType(schema.items, `${where}.items`))}[]`;
    case "object": {
      const required = new Set(schema.required ?? []);
      const props = Object.entries(schema.properties ?? {});
      if (props.length === 0) throw new Error(`${where}: objek tanpa properties`);
      const fields = props.map(
        ([name, value]) => `${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${tsType(value, `${where}.${name}`)}`,
      );
      return `{ ${fields.join("; ")} }`;
    }
    default:
      throw new Error(`${where}: type tidak dikenal ${JSON.stringify(schema.type)}`);
  }
}

const wrap = (type) => (/[|{]/.test(type) && !type.startsWith("{") ? `(${type})` : type);

function methodType(fn) {
  const args = fn.params?.args ?? [];
  if ((fn.params?.serialization_type ?? "json") !== "json") throw new Error(`${fn.name}: serialization bukan json`);
  const argsType = args.length === 0
    ? "Record<string, never>"
    : `{ ${args.map((a) => {
        const type = tsType(a.type_schema, `${fn.name}.${a.name}`);
        // Option<T> di Rust boleh dihilangkan di JSON.
        return `${JSON.stringify(a.name)}${/\bnull\b/.test(type) ? "?" : ""}: ${type}`;
      }).join("; ")} }`;
  const result = fn.result === undefined ? "void" : tsType(fn.result.type_schema, `${fn.name}.result`);
  const flags = (fn.modifiers ?? []).map((m) => `${m}: true`);
  return `{ args: ${argsType}; result: ${result}${flags.map((f) => `; ${f}`).join("")} }`;
}

/** `abiText` = isi berkas ABI; hasil = isi `types.generated.ts`. */
export function generate(abiText) {
  const abi = JSON.parse(abiText);
  const sha256 = createHash("sha256").update(abiText).digest("hex");
  const definitions = abi.body.root_schema.definitions ?? {};
  const functions = abi.body.functions;
  const views = functions.filter((f) => f.kind === "view");
  const calls = functions.filter((f) => f.kind === "call");
  if (views.length + calls.length !== functions.length) throw new Error("kind method selain view/call");

  const out = [];
  out.push(
    "// GENERATED oleh scripts/generate-contract-types.mjs dari abi/x207-circle.abi.json. Jangan diedit.",
    "// Ubah ABI lewat contracts (CT-068), lalu: node scripts/generate-contract-types.mjs --pin <abi.json>",
    "",
    `export const X207_CIRCLE_ABI_VERSION = ${JSON.stringify(abi.interface_version)};`,
    `export const X207_CIRCLE_ABI_SCHEMA_VERSION = ${JSON.stringify(abi.schema_version)};`,
    `export const X207_CIRCLE_ABI_SHA256 = ${JSON.stringify(sha256)};`,
    `export const X207_CIRCLE_EVENT_STANDARD = ${JSON.stringify(abi.event_standard)};`,
    "",
  );
  for (const [name, schema] of Object.entries(definitions)) {
    out.push(`export type ${name} = ${tsType(schema, name)};`);
  }
  out.push("", "/** View: `args` = argumen JSON, `result` = nilai kembalian. */", "export type CircleViews = {");
  for (const fn of views) out.push(`  ${JSON.stringify(fn.name)}: ${methodType(fn)};`);
  out.push("};", "", "/** Call: transaksi. `payable`, `init`, `private` dari modifier ABI. */", "export type CircleCalls = {");
  for (const fn of calls) out.push(`  ${JSON.stringify(fn.name)}: ${methodType(fn)};`);
  out.push("};", "");
  out.push(`export const CIRCLE_VIEW_METHODS = ${JSON.stringify(views.map((f) => f.name))} as const;`);
  out.push(`export const CIRCLE_CALL_METHODS = ${JSON.stringify(calls.map((f) => f.name))} as const;`, "");
  out.push("/** Nama event NEP-297 dan urutan field `data`-nya. */", "export const CIRCLE_EVENTS = {");
  for (const event of abi.events) out.push(`  ${JSON.stringify(event.name)}: ${JSON.stringify(event.fields)},`);
  out.push("} as const;", "", "export type CircleEventName = keyof typeof CIRCLE_EVENTS;", "");
  return out.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const pinIndex = process.argv.indexOf("--pin");
  if (pinIndex !== -1) {
    const source = process.argv[pinIndex + 1];
    if (!source) throw new Error("--pin butuh path abi.json");
    copyFileSync(source, PINNED_ABI_PATH);
  }
  writeFileSync(GENERATED_PATH, generate(readFileSync(PINNED_ABI_PATH, "utf8")));
  console.log(`ditulis ${GENERATED_PATH}`);
}
