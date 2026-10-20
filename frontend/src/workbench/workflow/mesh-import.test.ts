/* Stage 9.3 前半：主线程导入客户端（Worker 边界）的状态机测试。
   用假 Worker 替换 `?worker&inline` 模块，逐一覆盖：成功路径与进度转发、串号消息忽略、
   结构化错误不回退、Worker 基建故障回退主线程（结果与 Worker 路径同源）、取消、看门狗超时。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "../../engine/gcode-parser";
import type { MeshImportRequest, MeshImportWorkerReply } from "./mesh-import-protocol";

const { FakeWorker } = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static ctorError: Error | null = null;
    static script: ((worker: FakeWorker, request: MeshImportRequest) => void) | null = null;
    static reset(): void {
      FakeWorker.instances = [];
      FakeWorker.ctorError = null;
      FakeWorker.script = null;
    }
    onmessage: ((event: MessageEvent<MeshImportWorkerReply>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    posted: MeshImportRequest[] = [];
    terminated = false;
    constructor() {
      if (FakeWorker.ctorError) throw FakeWorker.ctorError;
      FakeWorker.instances.push(this);
    }
    postMessage(request: MeshImportRequest): void {
      this.posted.push(request);
      FakeWorker.script?.(this, request);
    }
    terminate(): void {
      this.terminated = true;
    }
    reply(data: MeshImportWorkerReply): void {
      this.onmessage?.({ data } as MessageEvent<MeshImportWorkerReply>);
    }
    crash(message: string): { preventDefault: ReturnType<typeof vi.fn> } {
      const event = { message, preventDefault: vi.fn() };
      this.onerror?.(event as unknown as ErrorEvent);
      return event;
    }
  }
  return { FakeWorker };
});

vi.mock("./mesh-import-worker?worker&inline", () => ({ default: FakeWorker }));

import { MeshImportError, importMeshFile, type MeshImportProgress } from "./mesh-import";

/** 单个三角形的二进制 STL（解析器接受的最小有效网格） */
function tinyStl(): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(84 + 50);
  const view = new DataView(buf);
  view.setUint32(80, 1, true);
  const coords = [0, 0, 0, 10, 0, 0, 0, 10, 0];
  coords.forEach((v, i) => view.setFloat32(84 + 12 + i * 4, v, true));
  return new Uint8Array(buf);
}

const probe = () => (globalThis as { __forgexMeshImportVia?: string }).__forgexMeshImportVia;

describe("importMeshFile：Worker 边界与主线程兜底", () => {
  let file: File;
  beforeEach(() => {
    FakeWorker.reset();
    delete (globalThis as { __forgexMeshImportVia?: string }).__forgexMeshImportVia;
    // 客户端用 window.setTimeout/clearTimeout 挂看门狗；转发到 globalThis 以便假时钟接管
    vi.stubGlobal("window", {
      setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
      clearTimeout: (...args: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...args),
    });
    file = new File([tinyStl()], "tiny.stl");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Worker 成功：进度逐条转发，结果带 via=worker，收尾追加 rebuild 并终止 Worker", async () => {
    const progress: MeshImportProgress[] = [];
    FakeWorker.script = (worker, request) => {
      const { requestId } = request;
      worker.reply({ type: "progress", requestId, phase: "read", progress: 0 });
      worker.reply({ type: "progress", requestId, phase: "hash", progress: 1 });
      worker.reply({ type: "progress", requestId, phase: "parse", progress: 0.5 });
      worker.reply({
        type: "result",
        requestId,
        sha256: "feed".repeat(16),
        mesh: { format: "stl-binary", triangleCount: 1 } as never,
      });
    };
    const result = await importMeshFile(file, (p) => progress.push(p)).promise;
    expect(result.via).toBe("worker");
    expect(result.sha256).toBe("feed".repeat(16));
    expect(result.mesh).toEqual({ format: "stl-binary", triangleCount: 1 });
    expect(progress).toEqual([
      { phase: "read", progress: 0 },
      { phase: "hash", progress: 1 },
      { phase: "parse", progress: 0.5 },
      { phase: "rebuild", progress: 1 },
    ]);
    expect(probe()).toBe("worker");
    const worker = FakeWorker.instances[0]!;
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.terminated).toBe(true);
    expect(worker.posted).toEqual([{ type: "parse", requestId: worker.posted[0]!.requestId, file }]);
  });

  it("串号消息被忽略：只有本次 requestId 的回复才会结算", async () => {
    const handle = importMeshFile(file);
    const worker = FakeWorker.instances[0]!;
    const mine = worker.posted[0]!.requestId;
    worker.reply({ type: "result", requestId: mine + 1000, sha256: "stale", mesh: {} as never });
    worker.reply({ type: "error", requestId: mine - 1, phase: "parse", code: "PARSE_FAILED", message: "stale" });
    expect(worker.terminated).toBe(false);
    worker.reply({ type: "result", requestId: mine, sha256: "fresh", mesh: {} as never });
    await expect(handle.promise).resolves.toMatchObject({ sha256: "fresh", via: "worker" });
  });

  it("Worker 结构化错误：原样映射为 MeshImportError，不回退主线程", async () => {
    FakeWorker.script = (worker, { requestId }) => {
      worker.reply({ type: "progress", requestId, phase: "parse", progress: 0 });
      worker.reply({
        type: "error",
        requestId,
        phase: "parse",
        code: "UNSUPPORTED_FORMAT",
        message: "无法识别的网格格式",
      });
    };
    const error = await importMeshFile(file).promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeshImportError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_FORMAT", phase: "parse", message: "无法识别的网格格式" });
    expect(probe()).toBeUndefined();
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  it("Worker 在首个回复前崩溃：回退主线程，结果与真实解析一致（via=main）", async () => {
    const progress: MeshImportProgress[] = [];
    FakeWorker.script = (worker) => {
      const event = worker.crash("Failed to construct 'Worker'");
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    };
    const result = await importMeshFile(file, (p) => progress.push(p)).promise;
    expect(result.via).toBe("main");
    expect(result.sha256).toBe(await sha256(tinyStl()));
    expect(result.mesh.format).toBe("stl-binary");
    expect(result.mesh.triangleCount).toBe(1);
    expect(result.mesh.sizeMm).toEqual({ x: 10, y: 10, z: 0 });
    expect(progress).toEqual([
      { phase: "read", progress: 0 },
      { phase: "parse", progress: 0 },
      { phase: "parse", progress: 1 },
    ]);
    expect(probe()).toBe("main");
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  it("Worker 在已回复后崩溃：判定为 WORKER_FAILURE，不再回退", async () => {
    FakeWorker.script = (worker, { requestId }) => {
      worker.reply({ type: "progress", requestId, phase: "read", progress: 1 });
      const event = worker.crash("worker died mid-way");
      expect(event.preventDefault).not.toHaveBeenCalled();
    };
    const error = await importMeshFile(file).promise.catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "MeshImportError", code: "WORKER_FAILURE", message: "worker died mid-way" });
    expect(probe()).toBeUndefined();
  });

  it("Worker 构造失败（无 Worker 基建）：直接走主线程；解析错误按阶段归类", async () => {
    FakeWorker.ctorError = new ReferenceError("Worker is not defined");
    const ok = await importMeshFile(file).promise;
    expect(ok.via).toBe("main");
    expect(FakeWorker.instances).toHaveLength(0);

    const garbage = new File([new Uint8Array(200)], "mystery.bin");
    const error = await importMeshFile(garbage).promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeshImportError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_FORMAT", phase: "parse" });
    expect((error as Error).message).toContain("无法识别的网格格式");
  });

  it("取消：立即以 CANCELLED 拒绝、终止 Worker，之后的结果被忽略", async () => {
    const handle = importMeshFile(file);
    const worker = FakeWorker.instances[0]!;
    handle.cancel();
    handle.cancel(); // 幂等
    await expect(handle.promise).rejects.toMatchObject({ code: "CANCELLED", message: "网格导入已取消" });
    expect(worker.terminated).toBe(true);
    worker.reply({ type: "result", requestId: worker.posted[0]!.requestId, sha256: "late", mesh: {} as never });
    expect(probe()).toBeUndefined();
  });

  it("看门狗：Worker 180 s 无终态回复则以 TIMEOUT 拒绝并终止", async () => {
    vi.useFakeTimers();
    const handle = importMeshFile(file);
    const worker = FakeWorker.instances[0]!;
    worker.reply({ type: "progress", requestId: worker.posted[0]!.requestId, phase: "parse", progress: 0.3 });
    vi.advanceTimersByTime(179_999);
    expect(worker.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(handle.promise).rejects.toMatchObject({ code: "TIMEOUT", phase: null });
    expect(worker.terminated).toBe(true);
  });
});
