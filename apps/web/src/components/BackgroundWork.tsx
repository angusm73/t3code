import type { BackgroundWorkProcess, EnvironmentId, ServerProcessSignal } from "@t3tools/contracts";
import {
  backgroundMemoryLabel,
  backgroundRuntimeLabel,
  backgroundWorkIsFresh,
  groupBackgroundWork,
} from "@t3tools/client-runtime/background-work";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { useEnvironments } from "../state/environments";
import { useThreadShells } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { ensureLocalApi } from "../localApi";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "./ui/dialog";

function useBackgroundWork(environmentId: EnvironmentId, includeProcesses: boolean) {
  const query = useEnvironmentQuery(
    serverEnvironment.backgroundWork({ environmentId, input: { includeProcesses } }),
  );
  const { refresh: refreshQuery } = query;
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      refreshQuery();
    };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshQuery]);
  return {
    ...query,
    fresh: query.data !== null && !query.error && backgroundWorkIsFresh(query.data),
  };
}

export function BackgroundWork() {
  const { environments } = useEnvironments();
  return (
    <div className="space-y-1 group-data-[collapsible=icon]:hidden">
      {environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => (
          <EnvironmentBackgroundWork
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ))}
    </div>
  );
}

function EnvironmentBackgroundWork({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const query = useBackgroundWork(environmentId, false);
  const description =
    query.data && query.fresh
      ? `${query.data.processCount} processes · ${backgroundMemoryLabel(query.data)}`
      : query.isPending && !query.data
        ? "Loading…"
        : "Usage unavailable";
  return (
    <>
      <button
        className="w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-2"
        onClick={() => setOpen(true)}
      >
        <span className="block truncate font-medium">Background work · {label}</span>
        <span className="block truncate text-muted-foreground">{description}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-2xl p-5">
          <DialogTitle>Background work · {label}</DialogTitle>
          <DialogDescription>
            Tracked agents, terminals, and their background processes on this environment. Older
            untracked processes may be missing.
          </DialogDescription>
          {open ? <BackgroundWorkDetails environmentId={environmentId} label={label} /> : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}

function BackgroundWorkDetails({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const query = useBackgroundWork(environmentId, true);
  const threads = useThreadShells();
  const signal = useAtomCommand(serverEnvironment.signalProcess, { reportFailure: false });
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const stop = async (process: BackgroundWorkProcess, requestedSignal: ServerProcessSignal) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (
        !(await ensureLocalApi().dialogs.confirm(
          `${requestedSignal === "SIGKILL" ? "Force stop" : "Interrupt"} ${process.name} (PID ${process.identity.pid}) on ${label}? This can interrupt active work. Child processes may continue.`,
          { variant: "destructive" },
        ))
      )
        return;
      const result = await signal({
        environmentId,
        input: { ...process.identity, signal: requestedSignal },
      });
      if (result._tag === "Failure") throw Cause.squash(result.cause);
      setMessage(
        result.value.signaled
          ? `Sent ${requestedSignal} to PID ${process.identity.pid}. Check the next refresh to confirm it exited.`
          : Option.getOrElse(result.value.message, () => "The process could not be stopped."),
      );
      query.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The process could not be stopped.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span>
          {query.data && query.fresh
            ? `${backgroundMemoryLabel(query.data)} · ${query.data.cpuPercent.toFixed(1)}% CPU`
            : "Current usage unavailable"}
        </span>
        <Button size="sm" variant="outline" onClick={query.refresh} disabled={query.isPending}>
          Refresh
        </Button>
      </div>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Refreshes every 15 seconds. 100% CPU is one core. Memory covers tracked backend work,
        excluding the T3 desktop. Ports are on this environment, not necessarily this device.
      </p>
      {query.data && !query.fresh ? (
        <p className="text-sm">Last known processes below; collection is unavailable or stale.</p>
      ) : null}
      {query.data && !query.data.portsAvailable ? (
        <p className="text-xs text-muted-foreground">Listening ports unavailable.</p>
      ) : null}
      <div className="max-h-[55vh] space-y-4 overflow-y-auto">
        {groupBackgroundWork(query.data?.processes ?? []).map((group) => (
          <section key={group.threadId ?? "unattributed"} className="rounded-md border p-3">
            <h3 className="break-words text-sm font-medium">
              {group.threadId === null
                ? "Thread unknown"
                : (threads.find(
                    (thread) =>
                      thread.environmentId === environmentId && thread.id === group.threadId,
                  )?.title ?? `Thread ${group.threadId}`)}
            </h3>
            <p className="text-xs text-muted-foreground">
              {group.processes.length} processes · {backgroundMemoryLabel(group)}
            </p>
            {group.processes.map((process) => (
              <div
                key={`${process.identity.pid}:${process.identity.startTimeMs}`}
                className="mt-3 border-t pt-2 text-xs"
              >
                <p className="break-words font-medium">
                  {process.name} · PID {process.identity.pid} ·{" "}
                  {backgroundRuntimeLabel(process.runTimeMs)}
                </p>
                {process.cwd ? (
                  <p className="break-all text-muted-foreground">{process.cwd}</p>
                ) : null}
                <p>
                  {backgroundMemoryLabel(process)} · {process.cpuPercent.toFixed(1)}% CPU
                  {process.ports.length ? ` · Ports ${process.ports.join(", ")}` : ""}
                </p>
                {process.owner?.terminalId ? (
                  <p className="break-all text-muted-foreground">
                    Terminal {process.owner.terminalId}
                  </p>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !query.fresh}
                    onClick={() => void stop(process, "SIGINT")}
                  >
                    Interrupt process
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !query.fresh}
                    onClick={() => void stop(process, "SIGKILL")}
                  >
                    Force stop
                  </Button>
                </div>
              </div>
            ))}
          </section>
        ))}
        {query.data?.processCount === 0 && query.fresh ? (
          <p className="text-sm">No tracked background processes.</p>
        ) : null}
      </div>
    </div>
  );
}
