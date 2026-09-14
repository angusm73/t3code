import type { BackgroundWorkSnapshot, ResourceTelemetrySnapshot } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";

type Listener = { readonly pid: number; readonly port: number };

/** Raw sockets include API servers and non-HTTP services, without waking them with probes. */
export function parseListeners(output: string, windows: boolean): ReadonlyArray<Listener> {
  const listeners = new Map<string, Listener>();
  let pid = 0;
  for (const line of output.split(/\r?\n/)) {
    let port = 0;
    if (windows) {
      const fields = line.trim().split("|");
      pid = Number(fields[0]);
      port = Number(fields[1]);
    } else if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n")) {
      port = Number(/:(\d+)(?:\s.*)?$/.exec(line)?.[1]);
    }
    if (Number.isInteger(pid) && pid > 0 && Number.isInteger(port) && port > 0 && port < 65536) {
      listeners.set(`${pid}:${port}`, { pid, port });
    }
  }
  return [...listeners.values()];
}

export function projectBackgroundWork(
  snapshot: ResourceTelemetrySnapshot,
  includeProcesses: boolean,
  listeners: ReadonlyArray<Listener> | null,
  now: number,
): BackgroundWorkSnapshot {
  const processes = snapshot.processes.filter((entry) =>
    ["server-child", "provider-root", "terminal-root"].includes(entry.category),
  );
  const footprintComplete =
    processes.length > 0 && processes.every((entry) => entry.physicalFootprintBytes !== undefined);
  const portsByPid = new Map<number, number[]>();
  for (const listener of listeners ?? []) {
    const ports = portsByPid.get(listener.pid) ?? [];
    ports.push(listener.port);
    portsByPid.set(listener.pid, ports);
  }
  return {
    readAt: snapshot.readAt,
    sampleAgeMs: Math.max(0, now - DateTime.toEpochMillis(snapshot.readAt)),
    collectorStatus: snapshot.health.native.status,
    processCount: processes.length,
    residentBytes: processes.reduce((total, entry) => total + entry.residentBytes, 0),
    ...(footprintComplete
      ? {
          physicalFootprintBytes: processes.reduce(
            (total, entry) => total + entry.physicalFootprintBytes!,
            0,
          ),
        }
      : {}),
    cpuPercent: processes.reduce((total, entry) => total + entry.cpuPercent, 0),
    portsAvailable: listeners !== null,
    processes: includeProcesses
      ? processes
          .map((entry) => ({
            identity: entry.identity,
            ...(entry.owner === undefined ? {} : { owner: entry.owner }),
            name: entry.name,
            ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
            runTimeMs: entry.runTimeMs,
            cpuPercent: entry.cpuPercent,
            residentBytes: entry.residentBytes,
            ...(entry.physicalFootprintBytes === undefined
              ? {}
              : { physicalFootprintBytes: entry.physicalFootprintBytes }),
            ports: (portsByPid.get(entry.identity.pid) ?? []).toSorted((a, b) => a - b),
          }))
          .toSorted(
            (a, b) =>
              (b.physicalFootprintBytes ?? b.residentBytes) -
              (a.physicalFootprintBytes ?? a.residentBytes),
          )
      : [],
  };
}

export class BackgroundWork extends Context.Service<
  BackgroundWork,
  {
    readonly read: (includeProcesses: boolean) => Effect.Effect<BackgroundWorkSnapshot>;
  }
>()("t3/resourceTelemetry/BackgroundWork") {}

export const make = Effect.fn("BackgroundWork.make")(function* () {
  const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const windows = platform === "win32";
  const sample = telemetry.refresh.pipe(Effect.catch(() => telemetry.latest));
  const snapshots = yield* Cache.make({
    capacity: 1,
    timeToLive: "5 seconds",
    lookup: (_key: "snapshot") => sample,
  });
  const ports = yield* Cache.make({
    capacity: 1,
    timeToLive: "5 seconds",
    lookup: (_key: "ports") =>
      runner
        .run({
          command: windows ? "powershell.exe" : "lsof",
          args: windows
            ? [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                'Get-NetTCPConnection -State Listen -ErrorAction Stop | ForEach-Object { Write-Output "$($_.OwningProcess)|$($_.LocalPort)" }',
              ]
            : ["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-F", "pn"],
          timeout: "5 seconds",
          maxOutputBytes: 1024 * 1024,
          outputMode: "error",
        })
        .pipe(
          Effect.map((result) =>
            result.code === 0 ||
            (!windows &&
              result.code === 1 &&
              result.stdout.trim() === "" &&
              result.stderr.trim() === "")
              ? parseListeners(result.stdout, windows)
              : null,
          ),
          Effect.catch(() => Effect.succeed(null)),
        ),
  });
  return BackgroundWork.of({
    read: Effect.fn("BackgroundWork.read")(function* (includeProcesses) {
      const snapshot = yield* Cache.get(snapshots, "snapshot");
      const listeners = includeProcesses ? yield* Cache.get(ports, "ports") : null;
      return projectBackgroundWork(
        snapshot,
        includeProcesses,
        listeners,
        DateTime.toEpochMillis(yield* DateTime.now),
      );
    }),
  });
});

export const layer = Layer.effect(BackgroundWork, make());
