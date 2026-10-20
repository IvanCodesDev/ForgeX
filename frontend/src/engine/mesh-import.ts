/* FORGE·X — STL / 3MF 网格导入（纯几何逻辑；不依赖 THREE / DOM，Worker 与主线程共用）。

   Stage 9.3 前半：浏览器侧「预览解析」。产物是与内置模型同构的可切片模型——
   切片器通过 outlinesAt(z) 取平面截交环，printer3d / 导出通过 buildGeometry 取三角网格，
   因此导入网格可以直接进入既有的切片 → 打印仿真 → 导出链。
   C# 校验结果由独立接口提供；本模块的所有
   数字都标注为「浏览器预览」，不得写入权威数据集。

   坐标约定：与 STL 行业惯例一致，Z-up、单位 mm。归一化后 XY 以包围盒中心为原点、
   Z 从 0 起（打印面），与 models.ts 内置模型的局部坐标一致。 */
import { contourLoops, type Loop } from "./slicer.ts";
import type { Point2 } from "./util.ts";
import type { BuiltModel } from "./models.ts";

export const MAX_MESH_BYTES = 64 * 1024 * 1024;
const MAX_MESH_XML_BYTES = 16 * 1024 * 1024;
const MAX_PREVIEW_TRIANGLES = 1_000_000;
/** 超过该三角面数仍可导入，但切片与预览会明显变慢，提示用户精简 */
export const HEAVY_TRIANGLES = 500_000;
/** 悬垂判据：法向与 −Z 夹角 < 45°（nz < −cos45°）且不贴打印面 */
const OVERHANG_NZ = -Math.SQRT1_2;
const OVERHANG_MIN_Z = 0.3;
const OVERHANG_AREA_MM2 = 25;

export type MeshFormat = "stl-binary" | "stl-ascii" | "3mf";

export interface MeshBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** 解析 + 归一化后的网格；positions 可 Transferable（Worker → 主线程零拷贝） */
export interface MeshImportPayload {
  readonly format: MeshFormat;
  /** 每三角形 9 个 float（x,y,z × 3），归一化后的模型局部坐标 */
  readonly positions: Float32Array;
  readonly triangleCount: number;
  /** 退化（零面积 / 非有限值）而被丢弃的三角形数 */
  readonly droppedTriangles: number;
  /** 3MF 参与构建的对象数；STL 恒 1 */
  readonly objectCount: number;
  readonly bounds: MeshBounds;
  readonly sizeMm: { readonly x: number; readonly y: number; readonly z: number };
  /** 有向体积绝对值（cm³，浏览器预览口径） */
  readonly volumeCm3: number;
  readonly surfaceAreaCm2: number;
  /** 需要支撑的朝下面面积（mm²） */
  readonly overhangAreaMm2: number;
  readonly needSupport: boolean;
  /** 3MF 的 unit 属性；STL 无单位声明 */
  readonly unit: string | null;
  readonly warnings: readonly string[];
}

/* ── 格式识别 ─────────────────────────────── */

const STL_HEADER_BYTES = 80;
const STL_TRIANGLE_BYTES = 50;
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

export function detectMeshFormat(fileName: string, bytes: Uint8Array): MeshFormat | null {
  const ext = (fileName.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (bytes.length >= 4) {
    const sig = readU32(bytes, 0);
    if (sig === ZIP_LOCAL_SIG || sig === ZIP_EOCD_SIG) return "3mf";
  }
  if (ext === "3mf") return "3mf";
  if (isBinaryStl(bytes)) return "stl-binary";
  if (looksLikeAsciiStl(bytes)) return "stl-ascii";
  if (ext === "stl") return bytes.length >= STL_HEADER_BYTES + 4 ? "stl-binary" : "stl-ascii";
  return null;
}

/** 二进制 STL 判据：80 字节头 + uint32 三角数，且 84 + 50·n 与文件长度吻合 */
function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < STL_HEADER_BYTES + 4) return false;
  const n = readU32(bytes, STL_HEADER_BYTES);
  if (n > MAX_PREVIEW_TRIANGLES && 84 + n * 50 <= bytes.length)
    throw new Error("预览三角面超过 1000000 个，请先精简模型");
  return STL_HEADER_BYTES + 4 + n * STL_TRIANGLE_BYTES === bytes.length;
}

function looksLikeAsciiStl(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith("solid") && (head.includes("facet") || head.includes("endsolid") || head.length < 300);
}

function readU16(bytes: Uint8Array, off: number): number {
  return bytes[off]! | (bytes[off + 1]! << 8);
}
function readU32(bytes: Uint8Array, off: number): number {
  return (bytes[off]! | (bytes[off + 1]! << 8) | (bytes[off + 2]! << 16) | (bytes[off + 3]! << 24)) >>> 0;
}

/* ── STL ──────────────────────────────────── */

export function parseStlBinary(bytes: Uint8Array): Float32Array {
  if (bytes.length < STL_HEADER_BYTES + 4) throw new Error("二进制 STL 文件不完整（不足 84 字节）");
  const n = readU32(bytes, STL_HEADER_BYTES);
  const need = STL_HEADER_BYTES + 4 + n * STL_TRIANGLE_BYTES;
  if (need > bytes.length) throw new Error(`二进制 STL 声明 ${n} 个三角形，但文件长度不足`);
  if (n > MAX_PREVIEW_TRIANGLES) throw new Error("预览三角面超过 1000000 个，请先精简模型");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(n * 9);
  let off = STL_HEADER_BYTES + 4;
  for (let t = 0; t < n; t++) {
    off += 12; // 法向量：由顶点重算，忽略文件内声明
    for (let k = 0; k < 9; k++) {
      out[t * 9 + k] = view.getFloat32(off, true);
      off += 4;
    }
    off += 2; // attribute byte count
  }
  return out;
}

const ASCII_VERTEX_RE = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;

export function parseStlAscii(text: string): Float32Array {
  const coords: number[] = [];
  ASCII_VERTEX_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ASCII_VERTEX_RE.exec(text)) !== null) {
    if (coords.length >= MAX_PREVIEW_TRIANGLES * 9) throw new Error("预览三角面超过 1000000 个，请先精简模型");
    coords.push(parseFloat(m[1]!), parseFloat(m[2]!), parseFloat(m[3]!));
  }
  if (!coords.length) throw new Error("ASCII STL 中没有 vertex 记录");
  if (coords.length % 9 !== 0) throw new Error(`ASCII STL 顶点数 ${coords.length / 3} 不是 3 的倍数（facet 不完整）`);
  return Float32Array.from(coords);
}

/* ── 3MF（ZIP + XML，零依赖） ─────────────── */

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localHeaderOffset: number;
}

function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  // EOCD 至少 22 字节，末尾可能跟注释：从尾部向前扫描签名
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (readU32(bytes, i) === ZIP_EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("3MF 不是有效的 ZIP 容器（找不到目录结尾记录）");
  const total = readU16(bytes, eocd + 10);
  const cdOffset = readU32(bytes, eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) throw new Error("暂不支持 ZIP64 格式的 3MF");
  const entries: ZipEntry[] = [];
  if (total > 256) throw new Error("3MF ZIP 条目超过 256 个");
  let expanded = 0;
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > bytes.length || readU32(bytes, p) !== ZIP_CENTRAL_SIG) throw new Error("3MF 中央目录损坏");
    const method = readU16(bytes, p + 10);
    const compressedSize = readU32(bytes, p + 20);
    const uncompressedSize = readU32(bytes, p + 24);
    const nameLen = readU16(bytes, p + 28);
    const extraLen = readU16(bytes, p + 30);
    const commentLen = readU16(bytes, p + 32);
    const localHeaderOffset = readU32(bytes, p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > bytes.length) throw new Error("3MF 中央目录长度损坏");
    expanded += uncompressedSize;
    if (expanded > MAX_MESH_BYTES) throw new Error("3MF 总解压大小超过 64 MB");
    const name = new TextDecoder("utf-8").decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const h = entry.localHeaderOffset;
  if (h + 30 > bytes.length || readU32(bytes, h) !== ZIP_LOCAL_SIG) throw new Error(`3MF 条目 ${entry.name} 头损坏`);
  const nameLen = readU16(bytes, h + 26);
  const extraLen = readU16(bytes, h + 28);
  const start = h + 30 + nameLen + extraLen;
  if (start + entry.compressedSize > bytes.length) throw new Error("3MF 压缩条目长度损坏");
  if (entry.uncompressedSize > MAX_MESH_XML_BYTES) throw new Error("3MF 单个模型 XML 超过 16 MB");
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    if (raw.length > MAX_MESH_XML_BYTES || raw.length !== entry.uncompressedSize)
      throw new Error("3MF 条目长度不符或超过限制");
    return raw;
  }
  if (entry.method !== 8) throw new Error(`3MF 条目 ${entry.name} 使用了不支持的压缩方式 ${entry.method}`);
  if (typeof DecompressionStream !== "function")
    throw new Error("当前运行环境不支持 deflate 解压（DecompressionStream）");
  const copy = new Uint8Array(raw); // 独立缓冲：Blob 不能引用共享大缓冲的子视图
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_MESH_XML_BYTES) throw new Error("3MF 实际解压模型超过 16 MB");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const inflated = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    inflated.set(chunk, offset);
    offset += chunk.length;
  }
  if (inflated.length !== entry.uncompressedSize) throw new Error(`3MF 条目 ${entry.name} 解压后长度不符`);
  return inflated;
}

const UNIT_TO_MM: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

/** 3MF 变换：12 个数 m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32（行向量右乘） */
type Mat = readonly [number, number, number, number, number, number, number, number, number, number, number, number];
const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

function parseMat(s: string | undefined): Mat {
  if (!s) return IDENTITY;
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) throw new Error(`3MF transform 非法：${s}`);
  return v as unknown as Mat;
}
/** 先 a 再 b：p·a·b */
function mulMat(a: Mat, b: Mat): Mat {
  const r = (i: number, j: number) => a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!;
  return [
    r(0, 0),
    r(0, 1),
    r(0, 2),
    r(1, 0),
    r(1, 1),
    r(1, 2),
    r(2, 0),
    r(2, 1),
    r(2, 2),
    r(3, 0) + b[9]!,
    r(3, 1) + b[10]!,
    r(3, 2) + b[11]!,
  ];
}

interface ModelObject {
  readonly id: string;
  readonly type: string;
  readonly vertices: Float64Array; // x,y,z
  readonly triangles: Uint32Array; // v1,v2,v3
  readonly components: ReadonlyArray<{ objectId: string; path: string | null; transform: Mat }>;
}

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(s)) !== null)
    out[m[1]!] = (m[2] ?? m[3] ?? "").replace(
      /&(?:amp|lt|gt|quot|apos);/g,
      (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[entity]!
    );
  return out;
}

const PRODUCTION_NS = "http://schemas.microsoft.com/3dmanufacturing/production/2015/06";
const MODEL_RELATIONSHIP = "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel";

function parseModelXml(
  xml: string,
  parseBuild = true
): {
  unit: string;
  hasBuild: boolean;
  objects: Map<string, ModelObject>;
  build: Array<{ objectId: string; path: string | null; transform: Mat }>;
} {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("3MF 不支持 DTD 或实体声明");
  xml = xml.replace(/<!--[\s\S]*?-->/g, "");
  const modelTag = xml.match(/<model\b([^>]*)>/i);
  if (!modelTag) throw new Error("3MF 缺少 model 元素");
  const modelAttrs = attrs(modelTag[1]!);
  if (modelAttrs.xmlns !== "http://schemas.microsoft.com/3dmanufacturing/core/2015/02")
    throw new Error("3MF 模型命名空间无效");
  const required = (modelAttrs.requiredextensions ?? "").split(/\s+/).filter(Boolean);
  if (required.some((prefix) => modelAttrs[`xmlns:${prefix}`] !== PRODUCTION_NS))
    throw new Error("3MF 声明了不受支持的必需扩展");
  const partPath = (attributes: Record<string, string>): string | null => {
    const key = Object.keys(attributes).find((name) => name === "path" || name.endsWith(":path"));
    if (key == null) return null;
    const prefix = key.includes(":") ? key.slice(0, key.indexOf(":")) : "";
    if (!prefix || (attributes[`xmlns:${prefix}`] ?? modelAttrs[`xmlns:${prefix}`]) !== PRODUCTION_NS)
      throw new Error("3MF 分件路径必须使用 Production 命名空间");
    if (!required.some((p) => modelAttrs[`xmlns:${p}`] === PRODUCTION_NS))
      throw new Error("3MF 分件引用必须声明 Production 必需扩展");
    return attributes[key]!;
  };
  const unit = modelAttrs.unit || "millimeter";
  const objects = new Map<string, ModelObject>();
  const objectRe = /<object\b([^>]*?)(\/>|>([\s\S]*?)<\/object>)/g;
  let om: RegExpExecArray | null;
  while ((om = objectRe.exec(xml)) !== null) {
    const a = attrs(om[1]!);
    const body = om[3] ?? "";
    const verts: number[] = [];
    const tris: number[] = [];
    const components: Array<{ objectId: string; path: string | null; transform: Mat }> = [];
    const vertRe = /<vertex\b([^>]*?)\/?>/g;
    let vm: RegExpExecArray | null;
    while ((vm = vertRe.exec(body)) !== null) {
      const va = attrs(vm[1]!);
      verts.push(parseFloat(va.x ?? "0"), parseFloat(va.y ?? "0"), parseFloat(va.z ?? "0"));
    }
    const triRe = /<triangle\b([^>]*?)\/?>/g;
    let tm: RegExpExecArray | null;
    while ((tm = triRe.exec(body)) !== null) {
      const ta = attrs(tm[1]!);
      tris.push(parseInt(ta.v1 ?? "-1", 10), parseInt(ta.v2 ?? "-1", 10), parseInt(ta.v3 ?? "-1", 10));
    }
    const compRe = /<component\b([^>]*?)\/?>/g;
    let cm: RegExpExecArray | null;
    while ((cm = compRe.exec(body)) !== null) {
      const ca = attrs(cm[1]!);
      if (!ca.objectid) continue;
      components.push({ objectId: ca.objectid, path: partPath(ca), transform: parseMat(ca.transform) });
    }
    if (!a.id) continue;
    if (objects.has(a.id)) throw new Error("3MF 对象 ID 重复");
    if (objects.size >= 4096) throw new Error("3MF 对象数超过 4096");
    objects.set(a.id, {
      id: a.id,
      type: a.type || "model",
      vertices: Float64Array.from(verts),
      triangles: Uint32Array.from(tris),
      components,
    });
  }
  const build: Array<{ objectId: string; path: string | null; transform: Mat }> = [];
  const buildBlock = parseBuild ? xml.match(/<build\b[^>]*>([\s\S]*?)<\/build>/i) : null;
  if (buildBlock) {
    const itemRe = /<item\b([^>]*?)\/?>/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(buildBlock[1]!)) !== null) {
      const ia = attrs(im[1]!);
      if (!ia.objectid) continue;
      if (ia.printable === "0" || ia.printable === "false") continue;
      build.push({ objectId: ia.objectid, path: partPath(ia), transform: parseMat(ia.transform) });
    }
  }
  return { unit, objects, build, hasBuild: /<build\b/.test(xml) };
}

function normalizePath(value: string): string {
  const path = decodeURIComponent(value).replace(/^\//, "");
  if (
    !path ||
    /[\\:#?]/.test(path) ||
    hasControlCharacters(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("3MF 包内路径不合法");
  return path;
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

function relationshipPath(owner: string, value: string): string {
  const decoded = decodeURIComponent(value);
  if (/^[a-z][a-z\d+.-]*:|^\/\/|[\\?#]/i.test(decoded) || hasControlCharacters(decoded))
    throw new Error("3MF 模型关系必须指向包内文件");
  const full = decoded.startsWith("/") ? decoded.slice(1) : owner.slice(0, owner.lastIndexOf("/") + 1) + decoded;
  const segments: string[] = [];
  for (const segment of full.split("/")) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) throw new Error("3MF 模型关系越过包根目录");
      segments.pop();
    } else if (!segment) throw new Error("3MF 模型关系路径无效");
    else segments.push(segment);
  }
  if (!segments.length) throw new Error("3MF 模型关系路径无效");
  return segments.join("/");
}

export interface Parsed3mf {
  readonly positions: Float32Array;
  readonly objectCount: number;
  readonly unit: string;
  readonly warnings: string[];
}

export async function parse3mf(bytes: Uint8Array): Promise<Parsed3mf> {
  const entries = readZipDirectory(bytes);
  const packageEntries = new Map<string, ZipEntry>();
  for (const entry of entries) {
    const key = normalizePath(entry.name.replace(/\/$/, "")).toLowerCase();
    if (packageEntries.has(key)) throw new Error("3MF 包含重复或大小写冲突的 ZIP 路径");
    packageEntries.set(key, entry);
  }
  const modelEntries = entries.filter((e) => /\.model$/i.test(e.name));
  if (!modelEntries.length) throw new Error("3MF 内没有 .model 部件（不是 3D 制造格式包）");
  let root =
    modelEntries.find((e) => normalizePath(e.name).toLowerCase() === "3d/3dmodel.model") ??
    modelEntries.find((e) => !/\/objects\//i.test(e.name)) ??
    modelEntries[0]!;
  const decoder = new TextDecoder("utf-8");
  let actualExpanded = 0;
  const readXml = async (entry: ZipEntry): Promise<string> => {
    const xml = await readZipEntry(bytes, entry);
    actualExpanded += xml.length;
    if (actualExpanded > MAX_MESH_BYTES) throw new Error("3MF XML 累计实际解压大小超过 64 MB");
    const text = decoder.decode(xml);
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("3MF 不支持 DTD 或实体声明");
    return text.replace(/<!--[\s\S]*?-->/g, "");
  };
  const readRelationships = async (entry: ZipEntry, owner: string): Promise<string[]> => {
    const xml = await readXml(entry);
    const tag = xml.match(/<Relationships\b([^>]*)>/);
    if (!tag || attrs(tag[1]!).xmlns !== "http://schemas.openxmlformats.org/package/2006/relationships")
      throw new Error("3MF 包关系命名空间无效");
    const paths: string[] = [];
    for (const match of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
      const a = attrs(match[1]!);
      if (a.Type !== MODEL_RELATIONSHIP) continue;
      if (a.TargetMode && a.TargetMode !== "Internal") throw new Error("3MF 不允许包外模型关系");
      const path = relationshipPath(owner, a.Target ?? "");
      if (!packageEntries.has(path.toLowerCase())) throw new Error("3MF 模型关系指向不存在的包内文件");
      paths.push(path);
    }
    return paths;
  };
  const rootRelations = packageEntries.get("_rels/.rels");
  if (rootRelations) {
    const paths = await readRelationships(rootRelations, "");
    if (paths.length !== 1) throw new Error("3MF 必须通过一个包内关系指定根模型");
    root = packageEntries.get(paths[0]!.toLowerCase())!;
  }
  const rootPath = normalizePath(root.name);
  const relationEntry = packageEntries.get(
    (
      rootPath.slice(0, rootPath.lastIndexOf("/") + 1) +
      "_rels/" +
      rootPath.slice(rootPath.lastIndexOf("/") + 1) +
      ".rels"
    ).toLowerCase()
  );
  const relatedParts = new Set(
    relationEntry ? (await readRelationships(relationEntry, rootPath)).map((p) => p.toLowerCase()) : []
  );
  const files = new Map<string, ReturnType<typeof parseModelXml>>();
  let resourceCount = 0;
  const readPart = async (path: string): Promise<ReturnType<typeof parseModelXml>> => {
    const key = path.toLowerCase();
    const cached = files.get(key);
    if (cached) return cached;
    const entry = packageEntries.get(key);
    if (!entry) throw new Error("3MF 缺少引用的模型部件");
    const part = parseModelXml(await readXml(entry), key === rootPath.toLowerCase());
    if (!Object.hasOwn(UNIT_TO_MM, part.unit)) throw new Error(`3MF 使用了未知单位 ${part.unit}`);
    resourceCount += part.objects.size;
    if (resourceCount > 4096) throw new Error("3MF 包内对象总数超过 4096");
    if (
      key !== rootPath.toLowerCase() &&
      [...part.objects.values()].some((o) => o.components.some((c) => c.path != null))
    )
      throw new Error("3MF 非根模型的组件不能跨文件引用");
    files.set(key, part);
    return part;
  };
  const rootModel = await readPart(rootPath);
  const unitScale = UNIT_TO_MM[rootModel.unit];
  if (unitScale == null) throw new Error(`3MF 使用了未知单位 ${rootModel.unit}`);
  const warnings: string[] = [];
  const coords: number[] = [];
  let objectCount = 0;
  let expandedObjects = 0;
  const visiting = new Set<string>();

  const reference = async (
    owner: string,
    target: string | null,
    transform: Mat,
    parent: Mat
  ): Promise<{ path: string; matrix: Mat }> => {
    const path = target == null ? owner : normalizePath(target);
    if (target != null && (!target.startsWith("/") || target.startsWith("//") || !relatedParts.has(path.toLowerCase())))
      throw new Error("3MF 分件需要包内绝对路径及根模型关系声明");
    const from = await readPart(path);
    const to = await readPart(owner);
    const ratio = UNIT_TO_MM[from.unit]! / UNIT_TO_MM[to.unit]!;
    const conversion: Mat = [ratio, 0, 0, 0, ratio, 0, 0, 0, ratio, 0, 0, 0];
    return { path, matrix: mulMat(mulMat(conversion, transform), parent) };
  };
  const emit = async (path: string, id: string, m: Mat, depth: number): Promise<void> => {
    if (++expandedObjects > 4096) throw new Error("3MF 构建实例超过 4096 个");
    const file = await readPart(path);
    const obj = file?.objects.get(id);
    if (!obj) {
      warnings.push(`3MF 引用了不存在的对象 ${path}#${id}，已跳过`);
      return;
    }
    if (obj.type !== "model" && obj.type !== "solidsupport") return; // support / other 不参与成品
    const key = `${path.toLowerCase()}#${id}`;
    if (visiting.has(key) || depth > 32) {
      warnings.push(`3MF 组件引用成环（${key}），已截断`);
      return;
    }
    visiting.add(key);
    if (obj.triangles.length) {
      objectCount++;
      const v = obj.vertices;
      const t = obj.triangles;
      const nv = v.length / 3;
      for (let i = 0; i < t.length; i += 3) {
        if (coords.length >= MAX_PREVIEW_TRIANGLES * 9) throw new Error("预览三角面超过 1000000 个，请先精简模型");
        for (let k = 0; k < 3; k++) {
          const vi = t[i + k]!;
          if (vi >= nv) throw new Error(`3MF 对象 ${id} 的三角形引用了不存在的顶点 ${vi}`);
          const x = v[vi * 3]!,
            y = v[vi * 3 + 1]!,
            z = v[vi * 3 + 2]!;
          coords.push(
            (x * m[0] + y * m[3] + z * m[6] + m[9]) * unitScale,
            (x * m[1] + y * m[4] + z * m[7] + m[10]) * unitScale,
            (x * m[2] + y * m[5] + z * m[8] + m[11]) * unitScale
          );
        }
      }
    }
    for (const c of obj.components) {
      const ref = await reference(path, c.path, c.transform, m);
      await emit(ref.path, c.objectId, ref.matrix, depth + 1);
    }
    visiting.delete(key);
  };

  if (rootModel.build.length) {
    for (const item of rootModel.build) {
      const ref = await reference(rootPath, item.path, item.transform, IDENTITY);
      await emit(ref.path, item.objectId, ref.matrix, 0);
    }
  } else {
    if (rootModel.hasBuild) throw new Error("3MF 构建清单没有可打印对象");
    warnings.push("3MF 缺少 <build> 段，已按全部 model 对象原位导入");
    for (const [id, obj] of rootModel.objects) if (obj.type === "model") await emit(rootPath, id, IDENTITY, 0);
  }
  if (!coords.length) throw new Error("3MF 内没有可构建的三角网格");
  return { positions: Float32Array.from(coords), objectCount, unit: rootModel.unit, warnings };
}

/* ── 归一化与统计 ─────────────────────────── */

export function analyzeTriangles(
  raw: Float32Array,
  format: MeshFormat,
  extra: { objectCount: number; unit: string | null; warnings: string[] }
): MeshImportPayload {
  const warnings = [...extra.warnings];
  const n = Math.floor(raw.length / 9);
  // 第一遍：过滤退化三角形并求包围盒
  const keep: number[] = [];
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    let finite = true;
    for (let k = 0; k < 9; k++) if (!Number.isFinite(raw[o + k]!)) finite = false;
    if (!finite) continue;
    const ax = raw[o]!,
      ay = raw[o + 1]!,
      az = raw[o + 2]!;
    const ux = raw[o + 3]! - ax,
      uy = raw[o + 4]! - ay,
      uz = raw[o + 5]! - az;
    const vx = raw[o + 6]! - ax,
      vy = raw[o + 7]! - ay,
      vz = raw[o + 8]! - az;
    const cx = uy * vz - uz * vy,
      cy = uz * vx - ux * vz,
      cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz < 1e-16) continue; // 零面积
    keep.push(t);
    for (let k = 0; k < 9; k += 3) {
      const x = raw[o + k]!,
        y = raw[o + k + 1]!,
        z = raw[o + k + 2]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  if (!keep.length) throw new Error("网格中没有有效三角形（全部退化或为空）");
  const dropped = n - keep.length;
  if (dropped) warnings.push(`已丢弃 ${dropped} 个退化三角形`);
  if (keep.length > HEAVY_TRIANGLES)
    warnings.push(`三角面 ${keep.length.toLocaleString()} 个，切片与预览会明显变慢，建议先精简`);

  const cx0 = (minX + maxX) / 2,
    cy0 = (minY + maxY) / 2;
  const positions = new Float32Array(keep.length * 9);
  let signedVol = 0,
    area = 0,
    overhang = 0;
  for (let i = 0; i < keep.length; i++) {
    const o = keep[i]! * 9,
      w = i * 9;
    for (let k = 0; k < 9; k += 3) {
      positions[w + k] = raw[o + k]! - cx0;
      positions[w + k + 1] = raw[o + k + 1]! - cy0;
      positions[w + k + 2] = raw[o + k + 2]! - minZ;
    }
    const ax = positions[w]!,
      ay = positions[w + 1]!,
      az = positions[w + 2]!;
    const bx = positions[w + 3]!,
      by = positions[w + 4]!,
      bz = positions[w + 5]!;
    const qx = positions[w + 6]!,
      qy = positions[w + 7]!,
      qz = positions[w + 8]!;
    const ux = bx - ax,
      uy = by - ay,
      uz = bz - az;
    const vx = qx - ax,
      vy = qy - ay,
      vz = qz - az;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const twiceArea = Math.hypot(nx, ny, nz);
    area += twiceArea / 2;
    signedVol += (ax * (by * qz - bz * qy) + ay * (bz * qx - bx * qz) + az * (bx * qy - by * qx)) / 6;
    if (twiceArea > 0 && nz / twiceArea < OVERHANG_NZ && Math.min(az, bz, qz) > OVERHANG_MIN_Z)
      overhang += twiceArea / 2;
  }
  if (signedVol < 0) warnings.push("三角形法向整体朝内（有向体积为负），体积已按绝对值计算");
  const bounds: MeshBounds = {
    minX: minX - cx0,
    maxX: maxX - cx0,
    minY: minY - cy0,
    maxY: maxY - cy0,
    minZ: 0,
    maxZ: maxZ - minZ,
  };
  return {
    format,
    positions,
    triangleCount: keep.length,
    droppedTriangles: dropped,
    objectCount: extra.objectCount,
    bounds,
    sizeMm: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    volumeCm3: Math.abs(signedVol) / 1000,
    surfaceAreaCm2: area / 100,
    overhangAreaMm2: overhang,
    needSupport: overhang > OVERHANG_AREA_MM2,
    unit: extra.unit,
    warnings,
  };
}

/** 读取字节 → 归一化网格（Worker 与主线程兜底共用的唯一入口） */
export async function parseMeshBuffer(buffer: ArrayBuffer, fileName: string): Promise<MeshImportPayload> {
  if (buffer.byteLength > MAX_MESH_BYTES)
    throw new Error(`网格文件超过 ${Math.round(MAX_MESH_BYTES / 1024 / 1024)}MB，请先精简`);
  const bytes = new Uint8Array(buffer);
  const format = detectMeshFormat(fileName, bytes);
  if (!format) throw new Error("无法识别的网格格式：仅支持 STL（二进制 / ASCII）与 3MF");
  if (format === "3mf") {
    const r = await parse3mf(bytes);
    return analyzeTriangles(r.positions, "3mf", { objectCount: r.objectCount, unit: r.unit, warnings: r.warnings });
  }
  const raw = format === "stl-binary" ? parseStlBinary(bytes) : parseStlAscii(new TextDecoder("utf-8").decode(bytes));
  if (!raw.length) throw new Error("STL 中没有三角形");
  return analyzeTriangles(raw, format, { objectCount: 1, unit: null, warnings: [] });
}

/* ── 平面截交 → 闭合环（切片器输入） ─────── */

/** 端点量化到 1 µm 网格后配对；比它更粗会把细小特征焊死，更细会因浮点误差断链 */
const CHAIN_QUANT = 1000;

/** 三角网格与平面 z 的截交，链接为闭合折线（开链丢弃）。candidates 为可选的三角形下标子集。 */
export function meshCrossSection(positions: Float32Array, z: number, candidates?: ArrayLike<number>): Point2[][] {
  const segs: number[] = []; // x0,y0,x1,y1
  const n = candidates ? candidates.length : positions.length / 9;
  for (let i = 0; i < n; i++) {
    const t = candidates ? candidates[i]! : i;
    const o = t * 9;
    const z0 = positions[o + 2]!,
      z1 = positions[o + 5]!,
      z2 = positions[o + 8]!;
    // 半开规则：z >= 平面视为上方，顶点恰在平面上不会产生重复段
    const a0 = z0 >= z,
      a1 = z1 >= z,
      a2 = z2 >= z;
    if (a0 === a1 && a1 === a2) continue;
    const pts: number[] = [];
    const edge = (i0: number, i1: number) => {
      const za = positions[o + i0 * 3 + 2]!,
        zb = positions[o + i1 * 3 + 2]!;
      const t01 = (z - za) / (zb - za);
      pts.push(
        positions[o + i0 * 3]! + (positions[o + i1 * 3]! - positions[o + i0 * 3]!) * t01,
        positions[o + i0 * 3 + 1]! + (positions[o + i1 * 3 + 1]! - positions[o + i0 * 3 + 1]!) * t01
      );
    };
    if (a0 !== a1) edge(0, 1);
    if (a1 !== a2) edge(1, 2);
    if (a2 !== a0) edge(2, 0);
    if (pts.length === 4) segs.push(pts[0]!, pts[1]!, pts[2]!, pts[3]!);
  }
  return chainSegments(segs);
}

function chainSegments(segs: number[]): Point2[][] {
  const count = segs.length / 4;
  if (!count) return [];
  const key = (x: number, y: number) => `${Math.round(x * CHAIN_QUANT)},${Math.round(y * CHAIN_QUANT)}`;
  const byKey = new Map<string, number[]>();
  const push = (k: string, s: number) => {
    const list = byKey.get(k);
    if (list) list.push(s);
    else byKey.set(k, [s]);
  };
  for (let s = 0; s < count; s++) {
    push(key(segs[s * 4]!, segs[s * 4 + 1]!), s);
    push(key(segs[s * 4 + 2]!, segs[s * 4 + 3]!), s);
  }
  const used = new Uint8Array(count);
  const loops: Point2[][] = [];
  for (let s0 = 0; s0 < count; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const startKey = key(segs[s0 * 4]!, segs[s0 * 4 + 1]!);
    const pts: Point2[] = [{ x: segs[s0 * 4]!, y: segs[s0 * 4 + 1]! }];
    let cx = segs[s0 * 4 + 2]!,
      cy = segs[s0 * 4 + 3]!;
    let closed = false;
    for (let guard = 0; guard <= count; guard++) {
      const k = key(cx, cy);
      if (k === startKey) {
        closed = true;
        break;
      }
      pts.push({ x: cx, y: cy });
      const next = (byKey.get(k) || []).find((s) => !used[s]);
      if (next == null) break;
      used[next] = 1;
      const fromStart = key(segs[next * 4]!, segs[next * 4 + 1]!) === k;
      cx = fromStart ? segs[next * 4 + 2]! : segs[next * 4]!;
      cy = fromStart ? segs[next * 4 + 3]! : segs[next * 4 + 1]!;
    }
    if (closed && pts.length >= 3) loops.push(pts);
  }
  return loops;
}

/* ── 可切片模型 ───────────────────────────── */

export interface MeshModel extends BuiltModel {
  kind: "mesh";
  source: "mesh-import";
  mesh: MeshImportPayload;
  fileName: string;
}

/** Z 向分桶索引：outlinesAt 只扫描跨越该高度带的三角形（切片 O(层数 × 命中面) 而非 O(层数 × 全部面）） */
function buildZBuckets(positions: Float32Array, height: number): { bucketH: number; buckets: Uint32Array[] } {
  const n = positions.length / 9;
  const B = Math.max(8, Math.min(64, Math.round(height / 2)));
  const bucketH = height / B || 1;
  const counts = new Uint32Array(B);
  const span = (t: number): [number, number] => {
    const o = t * 9;
    const z0 = positions[o + 2]!,
      z1 = positions[o + 5]!,
      z2 = positions[o + 8]!;
    const lo = Math.max(0, Math.min(B - 1, Math.floor(Math.min(z0, z1, z2) / bucketH)));
    const hi = Math.max(0, Math.min(B - 1, Math.floor(Math.max(z0, z1, z2) / bucketH)));
    return [lo, hi];
  };
  for (let t = 0; t < n; t++) {
    const [lo, hi] = span(t);
    for (let b = lo; b <= hi; b++) counts[b]!++;
  }
  const buckets = Array.from(counts, (c) => new Uint32Array(c));
  const fill = new Uint32Array(B);
  for (let t = 0; t < n; t++) {
    const [lo, hi] = span(t);
    for (let b = lo; b <= hi; b++) buckets[b]![fill[b]!++] = t;
  }
  return { bucketH, buckets };
}

export function createMeshModel(payload: MeshImportPayload, meta: { readonly name: string }): MeshModel {
  const height = payload.sizeMm.z;
  const { bucketH, buckets } = buildZBuckets(payload.positions, height);
  const fmt = (v: number) => v.toFixed(1);
  return {
    id: "mesh-import",
    kind: "mesh",
    source: "mesh-import",
    name: meta.name.replace(/\.[^.]+$/, "") || "导入网格",
    fileName: meta.name,
    dims: `${fmt(payload.sizeMm.x)} × ${fmt(payload.sizeMm.y)} × ${fmt(payload.sizeMm.z)} mm`,
    height,
    needSupport: payload.needSupport,
    footprintR: Math.max(
      Math.abs(payload.bounds.minX),
      Math.abs(payload.bounds.maxX),
      Math.abs(payload.bounds.minY),
      Math.abs(payload.bounds.maxY)
    ),
    mesh: payload,
    outlinesAt(zLocal: number): { loops: Loop[] } {
      const b = Math.max(0, Math.min(buckets.length - 1, Math.floor(zLocal / bucketH)));
      return { loops: contourLoops(meshCrossSection(payload.positions, zLocal, buckets[b]!)) };
    },
  };
}
