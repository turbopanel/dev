import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalConsoleAuthHeader,
  buildLocalConsoleCanonicalPayload,
  hashLocalConsoleContent,
  instanceSecretReadError,
  parseInstanceKeyringCurrentSecret,
  readInstanceSecret,
} from "./developer-client.ts";
import { instanceSecretsPath } from "./paths.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    request: vi.fn(),
  };
});

const SECRET = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6";
const CURRENT_SECRET = "currentKeyringSecretValue_should_be_used";

const mockedReadFileSync = vi.mocked(readFileSync);
/**
 * `http.request` is overloaded; `vi.mocked` resolves to the `(url, options, cb)`
 * form, so pin the `(options, cb)` shape the client under test actually calls.
 */
const mockedHttpRequest = vi.mocked(
  httpRequest as (
    options: RequestOptions,
    callback?: (res: IncomingMessage) => void,
  ) => ClientRequest,
);

function mockSocketHttpResponse(status: number | undefined, body: string): void {
  mockedHttpRequest.mockImplementation((_options, callback) => {
    const req = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.write = vi.fn();
    req.destroy = vi.fn((err?: Error) => {
      if (err) {
        req.emit("error", err);
      }
    });
    req.end = vi.fn(() => {
      const res = new EventEmitter() as EventEmitter & { statusCode?: number };
      if (status !== undefined) {
        res.statusCode = status;
      }
      queueMicrotask(() => {
        if (typeof callback === "function") {
          callback(res as IncomingMessage);
        }
        if (body.length > 0) {
          res.emit("data", Buffer.from(body));
        }
        res.emit("end");
      });
    });
    return req as unknown as ReturnType<typeof httpRequest>;
  });
}

function mockSocketHttpError(error: unknown): void {
  mockedHttpRequest.mockImplementation(() => {
    const req = new EventEmitter() as EventEmitter & {
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
    };
    req.write = vi.fn();
    req.destroy = vi.fn();
    req.end = vi.fn(() => {
      req.emit("error", error);
    });
    return req as unknown as ReturnType<typeof httpRequest>;
  });
}

function fsError(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

type MockFsValue = string | NodeJS.ErrnoException;

function mockFsMap(entries: ReadonlyArray<readonly [string, MockFsValue]>): void {
  const map = new Map<string, MockFsValue>(entries);
  mockedReadFileSync.mockImplementation((path, ..._args) => {
    const key = String(path);
    const entry = map.get(key);
    if (entry === undefined) {
      throw fsError("ENOENT");
    }
    if (typeof entry !== "string") {
      throw entry;
    }
    return entry;
  });
}

describe("Local-Console canonical payload (dev console)", () => {
  it("includes method, request target with query, and content digest", () => {
    const body = '{"x":1}';
    const digest = hashLocalConsoleContent(body);
    const timestamp = "2026-08-05T18:00:00.000Z";
    const payload = buildLocalConsoleCanonicalPayload(
      timestamp,
      "post",
      "/api/developer/v1/daemon/sync-dev?force=1",
      digest,
    );
    expect(payload.split("\0")).toEqual([
      "local-console-v1",
      timestamp,
      "POST",
      "/api/developer/v1/daemon/sync-dev?force=1",
      digest,
    ]);
  });

  it("buildLocalConsoleAuthHeader signs the canonical payload", () => {
    const body = "{}";
    const timestamp = "2026-08-05T18:00:00.000Z";
    const target = "/api/developer/v1/daemon/sync-dev";
    const { authorization, contentSha256 } = buildLocalConsoleAuthHeader(
      "POST",
      target,
      SECRET,
      body,
      timestamp,
    );
    expect(contentSha256).toBe(hashLocalConsoleContent(body));
    const expectedPayload = buildLocalConsoleCanonicalPayload(
      timestamp,
      "POST",
      target,
      contentSha256,
    );
    const expectedSig = createHmac("sha256", SECRET)
      .update(expectedPayload)
      .digest("base64url");
    const timestampPart = Buffer.from(timestamp, "utf8").toString("base64url");
    expect(authorization).toBe(`Local-Console ${timestampPart}.${expectedSig}`);
  });
});

describe("parseInstanceKeyringCurrentSecret", () => {
  it("returns the first entry value on a multi-entry line", () => {
    const value = parseInstanceKeyringCurrentSecret(
      "2:currentSecretValue,1:legacySecretValue",
    );
    if (value === undefined) {
      throw new TypeError("expected current secret from multi-entry keyring");
    }
    expect(value).toBe("currentSecretValue");
  });

  it("trims surrounding whitespace and newlines", () => {
    const value = parseInstanceKeyringCurrentSecret(
      "\n  2:trimmedSecret  \n",
    );
    if (value === undefined) {
      throw new TypeError("expected current secret after trim");
    }
    expect(value).toBe("trimmedSecret");
  });

  it("accepts gapped version numbers", () => {
    const value = parseInstanceKeyringCurrentSecret(
      "3:newestFirst,1:oldestStillListed",
    );
    if (value === undefined) {
      throw new TypeError("expected current secret from gapped versions");
    }
    expect(value).toBe("newestFirst");
  });

  it("returns undefined for missing colon, non-numeric version, empty value, or empty file", () => {
    expect(parseInstanceKeyringCurrentSecret("noseparator")).toBeUndefined();
    expect(parseInstanceKeyringCurrentSecret("v2:value")).toBeUndefined();
    expect(parseInstanceKeyringCurrentSecret("2:")).toBeUndefined();
    expect(parseInstanceKeyringCurrentSecret("")).toBeUndefined();
    expect(parseInstanceKeyringCurrentSecret("   \n")).toBeUndefined();
  });
});

describe("readInstanceSecret / instanceSecretReadError", () => {
  beforeEach(() => {
    mockedReadFileSync.mockReset();
  });

  it("returns the keyring current secret when the keyring is readable", () => {
    mockFsMap([
      [instanceSecretsPath(), `2:${CURRENT_SECRET},1:${SECRET}`],
    ]);
    expect(readInstanceSecret()).toBe(CURRENT_SECRET);
  });

  it("returns undefined when the keyring is absent (ENOENT)", () => {
    mockFsMap([]);
    expect(readInstanceSecret()).toBeUndefined();
    const err = instanceSecretReadError();
    expect(err.message).toContain("missing instance secrets keyring");
    expect(err.message).toContain(instanceSecretsPath());
  });

  it("returns undefined when the keyring is present but malformed", () => {
    mockFsMap([[instanceSecretsPath(), "not-a-valid-keyring"]]);
    expect(readInstanceSecret()).toBeUndefined();
    const err = instanceSecretReadError();
    expect(err.message).toContain("unreadable or unparseable instance secrets keyring");
    expect(err.message).toContain(instanceSecretsPath());
  });

  it("returns undefined when the keyring is unreadable (EACCES)", () => {
    mockFsMap([[instanceSecretsPath(), fsError("EACCES")]]);
    expect(readInstanceSecret()).toBeUndefined();
    const err = instanceSecretReadError();
    expect(err.message).toContain("cannot read instance secrets keyring");
    expect(err.message).toContain("permission denied");
    expect(err.message).toContain(instanceSecretsPath());
  });

  it("returns undefined on non-ENOENT keyring errors other than EACCES", () => {
    mockFsMap([[instanceSecretsPath(), fsError("EIO")]]);
    expect(readInstanceSecret()).toBeUndefined();
    const err = instanceSecretReadError();
    expect(err.message).toContain("unreadable or unparseable instance secrets keyring");
    expect(err.message).toContain(instanceSecretsPath());
  });

  it("instanceSecretReadError treats a throw without errno as unreadable", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("disk melted");
    });
    const err = instanceSecretReadError();
    expect(err.message).toContain("unreadable or unparseable instance secrets keyring");
  });

  it("instanceSecretReadError names the console user when USER is unset", () => {
    const prev = process.env.USER;
    delete process.env.USER;
    try {
      mockFsMap([[instanceSecretsPath(), fsError("EACCES")]]);
      const err = instanceSecretReadError();
      expect(err.message).toContain("root:dev-user");
    } finally {
      if (prev === undefined) {
        delete process.env.USER;
      } else {
        process.env.USER = prev;
      }
    }
  });

  it("instanceSecretReadError covers readable-but-parseable contradiction path", () => {
    mockFsMap([[instanceSecretsPath(), `2:${CURRENT_SECRET}`]]);
    // readInstanceSecret succeeds, so the final fallback branch is exercised
    // when callers invoke the diagnostic after a race emptied the keyring.
    const err = instanceSecretReadError();
    expect(err.message).toContain("missing instance secrets keyring");
  });
});

describe("developerFetch sync helpers", () => {
  beforeEach(() => {
    mockedReadFileSync.mockReset();
    mockedHttpRequest.mockReset();
    vi.resetModules();
  });

  it("rejects Workers runtime before opening the socket", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "workers",
    }));
    mockFsMap([[instanceSecretsPath(), `1:${CURRENT_SECRET}`]]);
    const { syncDevToAllDaemons } = await import("./developer-client.ts");
    await expect(syncDevToAllDaemons()).rejects.toThrow(/Workers/);
    expect(mockedHttpRequest).not.toHaveBeenCalled();
  });

  it("rejects when the instance secrets keyring is missing", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    mockFsMap([]);
    const { syncDevToDaemon } = await import("./developer-client.ts");
    await expect(syncDevToDaemon("abc")).rejects.toThrow(
      /missing instance secrets keyring/,
    );
    expect(mockedHttpRequest).not.toHaveBeenCalled();
  });

  it("POSTs sync-dev over the mocked Unix socket", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    mockFsMap([[instanceSecretsPath(), `1:${CURRENT_SECRET}`]]);
    mockSocketHttpResponse(
      200,
      JSON.stringify({ ok: true, results: [{ daemonId: "d1", ok: true }] }),
    );
    const { syncDevToAllDaemons } = await import("./developer-client.ts");
    await expect(syncDevToAllDaemons()).resolves.toEqual({
      ok: true,
      results: [{ daemonId: "d1", ok: true }],
    });
    expect(mockedHttpRequest).toHaveBeenCalledOnce();
    const options = mockedHttpRequest.mock.calls[0]?.[0];
    if (options === undefined || typeof options !== "object") {
      throw new TypeError("expected http.request options object");
    }
    expect(options).toMatchObject({
      socketPath: "/run/turbopanel/instance.sock",
      path: "/api/developer/v1/daemon/sync-dev",
      method: "POST",
    });
    const headers = "headers" in options ? options.headers : undefined;
    if (headers === undefined || typeof headers !== "object") {
      throw new TypeError("expected Local-Console request headers");
    }
    expect(headers).toMatchObject({
      authorization: expect.stringMatching(/^Local-Console /),
    });
  });

  it("POSTs per-daemon sync-dev and channel update with a JSON body", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    mockFsMap([[instanceSecretsPath(), `1:${CURRENT_SECRET}`]]);
    mockSocketHttpResponse(200, JSON.stringify({ ok: true, daemonId: "abc" }));
    const { syncDevToDaemon, updateConnectedDaemons } = await import(
      "./developer-client.ts"
    );
    await expect(syncDevToDaemon("abc/def")).resolves.toEqual({
      ok: true,
      daemonId: "abc",
    });
    const syncOpts = mockedHttpRequest.mock.calls[0]?.[0];
    if (syncOpts === undefined || typeof syncOpts !== "object") {
      throw new TypeError("expected per-daemon http.request options");
    }
    expect(syncOpts).toMatchObject({
      path: "/api/developer/v1/daemon/abc%2Fdef/sync-dev",
      method: "POST",
    });

    mockSocketHttpResponse(200, JSON.stringify({ ok: true, results: [] }));
    await expect(updateConnectedDaemons()).resolves.toEqual({
      ok: true,
      results: [],
    });
    const updateCall = mockedHttpRequest.mock.calls[1];
    if (updateCall === undefined) {
      throw new TypeError("expected daemon update http.request call");
    }
    const updateOpts = updateCall[0];
    if (updateOpts === undefined || typeof updateOpts !== "object") {
      throw new TypeError("expected daemon update http.request options");
    }
    expect(updateOpts).toMatchObject({
      path: "/api/developer/v1/daemon/update",
      method: "POST",
    });
    const req = mockedHttpRequest.mock.results[1]?.value as {
      write?: ReturnType<typeof vi.fn>;
    };
    expect(req.write).toHaveBeenCalledWith(JSON.stringify({ channel: "trunk" }));
  });

  it("surfaces JSON error bodies from non-2xx socket responses", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    mockFsMap([[instanceSecretsPath(), `1:${CURRENT_SECRET}`]]);
    mockSocketHttpResponse(401, JSON.stringify({ error: "unauthorized" }));
    const { syncDevToAllDaemons } = await import("./developer-client.ts");
    await expect(syncDevToAllDaemons()).rejects.toThrow(
      "/api/developer/v1/daemon/sync-dev failed: unauthorized",
    );
  });

  it("keeps the HTTP status when the error body is not JSON", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    mockFsMap([[instanceSecretsPath(), `1:${CURRENT_SECRET}`]]);
    mockSocketHttpResponse(502, "bad gateway");
    const { updateConnectedDaemons } = await import("./developer-client.ts");
    await expect(updateConnectedDaemons()).rejects.toThrow(
      "/api/developer/v1/daemon/update failed: HTTP 502",
    );
  });

  it("wraps Unix-socket connect failures", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    mockFsMap([[instanceSecretsPath(), `1:${CURRENT_SECRET}`]]);
    mockSocketHttpError(new Error("connect ENOENT"));
    const { syncDevToAllDaemons } = await import("./developer-client.ts");
    await expect(syncDevToAllDaemons()).rejects.toThrow(
      "instance Unix socket unavailable (/run/turbopanel/instance.sock): connect ENOENT",
    );
  });

  it("stringifies non-Error socket failures", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    mockFsMap([[instanceSecretsPath(), `1:${CURRENT_SECRET}`]]);
    mockSocketHttpError("connect ECONNREFUSED");
    const { syncDevToAllDaemons } = await import("./developer-client.ts");
    await expect(syncDevToAllDaemons()).rejects.toThrow(
      "instance Unix socket unavailable (/run/turbopanel/instance.sock): connect ECONNREFUSED",
    );
  });

  it("treats a missing HTTP status as 500", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    mockFsMap([[instanceSecretsPath(), `1:${CURRENT_SECRET}`]]);
    mockSocketHttpResponse(undefined, "no status");
    const { syncDevToAllDaemons } = await import("./developer-client.ts");
    await expect(syncDevToAllDaemons()).rejects.toThrow(
      "/api/developer/v1/daemon/sync-dev failed: HTTP 500",
    );
  });

  it("omits Local-Console authorization when the keyring vanishes after preflight", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    let reads = 0;
    mockedReadFileSync.mockImplementation((path) => {
      if (String(path) !== instanceSecretsPath()) {
        throw fsError("ENOENT");
      }
      reads += 1;
      if (reads === 1) {
        return `1:${CURRENT_SECRET}`;
      }
      throw fsError("ENOENT");
    });
    mockSocketHttpResponse(200, JSON.stringify({ ok: true }));
    const { syncDevToAllDaemons } = await import("./developer-client.ts");
    await expect(syncDevToAllDaemons()).resolves.toEqual({ ok: true });
    const options = mockedHttpRequest.mock.calls[0]?.[0];
    if (options === undefined || typeof options !== "object") {
      throw new TypeError("expected http.request options object");
    }
    const headers = "headers" in options ? options.headers : undefined;
    if (headers === undefined || typeof headers !== "object") {
      throw new TypeError("expected Local-Console request headers");
    }
    expect(headers).not.toHaveProperty("authorization");
  });

  it("defaults developerFetch to GET when init is omitted", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    mockFsMap([[instanceSecretsPath(), `1:${CURRENT_SECRET}`]]);
    mockSocketHttpResponse(200, JSON.stringify({ ok: true }));
    const { developerFetch } = await import("./developer-client.ts");
    await expect(developerFetch("/api/developer/v1/status")).resolves.toEqual({
      ok: true,
    });
    const options = mockedHttpRequest.mock.calls[0]?.[0];
    if (options === undefined || typeof options !== "object") {
      throw new TypeError("expected http.request options object");
    }
    expect(options).toMatchObject({
      path: "/api/developer/v1/status",
      method: "GET",
    });
    const req = mockedHttpRequest.mock.results[0]?.value as {
      write?: ReturnType<typeof vi.fn>;
    };
    expect(req.write).not.toHaveBeenCalled();
  });

  it("POSTs startDuckdbUi to the metrics duckdb-ui route", async () => {
    vi.doMock("./daemon-env.ts", () => ({
      readInstanceRuntime: () => "deno",
    }));
    mockFsMap([[instanceSecretsPath(), `1:${CURRENT_SECRET}`]]);
    mockSocketHttpResponse(200, JSON.stringify({ ok: true, port: 4213 }));
    const { startDuckdbUi: startUi } = await import("./developer-client.ts");
    await expect(startUi()).resolves.toEqual({ ok: true, port: 4213 });
    const options = mockedHttpRequest.mock.calls[0]?.[0];
    if (options === undefined || typeof options !== "object") {
      throw new TypeError("expected duckdb-ui http.request options");
    }
    expect(options).toMatchObject({
      path: "/api/developer/v1/metrics/duckdb-ui",
      method: "POST",
    });
  });
});