import type { GcodeParseOptions, LegacyGcodeResult } from "../features/gcode/gcode-types";

export const legacyGcodeParser: {
  readonly MAX_BYTES: number;
  createIncrementalParser(options: GcodeParseOptions): {
    push(textChunk: string): void;
    finish(): LegacyGcodeResult;
  };
  parse(text: string, options: GcodeParseOptions): LegacyGcodeResult;
};
