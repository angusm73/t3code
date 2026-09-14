import { describe, expect, it } from "@effect/vitest";

import { processOwnershipKey, withProcessOwnership } from "./ProcessOwnership.ts";

describe("process ownership environment", () => {
  it("replaces inherited ownership without changing provider configuration or the parent environment", () => {
    const parent = {
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/profile",
      T3CODE_PROCESS_OWNER: "another-thread",
    };
    const child = withProcessOwnership(
      parent,
      processOwnershipKey("/isolated/userdata"),
      "thread-2",
      "terminal-3",
    );
    expect(child.PATH).toBe(parent.PATH);
    expect(child.CLAUDE_CONFIG_DIR).toBe(parent.CLAUDE_CONFIG_DIR);
    expect(parent.T3CODE_PROCESS_OWNER).toBe("another-thread");
    expect(JSON.parse(child.T3CODE_PROCESS_OWNER!)).toEqual({
      version: 1,
      environmentKey: processOwnershipKey("/isolated/userdata"),
      threadId: "thread-2",
      terminalId: "terminal-3",
    });
  });

  it("uses a restart-stable key and keeps separate T3 homes distinct", () => {
    expect(processOwnershipKey("/one/userdata")).toBe(processOwnershipKey("/one/userdata"));
    expect(processOwnershipKey("/one/userdata")).not.toBe(processOwnershipKey("/two/userdata"));
  });
});
