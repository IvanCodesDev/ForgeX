import { sha256 } from "../../engine/gcode-parser";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export type ImageImportPhase = "read" | "hash" | "decode";
export class ImageImportError extends Error {
  constructor(
    readonly code: "INVALID_FILE" | "READ_FAILED" | "DECODE_FAILED" | "PIXEL_LIMIT" | "TIMEOUT" | "CANCELLED",
    message: string
  ) {
    super(message);
    this.name = "ImageImportError";
  }
}
export interface ImageImportResult {
  readonly img: HTMLImageElement;
  readonly sha256: string;
  /** The loaded image may be reused by controls; retain its URL until replacement or unmount. */
  dispose(): void;
}

export function importImageFile(file: File, onProgress?: (phase: ImageImportPhase) => void) {
  let reader: FileReader | null = null,
    img: HTMLImageElement | null = null,
    url: string | null = null;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectPromise: (error: unknown) => void = () => {};
  const release = () => {
    if (url) URL.revokeObjectURL(url);
    url = null;
  };
  const cleanup = () => {
    clearTimeout(timer);
    if (reader) {
      reader.onload = reader.onerror = reader.onabort = null;
      if (reader.readyState === 1) reader.abort();
      reader = null;
    }
    if (img) {
      img.onload = img.onerror = null;
    }
  };
  const promise = new Promise<ImageImportResult>((resolve, reject) => {
    rejectPromise = reject;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (img) img.src = "";
      release();
      reject(error);
    };
    const report = (phase: ImageImportPhase) => {
      if (!settled) onProgress?.(phase);
    };
    if (!/^image\//.test(file.type) || !file.size || file.size > MAX_IMAGE_BYTES) {
      fail(new ImageImportError("INVALID_FILE", "请选择不超过 20 MiB 的有效图片"));
      return;
    }
    timer = setTimeout(() => fail(new ImageImportError("TIMEOUT", "图片导入超时，已结束本次任务")), 30000);
    reader = new FileReader();
    reader.onerror = () => fail(new ImageImportError("READ_FAILED", "图片文件读取失败"));
    reader.onabort = () => fail(new ImageImportError("CANCELLED", "图片导入已取消"));
    reader.onload = () => {
      void (async () => {
        if (settled) return;
        const buffer = reader?.result;
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_IMAGE_BYTES)
          throw new ImageImportError("READ_FAILED", "图片文件读取结果无效或超限");
        report("hash");
        const digest = await sha256(buffer);
        if (settled) return;
        report("decode");
        url = URL.createObjectURL(file);
        img = new Image();
        img.decoding = "async";
        img.onerror = () => fail(new ImageImportError("DECODE_FAILED", "图片解码失败，请换一张图"));
        img.onload = () => {
          if (settled || !img) return;
          const { naturalWidth: width, naturalHeight: height } = img;
          if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
            fail(new ImageImportError("DECODE_FAILED", "无法读取有效图片尺寸"));
            return;
          }
          if (width > 16384 || height > 16384 || width * height > MAX_IMAGE_PIXELS) {
            fail(new ImageImportError("PIXEL_LIMIT", "图片解码后超过 1600 万像素或单边 16384，请先缩小尺寸"));
            return;
          }
          settled = true;
          cleanup();
          resolve({ img, sha256: digest, dispose: release });
        };
        img.src = url;
      })().catch(fail);
    };
    report("read");
    try {
      reader.readAsArrayBuffer(file);
    } catch (error) {
      fail(error);
    }
  });
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      cleanup();
      if (img) img.src = "";
      release();
      rejectPromise(new ImageImportError("CANCELLED", "图片导入已取消"));
    },
  };
}
