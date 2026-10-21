import { describe, expect, it } from "vitest";
import { createIncrementalParser, parse } from "./gcode-parser";

const mm =
  "G21\nG90\nM82\nG92 X0 Y0 Z0 E0\nG1 X25.4 Z0.254 E2.54 F1524\nG91\nM83\nG1 X25.4 Y25.4 E2.54\nG92 X0 Y0 E0\nG90\nM82\nG1 X25.4 E2.54\n";
const inches =
  "G20\nG90\nM82\nG92 X0 Y0 Z0 E0\nG1 X1 Z0.01 E0.1 F60\nG91\nM83\nG1 X1 Y1 E0.1\nG92 X0 Y0 E0\nG90\nM82\nG1 X1 E0.1\n";
describe("G-code units and extrusion modes", () => {
  it("normalizes absolute, relative, feed and G92 coordinates without changing results", () => {
    const expected = parse(mm),
      actual = parse(inches);
    expect(actual.stats).toEqual(expected.stats);
    expect(actual.layers).toEqual(expected.layers);
    expect(actual.bounds).toEqual(expected.bounds);
    expect(actual.warnings.some((v) => v.includes("英寸"))).toBe(true);
  });
  it("keeps the current feed in mm/min when switching units without a new F", () => {
    const source = "G20\nM83\nG1 X1 Z0.01 E0.1 F60\nG21\nG1 X50.8 E2.54\nG20\nG1 X3 E0.1\n";
    expect(parse(source).stats.timeSec).toBeCloseTo(3, 10);
    expect(parse(source).stats.filamentM).toBeCloseTo(0.00762, 12);
  });
  it("has identical semantics across one-character streaming chunks", () => {
    const stream = createIncrementalParser();
    for (const char of inches) stream.push(char);
    expect(stream.finish()).toEqual(parse(inches));
  });
  it.each(["M200 D0", "M200 S0", "M200 S0 D1.75", "T0", "G21"])("accepts explicit supported mode %s", (command) => {
    expect(parse(command + "\n" + mm).stats).toEqual(parse(mm).stats);
  });
  it.each(["M200 D1.75", "M200 S1", "M200 S1 D0", "M200", "T1", "T7"])(
    "rejects unsupported mode %s instead of assuming a shared length E",
    (command) => {
      expect(() => parse(command + "\n" + mm)).toThrow(/体积挤出|单工具/);
    }
  );
  it("rejects overflowing converted lengths before publishing nonfinite statistics", () => {
    expect(() => parse("G20\nG1 X1000000000000 E1\n")).toThrow("支持范围");
  });
});
