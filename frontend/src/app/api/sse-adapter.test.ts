import { describe, expect, it, vi } from "vitest";
import { createSseAdapter } from "./sse-adapter";

class FakeEventSource {
  public static instances: FakeEventSource[] = [];
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: (() => void) | null = null;
  public readonly close = vi.fn();

  public constructor(
    public readonly url: string,
    public readonly options?: EventSourceInit
  ) {
    FakeEventSource.instances.push(this);
  }
}

describe("SseAdapter", () => {
  it("does not start a network stream in offline mode", async () => {
    const onError = vi.fn();
    const adapter = createSseAdapter({ kind: "offline", apiBase: null, reason: "file-protocol" });
    const subscription = adapter.subscribe("/api/tasks/a/events", { onMessage: vi.fn(), onError });

    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "OFFLINE_UNAVAILABLE", retryable: false }));
    subscription.close();
  });

  it("uses credentials, parses JSON events and closes on abort", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const controller = new AbortController();
    const onMessage = vi.fn();
    const adapter = createSseAdapter({ kind: "remote", apiBase: "https://api.example.test", reason: "configured-api" });
    adapter.subscribe("/api/tasks/a/events", { onMessage, onError: vi.fn(), signal: controller.signal });
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error("Fake EventSource was not created");

    expect(source.url).toBe("https://api.example.test/api/tasks/a/events");
    expect(source.options).toEqual({ withCredentials: true });
    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ seq: 1 }) }));
    expect(onMessage).toHaveBeenCalledWith({ seq: 1 });
    controller.abort();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("reports malformed event payloads with a stable code", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const onError = vi.fn();
    const adapter = createSseAdapter({ kind: "remote", apiBase: "", reason: "same-origin" });
    adapter.subscribe("/api/tasks/a/events", { onMessage: vi.fn(), onError });
    const source = FakeEventSource.instances[0];
    if (!source) throw new Error("Fake EventSource was not created");

    source.onmessage?.(new MessageEvent("message", { data: "not-json" }));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "INVALID_EVENT", retryable: false }));
  });
});
