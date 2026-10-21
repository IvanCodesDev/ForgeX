import { useEffect, useState } from "react";
import type { AuthorityAnalysisResponse } from "../../authority/gcode-authority";
import {
  deleteReplayBookmark,
  listReplayBookmarks,
  saveReplayBookmark,
  REPLAY_BOOKMARK_KEY,
  type ReplayBookmark,
} from "../../authority/replay-bookmarks";

export function ReplayBookmarks({
  source,
  elapsedSeconds,
  busy,
  onRestore,
}: {
  readonly source: AuthorityAnalysisResponse;
  readonly elapsedSeconds: number | null;
  readonly busy: boolean;
  readonly onRestore: (seconds: number) => void;
}) {
  const [items, setItems] = useState<ReplayBookmark[]>([]),
    [name, setName] = useState("");
  const [notice, setNotice] = useState("");
  const refresh = () => {
    try {
      setItems(listReplayBookmarks(localStorage, source));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "浏览器书签不可用");
    }
  };
  useEffect(() => {
    const update = () => {
      try {
        setItems(listReplayBookmarks(localStorage, source));
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "浏览器书签不可用");
      }
    };
    update();
    const storage = (event: StorageEvent) => {
      if (event.key === REPLAY_BOOKMARK_KEY || event.key === null) update();
    };
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, [source]);
  const change = (action: () => void) => {
    try {
      action();
      refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "浏览器存储不可用");
    }
  };
  return (
    <details id="replay-bookmarks" data-bookmark-count={items.length}>
      <summary>浏览器回放书签（{items.length}）</summary>
      <div className="note">
        只在此浏览器保存名称和定位时间。相同原件、Profile 与引擎可恢复；恢复时重新向 C# 核验，不把书签当作服务端检查点。
      </div>
      <label>
        <span>书签名称</span>
        <input
          aria-label="回放书签名称"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button
        className="btn"
        disabled={busy || elapsedSeconds === null || !name.trim()}
        onClick={() =>
          change(() => {
            saveReplayBookmark(localStorage, source, name, elapsedSeconds!);
            setName("");
            setNotice("已保存在此浏览器");
          })
        }
      >
        保存已核验时间为书签
      </button>
      {notice && (
        <div className="note" role="status">
          {notice}
        </div>
      )}
      {items.map((item) => (
        <div className="replay-row" key={item.id} data-bookmark-id={item.id}>
          <span>
            {item.label} · {item.elapsedSeconds.toFixed(3)} 秒
          </span>
          <button className="btn" disabled={busy} onClick={() => onRestore(item.elapsedSeconds)}>
            恢复并核验：{item.label}
          </button>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              change(() => {
                deleteReplayBookmark(localStorage, source, item.id);
                setNotice("书签已删除");
              })
            }
          >
            删除书签：{item.label}
          </button>
        </div>
      ))}
    </details>
  );
}
