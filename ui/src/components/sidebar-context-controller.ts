import type { ReactiveController } from "lit";
import type { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";

/** Preserve each lower-sidebar scroll position without moving the global navigation. */
export class SidebarContextController implements ReactiveController {
  private readonly positions = new Map<string, number>();
  private presentedKey = "sessions";

  constructor(private readonly host: AppSidebarSessionNavigationElement) {
    host.addController(this);
  }

  hostUpdate(): void {
    if (this.key === this.presentedKey) {return;}
    const scroller = this.scroller;
    if (scroller) {this.positions.set(this.presentedKey, scroller.scrollTop);}
  }

  hostUpdated(): void {
    if (this.key === this.presentedKey) {return;}
    this.presentedKey = this.key;
    const scroller = this.scroller;
    if (scroller) {
      scroller.scrollTop = this.positions.get(this.key) ?? 0;
      if (!this.host.contextualSidebar) {this.host.sessionData.updateSessionsScrollState(scroller);}
    }
  }

  handleScroll(event: Event): void {
    const scroller = event.currentTarget;
    if (!(scroller instanceof HTMLElement)) {return;}
    this.positions.set(this.presentedKey, scroller.scrollTop);
    if (!this.host.contextualSidebar) {this.host.sessionData.updateSessionsScrollState(scroller);}
  }

  private get key(): string {
    return this.host.contextualSidebar?.key ?? "sessions";
  }
  private get scroller(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>(".sidebar-shell__body");
  }
}
