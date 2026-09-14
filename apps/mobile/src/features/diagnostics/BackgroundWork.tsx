import type { BackgroundWorkProcess, EnvironmentId, ServerProcessSignal } from "@t3tools/contracts";
import {
  backgroundMemoryLabel,
  backgroundRuntimeLabel,
  backgroundWorkIsFresh,
  groupBackgroundWork,
} from "@t3tools/client-runtime/background-work";
import { useIsFocused } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";
import { Alert, AppState, Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { useEnvironments } from "../../state/environments";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

function useBackgroundWork(environmentId: EnvironmentId, includeProcesses: boolean) {
  const focused = useIsFocused();
  const [active, setActive] = useState(AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const query = useEnvironmentQuery(
    focused && active
      ? serverEnvironment.backgroundWork({ environmentId, input: { includeProcesses } })
      : null,
  );
  const { refresh } = query;
  useEffect(() => {
    if (!focused || !active) return;
    const timer = setInterval(() => {
      refresh();
    }, 15_000);
    return () => clearInterval(timer);
  }, [focused, active, refresh]);
  return {
    ...query,
    fresh: query.data !== null && !query.error && backgroundWorkIsFresh(query.data),
  };
}

export function BackgroundWork() {
  const { environments } = useEnvironments();
  return (
    <View>
      {environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => (
          <EnvironmentBackgroundWork
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ))}
    </View>
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
  const insets = useSafeAreaInsets();
  return (
    <>
      <Pressable
        accessibilityRole="button"
        onPress={() => setOpen(true)}
        className="border-t border-border px-4 py-2"
      >
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          Background work · {label}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {query.data && query.fresh
            ? `${query.data.processCount} processes · ${backgroundMemoryLabel(query.data)}`
            : query.isPending && !query.data
              ? "Loading…"
              : "Usage unavailable"}
        </Text>
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View
          className="flex-1 bg-screen"
          style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
        >
          <View className="flex-row items-center justify-between gap-3 p-4">
            <Text className="flex-1 text-lg font-semibold text-foreground">
              Background work · {label}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)} className="p-2">
              <Text className="text-accent">Done</Text>
            </Pressable>
          </View>
          {open ? <BackgroundWorkDetails environmentId={environmentId} label={label} /> : null}
        </View>
      </Modal>
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
  const sendSignal = async (
    process: BackgroundWorkProcess,
    requestedSignal: ServerProcessSignal,
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
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
  const confirmStop = (process: BackgroundWorkProcess, requestedSignal: ServerProcessSignal) => {
    Alert.alert(
      `${requestedSignal === "SIGKILL" ? "Force stop" : "Interrupt"} ${process.name}?`,
      `PID ${process.identity.pid} on ${label}. This can interrupt active work. Child processes may continue.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: requestedSignal === "SIGKILL" ? "Force stop" : "Interrupt",
          style: "destructive",
          onPress: () => void sendSignal(process, requestedSignal),
        },
      ],
    );
  };
  return (
    <ScrollView contentContainerClassName="gap-3 px-4 pb-6">
      <Text className="text-sm text-foreground">
        {query.data && query.fresh
          ? `${backgroundMemoryLabel(query.data)} · ${query.data.cpuPercent.toFixed(1)}% CPU`
          : "Current usage unavailable"}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={query.refresh}
        disabled={query.isPending}
        className="py-2"
      >
        <Text className="text-accent">Refresh</Text>
      </Pressable>
      <Text className="text-xs text-foreground-muted">
        Tracked agents, terminals, and background processes on this environment. Older untracked
        processes may be missing. Refreshes every 15 seconds. 100% CPU is one core. Ports belong to
        this environment, not your phone.
      </Text>
      {query.error ? (
        <Text accessibilityRole="alert" className="text-sm text-foreground">
          {query.error}
        </Text>
      ) : null}
      {message ? <Text className="text-sm text-foreground">{message}</Text> : null}
      {query.data && !query.fresh ? (
        <Text className="text-sm text-foreground">
          Last known processes; collection is unavailable or stale.
        </Text>
      ) : null}
      {query.data && !query.data.portsAvailable ? (
        <Text className="text-xs text-foreground-muted">Listening ports unavailable.</Text>
      ) : null}
      {groupBackgroundWork(query.data?.processes ?? []).map((group) => (
        <View
          key={group.threadId ?? "unattributed"}
          className="gap-2 rounded-lg border border-border p-3"
        >
          <Text className="font-semibold text-foreground">
            {group.threadId === null
              ? "Thread unknown"
              : (threads.find(
                  (thread) =>
                    thread.environmentId === environmentId && thread.id === group.threadId,
                )?.title ?? `Thread ${group.threadId}`)}
          </Text>
          <Text className="text-xs text-foreground-muted">
            {group.processes.length} processes · {backgroundMemoryLabel(group)}
          </Text>
          {group.processes.map((process) => (
            <View
              key={`${process.identity.pid}:${process.identity.startTimeMs}`}
              className="gap-1 border-t border-border pt-2"
            >
              <Text className="text-sm font-medium text-foreground">
                {process.name} · PID {process.identity.pid} ·{" "}
                {backgroundRuntimeLabel(process.runTimeMs)}
              </Text>
              {process.cwd ? (
                <Text className="text-xs text-foreground-muted">{process.cwd}</Text>
              ) : null}
              <Text className="text-xs text-foreground">
                {backgroundMemoryLabel(process)} · {process.cpuPercent.toFixed(1)}% CPU
                {process.ports.length ? ` · Ports ${process.ports.join(", ")}` : ""}
              </Text>
              {process.owner?.terminalId ? (
                <Text className="text-xs text-foreground-muted">
                  Terminal {process.owner.terminalId}
                </Text>
              ) : null}
              <View className="flex-row gap-4">
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || !query.fresh}
                  onPress={() => confirmStop(process, "SIGINT")}
                  className="py-3 disabled:opacity-40"
                >
                  <Text className="text-accent">Interrupt process</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy || !query.fresh}
                  onPress={() => confirmStop(process, "SIGKILL")}
                  className="py-3 disabled:opacity-40"
                >
                  <Text className="text-accent">Force stop</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      ))}
      {query.data?.processCount === 0 && query.fresh ? (
        <Text className="text-sm text-foreground">No tracked background processes.</Text>
      ) : null}
    </ScrollView>
  );
}
