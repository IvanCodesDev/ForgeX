"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "backend", "src", "ForgeX.Api", "openapi", "v1.json");
const outputPath = path.join(root, "frontend", "src", "generated", "forgex-api.ts");
const checkOnly = process.argv.includes("--check");

function fail(message) {
  process.stderr.write(`OpenAPI generation failed: ${message}\n`);
  process.exit(1);
}

function identifier(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function referenceName(reference) {
  const prefix = "#/components/schemas/";
  if (typeof reference !== "string" || !reference.startsWith(prefix)) {
    fail(`unsupported reference ${String(reference)}`);
  }
  return reference.slice(prefix.length);
}

function schemaType(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) fail("schema must be an object");
  if (schema.$ref) return referenceName(schema.$ref);
  if (Object.prototype.hasOwnProperty.call(schema, "const")) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((item) => schemaType(item, depth)).join(" | ");
  if (Array.isArray(schema.type)) {
    return schema.type.map((type) => schemaType({ ...schema, type }, depth)).join(" | ");
  }
  if (schema.type === "null") return "null";
  if (schema.type === "string") return "string";
  if (schema.type === "number" || schema.type === "integer") return "number";
  if (schema.type === "boolean") return "boolean";
  if (schema.type === "array") return `ReadonlyArray<${schemaType(schema.items, depth)}>`;
  if (schema.type === "object" || schema.properties || schema.additionalProperties) {
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : null;
    if (!properties || Object.keys(properties).length === 0) {
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        return `Readonly<Record<string, ${schemaType(schema.additionalProperties, depth + 1)}>>`;
      }
      return "Readonly<Record<string, unknown>>";
    }
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const members = Object.entries(properties).map(([name, property]) => {
      const optional = required.has(name) ? "" : "?";
      return `readonly ${identifier(name)}${optional}: ${schemaType(property, depth + 1)};`;
    });
    return `{ ${members.join(" ")} }`;
  }
  fail(`unsupported schema ${JSON.stringify(schema)}`);
}

function schemaDeclaration(name, schema) {
  if (identifier(name) !== name) fail(`schema name is not a TypeScript identifier: ${name}`);
  if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const lines = [`export interface ${name} {`];
    for (const [propertyName, property] of Object.entries(schema.properties)) {
      const optional = required.has(propertyName) ? "" : "?";
      lines.push(`  readonly ${identifier(propertyName)}${optional}: ${schemaType(property, 1)};`);
    }
    lines.push("}");
    return lines.join("\n");
  }
  return `export type ${name} = ${schemaType(schema)};`;
}

function successType(operation, document) {
  const success = Object.entries(operation.responses || {}).find(([status]) => /^2\d\d$/.test(status));
  if (!success) return "unknown";
  let response = success[1];
  if (response.$ref) {
    const prefix = "#/components/responses/";
    if (!response.$ref.startsWith(prefix)) fail(`unsupported response reference ${response.$ref}`);
    response = document.components?.responses?.[response.$ref.slice(prefix.length)];
    if (!response) fail(`missing response component ${success[1].$ref}`);
  }
  const content = response.content || {};
  const media = content["application/json"] || content["application/problem+json"];
  return media?.schema ? schemaType(media.schema) : "unknown";
}

function generate(document, sourceSha256) {
  if (document.openapi !== "3.1.0") fail(`expected OpenAPI 3.1.0, got ${document.openapi}`);
  const schemas = document.components?.schemas;
  if (!schemas || typeof schemas !== "object") fail("components.schemas is missing");
  const operations = [];
  for (const [route, pathItem] of Object.entries(document.paths || {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = pathItem[method];
      if (!operation) continue;
      if (!operation.operationId) fail(`${method.toUpperCase()} ${route} has no operationId`);
      operations.push({
        operationId: operation.operationId,
        method: method.toUpperCase(),
        route,
        successType: successType(operation, document),
      });
    }
  }
  operations.sort((left, right) => compareText(left.operationId, right.operationId));

  const lines = [
    "// Generated by tools/generate-openapi-types.js. Do not edit by hand.",
    `// Source: backend/src/ForgeX.Api/openapi/v1.json (sha256:${sourceSha256})`,
    "",
  ];
  for (const [name, schema] of Object.entries(schemas).sort(([left], [right]) => compareText(left, right))) {
    lines.push(schemaDeclaration(name, schema), "");
  }
  lines.push("export const forgeXApiOperations = {");
  for (const operation of operations) {
    lines.push(
      `  ${identifier(operation.operationId)}: { method: ${JSON.stringify(operation.method)}, path: ${JSON.stringify(operation.route)} },`
    );
  }
  lines.push("} as const;", "");
  lines.push("export interface ForgeXApiOperationResponses {");
  for (const operation of operations) {
    lines.push(`  readonly ${identifier(operation.operationId)}: ${operation.successType};`);
  }
  lines.push("}", "");
  lines.push("export type ForgeXApiOperationId = keyof typeof forgeXApiOperations;", "");
  lines.push(
    "export function forgeXApiPath(operationId: ForgeXApiOperationId, parameters: Readonly<Record<string, string>> = {}): string {",
    "  const template = forgeXApiOperations[operationId].path;",
    "  return template.replace(/\\{([^}]+)\\}/g, (_match, name: string) => {",
    "    const value = parameters[name];",
    "    if (value === undefined) throw new Error(`Missing OpenAPI path parameter: ${name}`);",
    "    return encodeURIComponent(value);",
    "  });",
    "}",
    ""
  );
  return lines.join("\n");
}

if (!fs.existsSync(sourcePath)) fail(`source not found: ${sourcePath}`);
const source = fs.readFileSync(sourcePath);
const sourceSha256 = crypto.createHash("sha256").update(source).digest("hex");
const document = JSON.parse(source.toString("utf8"));
const generated = generate(document, sourceSha256);

if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
  if (current !== generated) fail(`generated client is stale; run node tools/generate-openapi-types.js`);
  process.stdout.write(`OpenAPI generated client is current: ${path.relative(root, outputPath)}\n`);
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generated);
  process.stdout.write(`Generated ${path.relative(root, outputPath)} from ${path.relative(root, sourcePath)}\n`);
}
