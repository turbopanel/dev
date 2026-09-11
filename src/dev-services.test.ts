import { describe, expect, it } from "vitest";
import {
  computeVisibleServices,
  parseDockerPsOutput,
  parseSystemctlShowBlocks,
  serviceDisplayName,
  type ServiceStatusSnapshot,
} from "./dev-services.ts";
import { platformRepoPath } from "./lib/paths.ts";
import {
  MAILPIT_CONTAINER_NAME,
  POSTGRES_CONTAINER_NAME,
  RABBITMQ_CONTAINER_NAME,
  REDIS_INSIGHT_CONTAINER_NAME,
} from "./lib/platform-docker-resources.ts";

const TURBOPANEL_REPO = platformRepoPath("turbopanel");
const UI_REPO = platformRepoPath("ui");

function loaded(activeState: string, subState = "running") {
  return { loadState: "loaded", activeState, subState };
}

function snapshot(
  overrides: Partial<ServiceStatusSnapshot> = {},
): ServiceStatusSnapshot {
  return {
    units: new Map(),
    containers: new Map(),
    repos: new Map(),
    daemonRepoExists: false,
    postgresSocketReady: false,
    env: {
      runtime: "deno",
      uiMode: "dev",
      runMode: "source",
      devInstanceEnabled: false,
    },
    ...overrides,
  };
}

function statusOf(services: ReturnType<typeof computeVisibleServices>, id: string) {
  return services.find((service) => service.id === id)?.status;
}

describe("parseSystemctlShowBlocks", () => {
  it("keys blank-line-separated blocks by Id, without the .service suffix", () => {
    const units = parseSystemctlShowBlocks(
      [
        "Id=turbopaneld.service",
        "LoadState=loaded",
        "ActiveState=active",
        "SubState=running",
        "",
        "Id=turbopanel-ui.service",
        "LoadState=not-found",
        "ActiveState=inactive",
        "SubState=dead",
        "",
      ].join("\n"),
    );

    expect(units.get("turbopaneld")).toEqual({
      loadState: "loaded",
      activeState: "active",
      subState: "running",
    });
    expect(units.get("turbopanel-ui")?.loadState).toBe("not-found");
  });

  it("keeps values that themselves contain '=' and skips blocks with no Id", () => {
    const units = parseSystemctlShowBlocks(
      "LoadState=loaded\n\nId=x.service\nLoadState=loaded\nSubState=a=b\n",
    );
    expect(units.size).toBe(1);
    expect(units.get("x")?.subState).toBe("a=b");
  });

  it("returns nothing for empty output", () => {
    expect(parseSystemctlShowBlocks("").size).toBe(0);
  });
});

describe("parseDockerPsOutput", () => {
  it("maps container names to whether they are running", () => {
    const containers = parseDockerPsOutput(
      "turbopanel-database\trunning\nturbopanel-queue\texited\n",
    );
    expect(containers.get("turbopanel-database")).toBe(true);
    expect(containers.get("turbopanel-queue")).toBe(false);
    // Absent means Docker does not know the container at all.
    expect(containers.has("turbopanel-dev-mailpit")).toBe(false);
  });

  it("ignores blank lines", () => {
    expect(parseDockerPsOutput("\n\n").size).toBe(0);
  });
});

describe("computeVisibleServices", () => {
  it("reports the daemon uninstalled with no unit and no checkout", () => {
    expect(computeVisibleServices(snapshot())).toEqual([
      { id: "daemon", label: "daemon", status: "uninstalled" },
    ]);
  });

  it("reports the daemon pending when only its checkout exists", () => {
    const services = computeVisibleServices(snapshot({ daemonRepoExists: true }));
    expect(statusOf(services, "daemon")).toBe("pending");
  });

  it("maps systemd active states onto service statuses", () => {
    const services = computeVisibleServices(snapshot({
      units: new Map([
        ["turbopaneld", loaded("active")],
        ["turbopanel-instance", loaded("failed", "failed")],
        ["turbopanel-ui", loaded("activating", "auto-restart")],
        ["turbopanel-website", loaded("inactive", "dead")],
      ]),
    }));

    expect(statusOf(services, "daemon")).toBe("running");
    expect(statusOf(services, "instance")).toBe("failed");
    expect(statusOf(services, "ui")).toBe("starting");
    expect(statusOf(services, "website")).toBe("stopped");
  });

  it("puts the instance above the daemon once the instance unit exists", () => {
    const services = computeVisibleServices(snapshot({
      units: new Map([
        ["turbopaneld", loaded("active")],
        ["turbopanel-instance", loaded("active")],
      ]),
    }));
    expect(services.map((service) => service.id).slice(0, 2))
      .toEqual(["instance", "daemon"]);
  });

  it("reports a downstream service pending when only its checkout exists", () => {
    const services = computeVisibleServices(snapshot({
      repos: new Map([[TURBOPANEL_REPO, true], [UI_REPO, false]]),
    }));
    expect(statusOf(services, "instance")).toBe("pending");
    expect(services.some((service) => service.id === "ui")).toBe(false);
  });

  it("prefers a live postgres socket over the container state", () => {
    const withSocket = computeVisibleServices(snapshot({
      postgresSocketReady: true,
      env: {
        runtime: "deno",
        uiMode: "dev",
        runMode: "source",
        devInstanceEnabled: true,
      },
    }));
    expect(statusOf(withSocket, "db")).toBe("running");

    const containerOnly = computeVisibleServices(snapshot({
      containers: new Map([[POSTGRES_CONTAINER_NAME, false]]),
      env: {
        runtime: "deno",
        uiMode: "dev",
        runMode: "source",
        devInstanceEnabled: true,
      },
    }));
    expect(statusOf(containerOnly, "db")).toBe("stopped");
  });

  it("falls back to the container when a docker-backed unit is absent", () => {
    const services = computeVisibleServices(snapshot({
      containers: new Map([
        [MAILPIT_CONTAINER_NAME, true],
        [REDIS_INSIGHT_CONTAINER_NAME, false],
        [RABBITMQ_CONTAINER_NAME, true],
      ]),
    }));
    expect(statusOf(services, "smtp")).toBe("running");
    expect(statusOf(services, "redisinsight")).toBe("stopped");
    expect(statusOf(services, "queue")).toBe("running");
  });

  it("prefers the unit over the container for mailpit and redis insight", () => {
    const services = computeVisibleServices(snapshot({
      units: new Map([
        ["turbopanel-mailpit", loaded("active")],
        ["turbopanel-redis-insight", loaded("failed", "failed")],
      ]),
      containers: new Map([
        [MAILPIT_CONTAINER_NAME, false],
        [REDIS_INSIGHT_CONTAINER_NAME, true],
      ]),
    }));
    expect(statusOf(services, "smtp")).toBe("running");
    expect(statusOf(services, "redisinsight")).toBe("failed");
  });

  it("hides ancillary services until something in the stack exists", () => {
    const hidden = computeVisibleServices(snapshot({ daemonRepoExists: true }));
    expect(hidden.some((service) => service.id === "db")).toBe(false);

    const shown = computeVisibleServices(snapshot({
      daemonRepoExists: true,
      env: {
        runtime: "deno",
        uiMode: "dev",
        runMode: "source",
        devInstanceEnabled: true,
      },
    }));
    expect(shown.some((service) => service.id === "db")).toBe(true);
  });

  it("drops Deno-only ancillary services on the Workers runtime", () => {
    const services = computeVisibleServices(snapshot({
      units: new Map([["turbopanel-instance", loaded("active")]]),
      env: {
        runtime: "workers",
        uiMode: "dev",
        runMode: "source",
        devInstanceEnabled: true,
      },
    }));
    expect(services.some((service) => service.id === "cache")).toBe(false);
    expect(services.some((service) => service.id === "queue")).toBe(false);
    expect(services.some((service) => service.id === "db")).toBe(true);
    expect(services.some((service) => service.id === "stripe")).toBe(true);
  });

  it("shows the Stripe CLI only on the Workers runtime", () => {
    const deno = computeVisibleServices(snapshot({
      units: new Map([["turbopanel-instance", loaded("active")]]),
      env: {
        runtime: "deno",
        uiMode: "dev",
        runMode: "source",
        devInstanceEnabled: true,
      },
    }));
    expect(deno.some((service) => service.id === "stripe")).toBe(false);

    const workers = computeVisibleServices(snapshot({
      units: new Map([["turbopanel-instance", loaded("active")]]),
      env: {
        runtime: "workers",
        uiMode: "dev",
        runMode: "source",
        devInstanceEnabled: true,
      },
    }));
    expect(workers.some((service) => service.id === "stripe")).toBe(true);
  });

  it("merges gray catalog rows once part of the stack is installed", () => {
    const services = computeVisibleServices(snapshot({
      units: new Map([["turbopaneld", loaded("active")]]),
    }));
    // Catalog rows come through as uninstalled placeholders.
    const website = services.find((service) => service.id === "website");
    expect(website?.status).toBe("uninstalled");
  });
});

describe("serviceDisplayName", () => {
  it("prefers an explicit label, then the def, then the id", () => {
    expect(serviceDisplayName("instance", "custom")).toBe("custom");
    expect(serviceDisplayName("redisinsight")).toBe("redisinsight");
    expect(serviceDisplayName("unknown-service")).toBe("unknown-service");
  });
});
