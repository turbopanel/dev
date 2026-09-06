import { describe, expect, it } from "vitest";
import { provisionerPhaseForDaemonOperation } from "./provisioner-phase.ts";

describe("provisionerPhaseForDaemonOperation", () => {
  it("does not treat rebuild or sync as daemon bootstrap", () => {
    expect(provisionerPhaseForDaemonOperation("rebuild-daemon-upgrade")).toBe(
      "rebuild-daemon-upgrade",
    );
    expect(provisionerPhaseForDaemonOperation("sync-dev-build")).toBe(
      "sync-dev-build",
    );
    expect(provisionerPhaseForDaemonOperation("reset-dev-env")).toBe(
      "reset-dev-env",
    );
    expect(provisionerPhaseForDaemonOperation("reset-dev-db")).toBe(
      "reset-dev-db",
    );
  });

  it("maps install (and missing operation) to daemon bootstrap", () => {
    expect(provisionerPhaseForDaemonOperation("install")).toBe("daemon");
    expect(provisionerPhaseForDaemonOperation("purge")).toBe("daemon");
    expect(provisionerPhaseForDaemonOperation("restart")).toBe("daemon");
    expect(provisionerPhaseForDaemonOperation(null)).toBe("daemon");
    expect(provisionerPhaseForDaemonOperation(undefined)).toBe("daemon");
  });

  it("maps a converge operation onto the dev-env provisioner phase", () => {
    expect(provisionerPhaseForDaemonOperation("dev-env")).toBe("dev-env");
  });

  it("returns an unexpected operation from the exhaustive fallback", () => {
    expect(
      provisionerPhaseForDaemonOperation("not-a-phase" as never),
    ).toBe("not-a-phase");
  });
});
