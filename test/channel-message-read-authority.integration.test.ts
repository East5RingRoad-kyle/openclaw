import { afterEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../extensions/discord/api.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";

const guild = "100000000000000001";
const parent = "100000000000000002";
const current = "100000000000000003";
const sibling = "100000000000000004";

afterEach(() => {
  vi.unstubAllGlobals();
  resetPluginRuntimeStateForTest();
});

describe("official Discord provider read boundary", () => {
  it.each(["allowed", "denied", "revoked", "legacy"] as const)(
    "routes a sibling-thread read through the real provider (%s)",
    async (mode) => {
      const owner = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime: {} as PluginRuntime,
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({
        id: "discord",
        origin: "global",
        trustedOfficialInstall: true,
      });
      const plugin = {
        ...discordPlugin,
        // Status probes have provider-specific generics and are not part of message dispatch.
        status: undefined,
        actions: {
          ...discordPlugin.actions!,
          supportsReadAuthority: mode === "legacy" ? undefined : (true as const),
        },
      };
      owner.registry.plugins.push(record);
      owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({ plugin });
      setActivePluginRegistry(owner.registry);
      const requests: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request) => {
          const url = input instanceof Request ? input.url : String(input);
          requests.push(url);
          if (url.includes(`/channels/${sibling}/messages`)) {
            return Response.json([]);
          }
          if (url.endsWith(`/channels/${sibling}`)) {
            if (mode === "revoked") {
              record.enabled = false;
            }
            return Response.json({
              id: sibling,
              type: 11,
              parent_id: parent,
              guild_id: guild,
              name: "sibling",
            });
          }
          if (url.endsWith(`/channels/${parent}`)) {
            return Response.json({ id: parent, type: 0, guild_id: guild, name: "discussion" });
          }
          throw new Error(`Unexpected synthetic provider request: ${url}`);
        }),
      );
      const invocation = dispatchChannelMessageAction({
        cfg: {
          channels: {
            discord: {
              enabled: true,
              token: "synthetic-provider-fixture",
              groupPolicy: "allowlist",
              guilds: { [guild]: { channels: { [parent]: { enabled: mode !== "denied" } } } },
            },
          },
        },
        channel: "discord",
        action: "read",
        params: { channelId: sibling, limit: 1 },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: { currentChannelProvider: "discord", currentChannelId: current },
      });
      if (mode === "allowed") {
        expect(await invocation).not.toBeNull();
        expect(requests.some((url) => url.includes(`/channels/${sibling}/messages`))).toBe(true);
      } else {
        await expect(invocation).rejects.toThrow(
          mode === "legacy"
            ? "exact current conversation"
            : mode === "revoked"
              ? "no longer active"
              : "not allowed",
        );
        expect(requests.some((url) => url.includes("/messages"))).toBe(false);
        if (mode === "legacy") {
          expect(requests).toEqual([]);
        }
        if (mode === "revoked") {
          expect(requests).toHaveLength(1);
        }
      }
    },
  );
});
