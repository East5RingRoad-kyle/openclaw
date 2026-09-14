import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
  type SidebarLifecycleState,
} from "../app-sidebar.ts";
import {
  openOwnerMenu,
  selectSessionMenuValue,
  setEffectiveOwner,
  visibleSessionKeys,
} from "./session-ownership.test-support.ts";
import "../../components/app-sidebar.ts";

async function selectSort(sidebar: SidebarLifecycleState, mode: string) {
  await selectSessionMenuValue(sidebar, `sort:${mode}`);
}

async function expectSort(sidebar: SidebarLifecycleState, mode: string, keys: string[]) {
  await selectSort(sidebar, mode);
  expect(visibleSessionKeys(sidebar)).toEqual(keys);
}

function sessionSharingHello(hasMultipleIdentities: boolean) {
  return {
    policy: { hasMultipleSessionSharingIdentities: hasMultipleIdentities },
  } as ApplicationGatewaySnapshot["hello"];
}

describe("AppSidebar session ownership", () => {
  it("owns People availability and fallback at the live session-owner roster", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({ hello: sessionSharingHello(true) });
    const keys = ["main", "b1", "a1", "b2", "a2"].map((id) => `agent:main:${id}`);
    const harness = createSessionsHarness("main", keys);
    const result = harness.sessions.state.result;
    if (!result) {
      throw new Error("expected session list");
    }
    for (const [index, id, label, updatedAt] of [
      [1, "profile-bob", "Bob", 40],
      [2, "profile-ada", "Ada", 40],
      [3, "profile-bob", "Bob", 30],
      [4, "profile-ada", "Ada", 20],
    ] as const) {
      Object.assign(result.sessions[index]!, {
        createdActor: { type: "human", id, label },
        owner: { actor: { type: "human", id, label } },
        updatedAt,
      });
    }
    result.owners = [{ type: "human", id: "profile-bob", label: "Bob" }];
    const createdOrder = keys.slice(1);
    // b1 and a1 tie at updatedAt 40; the ascending-key tie-break (mirroring
    // the gateway list order) puts a1 first.
    const updatedOrder = [keys[2]!, keys[1]!, keys[3]!, keys[4]!];
    const peopleOrder = [keys[2]!, keys[4]!, keys[1]!, keys[3]!];

    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    let menu = await openOwnerMenu(sidebar);
    expect(menu.querySelector('[value="sort:people"]')).toBeNull();
    expect(menu.querySelector('[value="sort:created"]')?.getAttribute("aria-checked")).toBe("true");
    menu.dispatchEvent(new Event("wa-after-hide", { bubbles: true }));
    await sidebar.updateComplete;

    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];
    gateway.publish({ hello: sessionSharingHello(false) });
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    await expectSort(sidebar, "people", peopleOrder);

    gateway.publish({ hello: null });
    await sidebar.updateComplete;
    menu = await openOwnerMenu(sidebar);
    expect(menu.querySelector('[value="sort:people"]')?.getAttribute("aria-checked")).toBe("true");
    expect(visibleSessionKeys(sidebar)).toEqual(peopleOrder);
    menu.dispatchEvent(new Event("wa-after-hide", { bubbles: true }));
    await sidebar.updateComplete;

    await expectSort(sidebar, "updated", updatedOrder);
    await expectSort(sidebar, "created", createdOrder);
    await expectSort(sidebar, "people", peopleOrder);
    result.owners = [{ type: "human", id: "profile-bob", label: "Bob" }];
    gateway.publish({ hello: sessionSharingHello(true) });
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    await sidebar.updateComplete;

    menu = await openOwnerMenu(sidebar);
    expect(menu.querySelector('[value="sort:people"]')).toBeNull();
    expect(menu.querySelector('[value="sort:created"]')?.getAttribute("aria-checked")).toBe("true");
    menu.dispatchEvent(new Event("wa-after-hide", { bubbles: true }));
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-bob", label: "Bob" },
    ];
    gateway.publish({ hello: sessionSharingHello(false) });
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    menu = await openOwnerMenu(sidebar);
    expect(menu.querySelector('[value="sort:people"]')).not.toBeNull();
    expect(menu.querySelector('[value="sort:created"]')?.getAttribute("aria-checked")).toBe("true");
  });

  it("groups sessions by owner based on the live session-owner roster", async () => {
    const gateway = createGatewayHarness({} as GatewayBrowserClient);
    gateway.publish({
      hello: sessionSharingHello(false),
      selfUser: { id: "profile-zoe", name: "Zoe" },
    });
    const harness = createSessionsHarness("main", [
      "agent:main:main",
      "agent:main:ada",
      "agent:main:zoe",
    ]);
    const result = harness.sessions.state.result;
    const ada = result?.sessions.find((row) => row.key.endsWith(":ada"));
    const zoe = result?.sessions.find((row) => row.key.endsWith(":zoe"));
    if (!result || !ada || !zoe) {
      throw new Error("expected owner rows");
    }
    setEffectiveOwner(ada, { type: "human", id: "profile-ada", label: "Ada" });
    setEffectiveOwner(zoe, {
      type: "human",
      id: "profile-zoe",
      label: "Zoe",
      avatarUrl: "/avatars/zoe",
    });
    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-zoe", label: "Zoe" },
    ];

    const { sidebar } = await mountSidebar(gateway.gateway, harness.sessions);
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;

    let menu = await openOwnerMenu(sidebar);
    expect(menu.querySelector('[value="grouping:person"]')).not.toBeNull();
    menu.dispatchEvent(new Event("wa-after-hide", { bubbles: true }));
    await sidebar.updateComplete;

    await selectSessionMenuValue(sidebar, "grouping:person");

    const ownerSections = () => [
      ...sidebar.querySelectorAll<HTMLElement>('[data-session-section^="person:"]'),
    ];
    expect(ownerSections().map((section) => section.dataset.sessionSection)).toEqual([
      "person:profile:profile-zoe",
      "person:profile:profile-ada",
    ]);
    expect(
      ownerSections()[0]?.querySelector(".sidebar-recent-sessions__label-text")?.textContent,
    ).toBe("Zoe");
    expect(
      ownerSections()[0]?.querySelector("openclaw-viewer-avatar")?.getAttribute("aria-hidden"),
    ).toBe("true");
    expect(
      ownerSections()[0]
        ?.querySelector(".sidebar-recent-sessions__head")
        ?.getAttribute("draggable"),
    ).toBe("false");
    // Derived person sections carry no stored-group menu; the only header action
    // is the owner filter, which reuses the group-actions reveal styling.
    expect(
      ownerSections()[0]?.querySelector('.sidebar-session-group-actions[aria-haspopup="menu"]'),
    ).toBeNull();
    expect(
      ownerSections()[0]
        ?.querySelector(".sidebar-session-person-filter")
        ?.getAttribute("aria-label"),
    ).toBe("Show only Zoe");

    gateway.publish({ hello: null });
    await sidebar.updateComplete;
    expect(ownerSections()).toHaveLength(2);
    menu = await openOwnerMenu(sidebar);
    expect(menu.querySelector('[value="grouping:person"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
    menu.dispatchEvent(new Event("wa-after-hide", { bubbles: true }));
    await sidebar.updateComplete;

    gateway.publish({ hello: sessionSharingHello(true) });
    result.owners = [{ type: "human", id: "profile-zoe", label: "Zoe" }];
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    expect(ownerSections()).toHaveLength(0);
    menu = await openOwnerMenu(sidebar);
    expect(menu.querySelector('[value="grouping:person"]')).toBeNull();
    expect(menu.querySelector('[value="grouping:category"]')?.getAttribute("aria-checked")).toBe(
      "true",
    );
    menu.dispatchEvent(new Event("wa-after-hide", { bubbles: true }));

    result.owners = [
      { type: "human", id: "profile-ada", label: "Ada" },
      { type: "human", id: "profile-zoe", label: "Zoe" },
    ];
    gateway.publish({ hello: sessionSharingHello(false) });
    harness.publishList({ result, agentId: "main" });
    await sidebar.updateComplete;
    expect(ownerSections()).toHaveLength(2);
  });
});
