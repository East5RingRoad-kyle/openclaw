// Crabline runner tests preserve provider-native thread ownership at the Gateway boundary.
import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";
import { startAgentRun } from "./suite-runtime-agent-process.js";

function createSelection(channel: OpenClawCrablineChannelDriverSelection["channel"]) {
  return {
    capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
    channel,
    channelDriver: "crabline",
    providerReadinessArtifactPath: "crabline-provider-readiness.json",
  } as const;
}

describe("Crabline provider thread routing", () => {
  it.each(["matrix", "mattermost"] as const)(
    "forwards %s threads at the Gateway boundary",
    async (channel) => {
      await withTempDir("qa-crabline-transport-", async (outputDir) => {
        const transport = await createQaCrablineTransportAdapter({
          outputDir,
          selection: createSelection(channel),
          state: createQaBusState(),
        });
        const gatewayCall = vi.fn(async () => ({ runId: `run-${channel}` }));

        try {
          await expect(
            startAgentRun({ gateway: { call: gatewayCall }, transport } as never, {
              sessionKey: `agent:qa:${channel}`,
              message: "thread routing proof",
              to: "group:qa-channel",
              threadId: "native-thread",
            }),
          ).resolves.toEqual({ runId: `run-${channel}` });
          expect(gatewayCall).toHaveBeenCalledWith(
            "agent",
            expect.objectContaining({ channel, threadId: "native-thread" }),
            { timeoutMs: 30_000 },
          );
        } finally {
          await transport.cleanupAfterGatewayStop?.();
        }
      });
    },
  );
});
