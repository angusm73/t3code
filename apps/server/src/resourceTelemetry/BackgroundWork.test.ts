import { describe, expect, it } from "@effect/vitest";
import {
  ThreadId,
  type ResourceTelemetryProcess,
  type ResourceTelemetrySnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ProcessRunner from "../processRunner.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";
import { emptyTelemetryCounters, mergeProcesses } from "./Model.ts";
import { make, parseListeners, projectBackgroundWork } from "./BackgroundWork.ts";

const now = DateTime.makeUnsafe("2026-09-14T00:00:00Z");
const emptyMerge = mergeProcesses({
  serverPid: 100,
  sidecarPid: Option.none(),
  fallbackSampledAtMs: DateTime.toEpochMillis(now),
  nativeSnapshot: Option.none(),
  desktopSnapshot: Option.none(),
  previous: new Map(),
  counters: emptyTelemetryCounters(),
  updatePrevious: false,
});
const source = {
  status: "healthy" as const,
  lastSampleAt: Option.some(now),
  lastError: Option.none(),
};
function snapshot(
  processes: ReadonlyArray<ResourceTelemetryProcess> = [],
): ResourceTelemetrySnapshot {
  return {
    readAt: now,
    sampleIntervalMs: 1000,
    processes,
    groups: emptyMerge.groups,
    power: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: now,
    },
    speedLimitPercent: Option.none(),
    attribution: { readAt: now, entries: [] },
    health: {
      native: source,
      desktop: source,
      sidecarVersion: Option.none(),
      sidecarPid: Option.none(),
      restartCount: 0,
      collectionDurationMicros: 0,
      scannedProcessCount: processes.length,
      retainedProcessCount: processes.length,
      inaccessibleProcessCount: 0,
    },
  };
}
function processEntry(
  pid: number,
  input: Partial<ResourceTelemetryProcess> = {},
): ResourceTelemetryProcess {
  return {
    identity: { pid, startTimeMs: pid },
    ppid: 100,
    childPids: [],
    depth: 1,
    name: "node",
    command: "private command not needed in summary",
    status: "Running",
    category: "server-child",
    cpuPercent: 10,
    cpuTimeMs: 100,
    residentBytes: 100,
    peakResidentBytes: 100,
    virtualBytes: 100,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioReadBytesPerSecond: 0,
    ioWriteBytesPerSecond: 0,
    ioSemantics: "storage",
    runTimeMs: 10_000,
    firstSeenAt: now,
    lastSeenAt: now,
    ...input,
  };
}

describe("background work", () => {
  it("measures sample age on the environment clock", () => {
    expect(
      projectBackgroundWork(snapshot(), false, null, DateTime.toEpochMillis(now) + 35_000)
        .sampleAgeMs,
    ).toBe(35_000);
    expect(
      projectBackgroundWork(snapshot(), false, null, DateTime.toEpochMillis(now) - 1000)
        .sampleAgeMs,
    ).toBe(0);
  });
  it("parses TCP listeners across bind addresses without merging different owners", () => {
    expect(
      parseListeners(
        "p12\nn*:3100\nn[::]:3100\np13\nn127.0.0.1:3100\nn192.168.1.2:9000\npbad\nn*:8888\np14\nn*:65536\n",
        false,
      ),
    ).toEqual([
      { pid: 12, port: 3100 },
      { pid: 13, port: 3100 },
      { pid: 13, port: 9000 },
    ]);
    expect(parseListeners("12|3100\r\n12|3100\r\n13|9000\r\n0|1\r\n14|NaN", true)).toEqual([
      { pid: 12, port: 3100 },
      { pid: 13, port: 9000 },
    ]);
  });

  it("includes only backend work and never labels partial footprint totals as complete", () => {
    const data = snapshot([
      processEntry(101, { category: "server", residentBytes: 1000 }),
      processEntry(102, { category: "electron-utility", residentBytes: 1000 }),
      processEntry(103, { category: "resource-monitor", residentBytes: 1000 }),
      processEntry(104, {
        owner: { threadId: ThreadId.make("thread-a") },
        physicalFootprintBytes: 800,
      }),
      processEntry(105),
    ]);
    const summary = projectBackgroundWork(data, false, null, DateTime.toEpochMillis(now));
    expect(summary).toMatchObject({
      processCount: 2,
      residentBytes: 200,
      cpuPercent: 20,
      processes: [],
      portsAvailable: false,
    });
    expect(summary.physicalFootprintBytes).toBeUndefined();
    const details = projectBackgroundWork(
      data,
      true,
      [
        { pid: 104, port: 3100 },
        { pid: 999, port: 9000 },
      ],
      DateTime.toEpochMillis(now),
    );
    expect(details.processes[0]).toMatchObject({
      identity: { pid: 104 },
      owner: { threadId: "thread-a" },
      ports: [3100],
    });
    expect(details.processes[1]?.ports).toEqual([]);
    expect(details.processes[0]).not.toHaveProperty("command");
    expect(
      projectBackgroundWork(
        snapshot([processEntry(104, { physicalFootprintBytes: 800 })]),
        false,
        null,
        DateTime.toEpochMillis(now),
      ).physicalFootprintBytes,
    ).toBe(800);
  });

  it.effect("shares samples across clients and scans sockets only for details", () =>
    Effect.gen(function* () {
      let samples = 0;
      const commands: string[] = [];
      const service = yield* make().pipe(
        Effect.provide(
          Layer.mock(ResourceTelemetry.ResourceTelemetry)({
            refresh: Effect.sync(() => {
              samples++;
              return snapshot([processEntry(104)]);
            }),
            latest: Effect.succeed(snapshot()),
          }),
        ),
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: (input) =>
            Effect.sync(() => {
              commands.push(input.command);
              return {
                stdout: "p104\nn*:3100\n",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
      );
      yield* Effect.all([service.read(false), service.read(false)], { concurrency: "unbounded" });
      expect(samples).toBe(1);
      expect(commands).toEqual([]);
      const [first, second] = yield* Effect.all([service.read(true), service.read(true)], {
        concurrency: "unbounded",
      });
      expect(samples).toBe(1);
      expect(commands).toEqual(["lsof"]);
      expect(first.processes[0]?.ports).toEqual([3100]);
      expect(second).toEqual(first);
    }),
  );

  it.effect("keeps processes visible when socket discovery fails", () =>
    Effect.gen(function* () {
      const data = snapshot([processEntry(104)]);
      const service = yield* make().pipe(
        Effect.provide(
          Layer.mock(ResourceTelemetry.ResourceTelemetry)({
            refresh: Effect.succeed(data),
            latest: Effect.succeed(data),
          }),
        ),
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: "lsof",
                argumentCount: 0,
                cause: "missing executable",
              }),
            ),
        }),
      );
      const result = yield* service.read(true);
      expect(result.processCount).toBe(1);
      expect(result.portsAvailable).toBe(false);
    }),
  );
});
