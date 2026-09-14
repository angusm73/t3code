import * as NodeCrypto from "node:crypto";

/** Stable across restarts, while keeping separate T3 homes on one machine distinct. */
export function processOwnershipKey(stateDir: string): string {
  return NodeCrypto.createHash("sha256").update(stateDir).digest("hex");
}

/** Children inherit the marker even when a shell or provider later exits. */
export function withProcessOwnership(
  environment: NodeJS.ProcessEnv,
  environmentKey: string,
  threadId: string,
  terminalId?: string,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    T3CODE_PROCESS_OWNER: JSON.stringify({ version: 1, environmentKey, threadId, terminalId }),
  };
}
