import { definePage } from "@openclaw/uirouter";
import { html, nothing } from "lit";
import { routePageSpec, type RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import type { SystemsRouteData } from "./systems-controller.ts";

export const page = definePage({
  ...routePageSpec("systems"),
  loaderDeps: (context: ApplicationContext<RouteId>) =>
    String(gatewayPresentationScope(context.gateway).key),
  // Inventory is refreshed by the mounted controller, not by a second route loader.
  staleTime: Infinity,
  loader: async (context: ApplicationContext<RouteId>): Promise<SystemsRouteData> => {
    const { SystemsController } = await import("./systems-controller.ts");
    return { controller: new SystemsController(context) };
  },
  component: () =>
    import("./systems-page.ts").then(() => ({
      // The router cache retains controller state; Chat keeps the single retained DOM slot.
      render: (data: SystemsRouteData | undefined, _pending: boolean, presented = true) =>
        data
          ? html`<openclaw-systems-page
              .routeData=${data}
              .presented=${presented}
            ></openclaw-systems-page>`
          : nothing,
      renderSidebar: (data: SystemsRouteData | undefined) =>
        data
          ? html`<openclaw-systems-sidebar
              .controller=${data.controller}
            ></openclaw-systems-sidebar>`
          : nothing,
    })),
});
