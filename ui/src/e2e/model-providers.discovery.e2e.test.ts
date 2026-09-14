import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Models discovery credential recovery",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

suite.define(() => {
  it.each(["auth", "manual"] as const)(
    "recovers an aliased provider through the exact %s credential method",
    async (kind) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const choice = {
          id: "fixture/account-key",
          brandId: "account-brand",
          groupLabel: "Account brand",
          label: "Account key",
          kind: "secret",
          featured: false,
        };
        const gateway = await installMockGateway(page, {
          featureMethods: [
            "config.get",
            "config.patch",
            "models.authStatus",
            "models.list",
            "models.authLogin",
            "openclaw.setup.detect",
            "wizard.next",
          ],
          methodResponses: {
            "models.authStatus": {
              ts: 1,
              providers: [],
              providerCapabilities: [
                {
                  provider: "credential-owner",
                  apiKeySupported: true,
                  quickApiKeySetup: false,
                  loginOptions: [
                    { ...choice, id: "fixture/browser", label: "Browser sign-in", kind: "oauth" },
                    choice,
                  ],
                },
              ],
            },
            "openclaw.setup.detect": {
              candidates: [],
              setupComplete: false,
              workspace: "/synthetic/workspace",
              authOptions: kind === "auth" ? [choice] : [],
              manualProviders: kind === "manual" ? [choice] : [],
              unavailableCandidates: [
                {
                  id: "expired-account",
                  label: "Account brand",
                  detail: "Saved credential expired",
                  reason: "Connect the account again",
                  ...(kind === "auth"
                    ? { authOptionId: choice.id }
                    : { manualProviderId: choice.id }),
                },
              ],
            },
            "models.authLogin": { done: false, status: "running" },
            "wizard.next": {
              done: false,
              status: "running",
              step: { id: "key", type: "text", sensitive: true, message: "Enter account key" },
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers?connect=1`);
        await page.locator("[data-models-login-discover]").click();
        await page.locator('[data-unavailable-candidate="expired-account"] button').click();
        await expect
          .poll(() => page.locator("[data-models-login-choice]").inputValue())
          .toBe(choice.id);
        expect(await page.locator(".model-provider-login__provider").textContent()).toContain(
          "Account brand",
        );
        expect(await page.locator(".model-setup-discovery").count()).toBe(0);
        expect(await gateway.getRequests("models.authLogin")).toHaveLength(0);
        await page.locator("[data-models-login-start]").click();
        expect((await gateway.waitForRequest("models.authLogin")).params).toMatchObject({
          authChoice: choice.id,
          agentId: "main",
        });
        expect(await gateway.getRequests("openclaw.setup.auth.start")).toHaveLength(0);
        expect(await gateway.getRequests("openclaw.setup.activate.start")).toHaveLength(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
      });
    },
  );
});
