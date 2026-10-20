import { describe, expect, it } from "vitest";
import { sha256 } from "../../engine/gcode-parser";
import { MAX_BYTES } from "../../engine/machine-log";
import { parseMachineLogFile, type MachineLogImportProgress } from "./machine-log-import-pipeline";

describe("后台日志解析与有界汇总", () => {
  it("限制异常长的元数据，错误消息同样有界", async () => {
    const input = new File([JSON.stringify({ job: { jobId: "x".repeat(40000) } })], "metadata.json");
    await expect(parseMachineLogFile(input, () => {})).rejects.toMatchObject({
      code: "PARSE_FAILED",
      phase: "summary",
    });
    const invalid = new File([JSON.stringify({ format: "x".repeat(40000) })], "invalid.json");
    const failure: unknown = await parseMachineLogFile(invalid, () => {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message.length).toBeLessThanOrEqual(500);
  });
  it("原件摘要保留 BOM/换行，汇总保留缺失值和各传感器范围", async () => {
    const text =
      '\uFEFF{"job":{"gcodeSha256":"' +
      "a".repeat(64) +
      '","filamentG":2,"energyKwh":0.1,"energyEvidence":"电表差额"},"samples":[{"timeSec":100,"nozzleC":20},{"timeSec":160,"nozzleC":210,"bedC":60},{"nozzleC":0,"bedC":-2}]}\r\n';
    const file = new File([text], "metered.json");
    const progress: MachineLogImportProgress[] = [];
    const log = await parseMachineLogFile(file, (value) => progress.push(value));
    expect(log.sourceSha256).toBe(await sha256(await file.arrayBuffer()));
    expect(log).toMatchObject({ actualTimeSec: 60, filamentG: 2, energyKwh: 0.1 });
    expect(log.telemetry).toEqual({
      sampleCount: 3,
      timeSec: { count: 2, min: 100, max: 160 },
      nozzleC: { count: 3, min: 0, max: 210 },
      bedC: { count: 2, min: -2, max: 60 },
    });
    expect(log).not.toHaveProperty("samples");
    expect(progress.map((value) => `${value.phase}:${value.progress}`)).toEqual([
      "read:0",
      "read:1",
      "hash:0",
      "hash:1",
      "parse:0",
      "parse:1",
      "summary:0",
      "summary:1",
    ]);
  });
  it("无遥测时不制造温度区间，JSON 与 CSV 保持相同汇总口径", async () => {
    const empty = await parseMachineLogFile(new File(['{"job":{}}'], "empty.json"), () => {});
    expect(empty.telemetry.sampleCount).toBe(0);
    expect(empty.telemetry.nozzleC).toEqual({ count: 0, min: null, max: null });
    expect(empty.actualTimeSec).toBeNull();
    const csv = await parseMachineLogFile(new File(["time_s,nozzle_c,bed_c\n10,0,\n20,,60"], "data.csv"), () => {});
    expect(csv.telemetry).toEqual({
      sampleCount: 2,
      timeSec: { count: 2, min: 10, max: 20 },
      nozzleC: { count: 1, min: 0, max: 0 },
      bedC: { count: 1, min: 60, max: 60 },
    });
  });
  it("20 万条遥测仅回传常量大小的结果，不包含原文或样本对象数组", async () => {
    const count = 200000;
    const text = '{"samples":[' + '{"timeSec":1,"nozzleC":210},'.repeat(count - 1) + '{"timeSec":2,"nozzleC":211}]}';
    const result = await parseMachineLogFile(new File([text], "large.json"), () => {});
    expect(result.telemetry.sampleCount).toBe(count);
    expect(result.telemetry.nozzleC).toEqual({ count, min: 210, max: 211 });
    expect(JSON.stringify(result).length).toBeLessThan(1500);
  });
  it("明确区分非法 UTF-8、解析失败、扩展名和实际字节超限", async () => {
    await expect(parseMachineLogFile(new File([new Uint8Array([0xff])], "bad.json"), () => {})).rejects.toMatchObject({
      code: "INVALID_UTF8",
      phase: "parse",
    });
    await expect(parseMachineLogFile(new File(['{"samples":false}'], "bad.json"), () => {})).rejects.toMatchObject({
      code: "PARSE_FAILED",
      phase: "parse",
    });
    await expect(parseMachineLogFile(new File(["{}"], "bad.txt"), () => {})).rejects.toMatchObject({
      code: "UNSUPPORTED_FORMAT",
    });
    const forged = { name: "oversize.json", size: 1, arrayBuffer: async () => new ArrayBuffer(MAX_BYTES + 1) } as File;
    await expect(parseMachineLogFile(forged, () => {})).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
  it("读取失败归类明确；预先取消不读原件", async () => {
    let reads = 0;
    const file = {
      name: "read.json",
      size: 1,
      arrayBuffer: async () => {
        reads++;
        throw new Error("read denied");
      },
    } as unknown as File;
    const controller = new AbortController();
    controller.abort();
    await expect(parseMachineLogFile(file, () => {}, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(reads).toBe(0);
    await expect(parseMachineLogFile(file, () => {})).rejects.toMatchObject({ code: "READ_FAILED" });
  });
});
