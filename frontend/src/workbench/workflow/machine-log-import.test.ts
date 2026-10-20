import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MachineLogImportRequest, MachineLogImportWorkerReply } from "./machine-log-import-protocol";
import { parseMachineLogFile } from "./machine-log-import-pipeline";

const { FakeWorker } = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static ctorError = false;
    static script: ((worker: FakeWorker, request: MachineLogImportRequest) => void) | null = null;
    onmessage: ((event: MessageEvent<MachineLogImportWorkerReply>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    request: MachineLogImportRequest | null = null;
    terminated = false;
    constructor() {
      if (FakeWorker.ctorError) throw new Error("unavailable");
      FakeWorker.instances.push(this);
    }
    postMessage(request: MachineLogImportRequest) {
      this.request = request;
      FakeWorker.script?.(this, request);
    }
    terminate() {
      this.terminated = true;
    }
    reply(reply: MachineLogImportWorkerReply) {
      this.onmessage?.({ data: reply } as MessageEvent<MachineLogImportWorkerReply>);
    }
    crash() {
      const event = { message: "crashed", preventDefault: vi.fn() };
      this.onerror?.(event as unknown as ErrorEvent);
      return event;
    }
  }
  return { FakeWorker };
});
vi.mock("./machine-log-import-worker?worker&inline", () => ({ default: FakeWorker }));
import { importMachineLogFile } from "./machine-log-import";

beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.ctorError = false;
  FakeWorker.script = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const file = () => new File(['{"job":{"durationSec":5,"energyKwh":0.1,"energyEvidence":"依据"}}'], "log.json");

describe("日志导入取消、超时和兼容边界", () => {
  it("Worker 成功只回传汇总，进度转发且结束即释放 Worker", async () => {
    const input = file(),
      expected = await parseMachineLogFile(input, () => {});
    const progress = vi.fn();
    FakeWorker.script = (worker, { requestId }) => {
      worker.reply({ type: "progress", requestId, phase: "parse", progress: 0 });
      worker.reply({ type: "result", requestId, log: expected });
    };
    await expect(importMachineLogFile(input, progress).promise).resolves.toEqual({ log: expected, via: "worker" });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ phase: "parse", progress: 0 }));
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });
  it("串号消息和完成后的回复均不能覆盖本次结果", async () => {
    const expected = await parseMachineLogFile(file(), () => {});
    const handle = importMachineLogFile(file());
    const worker = FakeWorker.instances[0]!,
      id = worker.request!.requestId;
    worker.reply({ type: "error", requestId: id + 1, code: "PARSE_FAILED", message: "stale", phase: "parse" });
    expect(worker.terminated).toBe(false);
    worker.reply({ type: "result", requestId: id, log: expected });
    worker.reply({ type: "error", requestId: id, code: "PARSE_FAILED", message: "late", phase: "parse" });
    await expect(handle.promise).resolves.toMatchObject({ log: expected });
  });
  it("业务解析错误不在主线程重试", async () => {
    const input = file(),
      read = vi.spyOn(input, "arrayBuffer");
    FakeWorker.script = (worker, { requestId }) =>
      worker.reply({ type: "error", requestId, code: "PARSE_FAILED", message: "bad csv", phase: "parse" });
    await expect(importMachineLogFile(input).promise).rejects.toMatchObject({
      code: "PARSE_FAILED",
      message: "bad csv",
    });
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["constructor", "startup", "post"])("仅启动失败走兼容解析：%s", async (kind) => {
    FakeWorker.ctorError = kind === "constructor";
    FakeWorker.script = (worker) => {
      if (kind === "post") throw new Error("clone failed");
      worker.crash();
    };
    const input = file(),
      expected = await parseMachineLogFile(input, () => {});
    await expect(importMachineLogFile(input).promise).resolves.toEqual({ log: expected, via: "main" });
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });
  it("收到进度后崩溃或消息反序列化失败不回退重跑", async () => {
    FakeWorker.script = (worker, { requestId }) => {
      worker.reply({ type: "progress", requestId, phase: "parse", progress: 0 });
      worker.crash();
    };
    await expect(importMachineLogFile(file()).promise).rejects.toMatchObject({ code: "WORKER_FAILURE" });
    const handle = importMachineLogFile(file());
    await expect(handle.promise).rejects.toMatchObject({ code: "WORKER_FAILURE" });
    FakeWorker.script = (worker) => worker.onmessageerror?.();
    await expect(importMachineLogFile(file()).promise).rejects.toMatchObject({ code: "WORKER_FAILURE" });
  });
  it("显式取消幂等，晚到结果不再发布", async () => {
    const progress = vi.fn(),
      handle = importMachineLogFile(file(), progress);
    const worker = FakeWorker.instances[0]!;
    handle.cancel();
    handle.cancel();
    await expect(handle.promise).rejects.toMatchObject({ code: "CANCELLED" });
    worker.reply({ type: "progress", requestId: worker.request!.requestId, phase: "parse", progress: 1 });
    expect(progress).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });
  it("启动前拒绝超限文件，不读取也不创建 Worker", async () => {
    const input = { name: "large.json", size: 20 * 1024 * 1024 + 1, arrayBuffer: vi.fn() } as unknown as File;
    await expect(importMachineLogFile(input).promise).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(input.arrayBuffer).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
  });
  it("后台与兼容路径均有 60 秒看门狗，终止后忽略迟到读取", async () => {
    vi.useFakeTimers();
    const workerHandle = importMachineLogFile(file());
    const rejected = expect(workerHandle.promise).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(60000);
    await rejected;
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
    FakeWorker.ctorError = true;
    let release: (bytes: ArrayBuffer) => void = () => {};
    const input = {
      name: "pending.json",
      size: 2,
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((resolve) => {
          release = resolve;
        }),
    } as File;
    const progress = vi.fn(),
      handle = importMachineLogFile(input, progress);
    const timeout = expect(handle.promise).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(60000);
    await timeout;
    const before = progress.mock.calls.length;
    release(new TextEncoder().encode("{}").buffer);
    await Promise.resolve();
    await Promise.resolve();
    expect(progress.mock.calls).toHaveLength(before);
  });
});
