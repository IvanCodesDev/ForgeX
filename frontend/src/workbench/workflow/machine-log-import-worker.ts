import { parseMachineLogFile } from "./machine-log-import-pipeline";
import {
  MachineLogImportError,
  type MachineLogImportRequest,
  type MachineLogImportWorkerReply,
} from "./machine-log-import-protocol";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MachineLogImportRequest>) => void) | null;
  postMessage(message: MachineLogImportWorkerReply): void;
};
scope.onmessage = (event) => {
  const request = event.data;
  if (request?.type !== "parse") return;
  const { requestId } = request;
  void parseMachineLogFile(request.file, (progress) => scope.postMessage({ type: "progress", requestId, ...progress }))
    .then((log) => scope.postMessage({ type: "result", requestId, log }))
    .catch((error: unknown) => {
      const failure =
        error instanceof MachineLogImportError
          ? error
          : new MachineLogImportError("WORKER_FAILURE", "真机日志后台解析失败");
      scope.postMessage({
        type: "error",
        requestId,
        code: failure.code,
        phase: failure.phase ?? "read",
        message: failure.message,
      });
    });
};
