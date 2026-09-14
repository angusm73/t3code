import type { BackgroundWorkProcess, BackgroundWorkSnapshot, ThreadId } from "@t3tools/contracts";

export function backgroundMemoryLabel(value: {
  readonly residentBytes: number;
  readonly physicalFootprintBytes?: number;
}): string {
  const bytes = value.physicalFootprintBytes ?? value.residentBytes;
  const amount =
    bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
      : `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${amount}${value.physicalFootprintBytes === undefined ? " RSS" : " footprint"}`;
}

export function backgroundRuntimeLabel(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function backgroundWorkIsFresh(snapshot: BackgroundWorkSnapshot): boolean {
  return snapshot.collectorStatus === "healthy" && snapshot.sampleAgeMs < 30_000;
}

export function groupBackgroundWork(processes: ReadonlyArray<BackgroundWorkProcess>) {
  const groups = new Map<ThreadId | null, BackgroundWorkProcess[]>();
  for (const process of processes) {
    const key = process.owner?.threadId ?? null;
    const entries = groups.get(key) ?? [];
    entries.push(process);
    groups.set(key, entries);
  }
  return [...groups]
    .map(([threadId, entries]) => ({
      threadId,
      processes: entries,
      residentBytes: entries.reduce((sum, entry) => sum + entry.residentBytes, 0),
      ...(entries.every((entry) => entry.physicalFootprintBytes !== undefined)
        ? {
            physicalFootprintBytes: entries.reduce(
              (sum, entry) => sum + entry.physicalFootprintBytes!,
              0,
            ),
          }
        : {}),
    }))
    .sort(
      (a, b) =>
        (b.physicalFootprintBytes ?? b.residentBytes) -
        (a.physicalFootprintBytes ?? a.residentBytes),
    );
}
