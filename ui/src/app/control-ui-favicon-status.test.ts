/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_RUN_ACTIVITY_CHANGED_EVENT } from "../pages/chat/chat-history-events.ts";
import type { ChatPaneBase } from "../pages/chat/chat-pane-base.ts";
import { disposeSidebarContextLifecycles } from "../test-helpers/app-sidebar-context-lifecycle.ts";
import { createContext, createSessionsHarness } from "../test-helpers/app-sidebar.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { connectControlUiFavicon } from "./control-ui-favicon-status.runtime.ts";
import { client, createGatewayHarness, flushMicrotasks } from "./overlays-access.test-support.ts";
import { createApplicationOverlays } from "./overlays.ts";

const colors = {
  attention: "rgb(201,131,31)",
  working: "rgb(181,51,61)",
  done: "rgb(31,141,81)",
  disconnected: "rgb(101,111,121)",
};
const cleanups: Array<() => void> = [];
let palette: HTMLStyleElement;

function visibility(value: DocumentVisibilityState) {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(value);
  document.dispatchEvent(new Event("visibilitychange"));
}

function setup(mountPane = true) {
  const gatewayClient = client(async (method) =>
    method === "question.list" ? { questions: [] } : [],
  );
  const harness = createGatewayHarness(gatewayClient);
  harness.update({ hello: gatewayHelloForMethods(["question.list", "exec.approval.list"]) });
  const overlays = createApplicationOverlays(harness.gateway);
  const sessions = createSessionsHarness("main", ["agent:main:background"]);
  const context = {
    ...createContext(harness.gateway, sessions.sessions),
    overlays,
  };
  const shell = document.createElement("div");
  const pane = document.createElement("openclaw-chat-pane");
  let activity: ChatPaneBase["runActivity"] = {
    client: gatewayClient,
    agentId: "main",
    working: false,
    completion: null,
  };
  Object.defineProperty(pane, "runActivity", { get: () => activity });
  if (mountPane) {
    shell.append(pane);
  }
  document.body.append(shell);
  const disconnect = connectControlUiFavicon(shell, context);
  cleanups.push(() => {
    disconnect();
    overlays.dispose();
    shell.remove();
  });
  return {
    context,
    harness,
    sessions,
    publish: (next: NonNullable<ChatPaneBase["runActivity"]>) => {
      activity = next;
      pane.dispatchEvent(new Event(CHAT_RUN_ACTIVITY_CHANGED_EVENT, { bubbles: true }));
    },
    activity: () => activity!,
    disconnect,
  };
}

function iconColor(): string | null {
  const href = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!.getAttribute("href")!;
  if (href === "/favicon.svg") {
    return null;
  }
  const svg = new DOMParser().parseFromString(
    decodeURIComponent(href.slice(href.indexOf(",") + 1)),
    "image/svg+xml",
  );
  return svg.querySelector("circle")?.getAttribute("fill") ?? null;
}

beforeEach(() => {
  document.head.insertAdjacentHTML(
    "beforeend",
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg">',
  );
  palette = document.createElement("style");
  palette.textContent = `:root { ${[
    ["--warn", colors.attention],
    ["--accent", colors.working],
    ["--ok", colors.done],
    ["--muted", colors.disconnected],
    ["--bg", "rgb(250, 250, 250)"],
  ]
    .map(([token, color]) => `${token}: ${color};`)
    .join(" ")} }`;
  document.head.append(palette);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () => new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/>'),
    ),
  );
  visibility("visible");
});

afterEach(() => {
  cleanups
    .splice(0)
    .toReversed()
    .forEach((cleanup) => cleanup());
  disposeSidebarContextLifecycles();
  palette.remove();
  document.querySelectorAll('link[rel="icon"]').forEach((icon) => icon.remove());
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("favicon status source wiring", () => {
  it("prioritizes live approvals, work, unseen completion and disconnection, then restores the original", async () => {
    const { harness, publish, activity } = setup();
    await flushMicrotasks();
    expect(iconColor()).toBeNull();
    visibility("hidden");
    publish({ ...activity(), working: true });
    await vi.waitFor(() => expect(iconColor()).toBe(colors.working));
    harness.emitApproval("approval", Date.now());
    await vi.waitFor(() => expect(iconColor()).toBe(colors.attention));
    publish({
      ...activity(),
      completion: { phase: "done", runId: "completed", sessionKey: "main", occurredAt: Date.now() },
    });
    harness.emitEvent("exec.approval.resolved", { id: "approval", decision: "allow-once" });
    await vi.waitFor(() => expect(iconColor()).toBe(colors.working));
    publish({ ...activity(), working: false });
    await vi.waitFor(() => expect(iconColor()).toBe(colors.done));
    harness.update({ phase: "reconnecting" });
    await vi.waitFor(() => expect(iconColor()).toBe(colors.done));
    visibility("visible");
    await vi.waitFor(() => expect(iconColor()).toBe(colors.disconnected));
    harness.update({ phase: "connected" });
    await vi.waitFor(() => expect(iconColor()).toBeNull());
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
    expect(icon.getAttribute("href")).toBe("/favicon.svg");
    expect(icon.getAttribute("type")).toBe("image/svg+xml");
    expect(icon.hasAttribute("data-openclaw-original-favicon")).toBe(false);
  });

  it("ignores interrupted runs and clears an unseen completion when the selected agent changes", async () => {
    const { context, publish, activity } = setup();
    visibility("hidden");
    publish({
      ...activity(),
      completion: {
        phase: "interrupted",
        runId: "aborted",
        sessionKey: "main",
        occurredAt: Date.now(),
      },
    });
    await flushMicrotasks();
    expect(iconColor()).toBeNull();
    publish({
      ...activity(),
      completion: { phase: "done", runId: "finished", sessionKey: "main", occurredAt: Date.now() },
    });
    await vi.waitFor(() => expect(iconColor()).toBe(colors.done));
    context.agentSelection.set("work");
    await vi.waitFor(() => expect(iconColor()).toBeNull());
    context.agentSelection.set("main");
    await flushMicrotasks();
    expect(iconColor()).toBeNull();
  });

  it("uses pending question events and clears attention when the question resolves", async () => {
    const { harness } = setup();
    await flushMicrotasks();
    harness.emitEvent("question.requested", {
      id: "question",
      agentId: "main",
      sessionKey: "main",
      status: "pending",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      questions: [
        {
          questionId: "continue_run",
          header: "Continue",
          question: "Continue this run?",
          options: [{ label: "Continue", description: "Resume the run." }],
        },
      ],
    });
    await vi.waitFor(() => expect(iconColor()).toBe(colors.attention));
    harness.emitEvent("question.resolved", { id: "question", status: "cancelled" });
    await vi.waitFor(() => expect(iconColor()).toBeNull());
  });

  it.each([false, true])(
    "marks hidden roster completion without a pane (reconnect: %s)",
    async (reconnect) => {
      const { sessions, harness } = setup(false);
      const result = sessions.sessions.state.result!;
      const row = result.sessions[0]!;
      const publishStatus = (status: "running" | "done" | "failed") =>
        sessions.publish({
          result: { ...result, sessions: [{ ...row, status }] },
        });
      visibility("hidden");
      publishStatus("running");
      await vi.waitFor(() => expect(iconColor()).toBe(colors.working));
      publishStatus("failed");
      await vi.waitFor(() => expect(iconColor()).toBeNull());
      publishStatus("running");
      await vi.waitFor(() => expect(iconColor()).toBe(colors.working));
      if (reconnect) {
        harness.update({ phase: "reconnecting" });
        sessions.publish({ result: null });
        await vi.waitFor(() => expect(iconColor()).toBe(colors.disconnected));
        harness.update({ phase: "connected" });
        await flushMicrotasks();
        expect(iconColor()).toBeNull();
      }
      publishStatus("done");
      await vi.waitFor(() => expect(iconColor()).toBe(colors.done));
      visibility("visible");
      await vi.waitFor(() => expect(iconColor()).toBeNull());
      visibility("hidden");
      publishStatus("done");
      await flushMicrotasks();
      expect(iconColor()).toBeNull();
      publishStatus("running");
      await vi.waitFor(() => expect(iconColor()).toBe(colors.working));
      sessions.publish({ result: { ...result, sessions: [] } });
      await vi.waitFor(() => expect(iconColor()).toBeNull());
      publishStatus("done");
      await flushMicrotasks();
      expect(iconColor()).toBeNull();
    },
  );

  it("retains questions across reconnect but retires them when the Gateway owner changes", async () => {
    const { harness } = setup();
    await flushMicrotasks();
    harness.emitEvent("question.requested", {
      id: "previous-gateway-question",
      agentId: "main",
      sessionKey: "main",
      status: "pending",
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      questions: [
        {
          questionId: "decision",
          question: "Continue?",
          header: "Continue",
          options: [{ label: "Continue", description: "Resume the run." }],
        },
      ],
    });
    await vi.waitFor(() => expect(iconColor()).toBe(colors.attention));
    harness.update({ phase: "reconnecting" });
    await flushMicrotasks();
    expect(iconColor()).toBe(colors.attention);
    harness.gateway.connectionRevision += 1;
    harness.gateway.connection.gatewayUrl = "ws://other-gateway.test";
    harness.update({ client: null, phase: "connecting" });
    await vi.waitFor(() => expect(iconColor()).toBe(colors.disconnected));
  });

  it("restores the favicon and ignores later source events after teardown", async () => {
    const { harness, disconnect } = setup();
    harness.emitApproval("first", Date.now());
    await vi.waitFor(() => expect(iconColor()).toBe(colors.attention));
    disconnect();
    expect(iconColor()).toBeNull();
    harness.emitApproval("second", Date.now());
    visibility("hidden");
    await flushMicrotasks();
    expect(iconColor()).toBeNull();
  });
});
