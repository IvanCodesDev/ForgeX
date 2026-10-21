import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as parser from "../../engine/gcode-parser";
import { importImageFile, MAX_IMAGE_BYTES } from "./image-import";

class Reader {
  static instances: Reader[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readyState = 0;
  result: unknown = null;
  abort = vi.fn(() => {
    this.readyState = 2;
    this.onabort?.();
  });
  constructor() {
    Reader.instances.push(this);
  }
  readAsArrayBuffer() {
    this.readyState = 1;
  }
  finish() {
    this.readyState = 2;
    this.result = new Uint8Array([1, 2, 3]).buffer;
    this.onload?.();
  }
}
class Picture {
  static instances: Picture[] = [];
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 40;
  naturalHeight = 40;
  src = "";
  constructor() {
    Picture.instances.push(this);
  }
}
const revoke = vi.fn(),
  create = vi.fn(() => "blob:test");
const file = () => new File(["abc"], "test.png", { type: "image/png" });
beforeEach(() => {
  Reader.instances = [];
  Picture.instances = [];
  revoke.mockClear();
  create.mockClear();
  vi.stubGlobal("FileReader", Reader);
  vi.stubGlobal("Image", Picture);
  vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function decoded() {
  Reader.instances[0]!.finish();
  await vi.waitFor(() => expect(Picture.instances).toHaveLength(1));
  return Picture.instances[0]!;
}
describe("image import resource lifecycle", () => {
  it("hashes original bytes and retains the URL until explicit disposal", async () => {
    const progress: string[] = [],
      handle = importImageFile(file(), (phase) => progress.push(phase));
    const img = await decoded();
    img.onload?.();
    const result = await handle.promise;
    expect(result.sha256).toBe(await parser.sha256(new Uint8Array([1, 2, 3]).buffer));
    expect(progress).toEqual(["read", "hash", "decode"]);
    expect(revoke).not.toHaveBeenCalled();
    result.dispose();
    result.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it.each(["read", "decode"])("cancels %s and ignores a captured late load callback", async (phase) => {
    const handle = importImageFile(file());
    if (phase === "read") {
      const reader = Reader.instances[0]!,
        late = reader.onload!;
      handle.cancel();
      reader.result = new ArrayBuffer(3);
      late();
      expect(reader.abort).toHaveBeenCalled();
    } else {
      const img = await decoded(),
        late = img.onload!;
      handle.cancel();
      late();
      expect(revoke).toHaveBeenCalledOnce();
    }
    await expect(handle.promise).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("does not decode after cancellation during hashing", async () => {
    let release!: (digest: string) => void;
    vi.spyOn(parser, "sha256").mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const handle = importImageFile(file());
    Reader.instances[0]!.finish();
    handle.cancel();
    await expect(handle.promise).rejects.toMatchObject({ code: "CANCELLED" });
    release("f".repeat(64));
    await Promise.resolve();
    expect(Picture.instances).toHaveLength(0);
  });
  it("times out stalled reads and clears resource handlers", async () => {
    vi.useFakeTimers();
    const handle = importImageFile(file()),
      failed = expect(handle.promise).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(30000);
    await failed;
    expect(Reader.instances[0]!.abort).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    [0, 1],
    [17000, 1],
    [4001, 4000],
  ])("rejects decoded dimensions %s × %s and revokes the URL", async (width, height) => {
    const handle = importImageFile(file()),
      img = await decoded();
    img.naturalWidth = width;
    img.naturalHeight = height;
    img.onload?.();
    await expect(handle.promise).rejects.toMatchObject({ code: width === 0 ? "DECODE_FAILED" : "PIXEL_LIMIT" });
    expect(revoke).toHaveBeenCalledOnce();
  });
  it("cleans up failed decode and read errors", async () => {
    const handle = importImageFile(file()),
      img = await decoded();
    img.onerror?.();
    await expect(handle.promise).rejects.toMatchObject({ code: "DECODE_FAILED" });
    const second = importImageFile(file());
    Reader.instances[1]!.onerror?.();
    await expect(second.promise).rejects.toMatchObject({ code: "READ_FAILED" });
  });
  it("rejects wrong MIME, empty files and compressed byte overflow before reading", async () => {
    for (const input of [new File(["x"], "x.bin"), new File([], "empty.png", { type: "image/png" }), file()]) {
      if (input.size === 3) Object.defineProperty(input, "size", { value: MAX_IMAGE_BYTES + 1 });
      await expect(importImageFile(input).promise).rejects.toMatchObject({ code: "INVALID_FILE" });
    }
    expect(Reader.instances).toHaveLength(0);
  });
});
