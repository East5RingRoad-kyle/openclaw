import { expect, it } from "vitest";
import { SIDEBAR_GEOMETRY_COMMIT_EVENT } from "../pages/chat/sidebar-layout.ts";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([
    { count: 1, direction: "ltr" },
    { count: 2, direction: "ltr" },
    { count: 5, direction: "ltr" },
    { count: 8, direction: "ltr" },
    { count: 80, direction: "ltr" },
    { count: 80, direction: "rtl" },
  ])(
    "keeps the rail anchored as Task progress and the composer grow ($count, $direction messages)",
    async ({ count, direction }) => {
      await suite.withPage(
        { colorScheme: "dark", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
        async ({ page }) => {
          const sessionKey = "agent:main:main";
          await installMockGateway(page, {
            sessionKey,
            historyMessages: Array.from({ length: count }, (_, index) => ({
              __openclaw: { id: `stable-rail-${index}`, seq: index + 1 },
              role: index % 2 === 0 ? "user" : "assistant",
              content: [
                {
                  type: "text",
                  text: `${direction === "rtl" ? "راجع الملاحظات. " : ""}Conversation checkpoint ${index + 1}: review the notes and confirm the next step.`,
                },
              ],
            })),
            featureMethods: [...defaultControlUiFeatureMethods, "progressCard.get"],
            methodResponses: {
              "progressCard.get": {
                card: {
                  sessionKey,
                  revision: 1,
                  updatedAt: Date.now(),
                  markdown: "Review the conversation and verify navigation.",
                  steps: [
                    { step: "Read the conversation", status: "completed" },
                    { step: "Verify navigation controls", status: "in_progress" },
                    { step: "Check the final evidence", status: "pending" },
                  ],
                },
              },
            },
          });
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.locator(`.chat-text[dir="${direction}"]`).first().waitFor();
          const card = page.locator(".session-progress-card--composer");
          await card.waitFor();
          const summary = card.locator("summary");
          if ((await card.getAttribute("open")) !== null) {
            await summary.click();
          }
          await expect
            .poll(() =>
              card.evaluate((element) => getComputedStyle(element, "::details-content").blockSize),
            )
            .toBe("0px");
          const track = page.locator(".chat-position-rail__track");
          const marks = page.locator(".chat-position-rail__marks");
          const composer = page.locator(".agent-chat__composer-shell");
          await track.waitFor();
          const bounds = () =>
            track.evaluate((element) => element.getBoundingClientRect().toJSON());
          const collapsed = await bounds();
          const collapsedComposer = (await composer.boundingBox())!;
          for (const open of [true, false, true]) {
            await summary.click();
            await expect
              .poll(() => card.evaluate((element) => (element as HTMLDetailsElement).open))
              .toBe(open);
            if (open) {
              await expect
                .poll(async () => (await composer.boundingBox())!.height)
                .toBeGreaterThan(collapsedComposer.height + 80);
            } else {
              await expect
                .poll(async () => (await composer.boundingBox())!.height)
                .toBe(collapsedComposer.height);
            }
            expect((await bounds()).top).toBe(collapsed.top);
          }
          const expandedHeight = (await marks.boundingBox())!.height;
          await page
            .locator(".agent-chat__composer-combobox textarea")
            .fill(
              Array.from(
                { length: 12 },
                (_, index) => `Review note ${index + 1}: keep navigation visible.`,
              ).join("\n"),
            );
          await expect
            .poll(async () => (await composer.boundingBox())!.height)
            .toBeGreaterThan(collapsedComposer.height + 180);
          expect((await bounds()).top).toBe(collapsed.top);
          if (count === 80) {
            expect((await marks.boundingBox())!.height).toBeLessThan(expandedHeight);
            expect(
              await marks.evaluate((element) => element.scrollHeight > element.clientHeight),
            ).toBe(true);
          }
          await expect
            .poll(() =>
              marks.evaluate(async (element) => {
                const height = element.getBoundingClientRect().height;
                await new Promise<void>((resolve) => {
                  requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
                });
                return height === element.getBoundingClientRect().height;
              }),
            )
            .toBe(true);
          const markers = marks.locator(".chat-position-rail__marker");
          expect(
            await marks.evaluate(
              (element) =>
                element.getBoundingClientRect().height >=
                element.querySelector(".chat-position-rail__marker")!.getBoundingClientRect()
                  .height,
            ),
          ).toBe(true);
          await page.locator(".chat-thread").focus();
          await page.keyboard.press("Tab");
          await page.keyboard.press("Home");
          // Every entry remains reachable above the composer, including both ends.
          for (let index = 0; index < count; index++) {
            if (index > 0) {
              await page.keyboard.press("ArrowDown");
            }
            await expect
              .poll(() =>
                markers.nth(index).evaluate((element) => {
                  const marker = element.getBoundingClientRect();
                  const viewport = element
                    .closest(".chat-position-rail__marks")!
                    .getBoundingClientRect();
                  const composerTop = document
                    .querySelector(".agent-chat__composer-shell")!
                    .getBoundingClientRect().top;
                  return (
                    element === document.activeElement &&
                    marker.top >= viewport.top &&
                    // Scroll ranges round a fractional viewport height to CSS pixels.
                    marker.bottom <= Math.ceil(viewport.bottom) &&
                    marker.bottom < composerTop
                  );
                }),
              )
              .toBe(true);
          }
          const preview = page.locator(".chat-position-rail__preview");
          const previewClearsComposer = () =>
            preview.evaluate(
              (element) =>
                element.getBoundingClientRect().bottom <=
                document.querySelector(".agent-chat__composer-shell")!.getBoundingClientRect().top,
            );
          await expect.poll(() => preview.textContent()).toContain(`checkpoint ${count}:`);
          await expect.poll(previewClearsComposer).toBe(true);
          await markers.last().press("Escape");
          // The button is already visible; avoid locator hover's extra scrollIntoView.
          const point = await markers.last().evaluate((element) => {
            const markerBounds = element.getBoundingClientRect();
            const x = markerBounds.x + markerBounds.width / 2;
            const y = markerBounds.y + markerBounds.height / 2;
            return { x, y, hitsMarker: element.contains(document.elementFromPoint(x, y)) };
          });
          expect(point.hitsMarker).toBe(true);
          await page.mouse.move(point.x, point.y);
          await expect.poll(() => preview.textContent()).toContain(`checkpoint ${count}:`);
          await expect.poll(previewClearsComposer).toBe(true);
          await page.mouse.move(900, 20);
          await markers.last().press("Home");
          await expect
            .poll(() => markers.first().evaluate((element) => element === document.activeElement))
            .toBe(true);
          await markers.first().press("End");
          await expect
            .poll(() => markers.last().evaluate((element) => element === document.activeElement))
            .toBe(true);
          await markers.last().press("Escape");
          await page.setViewportSize({ width: 390, height: 844 });
          await track.waitFor({ state: "hidden" });
        },
      );
    },
  );
  it("keeps the rail and its first preview clear in a bottom-docked chat pane", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 1440 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const sessionKey = "agent:main:main";
        await installMockGateway(page, {
          sessionKey,
          historyMessages: Array.from({ length: 80 }, (_, index) => ({
            __openclaw: { id: `docked-rail-${index}`, seq: index + 1 },
            role: index % 2 === 0 ? "user" : "assistant",
            content: [
              { type: "text", text: `Review checkpoint ${index + 1} and its supporting notes.` },
            ],
          })),
        });
        await page.addInitScript(createControlUiMockSameOriginGatewayScript());
        await page.addInitScript(
          ({ key, sessionKey: seededSessionKey }) =>
            localStorage.setItem(
              key,
              JSON.stringify({
                sessionKey: seededSessionKey,
                sidebarSessionLayouts: {
                  [seededSessionKey]: {
                    columns: [
                      {
                        id: "side-panel-column",
                        side: "right",
                        panels: [{ id: "workspace", slot: "workspace" }],
                        activePanelId: "workspace",
                        height: 700,
                        width: 480,
                      },
                    ],
                    dock: "bottom",
                    open: true,
                    expanded: false,
                  },
                },
              }),
            ),
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), sessionKey },
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        await page.locator(".sidebar-region--bottom.sidebar-region--open").waitFor();
        const transcript = page.locator(".chat-thread");
        const track = page.locator(".chat-position-rail__track");
        const marks = page.locator(".chat-position-rail__marks");
        const first = marks.locator(".chat-position-rail__marker").first();
        await first.waitFor();
        await transcript.evaluate((element) => {
          element.scrollTop = 0;
        });
        await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
        const top = (await track.boundingBox())!.y;
        await transcript.evaluate((element) => {
          element.scrollTop = 200;
        });
        await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(200);
        expect((await track.boundingBox())!.y).toBe(top);
        await marks.evaluate((element) => {
          element.scrollTop = 0;
        });
        await first.hover();
        const preview = page.locator(".chat-position-rail__preview");
        await preview.waitFor();
        expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(
          (await transcript.boundingBox())!.y,
        );
        await page.mouse.move(900, 20);
        await transcript.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Home");
        await expect
          .poll(() => first.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await preview.waitFor();
        expect((await preview.boundingBox())!.y).toBeGreaterThanOrEqual(
          (await transcript.boundingBox())!.y,
        );
      },
    );
  });
  it.each(["dark", "light"] as const)(
    "tracks reader position and keyboard jumps in %s mode",
    async (colorScheme) => {
      await suite.withPage(
        {
          colorScheme,
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1440 },
          ...(captureUiProofEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1440 } } }
            : {}),
        },
        async ({ page }) => {
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const messages = Array.from({ length: 240 }, (_, index) => ({
            __openclaw: { id: `position-rail-${index}`, seq: index + 1 },
            content:
              index === 0
                ? [
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: "image/png",
                        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=",
                      },
                    },
                  ]
                : [
                    {
                      text:
                        index === 1
                          ? "![Preview](data:image/gif;base64,R0lGODlhAAQABIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7)"
                          : `Transcript **checkpoint ${index}** with \`code\` and *emphasis*.`,
                      type: "text",
                    },
                  ],
            role: index % 2 === 0 ? "user" : "assistant",
            timestamp: Date.UTC(2026, 8, 4, 12, index),
          }));
          await installMockGateway(page, { historyMessages: messages });
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          await page.addInitScript(
            ({ key, mode }) => {
              localStorage.setItem(
                key,
                JSON.stringify({
                  ...JSON.parse(localStorage.getItem(key) ?? "{}"),
                  theme: mode,
                  themeMode: mode,
                }),
              );
            },
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), mode: colorScheme },
          );
          await page.goto(`${suite.server.baseUrl}chat`);
          const transcript = page.locator(".chat-thread");
          await transcript
            .locator(".chat-virtual-row")
            .getByText("Transcript checkpoint 239 with code and emphasis.", { exact: true })
            .waitFor();

          const rail = page.locator(".chat-position-rail");
          const markers = rail.locator(".chat-position-rail__marker");
          const preview = rail.locator(".chat-position-rail__preview-copy");
          await markers.first().waitFor();
          await expect.poll(() => markers.count()).toBe(240);
          const track = rail.locator(".chat-position-rail__track");
          const trackBounds = (await track.boundingBox())!;
          const transcriptBounds = (await transcript.boundingBox())!;
          const contentBounds = (await transcript.locator(".chat-thread-inner").boundingBox())!;
          const conversationBounds = (await page
            .locator(".chat-main__conversation")
            .boundingBox())!;
          expect(trackBounds.x).toBeGreaterThanOrEqual(transcriptBounds.x);
          expect(trackBounds.x + trackBounds.width).toBeLessThan(contentBounds.x);
          expect(trackBounds.height).toBeCloseTo(900 * 0.45, 2);
          expect(
            Math.abs(
              trackBounds.y +
                trackBounds.height / 2 -
                (conversationBounds.y + conversationBounds.height / 2),
            ),
          ).toBeLessThan(2);
          const markBounds = await markers.evaluateAll((items) =>
            items.map((item) => item.getBoundingClientRect().toJSON()),
          );
          expect(Math.min(...markBounds.map((bounds) => bounds.width))).toBeGreaterThanOrEqual(44);
          for (let index = 1; index < markBounds.length; index++) {
            expect(markBounds[index]!.y - markBounds[index - 1]!.y).toBeCloseTo(12, 2);
            expect(markBounds[index]!.y).toBeCloseTo(markBounds[index - 1]!.bottom, 2);
          }
          expect(await markers.first().getAttribute("aria-label")).toContain("1 of 240");
          expect(await markers.last().getAttribute("aria-label")).toContain("240 of 240");
          expect(await preview.count()).toBe(0);
          expect(await rail.locator('[role="status"]').count()).toBe(0);
          await captureUiProof(suite, page, "chat-position-rail", "idle.png");

          // Exercise the composite through real Tab navigation, including reentry.
          const focusedMarkerId = () =>
            page.evaluate(() => document.activeElement?.getAttribute("data-position-marker-id"));
          const currentMarkerId = () =>
            rail.locator('[aria-current="true"]').getAttribute("data-position-marker-id");
          await expect.poll(() => rail.locator('[aria-current="true"]').count()).toBe(1);
          await transcript.focus();
          const entryId = await currentMarkerId();
          await page.keyboard.press("Tab");
          await expect.poll(focusedMarkerId).toBe(entryId);
          await page.keyboard.press("Home");
          await page.keyboard.press("ArrowDown");
          await expect.poll(focusedMarkerId).toBe("position-rail-1");
          await expect.poll(() => preview.count()).toBe(1);
          await page.keyboard.press("ArrowUp");
          await expect.poll(focusedMarkerId).toBe("position-rail-0");
          await expect.poll(() => rail.locator('[tabindex="0"]').count()).toBe(1);
          await page.keyboard.press("Tab");
          expect(await focusedMarkerId()).toBeNull();
          await transcript.focus();
          const reentryId = await currentMarkerId();
          await page.keyboard.press("Tab");
          await expect.poll(focusedMarkerId).toBe(reentryId);
          await page.keyboard.press("Shift+Tab");
          expect(await transcript.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
          await page.keyboard.press("Tab");
          await page.keyboard.press("Home");
          await page.keyboard.press("Enter");
          await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
          await page.keyboard.press("Escape");
          expect(await transcript.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
          await expect.poll(() => preview.count()).toBe(0);
          await page.keyboard.press("Tab");
          await page.keyboard.press("End");
          await page.keyboard.press(" ");
          await expect.poll(currentMarkerId).toBe("position-rail-239");
          await page.keyboard.press("Escape");

          const currentMarkerIndex = () =>
            markers.evaluateAll((items) =>
              items.findIndex((item) => item.getAttribute("aria-current") === "true"),
            );
          const scroller = rail.locator(".chat-position-rail__marks");
          const fades = () =>
            scroller.evaluate((element) => ({
              top: element.hasAttribute("data-overflow-top"),
              bottom: element.hasAttribute("data-overflow-bottom"),
            }));
          const currentIsVisible = () =>
            scroller.evaluate((element) => {
              const current = element
                .querySelector('[aria-current="true"]')!
                .getBoundingClientRect();
              const viewport = element.getBoundingClientRect();
              return current.top >= viewport.top && current.bottom <= viewport.bottom;
            });
          const strokeSizes = () =>
            markers.evaluateAll((items) => [
              ...new Set(
                items.map((item) => {
                  const style = getComputedStyle(item.querySelector(".chat-position-rail__tick")!);
                  return `${style.width} × ${style.height}`;
                }),
              ),
            ]);
          await page.mouse.move(700, 80);
          await expect.poll(strokeSizes).toEqual(["8px × 2px"]);
          const colors = await rail.evaluate((element) => {
            const probe = document.createElement("span");
            element.append(probe);
            probe.style.color = "var(--muted)";
            const muted = getComputedStyle(probe).color;
            probe.style.color = "var(--text)";
            const text = getComputedStyle(probe).color;
            probe.remove();
            return { muted, text };
          });
          const strokeColor = (index: number) =>
            markers
              .nth(index)
              .locator(".chat-position-rail__tick")
              .evaluate((element) => getComputedStyle(element).backgroundColor);
          const visibilityMatchesViewport = () =>
            transcript.evaluate((element) => {
              const viewport = element.getBoundingClientRect();
              const covered =
                Number.parseFloat(
                  getComputedStyle(element).getPropertyValue("--chat-transcript-composer-underlap"),
                ) || 0;
              const marks = [
                ...element.querySelectorAll<HTMLElement>(".chat-position-rail__marker"),
              ];
              const ids = new Set(marks.map((mark) => mark.dataset.positionMarkerId));
              const expected = [
                ...element.querySelectorAll<HTMLElement>(".chat-bubble[data-entry-id]"),
              ]
                .filter((bubble) => {
                  const rect = bubble.getBoundingClientRect();
                  return (
                    ids.has(bubble.dataset.entryId) &&
                    rect.height > 0 &&
                    rect.bottom > viewport.top &&
                    rect.top < viewport.bottom - covered
                  );
                })
                .map((bubble) => bubble.dataset.entryId);
              const actual = new Set(
                marks
                  .filter((mark) => mark.hasAttribute("data-visible"))
                  .map((mark) => mark.dataset.positionMarkerId),
              );
              return (
                expected.length > 1 &&
                expected.length === actual.size &&
                expected.every((id) => actual.has(id))
              );
            });
          await expect.poll(visibilityMatchesViewport).toBe(true);
          const firstMarkerNode = await markers.first().elementHandle();
          await expect.poll(currentMarkerIndex).toBe(239);
          expect(await strokeColor(0)).toMatch(/\/ 0\.4\)$/);
          expect(await strokeColor(239)).toBe(colors.muted);
          await expect.poll(fades).toEqual({ top: true, bottom: false });
          await expect.poll(currentIsVisible).toBe(true);
          await transcript.evaluate((element) => {
            element.scrollTop = Math.round((element.scrollHeight - element.clientHeight) / 2);
          });
          await expect.poll(currentMarkerIndex).toBeGreaterThan(50);
          await expect.poll(currentMarkerIndex).toBeLessThan(200);
          await expect.poll(fades).toEqual({ top: true, bottom: true });
          await expect.poll(visibilityMatchesViewport).toBe(true);
          expect(await firstMarkerNode!.evaluate((element) => element.isConnected)).toBe(true);
          await expect.poll(currentIsVisible).toBe(true);
          await captureUiProof(suite, page, "chat-position-rail", "stress-both-fades.png");

          // Crossing the midpoint can change the anchor while the visible cohort stays fixed.
          const crossingOffset = await transcript.evaluate((element) => {
            const row = element
              .querySelector('[data-entry-id="position-rail-121"]')!
              .closest(".chat-virtual-row")!;
            return (
              element.scrollTop +
              row.getBoundingClientRect().top -
              element.getBoundingClientRect().top -
              element.clientHeight / 2
            );
          });
          const visibleMarkerIds = () =>
            markers.evaluateAll((items) =>
              items
                .filter((item) => item.hasAttribute("data-visible"))
                .map((item) => item.getAttribute("data-position-marker-id")),
            );
          await transcript.evaluate((element, offset) => {
            element.scrollTop = offset - 2;
          }, crossingOffset);
          await expect.poll(currentMarkerIndex).toBe(120);
          await expect.poll(visibilityMatchesViewport).toBe(true);
          const cohort = await visibleMarkerIds();
          await transcript.evaluate((element, offset) => {
            element.scrollTop = offset + 2;
          }, crossingOffset);
          await expect.poll(currentMarkerIndex).toBe(121);
          expect(await visibleMarkerIds()).toEqual(cohort);
          await transcript.evaluate((element, offset) => {
            element.scrollTop = offset - 2;
          }, crossingOffset);
          await expect.poll(currentMarkerIndex).toBe(120);
          expect(await visibleMarkerIds()).toEqual(cohort);

          // Wheel exploration stays within the rail and does not snap back to the active mark.
          const readerOffset = await transcript.evaluate((element) => element.scrollTop);
          await scroller.hover();
          await page.mouse.wheel(0, -6000);
          await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
          await expect.poll(fades).toEqual({ top: false, bottom: true });
          await markers.nth(1).hover();
          const previewImage = preview.locator("img");
          await expect
            .poll(() => previewImage.evaluate((image: HTMLImageElement) => image.naturalHeight))
            .toBe(1024);
          expect(
            await preview.evaluate(
              (element) =>
                element.getBoundingClientRect().height /
                Number.parseFloat(getComputedStyle(element).lineHeight),
            ),
          ).toBeLessThanOrEqual(3.01);
          await page.mouse.move(600, 100);

          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 4");
          expect(await preview.locator("strong").textContent()).toBe("checkpoint 4");
          expect(await preview.locator("code").textContent()).toBe("code");
          expect(await preview.locator("em").textContent()).toBe("emphasis");
          expect(await transcript.evaluate((element) => element.scrollTop)).toBe(readerOffset);
          expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
          // Pointer focus must not move an edge mark before its click completes.
          await scroller.evaluate((element) => {
            element.scrollTop = element.querySelector<HTMLElement>(
              '[data-position-marker-id="position-rail-60"]',
            )!.offsetTop;
          });
          const edgeBounds = (await markers.nth(60).boundingBox())!;
          await page.mouse.move(edgeBounds.x + 5, edgeBounds.y + edgeBounds.height / 2);
          await page.mouse.down();
          const pressedBounds = (await markers.nth(60).boundingBox())!;
          await page.mouse.up();
          expect(pressedBounds.y).toBeCloseTo(edgeBounds.y, 2);
          const edgeTarget = transcript.locator('.chat-bubble[data-entry-id="position-rail-60"]');
          await expect
            .poll(() =>
              edgeTarget.evaluate((element) => {
                const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
                const bubble = element.getBoundingClientRect();
                return bubble.top >= viewport.top && bubble.bottom <= viewport.bottom;
              }),
            )
            .toBe(true);
          await page.mouse.move(700, 80);
          await transcript.evaluate((element) => {
            element.scrollTop = 0;
          });
          await expect.poll(currentMarkerIndex).toBeLessThan(10);
          await expect.poll(currentIsVisible).toBe(true);

          const composer = page.locator(".agent-chat__composer-combobox textarea");
          await composer.focus();
          const strokeColors = () =>
            markers.evaluateAll((items) =>
              items.map(
                (item) =>
                  getComputedStyle(item.querySelector(".chat-position-rail__tick")!)
                    .backgroundColor,
              ),
            );
          const restingColors = await strokeColors();
          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 4");
          await expect
            .poll(() =>
              markers.evaluateAll((items) =>
                items
                  .slice(0, 9)
                  .map((item) =>
                    Number.parseFloat(
                      getComputedStyle(item.querySelector(".chat-position-rail__tick")!).width,
                    ),
                  ),
              ),
            )
            .toEqual([8, 12, 16, 24, 32, 24, 16, 12, 8]);
          await expect
            .poll(strokeColors)
            .toEqual(restingColors.map((color, index) => (index === 4 ? colors.text : color)));
          await captureUiProof(suite, page, "chat-position-rail", "scroll-follow-hover.png");

          const previewBounds = await preview.boundingBox();
          expect(previewBounds).not.toBeNull();
          await page.mouse.move(
            previewBounds!.x + previewBounds!.width / 2,
            previewBounds!.y + previewBounds!.height / 2,
            { steps: 20 },
          );
          expect(await preview.textContent()).toContain("Transcript checkpoint 4");
          await captureUiProof(suite, page, "chat-position-rail", "hover-reading.png");
          await page.keyboard.press("Escape");
          await expect.poll(() => preview.count()).toBe(0);
          expect(await composer.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );

          await page.mouse.move(600, 100);
          await markers.nth(4).hover();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 4");
          await page.mouse.move(600, 100);
          await expect.poll(() => preview.count()).toBe(0);
          await expect.poll(strokeSizes).toEqual(["8px × 2px"]);
          await expect.poll(visibilityMatchesViewport).toBe(true);
          await markers.first().hover();
          await expect
            .poll(async () => (await preview.textContent())?.trim())
            .toBe("Preview unavailable");
          expect(await preview.boundingBox()).not.toBeNull();
          await page.mouse.move(600, 100);
          await markers.nth(5).focus();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 5");
          await markers.nth(5).press("ArrowDown");
          await expect
            .poll(() =>
              page.evaluate(
                () => document.activeElement?.getAttribute("data-position-marker-id") ?? null,
              ),
            )
            .toBe("position-rail-6");
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 6");
          expect(
            await markers
              .nth(6)
              .locator(".chat-position-rail__tick")
              .evaluate((element) => getComputedStyle(element).width),
          ).toBe("8px");
          await markers.nth(120).focus();
          await expect.poll(() => preview.textContent()).toContain("Transcript checkpoint 120");
          expect(await transcript.evaluate((element) => element.scrollTop)).toBe(0);
          const focusedBounds = (await markers.nth(120).boundingBox())!;
          const scrollBounds = (await scroller.boundingBox())!;
          expect(focusedBounds.y).toBeGreaterThan(scrollBounds.y + 60);
          expect(focusedBounds.y + focusedBounds.height).toBeLessThan(
            scrollBounds.y + scrollBounds.height - 60,
          );
          const flashPaint = (index: number) =>
            transcript
              .locator(`.chat-bubble[data-entry-id="position-rail-${index}"]`)
              .evaluate((element) => {
                const overlay = getComputedStyle(element, "::after");
                return {
                  visible: overlay.content !== "none" && Number.parseFloat(overlay.opacity) > 0,
                  animated: overlay.animationName !== "none",
                  outline: getComputedStyle(element).outlineStyle,
                };
              });
          for (const index of [120, 121]) {
            await markers.nth(index).click();
            const revealed = transcript.locator(
              `.chat-bubble[data-entry-id="position-rail-${index}"]`,
            );
            await expect
              .poll(() =>
                revealed.evaluate((element) => {
                  const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
                  const bubble = element.getBoundingClientRect();
                  return bubble.top >= viewport.top && bubble.bottom <= viewport.bottom;
                }),
              )
              .toBe(true);
            await expect
              .poll(() => flashPaint(index))
              .toEqual({ visible: true, animated: true, outline: "none" });
            await captureUiProof(suite, page, "chat-position-rail", `jump-flash-${index}.png`);
            await expect.poll(async () => (await flashPaint(index)).visible).toBe(false);
          }
          await markers.nth(120).press("Escape");
          await expect.poll(() => preview.count()).toBe(0);
          await markers.nth(120).press("Home");
          await expect
            .poll(() => markers.first().evaluate((element) => element === document.activeElement))
            .toBe(true);
          await markers.first().press(" ");
          await expect.poll(() => transcript.evaluate((element) => element.scrollTop)).toBe(0);
          await markers.first().press("End");
          await markers.last().press("Enter");
          await expect.poll(currentMarkerIndex).toBe(239);

          // Pane-local width matters even inside an otherwise wide desktop.
          await transcript.evaluate((element) => {
            element.style.width = "800px";
          });
          await markers.first().waitFor({ state: "hidden" });
          await transcript.evaluate((element) => {
            element.style.removeProperty("width");
          });
          await markers.first().waitFor({ state: "visible" });

          await page.setViewportSize({ height: 900, width: 900 });
          await markers.first().waitFor({ state: "hidden" });
          await captureUiProof(suite, page, "chat-position-rail", "narrow-pane.png");
          await page.setViewportSize({ height: 844, width: 390 });
          await markers.first().waitFor({ state: "hidden" });
          await captureUiProof(suite, page, "chat-position-rail", "mobile.png");
          await page.setViewportSize({ height: 900, width: 1440 });
          await markers.first().waitFor({ state: "visible" });
          await page.emulateMedia({ reducedMotion: "reduce" });
          expect(
            await markers
              .first()
              .locator(".chat-position-rail__tick")
              .evaluate((element) =>
                Number.parseFloat(getComputedStyle(element).transitionDuration),
              ),
          ).toBeLessThanOrEqual(0.00001); // Global reduced-motion policy uses 0.01ms.

          await markers.last().click();
          await expect
            .poll(() => flashPaint(239))
            .toEqual({ visible: true, animated: false, outline: "none" });
          await expect.poll(async () => (await flashPaint(239)).visible).toBe(false);

          // Saved widths can consume the gutter even in a wide desktop pane.
          for (const width of ["100%", "none", "95%", "48rem"]) {
            await page.goto(`${suite.server.baseUrl}settings/appearance#settings-appearance-chat`);
            const widthInput = page.locator("[data-settings-chat-message-width]");
            await widthInput.fill(width);
            await widthInput.press("Tab");
            await expect
              .poll(() =>
                page.evaluate(
                  (key) => JSON.parse(localStorage.getItem(key) ?? "{}").chatMessageMaxWidth,
                  controlUiBundledSettingsStorageKey(suite.server.baseUrl),
                ),
              )
              .toBe(width);
            await page.goto(`${suite.server.baseUrl}chat`);
            await transcript.locator('.chat-bubble[data-entry-id="position-rail-239"]').waitFor();
            await expect
              .poll(() =>
                transcript.evaluate((element) =>
                  getComputedStyle(element).getPropertyValue("--chat-thread-max-width").trim(),
                ),
              )
              .toBe(width);
            await markers.first().waitFor({ state: width === "48rem" ? "visible" : "hidden" });
            if (width === "48rem") {
              const inner = await transcript.locator(".chat-thread-inner").boundingBox();
              const marker = await markers.first().boundingBox();
              expect(inner!.x - (marker!.x + marker!.width)).toBeGreaterThanOrEqual(10);
            }
            await captureUiProof(
              suite,
              page,
              "chat-position-rail",
              `saved-width-${width.replace("%", "percent")}.png`,
            );
          }
          // A foreign-host commit can change the inner column while the pane's
          // own dimensions stay fixed. Exercise that existing event boundary.
          for (const width of ["95%", "48rem"]) {
            await transcript.evaluate(
              (element, { columnWidth, eventName }) => {
                element.style.setProperty("--chat-thread-max-width", columnWidth);
                element.dispatchEvent(
                  new CustomEvent(eventName, {
                    bubbles: true,
                    detail: { widthChanged: false },
                  }),
                );
              },
              { columnWidth: width, eventName: SIDEBAR_GEOMETRY_COMMIT_EVENT },
            );
            await markers.first().waitFor({ state: width === "48rem" ? "visible" : "hidden" });
          }
          await transcript.evaluate((element) =>
            element.style.removeProperty("--chat-thread-max-width"),
          );
          expect(pageErrors).toEqual([]);
        },
      );
    },
  );
  it.each(["dark", "light"] as const)(
    "keeps one run current while reading its long continuation in %s mode",
    async (colorScheme) => {
      await suite.withPage(
        { colorScheme, viewport: { width: 1440, height: 900 } },
        async ({ page }) => {
          const message = (
            id: string,
            role: string,
            content: unknown,
            seq: number,
            runId?: string,
          ) => ({
            role,
            content,
            timestamp: seq * 1_000,
            __openclaw: { id, seq, ...(runId ? { runId } : {}) },
          });
          const longReply = Array.from(
            { length: 18 },
            (
              _,
              index,
            ) => `Section ${index + 1}: The review preserves the original request, explains the evidence, and records the resulting decision. Each participant can check the source and understand the next step.

`,
          ).join("");
          await installMockGateway(page, {
            historyMessages: [
              message("question", "user", "Review the shared design", 1),
              message("first", "assistant", "I will inspect the design", 2, "review-run"),
              message(
                "call",
                "assistant",
                [
                  {
                    type: "toolCall",
                    id: "read-1",
                    name: "read",
                    arguments: { path: "design.md" },
                  },
                ],
                3,
                "review-run",
              ),
              {
                ...message("result", "toolResult", "The design was loaded", 4, "review-run"),
                toolName: "read",
                toolCallId: "read-1",
              },
              message("continuation", "assistant", longReply, 5, "review-run"),
              message("final", "assistant", "The shared design is ready", 6, "review-run"),
              message("next-question", "user", "Continue with the next review", 7),
              message("next-answer", "assistant", "Ready for the next review", 8, "next-run"),
            ],
          });
          await page.addInitScript(createControlUiMockSameOriginGatewayScript());
          await page.addInitScript(
            ({ key, mode }) => {
              localStorage.setItem(
                key,
                JSON.stringify({
                  ...JSON.parse(localStorage.getItem(key) ?? "{}"),
                  theme: mode,
                  themeMode: mode,
                }),
              );
            },
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), mode: colorScheme },
          );
          await page.goto(`${suite.server.baseUrl}chat`);
          const thread = page.locator(".chat-thread");
          const marks = thread.locator(".chat-position-rail__marker");
          await expect.poll(() => marks.count()).toBe(4);
          const runMarker = thread.locator('[data-position-marker-id="run:review-run"]');
          await runMarker.focus();
          await runMarker.press("Enter");
          const first = thread.locator('.chat-bubble[data-entry-id="first"]');
          await expect
            .poll(() =>
              first.evaluate((element) => element.classList.contains("chat-bubble--reply-target")),
            )
            .toBe(true);
          await expect
            .poll(async () =>
              (await thread.locator(".chat-position-rail__preview-copy").textContent())?.trim(),
            )
            .toBe("The shared design is ready");
          const continuation = thread.locator('.chat-bubble[data-entry-id="continuation"]');
          await continuation.evaluate((element) => {
            const root = element.closest<HTMLElement>(".chat-thread")!;
            const rect = element.getBoundingClientRect();
            root.scrollTop +=
              rect.top - root.getBoundingClientRect().top + rect.height / 2 - root.clientHeight / 2;
          });
          await expect.poll(() => runMarker.getAttribute("aria-current")).toBe("true");
          await expect.poll(() => runMarker.getAttribute("data-visible")).toBe("");
          expect(
            await thread.locator('.chat-position-rail__marker[aria-current="true"]').count(),
          ).toBe(1);
          expect(
            await first.evaluate(
              (element) =>
                element.getBoundingClientRect().bottom <
                element.closest(".chat-thread")!.getBoundingClientRect().top,
            ),
          ).toBe(true);
          expect(
            await continuation.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
              return rect.top < viewport.top && rect.bottom > viewport.bottom;
            }),
          ).toBe(true);
          await captureUiProof(
            suite,
            page,
            "chat-position-rail",
            `run-continuation-${colorScheme}.png`,
          );
          await runMarker.press("Enter");
          await expect
            .poll(() =>
              first.evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const viewport = element.closest(".chat-thread")!.getBoundingClientRect();
                return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
              }),
            )
            .toBe(true);
        },
      );
    },
  );
});
