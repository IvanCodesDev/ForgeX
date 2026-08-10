import { describe, expect, it } from "vitest";
import { detectRuntimeMode } from "./runtime-mode";

function env(apiBase?: string): ImportMetaEnv {
  return {
    BASE_URL: "/",
    MODE: "test",
    DEV: false,
    PROD: false,
    SSR: false,
    ...(apiBase === undefined ? {} : { VITE_API_BASE: apiBase }),
  };
}

describe("detectRuntimeMode", () => {
  it("honors explicit forced-offline mode first", () => {
    expect(detectRuntimeMode({ protocol: "https:" }, env("offline"))).toEqual({
      kind: "offline",
      apiBase: null,
      reason: "forced-offline",
    });
  });

  it("keeps file protocol offline even when an API base is configured", () => {
    expect(detectRuntimeMode({ protocol: "file:" }, env("https://api.example.test/"))).toEqual({
      kind: "offline",
      apiBase: null,
      reason: "file-protocol",
    });
  });

  it("uses and normalizes an explicit API base for hosted pages", () => {
    expect(detectRuntimeMode({ protocol: "https:" }, env(" https://api.example.test/// "))).toEqual({
      kind: "remote",
      apiBase: "https://api.example.test",
      reason: "configured-api",
    });
  });

  it("defaults hosted pages to same-origin API access", () => {
    expect(detectRuntimeMode({ protocol: "http:" }, env())).toEqual({
      kind: "remote",
      apiBase: "",
      reason: "same-origin",
    });
  });
});
