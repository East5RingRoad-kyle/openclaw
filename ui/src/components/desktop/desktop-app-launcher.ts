import type { DesktopSource, WorkerDesktopLaunchResult } from "@openclaw/gateway-protocol";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { DesktopAppId } from "./desktop-panel-connection.ts";
import type { DesktopPanelState } from "./desktop-panel-state.ts";

type LaunchTarget = {
  client: GatewayBrowserClient | null;
  source: DesktopSource | null;
  presented: boolean;
  state: DesktopPanelState;
  apps: readonly DesktopAppId[];
};

/** Owns launch feedback and retires replies when the viewer changes source or leaves. */
export class DesktopAppLauncher {
  app: DesktopAppId | null = null;
  error: string | null = null;
  private generation = 0;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly target: () => LaunchTarget,
  ) {}

  clear(): void {
    this.generation += 1;
    const changed = this.app !== null || this.error !== null;
    this.app = null;
    this.error = null;
    if (changed) {
      this.host.requestUpdate();
    }
  }

  async launch(app: DesktopAppId): Promise<void> {
    const { client, source, presented, state, apps } = this.target();
    if (
      !client ||
      !presented ||
      source?.kind !== "environment" ||
      (state !== "connecting" && state !== "connected") ||
      !apps.includes(app) ||
      this.app === app
    ) {
      return;
    }
    const generation = ++this.generation;
    this.app = app;
    this.error = null;
    this.host.requestUpdate();
    try {
      await client.request<WorkerDesktopLaunchResult>("desktop.launch", { source, app });
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.error = formatUiError(error);
    }
    if (generation === this.generation) {
      this.app = null;
      this.host.requestUpdate();
    }
  }
}
