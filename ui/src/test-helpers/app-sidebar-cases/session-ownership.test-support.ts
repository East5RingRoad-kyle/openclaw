import { expect } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { SidebarLifecycleState } from "../app-sidebar.ts";
import { waitForFast } from "../wait-for.ts";

export async function openOwnerMenu(sidebar: SidebarLifecycleState): Promise<HTMLElement> {
  const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort");
  if (!trigger) {
    throw new Error("expected session sort trigger");
  }
  trigger.click();
  await sidebar.updateComplete;
  const menu = sidebar.querySelector<HTMLElement>(".sidebar-session-sort-menu");
  if (!menu) {
    throw new Error("expected session sort menu");
  }
  return menu;
}

export async function selectSessionMenuValue(sidebar: SidebarLifecycleState, value: string) {
  const menu = await openOwnerMenu(sidebar);
  expect(menu.querySelector(`[value="${value}"]`)).not.toBeNull();
  menu.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      detail: { item: { value } },
    }),
  );
  await sidebar.updateComplete;
  await waitForFast(() => expect(sidebar.sessionData.sessionsLoading).toBe(false));
  await sidebar.updateComplete;
}

export function visibleSessionKeys(sidebar: SidebarLifecycleState): string[] {
  return [...sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session[data-session-key]")]
    .filter((row) => !row.classList.contains("sidebar-recent-session--child"))
    .map((row) => row.dataset.sessionKey ?? "");
}

export function setEffectiveOwner(
  row: GatewaySessionRow,
  actor: NonNullable<GatewaySessionRow["createdActor"]> & { id: string },
) {
  const owner: typeof actor = {
    ...actor,
    identity:
      actor.type === "agent" ? { type: "agent", id: actor.id } : { type: "profile", id: actor.id },
  };
  row.createdActor = owner;
  row.owner = { actor: owner };
}
