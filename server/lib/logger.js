/* 结构化 JSON 行日志：{ts,level,msg,...fields}。reqId / taskId 贯穿整条排障链路。 */
"use strict";
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(level) {
  const min = LEVELS[level] || 20;
  const emit = (lv, msg, fields) => {
    if (LEVELS[lv] < min) return;
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), level: lv, msg }, fields || {}));
    (LEVELS[lv] >= 30 ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

module.exports = { createLogger };
