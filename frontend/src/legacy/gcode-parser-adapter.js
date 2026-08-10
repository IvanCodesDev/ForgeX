// 渐进迁移适配层：Worker 继续复用经过黄金样例验证的 legacy 解析器，避免复制算法。
import "../../../js/gcode-parser.js";

export const legacyGcodeParser = globalThis.FXGcodeParser;
