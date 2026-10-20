/* 真机日志解析与 G-code 计划/实测对比（Stage 7.4 前置：自 tests/machine-log.test.js 与
   tests/stage0-hardening.test.js 的引擎段迁入 vitest，改测 TS 引擎）。 */
import { describe, expect, it } from "vitest";
import { sha256, type ParsedGcodeResult } from "./gcode-parser.ts";
import { compare, parse, verifyGcodeBinding } from "./machine-log.ts";
import exampleLog from "../../../contracts/logs/example-machine-log.json?raw";

describe("标准 JSON 真机日志", () => {
  it("仓库示例：任务时长、耗材、层数/状态、温度遥测", () => {
    const json = parse(exampleLog, { name: "example-machine-log.json" });
    expect(json.actualTimeSec).toBe(4380);
    expect(json.filamentMm).toBe(8240);
    expect(json.filamentG).toBe(24.7);
    expect(json.completedLayers).toBe(120);
    expect(json.status).toBe("success");
    expect(json.samples).toHaveLength(4);
    expect(json.samples[1]!.nozzleC).toBe(209.6);
  });

  it("保留任务、机型、固件与 G-code 责任链", () => {
    const linked = parse(
      JSON.stringify({
        format: "forgex-machine-log",
        version: 1,
        job: {
          jobId: "J-1",
          machineId: "FX-01",
          firmware: "Klipper 0.12",
          slicer: "OrcaSlicer 2.2",
          gcodeSha256: "a".repeat(64),
          durationSec: 100,
          status: "success",
        },
        telemetry: [],
      })
    );
    expect(linked).toMatchObject({
      jobId: "J-1",
      machineId: "FX-01",
      firmware: "Klipper 0.12",
      gcodeSha256: "a".repeat(64),
    });
  });
});

const csvSha = "b".repeat(64);
const csvLog = parse(
  [
    "time_s,nozzle_c,bed_c,filament_mm,filament_g,completed_layers,status,gcode_sha256",
    `0,25,25,,,,running,${csvSha}`,
    `120,210,60,300,0.9,2,success,${csvSha}`,
  ].join("\n"),
  { name: "machine.csv" }
);

describe("通用 CSV 真机日志", () => {
  it("时长取最后时间、最后一行汇总生效、样本归一、SHA-256 保留并可强绑定", () => {
    expect(csvLog.actualTimeSec).toBe(120);
    expect(csvLog.filamentMm).toBe(300);
    expect(csvLog.completedLayers).toBe(2);
    expect(csvLog.samples).toHaveLength(2);
    expect(csvLog.samples[1]!.bedC).toBe(60);
    expect(csvLog.gcodeSha256).toBe(csvSha);
    expect(verifyGcodeBinding({ sha256: csvSha }, csvLog).verified).toBe(true);
  });
});

describe("计划 / 实测对比", () => {
  const planned = {
    totalLayers: 2,
    stats: { timeSec: 120, filamentM: 0.3, filamentG: 0.9 },
  } as unknown as ParsedGcodeResult;

  it("生成时长、长度、克重、层数四项；精确一致项吻合且每项带解释", () => {
    const compared = compare(planned, csvLog);
    expect(compared).toHaveLength(4);
    expect(compared.every((x) => x.agrees)).toBe(true);
    expect(compared.every((x) => x.note && x.note.length > 10)).toBe(true);
  });

  it("明显偏差被标记但仍保留两侧原值", () => {
    const slow = parse(
      JSON.stringify({
        format: "forgex-machine-log",
        version: 1,
        job: { durationSec: 200, status: "success" },
        telemetry: [],
      })
    );
    const slowTime = compare(planned, slow)[0]!;
    expect(slowTime.agrees).toBe(false);
    expect(slowTime.planned).toBe(120);
    expect(slowTime.actual).toBe(200);
  });
});

describe("错误与限制", () => {
  it("空日志 / 未知格式 / CSV 摘要冲突 均明确报错", () => {
    expect(() => parse("")).toThrow(/为空/);
    expect(() => parse('{"format":"unknown","version":1}')).toThrow(/不支持/);
    expect(() =>
      parse(["time_s,status,gcode_sha256", `0,running,${"c".repeat(64)}`, `1,success,${"d".repeat(64)}`].join("\n"))
    ).toThrow(/不一致/);
  });
});

describe("内容寻址与文件责任链（Stage 0 硬化）", () => {
  it("sha256('abc') 为标准摘要；绑定核验区分 verified / mismatch / missing", async () => {
    const digest = await sha256("abc");
    expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(verifyGcodeBinding({ sha256: digest }, { gcodeSha256: digest }).status).toBe("verified");
    expect(verifyGcodeBinding({ sha256: digest }, { gcodeSha256: "a".repeat(64) }).status).toBe("mismatch");
    expect(verifyGcodeBinding({ sha256: digest }, { gcodeSha256: "" }).status).toBe("missing");
  });
});
