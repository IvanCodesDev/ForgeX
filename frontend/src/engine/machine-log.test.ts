/* 真机日志解析与 G-code 计划/实测对比（Stage 7.4 前置：自 tests/machine-log.test.js 与
   tests/stage0-hardening.test.js 的引擎段迁入 vitest，改测 TS 引擎）。 */
import { describe, expect, it } from "vitest";
import { sha256, type ParsedGcodeResult } from "./gcode-parser.ts";
import { MAX_BYTES, MAX_ROWS, compare, parse, verifyGcodeBinding } from "./machine-log.ts";
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

describe("日志数值与计量边界", () => {
  it.each([{}, { durationSec: null, filamentG: null }, { durationSec: " ", durationMin: "" }])(
    "缺失、null、空白汇总保持未知：%j",
    (job) => {
      const log = parse(JSON.stringify({ job, samples: [] }));
      expect(log.actualTimeSec).toBeNull();
      expect(log.filamentG).toBeNull();
      expect(log.filamentMm).toBeNull();
      expect(log.completedLayers).toBeNull();
      expect(log.energyKwh).toBeNull();
    }
  );
  it("缺失温度不生成 0；遥测时间从非零起点取跨度", () => {
    const log = parse("time_s,nozzle_c,bed_c\n100,,\n220,200,\n");
    expect(log.actualTimeSec).toBe(120);
    expect(log.samples[0]).toEqual({ timeSec: 100, nozzleC: null, bedC: null });
    expect(log.warnings.join(" ")).toContain("跨度");
  });
  it("JSON 遥测回退与显式时长优先；分钟正确换算", () => {
    expect(parse('{"samples":[{"timeSec":10},{"timeSec":130}]}').actualTimeSec).toBe(120);
    expect(parse('{"job":{"durationSec":0},"samples":[{"timeSec":10},{"timeSec":130}]}').actualTimeSec).toBe(0);
    expect(parse('{"job":{"duration_min":"2.5"}}').actualTimeSec).toBe(150);
  });
  it("显式 0 与缺失不同，保留零能耗及依据", () => {
    const log = parse('{"job":{"durationSec":0,"filamentG":0,"energyKwh":0,"energyEvidence":"设备明确记录零消耗"}}');
    expect(log).toMatchObject({ actualTimeSec: 0, filamentG: 0, energyKwh: 0, sourceSha256: "" });
    expect(log.warnings.join(" ")).not.toContain("缺少计量依据");
  });
  it.each([true, [], {}, "abc", "0x10", "Infinity", -1, Infinity])("拒绝非法时长 %j", (value) => {
    // Infinity 的 JSON 形式是 null；通过 CSV 单独覆盖非有限文字。
    if (value === Infinity) expect(() => parse("duration_s\n1e999")).toThrow(/有限/);
    else expect(() => parse(JSON.stringify({ job: { durationSec: value } }))).toThrow();
  });
  it.each([
    { filamentG: -1 },
    { completedLayers: 1.2 },
    { completedLayers: 1e20 },
    { energyKwh: -1 },
    { energyKwh: 1000001 },
    { energyEvidence: 123 },
  ])("拒绝非法汇总 %j", (job) => {
    expect(() => parse(JSON.stringify({ job }))).toThrow();
  });
  it("能耗缺少依据只保留记录并警告；依据长度与控制字符受限", () => {
    const log = parse('{"job":{"energyKwh":0.4}}');
    expect(log.energyKwh).toBe(0.4);
    expect(log.warnings.join(" ")).toContain("不参与成本对账");
    for (const energyEvidence of ["x".repeat(501), "bad\u0000text"])
      expect(() => parse(JSON.stringify({ job: { energyKwh: 1, energyEvidence } }))).toThrow(/依据/);
  });
  it("CSV 单任务能耗与带逗号、换行的引用依据归一", () => {
    const log = parse('time_s,energy_kwh,energy_evidence\r\n0,,\r\n60,0.02,"电表 A, 起止差额\n任务区间 60s"');
    expect(log.energyKwh).toBe(0.02);
    expect(log.energyEvidence).toBe("电表 A, 起止差额\n任务区间 60s");
  });
  it("CSV 稀疏身份保留首行声明，拒绝多任务、多设备混入", () => {
    expect(parse("time_s,job_id,machine_id\n0,J-1,M-1\n10,,")).toMatchObject({ jobId: "J-1", machineId: "M-1" });
    expect(() => parse("time_s,job_id\n0,J-1\n10,J-2")).toThrow(/不一致/);
    expect(() => parse("time_s,machine_id\n0,M-1\n10,M-2")).toThrow(/不一致/);
  });
  it("UTF-8 BOM 的 JSON 与 CSV 均可解析", () => {
    expect(parse('\uFEFF{"job":{"durationSec":5}}').actualTimeSec).toBe(5);
    expect(parse("\uFEFFtime_s\n10\n15").actualTimeSec).toBe(5);
  });
  it.each([
    '{"job":[]}',
    '{"samples":{}}',
    '{"samples":[null]}',
    '{"samples":[false]}',
    '{"samples":[{"timeSec":-1}]}',
  ])("拒绝结构无效的日志 %s", (text) => {
    expect(() => parse(text)).toThrow();
  });
  it.each(["time_s,time-s\n0,1", ",time_s\nx,1", "time_s,bed_c\n0", 'time_s\n"12', 'time_s\n1"2"', 'time_s\n"1"x'])(
    "拒绝含歧义的 CSV %s",
    (text) => {
      expect(() => parse(text)).toThrow(/CSV/);
    }
  );
  it("大规模遥测不向 Math.max/min 展开参数", () => {
    const samples = Array.from({ length: 180000 }, (_, timeSec) => ({ timeSec }));
    const log = parse(JSON.stringify({ samples }));
    expect(log.actualTimeSec).toBe(179999);
    expect(log.samples).toHaveLength(180000);
  });
  it("JSON 与无结尾换行的 CSV 均受行数上限约束", () => {
    expect(() => parse(JSON.stringify({ samples: Array(MAX_ROWS + 1).fill({}) }))).toThrow(/行数/);
    expect(() => parse("time_s\n" + "1\n".repeat(MAX_ROWS) + "2")).toThrow(/行数/);
  });
  it("按 UTF-8 原始字节限制大小", () => {
    const oversized = "中".repeat(Math.floor(MAX_BYTES / 3) + 1);
    expect(oversized.length).toBeLessThan(MAX_BYTES);
    expect(() => parse(oversized)).toThrow(/超过/);
  });
  it("零计划值对非零实测不再报告 0% 一致", () => {
    const plan = { totalLayers: 0, stats: { timeSec: 0, filamentM: 0, filamentG: 0 } } as ParsedGcodeResult;
    const compared = compare(plan, parse('{"job":{"durationSec":1,"filamentG":0}}'));
    expect(compared[0]).toMatchObject({ agrees: false, relDiff: null });
    expect(compared[1]).toMatchObject({ agrees: true, relDiff: 0 });
  });
});
