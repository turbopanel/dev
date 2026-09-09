import { useCallback, useEffect, useRef, useState } from "react";
import { readVisibleServices, type DevService } from "../dev-services.ts";

export function servicesEqual(current: DevService[], next: DevService[]): boolean {
  if (current.length !== next.length) {
    return false;
  }

  return current.every((service, index) => {
    const other = next[index]!;
    return (
      service.id === other.id &&
      service.label === other.label &&
      service.status === other.status
    );
  });
}

/**
 * Status polling is deliberately slow — the systemd/Docker scan is off-thread
 * now, but it still spawns subprocesses.
 */
const STATUS_POLL_MS = 15_000;

export type VisibleServicesState = {
  services: DevService[];
  /** True until the first scan lands; the list renders a skeleton meanwhile. */
  loading: boolean;
  refresh: () => void;
};

export function useVisibleServices(): VisibleServicesState {
  const [services, setServices] = useState<DevService[]>([]);
  const [loading, setLoading] = useState(true);
  const busyRef = useRef(false);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    // Never scan twice at once, but never drop a request either: a refresh
    // fired from a restart/action handler that lands mid-scan must still run,
    // or the row keeps its stale status until the next 15s poll.
    if (busyRef.current) {
      pendingRef.current = true;
      return;
    }
    busyRef.current = true;
    void (async () => {
      try {
        const next = await readVisibleServices();
        if (!mountedRef.current) {
          return;
        }
        setServices((current) => (servicesEqual(current, next) ? current : next));
        setLoading(false);
      } catch {
        // A failed probe leaves the previous list in place; the poll retries.
        if (mountedRef.current) {
          setLoading(false);
        }
      } finally {
        busyRef.current = false;
        if (pendingRef.current && mountedRef.current) {
          pendingRef.current = false;
          refresh();
        }
      }
    })();
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return { services, loading, refresh };
}
