import { describe, expect, it, vi } from "vitest";
import type { AuthorityAnalysisResponse } from "./gcode-authority";
import { deleteReplayBookmark, listReplayBookmarks, REPLAY_BOOKMARK_KEY, saveReplayBookmark } from "./replay-bookmarks";
const source = {
  input: { sha256: "a".repeat(64) },
  profile: { fingerprint: "b".repeat(64) },
  engine: { version: "1.6.0" },
  summary: { totalLayers: 1, estimatedTimeSeconds: 12 },
  layers: [{ index: 0, sourceOrder: 0, timeSeconds: 10, filamentLengthMm: 1 }],
} as unknown as AuthorityAnalysisResponse;
function store() {
  let raw: string | null = null;
  return {
    getItem: vi.fn((_key: string) => raw),
    setItem: vi.fn((_key: string, value: string) => {
      raw = value;
    }),
  };
}
describe("local replay bookmark intents", () => {
  it("persists a normalized name and time without storing a trusted checkpoint", () => {
    const storage = store(),
      item = saveReplayBookmark(storage, source, " 首层结束 ", 12);
    expect(item.label).toBe("首层结束");
    expect(listReplayBookmarks(storage, source)).toEqual([item]);
    const data = JSON.parse(storage.getItem(REPLAY_BOOKMARK_KEY)!);
    expect(data.items[0].checkpoint).toBeUndefined();
    expect(data.items[0].fingerprint).toBeUndefined();
    expect(data.items[0].source.sha256).toBe(source.input.sha256);
  });
  it("reuses an intent after the same source is analyzed as a different job", () => {
    const storage = store();
    saveReplayBookmark(storage, source, "观察点", 5);
    expect(listReplayBookmarks(storage, structuredClone(source))).toHaveLength(1);
  });
  it.each(["sha", "profile", "engine", "duration", "layers"])("isolates changed %s evidence", (field) => {
    const storage = store();
    saveReplayBookmark(storage, source, "观察点", 5);
    const other = structuredClone(source);
    if (field === "sha") Object.assign(other.input, { sha256: "c".repeat(64) });
    if (field === "profile") Object.assign(other.profile, { fingerprint: "c".repeat(64) });
    if (field === "engine") Object.assign(other.engine, { version: "next" });
    if (field === "duration") Object.assign(other.summary, { estimatedTimeSeconds: 13 });
    if (field === "layers") {
      Object.assign(other.summary, { totalLayers: 2 });
      Object.assign(other, {
        layers: [other.layers[0], { ...other.layers[0], index: 1, sourceOrder: 1, timeSeconds: 0 }],
      });
    }
    expect(listReplayBookmarks(storage, other)).toHaveLength(0);
  });
  it.each(["", "  ", "x".repeat(81), "line\nbreak"])("rejects unusable label %s", (name) => {
    expect(() => saveReplayBookmark(store(), source, name, 2)).toThrow();
  });
  it.each([-1, NaN, Infinity, 13])("rejects invalid time %s", (seconds) => {
    expect(() => saveReplayBookmark(store(), source, "点位", seconds)).toThrow();
  });
  it("only deletes a bookmark belonging to the selected source", () => {
    const storage = store(),
      item = saveReplayBookmark(storage, source, "保留", 1),
      other = { ...source, input: { ...source.input, sha256: "c".repeat(64) } };
    deleteReplayBookmark(storage, other, item.id);
    expect(listReplayBookmarks(storage, source)).toHaveLength(1);
    deleteReplayBookmark(storage, source, item.id);
    expect(listReplayBookmarks(storage, source)).toHaveLength(0);
  });
  it("limits each source to 20 and leaves existing entries untouched", () => {
    const storage = store();
    for (let i = 0; i < 20; i++) saveReplayBookmark(storage, source, `点位${i}`, i / 2);
    const before = storage.getItem(REPLAY_BOOKMARK_KEY);
    expect(() => saveReplayBookmark(storage, source, "超限", 1)).toThrow("20");
    expect(storage.getItem(REPLAY_BOOKMARK_KEY)).toBe(before);
  });
  it("does not overwrite malformed or oversized storage", () => {
    for (const raw of ["{bad", "null", '{"version":2,"items":[]}', "x".repeat(65537)]) {
      const storage = store();
      storage.setItem(REPLAY_BOOKMARK_KEY, raw);
      expect(() => saveReplayBookmark(storage, source, "点位", 1)).toThrow();
      expect(storage.getItem(REPLAY_BOOKMARK_KEY)).toBe(raw);
    }
  });
  it("rejects forged stored fields and duplicate ids before writing", () => {
    const storage = store();
    saveReplayBookmark(storage, source, "点位", 1);
    const original = storage.getItem(REPLAY_BOOKMARK_KEY)!;
    for (const mutate of [
      (v: Record<string, unknown>) => {
        v.elapsedSeconds = "1";
      },
      (v: Record<string, unknown>) => {
        v.createdAt = "yesterday";
      },
      (v: Record<string, unknown>) => {
        v.source = {};
      },
    ]) {
      const data = JSON.parse(original);
      mutate(data.items[0]);
      const raw = JSON.stringify(data);
      storage.setItem(REPLAY_BOOKMARK_KEY, raw);
      expect(() => saveReplayBookmark(storage, source, "另一个", 1)).toThrow();
      expect(storage.getItem(REPLAY_BOOKMARK_KEY)).toBe(raw);
    }
    const data = JSON.parse(original);
    data.items.push(data.items[0]);
    storage.setItem(REPLAY_BOOKMARK_KEY, JSON.stringify(data));
    expect(() => listReplayBookmarks(storage, source)).toThrow();
  });
  it("propagates quota failures without reporting a successful save", () => {
    const storage = store();
    storage.setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveReplayBookmark(storage, source, "点位", 1)).toThrow("quota");
    expect(listReplayBookmarks(storage, source)).toEqual([]);
  });
});
