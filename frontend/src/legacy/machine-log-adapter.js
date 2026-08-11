// 渐进迁移适配层：Worker 复用已由 legacy 与夹具测试覆盖的日志算法。
import "../../../js/machine-log.js";

export const legacyMachineLog = globalThis.FXMachineLog;
