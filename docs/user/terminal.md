# Terminal history

Each terminal keeps up to 5,000 lines and 8 MiB of scrollback on its environment
server. T3 Code removes the oldest output when either limit is reached. A long
line can be shortened at the start. New terminal output is not truncated.

These limits apply when you reconnect and when T3 Code restores saved terminal
history. A client can show less scrollback than the server keeps.

## Find background processes

Open **Background work** in the sidebar or mobile thread list to see processes
running on each connected environment. You can also open it from Settings →
Diagnostics. The summary shows their count and memory use, refreshing every
15 seconds while the app is active.

Expand it to find a process by thread, working directory, listening port, or
runtime. Memory is labeled **footprint** when available, otherwise **RSS**.
The list includes agents and terminals as well as dev servers. Processes that
started before ownership tracking was available may be missing or have an
unknown thread.

**Interrupt process** requests a graceful stop. **Force stop** ends it immediately.
Both can interrupt active work, and child processes may continue. Refresh to
check what remains. When connected remotely, these actions affect the selected
environment, not the device displaying the list.
