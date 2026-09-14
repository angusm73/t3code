import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type BackgroundWorkProcess } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  backgroundMemoryLabel,
  backgroundRuntimeLabel,
  backgroundWorkIsFresh,
  groupBackgroundWork,
} from "./backgroundWork.ts";

const process = (pid: number, input: Partial<BackgroundWorkProcess>): BackgroundWorkProcess => ({
  identity: { pid, startTimeMs: pid },
  name: "node",
  runTimeMs: 1000,
  cpuPercent: 0,
  residentBytes: 100,
  ports: [],
  ...input,
});
describe("background work presentation", () => {
  it("separates unknown ownership and keeps mixed-memory groups in RSS", () => {
    const groups = groupBackgroundWork([
      process(1, { owner: { threadId: ThreadId.make("a") }, physicalFootprintBytes: 500 }),
      process(2, { owner: { threadId: ThreadId.make("a") } }),
      process(3, { physicalFootprintBytes: 800 }),
    ]);
    expect(groups.map((group) => group.threadId)).toEqual([null, "a"]);
    expect(groups[0]?.physicalFootprintBytes).toBe(800);
    expect(groups[1]?.residentBytes).toBe(200);
    expect(groups[1]?.physicalFootprintBytes).toBeUndefined();
  });
  it("labels measurement and long-running process age explicitly", () => {
    expect(backgroundMemoryLabel({ residentBytes: 1024 ** 3 })).toBe("1.00 GB RSS");
    expect(
      backgroundMemoryLabel({ residentBytes: 1024 ** 3, physicalFootprintBytes: 3 * 1024 ** 3 }),
    ).toBe("3.00 GB footprint");
    expect(backgroundRuntimeLabel(6 * 24 * 60 * 60 * 1000)).toBe("6d 0h");
  });
  it("never treats stale data or collector failure as current usage", () => {
    const data = {
      readAt: DateTime.makeUnsafe(1000),
      sampleAgeMs: 1000,
      collectorStatus: "healthy" as const,
      processes: [],
      residentBytes: 0,
      processCount: 0,
      cpuPercent: 0,
      portsAvailable: false,
    };
    expect(backgroundWorkIsFresh(data)).toBe(true);
    expect(backgroundWorkIsFresh({ ...data, sampleAgeMs: 30_000 })).toBe(false);
    expect(backgroundWorkIsFresh({ ...data, collectorStatus: "degraded" })).toBe(false);
    expect(
      backgroundWorkIsFresh({ ...data, readAt: DateTime.makeUnsafe("2099-01-01T00:00:00Z") }),
    ).toBe(true);
  });
});
