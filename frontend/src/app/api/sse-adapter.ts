import type { RuntimeMode } from "../runtime/runtime-mode";

export interface SseAdapterError {
  readonly code: "OFFLINE_UNAVAILABLE" | "INVALID_EVENT" | "STREAM_ERROR";
  readonly message: string;
  readonly retryable: boolean;
}

export interface SseHandlers<T> {
  readonly onMessage: (value: T) => void;
  readonly onError: (error: SseAdapterError) => void;
  readonly signal?: AbortSignal;
}

export interface SseSubscription {
  close(): void;
}

export interface SseAdapter {
  subscribe<T>(path: `/${string}`, handlers: SseHandlers<T>): SseSubscription;
}

class BrowserSseAdapter implements SseAdapter {
  public constructor(private readonly base: string) {}

  public subscribe<T>(path: `/${string}`, handlers: SseHandlers<T>): SseSubscription {
    const source = new EventSource(this.base + path, { withCredentials: true });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      source.close();
      handlers.signal?.removeEventListener("abort", close);
    };
    source.onmessage = (event) => {
      if (closed) return;
      try {
        handlers.onMessage(JSON.parse(event.data) as T);
      } catch {
        handlers.onError({ code: "INVALID_EVENT", message: "SSE 事件不是有效 JSON", retryable: false });
      }
    };
    source.onerror = () => {
      if (!closed) handlers.onError({ code: "STREAM_ERROR", message: "SSE 连接中断", retryable: true });
    };
    if (handlers.signal?.aborted) close();
    else handlers.signal?.addEventListener("abort", close, { once: true });
    return { close };
  }
}

class OfflineSseAdapter implements SseAdapter {
  public subscribe<T>(_path: `/${string}`, handlers: SseHandlers<T>): SseSubscription {
    let closed = false;
    queueMicrotask(() => {
      if (!closed) {
        handlers.onError({
          code: "OFFLINE_UNAVAILABLE",
          message: "离线预览不连接服务端事件流",
          retryable: false,
        });
      }
    });
    return {
      close: () => {
        closed = true;
      },
    };
  }
}

export function createSseAdapter(mode: RuntimeMode): SseAdapter {
  return mode.kind === "remote" ? new BrowserSseAdapter(mode.apiBase) : new OfflineSseAdapter();
}
