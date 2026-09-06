import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDeveloperSurfaceInstance, readInstanceRuntime } from "./daemon-env.ts";
import { startDuckdbUi } from "./developer-client.ts";
import { openUrlInBrowser } from "./open-url.ts";
import { duckdbUiBrowserUrl } from "./service-urls.ts";

vi.mock("./daemon-env.ts", () => ({
  readInstanceRuntime: vi.fn(() => "deno"),
  isDeveloperSurfaceInstance: vi.fn(() => true),
}));

vi.mock("./developer-client.ts", () => ({
  startDuckdbUi: vi.fn(async () => ({ ok: true, port: 4213 })),
}));

vi.mock("./open-url.ts", () => ({
  openUrlInBrowser: vi.fn(() => true),
}));

vi.mock("./service-urls.ts", () => ({
  duckdbUiBrowserUrl: vi.fn(() => "http://127.0.0.1:4213"),
}));

import { openDuckDbUi } from "./duckdb-ui.ts";

const mockedRuntime = vi.mocked(readInstanceRuntime);
const mockedDeveloperSurface = vi.mocked(isDeveloperSurfaceInstance);
const mockedStartDuckdbUi = vi.mocked(startDuckdbUi);
const mockedOpenUrl = vi.mocked(openUrlInBrowser);
const mockedDuckdbUrl = vi.mocked(duckdbUiBrowserUrl);

beforeEach(() => {
  mockedRuntime.mockReset();
  mockedDeveloperSurface.mockReset();
  mockedStartDuckdbUi.mockReset();
  mockedOpenUrl.mockReset();
  mockedDuckdbUrl.mockReset();
  mockedRuntime.mockReturnValue("deno");
  mockedDeveloperSurface.mockReturnValue(true);
  mockedStartDuckdbUi.mockResolvedValue({ ok: true, port: 4213 });
  mockedOpenUrl.mockReturnValue(true);
  mockedDuckdbUrl.mockReturnValue("http://127.0.0.1:4213");
});

describe("openDuckDbUi", () => {
  it("rejects Workers runtime before calling the developer API", async () => {
    mockedRuntime.mockReturnValue("workers");
    await expect(openDuckDbUi()).rejects.toThrow(/Workers/);
    expect(mockedStartDuckdbUi).not.toHaveBeenCalled();
  });

  it("rejects compiled and static instance builds", async () => {
    mockedDeveloperSurface.mockReturnValue(false);
    await expect(openDuckDbUi()).rejects.toThrow(/developer-surface/);
    expect(mockedStartDuckdbUi).not.toHaveBeenCalled();
  });

  it("throws the API error when startDuckdbUi fails", async () => {
    mockedStartDuckdbUi.mockResolvedValue({
      ok: false,
      error: "metrics store is closed",
    });
    await expect(openDuckDbUi()).rejects.toThrow("metrics store is closed");
  });

  it("throws a default message when the API omits error text", async () => {
    mockedStartDuckdbUi.mockResolvedValue({ ok: false });
    await expect(openDuckDbUi()).rejects.toThrow("Failed to start the DuckDB UI");
  });

  it("starts the UI, reports the URL, and opens the browser", async () => {
    const output: string[] = [];
    await openDuckDbUi((line) => output.push(line));
    expect(mockedStartDuckdbUi).toHaveBeenCalledOnce();
    expect(mockedOpenUrl).toHaveBeenCalledWith("http://127.0.0.1:4213");
    expect(output).toEqual([
      "Starting embedded DuckDB UI via the instance developer API…",
      "DuckDB UI ready at http://127.0.0.1:4213",
    ]);
  });

  it("prints a fallback when the browser opener fails", async () => {
    mockedOpenUrl.mockReturnValue(false);
    const output: string[] = [];
    await openDuckDbUi((line) => output.push(line));
    expect(output.at(-1)).toBe("Open http://127.0.0.1:4213 in your browser");
  });

  it("succeeds without an output handler", async () => {
    await expect(openDuckDbUi()).resolves.toBeUndefined();
    expect(mockedOpenUrl).toHaveBeenCalledWith("http://127.0.0.1:4213");
  });
});
