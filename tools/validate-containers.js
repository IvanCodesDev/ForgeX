"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");
const dockerignore = read(".dockerignore");
const nodeDockerfile = read("deploy/Dockerfile");
const apiDockerfile = read("deploy/Dockerfile.api");
const compose = read("deploy/docker-compose.yml");
const envExample = read("deploy/.env.example");
const smoke = read("deploy/verify-containers.sh");

const checks = [];
const check = (name, condition, detail) => {
  checks.push({ name, pass: Boolean(condition), detail });
};
const count = (text, pattern) => [...text.matchAll(pattern)].length;

check(
  "node-image-pinned",
  count(nodeDockerfile, /^FROM node:22\.13\.1-alpine3\.21(?: AS \S+)?$/gm) === 2,
  "builder and runtime use node:22.13.1-alpine3.21"
);
check(
  "api-images-pinned",
  apiDockerfile.includes("mcr.microsoft.com/dotnet/sdk:10.0.302-alpine3.23") &&
    apiDockerfile.includes("mcr.microsoft.com/dotnet/aspnet:10.0.10-alpine3.23"),
  "SDK and ASP.NET runtime tags are explicit"
);
check(
  "multi-stage-builds",
  count(nodeDockerfile, /^FROM /gm) === 2 && count(apiDockerfile, /^FROM /gm) === 2,
  "both images have separate build and runtime stages"
);
check(
  "nonroot-runtime-users",
  /^USER 1000:1000$/m.test(nodeDockerfile) && /^USER 1654:1654$/m.test(apiDockerfile),
  "runtime users are numeric and non-root"
);
check(
  "no-copy-all",
  !/^COPY\s+\.\s+\.$/m.test(nodeDockerfile) && !/^COPY\s+\.\s+\.$/m.test(apiDockerfile),
  "runtime contexts use explicit COPY allowlists"
);
check(
  "writable-data-owned",
  nodeDockerfile.includes("chown -R node:node /app") && apiDockerfile.includes("chown -R 1654:1654 /app"),
  "persistent data roots are owned before dropping privileges"
);
check(
  "image-healthchecks",
  count(nodeDockerfile, /^HEALTHCHECK /gm) === 1 && count(apiDockerfile, /^HEALTHCHECK /gm) === 1,
  "both runtime images define health checks"
);
check(
  "compose-services",
  /^ {2}forgex-api:$/m.test(compose) && /^ {2}forgex:$/m.test(compose),
  "gateway and authority are separate services"
);
check(
  "compose-private-sidecar",
  /^ {4}expose:\n {6}- "8788"$/m.test(compose) && !/^ {6}- "\$\{[^\n]+:8788"$/m.test(compose),
  "authority is exposed only to the compose network"
);
check(
  "compose-trusted-boundary",
  compose.includes('GCODE_AUTHORITY_URL: "http://forgex-api:8788"') &&
    count(compose, /\$\{GCODE_AUTHORITY_INTERNAL_SECRET:\?/g) === 2,
  "gateway and authority share a required internal secret"
);
check(
  "compose-separate-volumes",
  compose.includes("forgex-node-data:/app/data") &&
    compose.includes("forgex-authority-data:/app/data") &&
    /^ {2}forgex-node-data:$/m.test(compose) &&
    /^ {2}forgex-authority-data:$/m.test(compose),
  "service data uses separate named volumes"
);
check(
  "compose-hardening",
  count(compose, /^ {4}read_only: true$/gm) === 2 &&
    count(compose, /^ {4}cap_drop:$/gm) === 2 &&
    count(compose, /^ {6}- ALL$/gm) === 2 &&
    count(compose, /^ {6}- no-new-privileges:true$/gm) === 2 &&
    count(compose, /^ {4}tmpfs:$/gm) === 2,
  "both services are read-only, capability-free and no-new-privileges"
);
check(
  "compose-health-ordering",
  compose.includes("condition: service_healthy") && compose.includes("http://127.0.0.1:8788/health/ready"),
  "gateway waits for the authority readiness probe"
);
check(
  "dockerignore-sensitive-state",
  [
    ".git",
    "node_modules",
    "dist",
    "backend/**/bin",
    "backend/**/obj",
    "optimization",
    "data",
    "server/.env",
    ".env",
  ].every((entry) => dockerignore.split("\n").includes(entry)),
  "build contexts exclude repositories, secrets, state and generated outputs"
);
check(
  "secret-example-empty",
  /^GCODE_AUTHORITY_INTERNAL_SECRET=$/m.test(envExample) && !/^GCODE_AUTHORITY_INTERNAL_SECRET=\S+/m.test(envExample),
  "deployment example never contains a reusable secret"
);
check(
  "runtime-smoke-contract",
  smoke.includes('assert_eq "1654"') &&
    smoke.includes('assert_eq "1000"') &&
    smoke.includes('restart "$api_name"') &&
    smoke.includes("/metrics") &&
    smoke.includes("/react/"),
  "runtime drill checks identity, restart, metrics and UI"
);

const failed = checks.filter((item) => !item.pass);
const report = {
  schemaVersion: 1,
  status: failed.length === 0 ? "pass" : "fail",
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (failed.length) process.exitCode = 1;
