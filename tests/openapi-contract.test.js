"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sourcePath = path.join(root, "backend", "src", "ForgeX.Api", "openapi", "v1.json");
const generatedPath = path.join(root, "frontend", "src", "generated", "forgex-api.ts");
const projectPath = path.join(root, "backend", "src", "ForgeX.Api", "ForgeX.Api.csproj");
const loaderPath = path.join(root, "backend", "src", "ForgeX.Api", "OpenApiDocument.cs");

const document = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
assert.strictEqual(document.openapi, "3.1.0", "OpenAPI version must remain 3.1.0");

const expectedOperations = new Map([
  ["analyzeGCode", ["POST", "/api/v1/gcode/analyze"]],
  ["createGCodeAnalysisJob", ["POST", "/api/v1/gcode/analyses"]],
  ["getGCodeAnalysisJob", ["GET", "/api/v1/jobs/{id}"]],
  ["streamGCodeAnalysisJobEvents", ["GET", "/api/v1/jobs/{id}/events"]],
  ["cancelGCodeAnalysisJob", ["POST", "/api/v1/jobs/{id}/cancel"]],
  ["analyzeAnalyticsReport", ["POST", "/api/v1/analytics/reports"]],
]);
const actualOperations = new Map();
for (const [route, pathItem] of Object.entries(document.paths)) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const operation = pathItem[method];
    if (!operation) continue;
    assert.ok(operation.operationId, `${method.toUpperCase()} ${route} must have operationId`);
    assert.ok(!actualOperations.has(operation.operationId), `duplicate operationId ${operation.operationId}`);
    actualOperations.set(operation.operationId, [method.toUpperCase(), route]);
  }
}
for (const [operationId, contract] of expectedOperations) {
  assert.deepStrictEqual(actualOperations.get(operationId), contract, `${operationId} route drifted`);
}

const schemas = document.components.schemas;
for (const schemaName of [
  "GCodeAnalysisResponse",
  "GCodeInputSummary",
  "GCodeJobAcceptedResponse",
  "GCodeJobSnapshotResponse",
  "GCodeJobLinks",
  "GCodeJobError",
  "GCodeJobEvent",
  "AnalyticsReportRequest",
  "AnalyticsAuthorityResponse",
  "AnalyticsReport",
  "AnalyticsEvidence",
  "ApiProblem",
]) {
  assert.ok(schemas[schemaName], `missing schema ${schemaName}`);
}
assert.strictEqual(
  schemas.GCodeJobAcceptedResponse.properties.links.$ref,
  "#/components/schemas/GCodeJobLinks",
  "accepted links must not degrade to an untyped object"
);
assert.strictEqual(
  schemas.GCodeJobSnapshotResponse.properties.result.oneOf[0].$ref,
  "#/components/schemas/GCodeAnalysisResponse",
  "terminal result must retain the authority schema"
);
assert.strictEqual(
  schemas.AnalyticsAuthorityResponse.properties.report.$ref,
  "#/components/schemas/AnalyticsReport",
  "analytics authority response must retain the typed report schema"
);
assert.strictEqual(
  schemas.AnalyticsReportRequest.properties.rows.items.$ref,
  "#/components/schemas/AnalyticsRow",
  "analytics request rows must remain typed"
);

const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
const generated = fs.readFileSync(generatedPath, "utf8");
assert.ok(generated.includes(`sha256:${sourceSha256}`), "generated client source hash is stale");

const project = fs.readFileSync(projectPath, "utf8");
const loader = fs.readFileSync(loaderPath, "utf8");
assert.ok(project.includes('EmbeddedResource Include="openapi\\v1.json"'), "OpenAPI JSON must be embedded in API DLL");
assert.ok(
  loader.includes('ResourceName = "ForgeX.Api.openapi.v1.json"'),
  "API must serve the embedded canonical document"
);
assert.ok(!loader.includes('public const string Json = """'), "a second handwritten OpenAPI copy is forbidden");

process.argv.push("--check");
require(path.join(root, "tools", "generate-openapi-types.js"));
process.argv.pop();

console.log(`OpenAPI contract OK: ${actualOperations.size} operations, ${Object.keys(schemas).length} schemas`);
