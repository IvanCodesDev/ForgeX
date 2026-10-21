import type { AuthorityAnalysisResponse } from "./gcode-authority";
import { deriveLayerPlan } from "./gcode-replay";

export const REPLAY_BOOKMARK_KEY = "forgex.replay-bookmarks.v1";
export interface ReplayBookmark {
  readonly id: string;
  readonly label: string;
  readonly elapsedSeconds: number;
  readonly createdAt: string;
  readonly source: {
    readonly sha256: string;
    readonly profileFingerprint: string;
    readonly engineVersion: string;
    readonly durationSeconds: number;
    readonly totalLayers: number;
  };
}
type Store = Pick<Storage, "getItem" | "setItem">;
const hash = /^[a-f0-9]{64}$/;
const sourceOf = (source: AuthorityAnalysisResponse): ReplayBookmark["source"] => ({
  sha256: source.input.sha256,
  profileFingerprint: source.profile.fingerprint,
  engineVersion: source.engine.version,
  durationSeconds: source.summary.estimatedTimeSeconds,
  totalLayers: source.summary.totalLayers,
});
function same(left: ReplayBookmark["source"], right: ReplayBookmark["source"]) {
  return Object.keys(left).every((key) => left[key as keyof typeof left] === right[key as keyof typeof right]);
}
function label(value: string) {
  const text = value.trim();
  if (!text || text.length > 80 || [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    throw new Error("书签名称须为 1–80 字，不能含控制字符");
  return text;
}
function read(store: Store): ReplayBookmark[] {
  const raw = store.getItem(REPLAY_BOOKMARK_KEY);
  if (raw === null) return [];
  if (new TextEncoder().encode(raw).byteLength > 65536) throw new Error("书签存储超出 64 KiB，未覆盖原数据");
  let root: { version?: unknown; items?: unknown };
  try {
    root = JSON.parse(raw) as typeof root;
  } catch {
    throw new Error("本地书签 JSON 无效，未覆盖原数据");
  }
  if (!root || root.version !== 1 || !Array.isArray(root.items) || root.items.length > 100)
    throw new Error("本地书签格式无效，未覆盖原数据");
  const ids = new Set<string>();
  return root.items.map((value: ReplayBookmark) => {
    if (
      !value ||
      typeof value.id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.id) ||
      ids.has(value.id) ||
      typeof value.label !== "string" ||
      label(value.label) !== value.label ||
      !Number.isFinite(value.elapsedSeconds) ||
      value.elapsedSeconds < 0 ||
      value.elapsedSeconds > 31536001 ||
      typeof value.createdAt !== "string" ||
      value.createdAt.length !== 24 ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      new Date(value.createdAt).toISOString() !== value.createdAt ||
      !value.source ||
      !hash.test(value.source.sha256) ||
      !hash.test(value.source.profileFingerprint) ||
      typeof value.source.engineVersion !== "string" ||
      !/^[!-~]{1,100}$/.test(value.source.engineVersion) ||
      !Number.isFinite(value.source.durationSeconds) ||
      value.source.durationSeconds < 0 ||
      value.source.durationSeconds > 31536000 ||
      !Number.isInteger(value.source.totalLayers) ||
      value.source.totalLayers < 1 ||
      value.source.totalLayers > 100000
    )
      throw new Error("本地书签字段无效，未覆盖原数据");
    ids.add(value.id);
    // Only persist the supported intent fields; a stored object is never a trusted C# checkpoint.
    return {
      id: value.id,
      label: value.label,
      elapsedSeconds: value.elapsedSeconds,
      createdAt: value.createdAt,
      source: {
        sha256: value.source.sha256,
        profileFingerprint: value.source.profileFingerprint,
        engineVersion: value.source.engineVersion,
        durationSeconds: value.source.durationSeconds,
        totalLayers: value.source.totalLayers,
      },
    };
  });
}
function write(store: Store, items: ReplayBookmark[]) {
  const raw = JSON.stringify({ version: 1, items });
  if (new TextEncoder().encode(raw).byteLength > 65536) throw new Error("书签存储已满，请先删除不需要的书签");
  store.setItem(REPLAY_BOOKMARK_KEY, raw);
}
export function listReplayBookmarks(store: Store, source: AuthorityAnalysisResponse) {
  const basis = sourceOf(source),
    max = deriveLayerPlan(source).total;
  return read(store).filter((item) => same(item.source, basis) && item.elapsedSeconds <= max);
}
export function saveReplayBookmark(
  store: Store,
  source: AuthorityAnalysisResponse,
  name: string,
  elapsedSeconds: number
) {
  const title = label(name),
    basis = sourceOf(source),
    max = deriveLayerPlan(source).total;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > max)
    throw new Error("书签时间超出当前层计划");
  const items = read(store);
  if (items.length >= 100 || items.filter((item) => same(item.source, basis)).length >= 20)
    throw new Error("每份来源最多 20 个书签，本浏览器最多 100 个");
  const item = {
    id: crypto.randomUUID(),
    label: title,
    elapsedSeconds,
    createdAt: new Date().toISOString(),
    source: basis,
  };
  write(store, [...items, item]);
  return item;
}
export function deleteReplayBookmark(store: Store, source: AuthorityAnalysisResponse, id: string) {
  const basis = sourceOf(source);
  write(
    store,
    read(store).filter((item) => !(item.id === id && same(item.source, basis)))
  );
}
