namespace ForgeX.Api;

internal static class OpenApiDocument
{
    public const string Json = """
        {
          "openapi": "3.1.0",
          "info": {
            "title": "ForgeX Authoritative API",
            "version": "1.0.0",
            "description": "Deterministic, streaming G-code analysis API. The response contains summary evidence and never returns full toolpaths."
          },
          "servers": [
            { "url": "http://127.0.0.1:8788", "description": "Local development" }
          ],
          "paths": {
            "/health/live": {
              "get": {
                "operationId": "getLiveness",
                "responses": { "200": { "$ref": "#/components/responses/Health" } }
              }
            },
            "/health/ready": {
              "get": {
                "operationId": "getReadiness",
                "responses": { "200": { "$ref": "#/components/responses/Health" } }
              }
            },
            "/healthz": {
              "get": {
                "operationId": "getLegacyHealth",
                "responses": {
                  "200": {
                    "description": "Compatibility health response",
                    "content": { "application/json": { "schema": { "$ref": "#/components/schemas/LegacyHealthResponse" } } }
                  }
                }
              }
            },
            "/api/v1/gcode/analyze": {
              "post": {
                "operationId": "analyzeGCode",
                "summary": "Analyze an FDM G-code stream",
                "parameters": [
                  { "name": "bedSizeMm", "in": "query", "schema": { "type": "number", "minimum": 1, "maximum": 2000, "default": 256 } },
                  { "name": "coordinateOrigin", "in": "query", "schema": { "type": "string", "enum": ["corner", "center"], "default": "corner" } },
                  { "name": "filamentDensityGPerCm3", "in": "query", "schema": { "type": "number", "exclusiveMinimum": 0, "maximum": 20, "default": 1.24 } }
                ],
                "requestBody": {
                  "required": true,
                  "content": { "application/x-gcode": { "schema": { "type": "string", "format": "binary", "maxLength": 67108864 } } }
                },
                "responses": {
                  "200": {
                    "description": "Authoritative analysis summary",
                    "content": { "application/json": { "schema": { "$ref": "#/components/schemas/GCodeAnalysisResponse" } } }
                  },
                  "400": { "$ref": "#/components/responses/Problem" },
                  "413": { "$ref": "#/components/responses/Problem" },
                  "415": { "$ref": "#/components/responses/Problem" },
                  "422": { "$ref": "#/components/responses/Problem" },
                  "500": { "$ref": "#/components/responses/Problem" }
                }
              }
            },
            "/api/v1/gcode/analyses": {
              "post": {
                "operationId": "createGCodeAnalysisJob",
                "summary": "Persist a G-code stream and queue an authoritative analysis",
                "parameters": [
                  { "name": "Idempotency-Key", "in": "header", "schema": { "type": "string", "maxLength": 128 } },
                  { "name": "bedSizeMm", "in": "query", "schema": { "type": "number", "minimum": 1, "maximum": 2000, "default": 256 } },
                  { "name": "coordinateOrigin", "in": "query", "schema": { "type": "string", "enum": ["corner", "center"], "default": "corner" } },
                  { "name": "filamentDensityGPerCm3", "in": "query", "schema": { "type": "number", "exclusiveMinimum": 0, "maximum": 20, "default": 1.24 } }
                ],
                "requestBody": { "required": true, "content": { "application/x-gcode": { "schema": { "type": "string", "format": "binary", "maxLength": 67108864 } } } },
                "responses": {
                  "202": { "description": "Job queued", "headers": { "Location": { "schema": { "type": "string" } } }, "content": { "application/json": { "schema": { "$ref": "#/components/schemas/GCodeJobAcceptedResponse" } } } },
                  "409": { "$ref": "#/components/responses/Problem" }
                }
              }
            },
            "/api/v1/jobs/{id}": {
              "get": {
                "operationId": "getGCodeAnalysisJob",
                "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string", "pattern": "^[a-f0-9]{32}$" } }],
                "responses": { "200": { "description": "Durable job snapshot", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/GCodeJobSnapshotResponse" } } } }, "404": { "$ref": "#/components/responses/Problem" } }
              }
            },
            "/api/v1/jobs/{id}/events": {
              "get": {
                "operationId": "streamGCodeAnalysisJobEvents",
                "parameters": [
                  { "name": "id", "in": "path", "required": true, "schema": { "type": "string", "pattern": "^[a-f0-9]{32}$" } },
                  { "name": "Last-Event-ID", "in": "header", "schema": { "type": "integer", "minimum": 0 } }
                ],
                "responses": { "200": { "description": "SSE progress, heartbeat, and terminal events", "content": { "text/event-stream": { "schema": { "type": "string" } } } }, "404": { "$ref": "#/components/responses/Problem" } }
              }
            },
            "/api/v1/jobs/{id}/cancel": {
              "post": {
                "operationId": "cancelGCodeAnalysisJob",
                "parameters": [{ "name": "id", "in": "path", "required": true, "schema": { "type": "string", "pattern": "^[a-f0-9]{32}$" } }],
                "responses": { "200": { "description": "Current terminal or cancelled snapshot", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/GCodeJobSnapshotResponse" } } } }, "404": { "$ref": "#/components/responses/Problem" } }
              }
            }
          },
          "components": {
            "responses": {
              "Health": {
                "description": "Health status",
                "content": { "application/json": { "schema": { "$ref": "#/components/schemas/HealthResponse" } } }
              },
              "Problem": {
                "description": "RFC 9457 problem details with stable ForgeX extensions",
                "content": { "application/problem+json": { "schema": { "$ref": "#/components/schemas/ApiProblem" } } }
              }
            },
            "schemas": {
              "HealthResponse": {
                "type": "object",
                "required": ["status", "service", "version", "timestampUtc"],
                "properties": {
                  "status": { "type": "string" },
                  "service": { "type": "string" },
                  "version": { "type": "string" },
                  "timestampUtc": { "type": "string", "format": "date-time" },
                  "checks": { "type": "object", "additionalProperties": { "type": "string" } }
                }
              },
              "LegacyHealthResponse": {
                "type": "object",
                "required": ["ok", "engine", "provider", "capabilities", "capabilityScope", "now"],
                "properties": {
                  "ok": { "type": "boolean" },
                  "engine": { "type": "string" },
                  "provider": { "type": "string" },
                  "capabilities": {
                    "type": "object",
                    "properties": {
                      "ai": { "type": "boolean" },
                      "gCodeAnalysis": { "type": "boolean" },
                      "streaming": { "type": "boolean" },
                      "structuredOutput": { "type": "boolean" }
                    }
                  },
                  "capabilityScope": { "type": "string" },
                  "now": { "type": "integer", "format": "int64" }
                }
              },
              "GCodeAnalysisResponse": {
                "type": "object",
                "required": ["schemaVersion", "engine", "input", "parameters", "summary", "bounds", "claims", "pathTypeCounts", "warnings"],
                "properties": {
                  "schemaVersion": { "type": "string", "const": "1.0" },
                  "engine": {
                    "type": "object",
                    "required": ["version", "source"],
                    "properties": { "version": { "type": "string" }, "source": { "type": "string" } }
                  },
                  "input": {
                    "type": "object",
                    "required": ["sha256", "bytesRead", "linesRead"],
                    "properties": {
                      "sha256": { "type": "string", "pattern": "^[a-f0-9]{64}$" },
                      "bytesRead": { "type": "integer", "format": "int64" },
                      "linesRead": { "type": "integer", "format": "int64" }
                    }
                  },
                  "parameters": {
                    "type": "object",
                    "required": ["bedSizeMm", "coordinateOrigin", "filamentDensityGPerCm3"],
                    "properties": {
                      "bedSizeMm": { "type": "number" },
                      "coordinateOrigin": { "type": "string", "enum": ["corner", "center"] },
                      "filamentDensityGPerCm3": { "type": "number" }
                    }
                  },
                  "summary": {
                    "type": "object",
                    "required": ["totalLayers", "heightMm", "extrusionLengthMm", "travelLengthMm", "estimatedTimeSeconds", "volumeCm3", "filamentLengthM", "filamentMassG"],
                    "properties": {
                      "totalLayers": { "type": "integer" },
                      "heightMm": { "type": "number" },
                      "extrusionLengthMm": { "type": "number" },
                      "travelLengthMm": { "type": "number" },
                      "estimatedTimeSeconds": { "type": "number" },
                      "volumeCm3": { "type": "number" },
                      "filamentLengthM": { "type": "number" },
                      "filamentMassG": { "type": "number" }
                    }
                  },
                  "bounds": {
                    "type": "object",
                    "required": ["minX", "maxX", "minY", "maxY"],
                    "properties": {
                      "minX": { "type": "number" }, "maxX": { "type": "number" },
                      "minY": { "type": "number" }, "maxY": { "type": "number" }
                    }
                  },
                  "claims": { "type": "object", "additionalProperties": { "type": "string" } },
                  "pathTypeCounts": { "type": "object", "additionalProperties": { "type": "integer", "format": "int64" } },
                  "warnings": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "required": ["code", "message"],
                      "properties": { "code": { "type": "string" }, "message": { "type": "string" } }
                    }
                  }
                }
              },
              "GCodeJobAcceptedResponse": {
                "type": "object",
                "required": ["schemaVersion", "jobId", "status", "input", "links"],
                "properties": {
                  "schemaVersion": { "type": "string", "const": "1.0" },
                  "jobId": { "type": "string", "pattern": "^[a-f0-9]{32}$" },
                  "status": { "type": "string", "enum": ["queued", "running", "succeeded", "degraded", "failed", "cancelled"] },
                  "input": { "type": "object" },
                  "links": { "type": "object" }
                }
              },
              "GCodeJobSnapshotResponse": {
                "type": "object",
                "required": ["schemaVersion", "id", "kind", "status", "progress", "phase", "sequence", "createdAtUtc", "input", "links"],
                "properties": {
                  "schemaVersion": { "type": "string", "const": "1.0" },
                  "id": { "type": "string", "pattern": "^[a-f0-9]{32}$" },
                  "kind": { "type": "string", "const": "gcode-analysis" },
                  "status": { "type": "string", "enum": ["queued", "running", "succeeded", "degraded", "failed", "cancelled"] },
                  "progress": { "type": "number", "minimum": 0, "maximum": 1 },
                  "phase": { "type": "string" },
                  "sequence": { "type": "integer", "format": "int64" },
                  "createdAtUtc": { "type": "string", "format": "date-time" },
                  "input": { "type": "object" },
                  "engineVersion": { "type": ["string", "null"] },
                  "result": { "oneOf": [{ "$ref": "#/components/schemas/GCodeAnalysisResponse" }, { "type": "null" }] },
                  "error": { "type": ["object", "null"] },
                  "links": { "type": "object" }
                }
              },
              "ApiProblem": {
                "type": "object",
                "required": ["type", "title", "status", "code", "traceId"],
                "properties": {
                  "type": { "type": "string" },
                  "title": { "type": "string" },
                  "status": { "type": "integer" },
                  "code": { "type": "string" },
                  "traceId": { "type": "string" },
                  "detail": { "type": "string" },
                  "instance": { "type": "string" },
                  "errors": {
                    "type": "object",
                    "additionalProperties": { "type": "array", "items": { "type": "string" } }
                  }
                }
              }
            }
          }
        }
        """;
}
