import { afterEach, describe, expect, it, vi } from "vitest";
import { meshAuthorityEnabled, parseMeshAuthorityResponse, requestMeshAuthority } from "./mesh-authority";

const digest = "a".repeat(64);
const baseEnv: ImportMetaEnv = { BASE_URL: "/", MODE: "test", DEV: true, PROD: false, SSR: false };
const env: ImportMetaEnv = {
  ...baseEnv,
  VITE_MESH_AUTHORITY: "dotnet",
  VITE_API_BASE: "https://forgex.example/",
  VITE_NODE_API_KEY: "mesh-key",
};
const fixture = () => ({
  schemaVersion: "1.0",
  engine: "forgex-mesh-csharp",
  engineVersion: "1.0.0",
  sha256: digest,
  bytes: 1,
  format: "stl-binary",
  unit: null,
  triangleCount: 4,
  droppedTriangles: 0,
  objectCount: 1,
  sizeMm: { x: 10, y: 10, z: 10 },
  volumeCm3: 1 / 6,
  surfaceAreaCm2: 2.36,
  topology: {
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    inconsistentEdges: 0,
    closedEdgeManifold: true,
    orientationConsistent: true,
    selfIntersectionChecked: false,
  },
  warnings: ["未检查自相交"],
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("mesh authority boundary", () => {
  it("requires explicit opt-in and stays offline for file/offline modes", async () => {
    expect(meshAuthorityEnabled(baseEnv)).toBe(false);
    expect(meshAuthorityEnabled(env, { protocol: "https:" })).toBe(true);
    expect(meshAuthorityEnabled(env, { protocol: "file:" })).toBe(false);
    expect(meshAuthorityEnabled({ ...env, VITE_API_BASE: "offline" })).toBe(false);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      requestMeshAuthority(new File(["x"], "x.stl"), digest, baseEnv, new AbortController().signal)
    ).rejects.toThrow(/未启用/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts bound geometry and withholds volume for open surfaces", () => {
    expect(parseMeshAuthorityResponse(fixture(), digest, 1, "stl").triangleCount).toBe(4);
    const open = {
      ...fixture(),
      volumeCm3: null,
      topology: { ...fixture().topology, boundaryEdges: 3, closedEdgeManifold: false },
    };
    expect(parseMeshAuthorityResponse(open, digest, 1, "stl").volumeCm3).toBeNull();
    expect(() => parseMeshAuthorityResponse({ ...open, volumeCm3: 3 }, digest, 1, "stl")).toThrow(/不应给出体积/);
    expect(
      parseMeshAuthorityResponse({ ...fixture(), objectCount: 2, volumeCm3: null }, digest, 1, "stl").volumeCm3
    ).toBeNull();
  });
  it.each([
    ["engine", { engine: "browser" }],
    ["schema", { schemaVersion: "2" }],
    ["hash", { sha256: "b".repeat(64) }],
    ["bytes", { bytes: 2 }],
    ["format", { format: "3mf" }],
    ["unit", { unit: "inch" }],
    ["triangles", { triangleCount: 0 }],
    ["limit", { triangleCount: 250001 }],
    ["nan", { sizeMm: { x: NaN, y: 10, z: 10 } }],
    ["negative", { surfaceAreaCm2: -1 }],
    ["volume", { volumeCm3: Infinity }],
    ["topology", { topology: { ...fixture().topology, closedEdgeManifold: false } }],
    ["intersections", { topology: { ...fixture().topology, selfIntersectionChecked: true } }],
    ["warnings", { warnings: [42] }],
  ])("rejects response drift: %s", (_name, patch) => {
    expect(() => parseMeshAuthorityResponse({ ...fixture(), ...patch }, digest, 1, "stl")).toThrow();
  });
  it("posts original bytes with API key and generated endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(fixture()));
    vi.stubGlobal("fetch", fetcher);
    const file = new File(["x"], "MODEL.STL");
    await expect(requestMeshAuthority(file, digest, env, new AbortController().signal)).resolves.toMatchObject({
      sha256: digest,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://forgex.example/api/v1/meshes/analyze?format=stl");
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(file);
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("X-API-Key")).toBe("mesh-key");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/octet-stream");
    expect(new Headers(init.headers).has("X-ForgeX-Internal-Token")).toBe(false);
  });
  it("keeps structured backend failure visible", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ title: "必需扩展不受支持" }, { status: 422 })));
    await expect(
      requestMeshAuthority(new File(["x"], "x.stl"), digest, env, new AbortController().signal)
    ).rejects.toThrow(/HTTP 422.*必需扩展/);
  });
  it("rejects unsupported files before sending and honors pre-abort", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(requestMeshAuthority(new File(["x"], "x.stl"), digest, env, controller.signal)).rejects.toThrow();
    await expect(
      requestMeshAuthority(new File(["x"], "x.obj"), digest, env, new AbortController().signal)
    ).rejects.toThrow(/仅支持/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("cancels an in-flight request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
          })
      )
    );
    const controller = new AbortController();
    const request = requestMeshAuthority(new File(["x"], "x.stl"), digest, env, controller.signal);
    const rejected = expect(request).rejects.toThrow(/changed/);
    controller.abort(new Error("model changed"));
    await rejected;
  });
  it("bounds stalled backend requests", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
          })
      )
    );
    const request = requestMeshAuthority(new File(["x"], "x.stl"), digest, env, new AbortController().signal);
    const rejected = expect(request).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });
});
