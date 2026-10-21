import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as parser from "../../engine/gcode-parser";
import * as packing from "./gcode-toolpath-pack";
import type { GcodeImportRequest, GcodeImportWorkerReply } from "./gcode-import-protocol";
const { FakeWorker } = vi.hoisted(() => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static ctorError = false;
    static postError = false;
    onmessage: ((event: MessageEvent<GcodeImportWorkerReply>) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    request!: GcodeImportRequest;
    terminated = false;
    constructor() {
      if (FakeWorker.ctorError) throw new Error("no worker");
      FakeWorker.instances.push(this);
    }
    postMessage(request: GcodeImportRequest) {
      if (FakeWorker.postError) throw new Error("clone failure");
      this.request = request;
    }
    terminate() {
      this.terminated = true;
    }
    reply(value: GcodeImportWorkerReply) {
      this.onmessage?.({ data: value } as MessageEvent<GcodeImportWorkerReply>);
    }
    crash() {
      this.onerror?.({ preventDefault: vi.fn(), message: "crashed" } as unknown as ErrorEvent);
    }
  }
  return { FakeWorker };
});
vi.mock("./gcode-import-worker?worker&inline", () => ({ default: FakeWorker }));
import { importGcodeFile, type GcodeImportProgress } from "./gcode-import";
const text = "G90\nM82\nG1 X0 Y0 Z0.2 F600\nG1 X10 Y0 E1 F600\n";
const options = { bedSize: 256, densityG: 1.24, origin: "corner" } as const;
const file = () => new File([text], "test.gcode");
function reply(worker: InstanceType<typeof FakeWorker>, requestId = worker.request.requestId) {
  worker.reply({ type: "source-text", requestId, sourceText: text });
  worker.reply({
    type: "result",
    requestId,
    sha256: "a".repeat(64),
    packed: packing.packParsedGcode(parser.parse(text, options)),
    toolpath: {} as never,
  });
}
beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.ctorError = false;
  FakeWorker.postError = false;
  vi.stubGlobal("window", {
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: number) => clearTimeout(id),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("G-code import lifecycle", () => {
  it("unpacks only the matching worker result, terminates it and reports completion once", async () => {
    const progress: GcodeImportProgress[] = [];
    const handle = importGcodeFile(file(), options, (p) => progress.push(p));
    const worker = FakeWorker.instances[0]!;
    reply(worker, worker.request.requestId + 1);
    expect(worker.terminated).toBe(false);
    reply(worker);
    reply(worker);
    worker.onmessageerror?.();
    const result = await handle.promise;
    expect(result.via).toBe("worker");
    expect(result.sourceText).toBe(text);
    expect(result.parsed.totalLayers).toBe(1);
    expect(progress.filter((p) => p.phase === "rebuild" && p.progress === 1)).toHaveLength(1);
    expect(worker.terminated).toBe(true);
  });
  it.each(["constructor", "postMessage", "startup"])("falls back once after %s failure", async (failure) => {
    FakeWorker.ctorError = failure === "constructor";
    FakeWorker.postError = failure === "postMessage";
    const input = file(),
      read = vi.spyOn(input, "arrayBuffer");
    const handle = importGcodeFile(input, options);
    if (failure === "startup") {
      const worker = FakeWorker.instances[0]!;
      worker.crash();
      worker.crash();
      reply(worker);
    }
    const result = await handle.promise;
    expect(result.via).toBe("main");
    expect(result.sha256).toBe(await parser.sha256(await file().arrayBuffer()));
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each(["business", "runtime", "messageerror"])("does not retry %s failures on the main thread", async (failure) => {
    const input = file(),
      read = vi.spyOn(input, "arrayBuffer"),
      handle = importGcodeFile(input, options),
      worker = FakeWorker.instances[0]!;
    if (failure === "business")
      worker.reply({
        type: "error",
        requestId: worker.request.requestId,
        phase: "parse",
        code: "PARSE_FAILED",
        message: "bad",
      });
    else if (failure === "runtime") {
      worker.reply({ type: "progress", requestId: worker.request.requestId, phase: "read", progress: 0 });
      worker.crash();
    } else worker.onmessageerror?.();
    await expect(handle.promise).rejects.toMatchObject({
      code: failure === "business" ? "PARSE_FAILED" : "WORKER_FAILURE",
    });
    expect(read).not.toHaveBeenCalled();
    expect(worker.terminated).toBe(true);
  });
  it.each(["cancel", "timeout"])("stops fallback before hashing after %s during file read", async (ending) => {
    vi.useFakeTimers();
    FakeWorker.ctorError = true;
    let release!: (buffer: ArrayBuffer) => void;
    const input = file();
    vi.spyOn(input, "arrayBuffer").mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const hash = vi.spyOn(parser, "sha256"),
      progress: GcodeImportProgress[] = [];
    const handle = importGcodeFile(input, options, (p) => progress.push(p));
    const failed = expect(handle.promise).rejects.toMatchObject({
      code: ending === "cancel" ? "CANCELLED" : "TIMEOUT",
    });
    if (ending === "cancel") handle.cancel();
    else await vi.advanceTimersByTimeAsync(300000);
    await failed;
    const count = progress.length;
    release(new TextEncoder().encode(text).buffer);
    await vi.advanceTimersByTimeAsync(1);
    expect(hash).not.toHaveBeenCalled();
    expect(progress).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops fallback after hashing when cancelled", async () => {
    FakeWorker.ctorError = true;
    let release!: (hash: string) => void;
    const input = file(),
      hash = vi.spyOn(parser, "sha256").mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        })
      );
    const parse = vi.spyOn(parser, "parse"),
      handle = importGcodeFile(input, options);
    await vi.waitFor(() => expect(hash).toHaveBeenCalled());
    handle.cancel();
    await expect(handle.promise).rejects.toMatchObject({ code: "CANCELLED" });
    release("a".repeat(64));
    await Promise.resolve();
    await Promise.resolve();
    expect(parse).not.toHaveBeenCalled();
  });
  it.each(["cancel", "timeout"])("stops unpacking and suppresses rebuild completion after %s", async (ending) => {
    vi.useFakeTimers();
    const parsed = parser.parse(text, options);
    let release!: () => void;
    vi.spyOn(packing, "unpackParsedGcode").mockImplementation(async (_packed, hooks) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await hooks!.yieldToEventLoop!();
      return parsed;
    });
    const progress: GcodeImportProgress[] = [],
      handle = importGcodeFile(file(), options, (p) => progress.push(p));
    reply(FakeWorker.instances[0]!);
    const failed = expect(handle.promise).rejects.toMatchObject({
      code: ending === "cancel" ? "CANCELLED" : "TIMEOUT",
    });
    if (ending === "cancel") handle.cancel();
    else await vi.advanceTimersByTimeAsync(300000);
    await failed;
    release();
    await vi.runAllTimersAsync();
    expect(progress).not.toContainEqual({ phase: "rebuild", progress: 1 });
  });
});
