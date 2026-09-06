import { beforeEach, expect, test, vi } from "vitest";

vi.mock("./install-output.ts", () => ({
  runCaptured: vi.fn(async () => 0),
}));

import { runCaptured } from "./install-output.ts";
import { aptGetInstall } from "./apt.ts";

const mockedRunCaptured = vi.mocked(runCaptured);

beforeEach(() => {
  mockedRunCaptured.mockClear();
  mockedRunCaptured.mockResolvedValue(0);
});

test("aptGetInstall runs sudo noninteractive install with lock timeout", async () => {
  const code = await aptGetInstall(["curl", "tar"]);
  expect(code).toBe(0);
  expect(mockedRunCaptured).toHaveBeenCalledTimes(1);
  const [cmd] = mockedRunCaptured.mock.calls[0]!;
  expect(cmd[0]).toBe("sudo");
  expect(cmd[1]).toBe("-n");
  expect(cmd[2]).toBe("sh");
  expect(cmd[3]).toBe("-c");
  const script = cmd[4] as string;
  expect(script).toContain("DEBIAN_FRONTEND=noninteractive");
  expect(script).toContain("DPkg::Lock::Timeout=300");
  expect(script).toContain("apt-get");
  expect(script).toContain("install -y");
  expect(script).toContain("curl");
  expect(script).toContain("tar");
  expect(script).not.toContain("update");
});

test("aptGetInstall optionally runs apt-get update first", async () => {
  await aptGetInstall(["ca-certificates"], undefined, { update: true });
  const script = mockedRunCaptured.mock.calls[0]![0][4] as string;
  expect(script).toContain("apt-get");
  expect(script).toContain("update -qq");
  expect(script).toContain("&&");
  expect(script).toContain("ca-certificates");
});

test("aptGetInstall serializes concurrent callers", async () => {
  const order: string[] = [];
  mockedRunCaptured.mockImplementation(async () => {
    order.push("start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("end");
    return 0;
  });

  await Promise.all([
    aptGetInstall(["a"]),
    aptGetInstall(["b"]),
  ]);

  expect(order).toEqual(["start", "end", "start", "end"]);
  expect(mockedRunCaptured).toHaveBeenCalledTimes(2);
});

test("aptGetInstall keeps serializing after a rejected call", async () => {
  mockedRunCaptured
    .mockRejectedValueOnce(new Error("apt failed"))
    .mockResolvedValueOnce(0);

  await expect(aptGetInstall(["curl"])).rejects.toThrow("apt failed");
  await expect(aptGetInstall(["tar"])).resolves.toBe(0);
  expect(mockedRunCaptured).toHaveBeenCalledTimes(2);
});
