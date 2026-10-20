/* FORGE·X — STL / 3MF 导入 Worker 入口（Stage 9.3 前半）。

   主线程只负责选文件、进度展示与模型装配；本线程完成：
   读取字节 → SHA-256 → 格式识别 → 解析（二进制/ASCII STL、3MF ZIP+XML）→ 归一化与统计。
   三角形顶点缓冲经 Transferable 零拷贝回传。

   经 Vite `?worker&inline` 内联打包：普通构建与离线单 HTML 同一条代码路径。 */
import { sha256 } from "../../engine/gcode-parser";
import { MAX_MESH_BYTES, parseMeshBuffer } from "../../engine/mesh-import";
import {
  classifyMeshError,
  type MeshImportPhase,
  type MeshImportRequest,
  type MeshImportWorkerReply,
} from "./mesh-import-protocol";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<MeshImportRequest>) => void) | null;
  postMessage(message: MeshImportWorkerReply, transfer?: Transferable[]): void;
};

async function handleParse(request: MeshImportRequest): Promise<void> {
  const { requestId, file } = request;
  const progress = (phase: MeshImportPhase, value: number) =>
    scope.postMessage({ type: "progress", requestId, phase, progress: value });
  let phase: MeshImportPhase = "read";
  try {
    if (file.size > MAX_MESH_BYTES) {
      throw new Error(`网格文件超过 ${Math.round(MAX_MESH_BYTES / 1024 / 1024)}MB，请先精简`);
    }
    progress("read", 0);
    const buffer = await file.arrayBuffer();
    progress("read", 1);

    phase = "hash";
    progress("hash", 0);
    const digest = await sha256(buffer);
    progress("hash", 1);

    phase = "parse";
    progress("parse", 0);
    const mesh = await parseMeshBuffer(buffer, file.name);
    progress("parse", 1);

    scope.postMessage({ type: "result", requestId, sha256: digest, mesh }, [mesh.positions.buffer as ArrayBuffer]);
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    scope.postMessage({ type: "error", requestId, phase, code: classifyMeshError(message, phase), message });
  }
}

scope.onmessage = (event) => {
  if (event.data && event.data.type === "parse") void handleParse(event.data);
};
