import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import { isSessionRouteId } from "../app-route-paths.ts";
import type { RouteId } from "../app-routes.ts";
import { selectRenderedRouteMatch } from "./router-outlet.ts";

type SidebarRenderer = (data: unknown, loaderPending: boolean, presented?: boolean) => unknown;

export type ShellRouteState = {
  routeId?: RouteId;
  routeFailed?: boolean;
  location?: RouteLocation;
  committedRouteId?: RouteId;
  committedLocation?: RouteLocation;
  committedSessionKey?: string;
  contextualSidebar?: {
    key: RouteId;
    data: unknown;
    loaderPending: boolean;
    render: SidebarRenderer;
  };
};

function sessionKeyFromRouteData(routeId: RouteId, data: unknown): string | undefined {
  if (!isSessionRouteId(routeId) || !data || typeof data !== "object") {
    return undefined;
  }
  const record = data as { kind?: unknown; sessionKey?: unknown };
  return record.kind === "session" && typeof record.sessionKey === "string"
    ? record.sessionKey.trim() || undefined
    : undefined;
}

export function selectShellRouteState(routerState: RouterState<RouteId>): ShellRouteState {
  const match = selectRenderedRouteMatch(routerState.matches[0], routerState.pendingMatches[0]);
  const committedMatch = routerState.matches[0];
  const module = match?.module;
  const renderSidebar = hasSidebarRenderer(module) ? module.renderSidebar : undefined;
  const committedSessionKey = committedMatch
    ? sessionKeyFromRouteData(committedMatch.routeId, committedMatch.data)
    : undefined;
  return {
    ...(match
      ? {
          routeId: match.routeId,
          location: match.location,
          routeFailed: match.status === "error" || match.status === "notFound",
        }
      : routerState.status === "notFound"
        ? { routeFailed: true }
        : {}),
    ...(committedMatch
      ? { committedRouteId: committedMatch.routeId, committedLocation: committedMatch.location }
      : {}),
    ...(committedSessionKey ? { committedSessionKey } : {}),
    // Use the same selected match as the main outlet. Cold imports retain both
    // surfaces together; failed routes must not leave actionable stale context.
    ...(match &&
    (match.status === "success" || match.status === "pending") &&
    match.error === undefined &&
    typeof renderSidebar === "function"
      ? {
          contextualSidebar: {
            key: match.routeId,
            data: match.data,
            loaderPending: match.isFetching === "loader",
            render: renderSidebar,
          },
        }
      : {}),
  };
}

function hasSidebarRenderer(module: unknown): module is { renderSidebar: SidebarRenderer } {
  return (
    typeof module === "object" &&
    module !== null &&
    "renderSidebar" in module &&
    typeof module.renderSidebar === "function"
  );
}

export function equalShellRouteState(previous: ShellRouteState, next: ShellRouteState): boolean {
  return (
    previous.routeId === next.routeId &&
    previous.routeFailed === next.routeFailed &&
    previous.location?.pathname === next.location?.pathname &&
    previous.location?.search === next.location?.search &&
    previous.location?.hash === next.location?.hash &&
    previous.committedRouteId === next.committedRouteId &&
    previous.committedLocation?.pathname === next.committedLocation?.pathname &&
    previous.committedLocation?.search === next.committedLocation?.search &&
    previous.committedLocation?.hash === next.committedLocation?.hash &&
    previous.committedSessionKey === next.committedSessionKey &&
    previous.contextualSidebar?.key === next.contextualSidebar?.key &&
    previous.contextualSidebar?.data === next.contextualSidebar?.data &&
    previous.contextualSidebar?.loaderPending === next.contextualSidebar?.loaderPending &&
    previous.contextualSidebar?.render === next.contextualSidebar?.render
  );
}
