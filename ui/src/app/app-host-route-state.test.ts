/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { equalShellRouteState, selectShellRouteState } from "./app-host-route-state.ts";
import { committedRouterState } from "./app-host.test-support.ts";

describe("shell route state", () => {
  it("binds contextual navigation to the same rendered route as the workspace", () => {
    const data = { source: "host" };
    const renderSidebar = vi.fn(() => "Machine inventory");
    const state = committedRouterState("systems", "/systems", data);
    Object.assign(state.matches[0]!, { status: "success", module: { renderSidebar } });
    const sidebar = selectShellRouteState(state).contextualSidebar;
    expect(sidebar?.key).toBe("systems");
    expect(sidebar?.render(sidebar.data, sidebar.loaderPending, true)).toBe("Machine inventory");
    expect(renderSidebar).toHaveBeenCalledWith(data, false, true);

    // A cold import keeps the current main page, so its contextual list stays too.
    state.pendingMatches = [
      { ...state.matches[0]!, routeId: "tasks", status: "pending", module: undefined },
    ];
    expect(selectShellRouteState(state).contextualSidebar?.key).toBe("systems");
    Object.assign(state.pendingMatches[0]!, { status: "error", error: new Error("Route failed") });
    expect(selectShellRouteState(state).contextualSidebar).toBeUndefined();
  });

  it("updates a contextual sidebar when its loader settles without a route change", () => {
    const renderSidebar = vi.fn(() => "Machine inventory");
    const state = committedRouterState("systems", "/systems");
    Object.assign(state.matches[0]!, {
      status: "pending",
      module: { renderSidebar },
      isFetching: "loader",
    });
    const pending = selectShellRouteState(state);
    expect(equalShellRouteState(pending, selectShellRouteState(state))).toBe(true);
    const data = { source: "Gateway" };
    Object.assign(state.matches[0]!, { status: "success", data, isFetching: false });
    const ready = selectShellRouteState(state);
    expect(equalShellRouteState(pending, ready)).toBe(false);
    expect(equalShellRouteState(ready, selectShellRouteState(state))).toBe(true);
    Object.assign(state.matches[0]!, { data: { source: "Worker" } });
    expect(equalShellRouteState(ready, selectShellRouteState(state))).toBe(false);
    Object.assign(state.matches[0]!, { status: "error", error: new Error("Unavailable") });
    expect(selectShellRouteState(state).contextualSidebar).toBeUndefined();
    expect(equalShellRouteState(ready, selectShellRouteState(state))).toBe(false);
  });
});
