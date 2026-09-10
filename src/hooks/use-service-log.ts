import { useEffect, useState } from "react";
import { serviceLogLinesEqual } from "../lib/log-lines-equal.ts";
import {
  type ServiceLogByteFloor,
  type ServiceLogLine,
  readServiceLogTail,
} from "../lib/service-log.ts";

const POLL_MS = 5_000;
// Default tail window. Keep this small so initial render and scroll-back stay
// cheap; reverse infinite scroll can raise it on demand later.
const MAX_LINES = 100;

const serviceLogCache = new Map<string, ServiceLogLine[]>();

/** Drop the module-level tail cache so hook tests can exercise a cold start. */
export function resetServiceLogCache(): void {
  serviceLogCache.clear();
}

export function serviceLogCacheKey(
  serviceId: string,
  byteFloor?: ServiceLogByteFloor | null,
): string {
  if (!byteFloor || Object.keys(byteFloor).length === 0) {
    return serviceId;
  }
  const parts = Object.entries(byteFloor).sort(([a], [b]) => a.localeCompare(b));
  return `${serviceId}:${JSON.stringify(parts)}`;
}

export type ServiceLogState = {
  lines: ServiceLogLine[];
  loading: boolean;
};

type LogHookState = {
  cacheKey: string | null;
  lines: ServiceLogLine[];
  loading: boolean;
};

/** Apply a tail snapshot, ignoring stale keys and skipping unchanged idle polls. */
export function applyServiceLogRefresh(
  current: LogHookState,
  nextKey: string,
  next: ServiceLogLine[],
): LogHookState {
  if (current.cacheKey !== nextKey) {
    return current;
  }
  const sameLines = serviceLogLinesEqual(current.lines, next);
  if (sameLines && !current.loading) {
    return current;
  }
  return {
    cacheKey: nextKey,
    lines: sameLines ? current.lines : next,
    loading: false,
  };
}

export function initialLogState(
  serviceId: string | null,
  byteFloor?: ServiceLogByteFloor | null,
): LogHookState {
  if (!serviceId) {
    return { cacheKey: null, lines: [], loading: false };
  }
  const cacheKey = serviceLogCacheKey(serviceId, byteFloor);
  const cached = serviceLogCache.get(cacheKey);
  return {
    cacheKey,
    lines: cached ?? [],
    loading: !cached,
  };
}

export function useServiceLog(
  serviceId: string | null,
  byteFloor?: ServiceLogByteFloor | null,
): ServiceLogState {
  const nextKey = serviceId ? serviceLogCacheKey(serviceId, byteFloor) : null;
  const [state, setState] = useState<LogHookState>(() =>
    initialLogState(serviceId, byteFloor),
  );

  // Reset synchronously on selection change so the first paint shows title +
  // spinner (or cached lines) instead of the previous service's logs.
  if (state.cacheKey !== nextKey) {
    setState(initialLogState(serviceId, byteFloor));
  }

  useEffect(() => {
    if (!serviceId || !nextKey) {
      return;
    }

    let cancelled = false;
    let pollId: ReturnType<typeof setInterval> | undefined;
    const hadCache = serviceLogCache.has(nextKey);

    const refresh = () => {
      const next = readServiceLogTail(serviceId, MAX_LINES, byteFloor);
      if (cancelled) {
        return;
      }
      serviceLogCache.set(nextKey, next);
      setState((current) => applyServiceLogRefresh(current, nextKey, next));
    };

    // setTimeout(0) yields so Ink can paint the title + spinner first.
    // Cache hits skip the initial read — only the poll refreshes later.
    const deferId = setTimeout(() => {
      if (!hadCache) {
        refresh();
      }
      pollId = setInterval(() => refresh(), POLL_MS);
    }, 50);

    return () => {
      cancelled = true;
      clearTimeout(deferId);
      if (pollId !== undefined) {
        clearInterval(pollId);
      }
    };
  }, [serviceId, nextKey, byteFloor]);

  return { lines: state.lines, loading: state.loading };
}
