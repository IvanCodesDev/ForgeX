/* 极简 SSE 帧解析器（text/event-stream，WHATWG 规范的子集）。

   Stage 8.6c-2a：Node 在 ANALYSIS_TASKS_AUTHORITY=csharp 时消费 ForgeX.Api 的
   `id: / event: / data:` 命名帧，重新组成前端现用的无名 `data:` 帧。这里只做逐行切帧：
     - 以空行结束一帧；`:` 开头是注释（心跳），单独回调；
     - `data:` 多行按规范以 \n 拼接；`id:` / `event:` 取最后一次；
     - 字段名后的一个空格按规范剥掉；行尾 \r 兼容 CRLF。
   零依赖、无状态外泄——只在进程内切帧，不解析 JSON（交给调用方决定怎么用 data）。 */
"use strict";

function createSseParser(handlers) {
  const onFrame = handlers && typeof handlers.onFrame === "function" ? handlers.onFrame : () => {};
  const onComment = handlers && typeof handlers.onComment === "function" ? handlers.onComment : () => {};
  let buffer = "";
  let frame = null;

  const flush = () => {
    if (frame && frame.data.length) {
      onFrame({ id: frame.id, event: frame.event || "message", data: frame.data.join("\n") });
    }
    frame = null;
  };

  const handleLine = (rawLine) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      flush();
      return;
    }
    if (line.startsWith(":")) {
      onComment(line.slice(1).startsWith(" ") ? line.slice(2) : line.slice(1));
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (!frame) frame = { id: null, event: null, data: [] };
    if (field === "data") frame.data.push(value);
    else if (field === "event") frame.event = value;
    else if (field === "id") frame.id = value;
    // retry 与未知字段按规范忽略
  };

  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    end() {
      if (buffer.length) handleLine(buffer);
      buffer = "";
      flush();
    },
  };
}

module.exports = { createSseParser };
