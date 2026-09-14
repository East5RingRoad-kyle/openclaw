/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WizardCancelParams,
  WizardNextParams,
} from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ModelAuthStatusResult, WizardNextResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { EMPTY_MODEL_PROVIDERS_DATA } from "./load.ts";
import { ModelProviderLoginController } from "./login-controller.ts";
import {
  appendPage,
  createHarness,
  type ModelProvidersPageTestElement,
} from "./model-providers-page.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function loginHarness(
  options: {
    capabilities?: ModelAuthStatusResult["providerCapabilities"];
    saved?: boolean;
  } = {},
) {
  const harness = createHarness("writer");
  const { context, request } = harness;
  const originalRequest = request.getMockImplementation()!;
  let saved = options.saved ?? false;
  let stepShown = false;
  const answer = deferred<WizardNextResult>();
  const cancel = deferred<{ status: "running" | "cancelled" }>();
  const status = deferred<{ status: "cancelled" }>();
  const authStatus = (): ModelAuthStatusResult => ({
    ts: 1,
    providers: saved
      ? [
          {
            provider: "example",
            displayName: "Example provider",
            status: "ok",
            profiles: [{ profileId: "example:new", type: "api_key", status: "ok" }],
          },
        ]
      : [],
    providerCapabilities: options.capabilities ?? [
      {
        provider: "example",
        apiKeySupported: true,
        quickApiKeySetup: true,
        loginOptions: [
          {
            id: "example-secret",
            brandId: "example",
            label: "Example API key",
            groupLabel: "Example provider",
            hint: "Use your Example account key",
            kind: "secret",
            featured: false,
          },
          {
            id: "example-browser",
            brandId: "example",
            label: "Example browser sign-in",
            kind: "oauth",
            featured: true,
          },
        ],
      },
    ],
  });
  request.mockImplementation(async (method: string) => {
    switch (method) {
      case "models.authStatus":
        return authStatus();
      case "models.authLogin":
        return { done: false, status: "running" };
      case "wizard.next":
        if (!stepShown) {
          stepShown = true;
          return {
            done: false,
            status: "running",
            step: { id: "credential", type: "text", sensitive: true, message: "Enter your key" },
          };
        }
        return answer.promise.then((result) => {
          saved = result.done && result.status === "done";
          return result;
        });
      case "wizard.cancel":
        return cancel.promise;
      case "wizard.status":
        return status.promise;
      default:
        return originalRequest(method);
    }
  });
  context.runtimeConfig.runExternalMutation = async (task, mutationOptions) => {
    if (mutationOptions?.canDispatch?.() === false) {
      return { ok: false, reason: "rejected", error: "Sign-in owner changed" };
    }
    const value = await task(context.gateway.snapshot.client!);
    return { ok: true, value, refresh: { ok: true } };
  };
  return { ...harness, answer, cancel, status };
}

async function openPicker(page: ModelProvidersPageTestElement) {
  await waitForFast(() => expect(page.data?.updatedAt).toEqual(expect.any(Number)));
  await waitForFast(() =>
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(false),
  );
  page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
  await page.updateComplete;
}

async function selectProvider(page: ModelProvidersPageTestElement, provider: string) {
  page.querySelector<HTMLButtonElement>(`[data-models-login-provider="${provider}"]`)!.click();
  await page.updateComplete;
}

async function startSelectedLogin(page: ModelProvidersPageTestElement, choice: string) {
  const picker = page.querySelector<HTMLSelectElement>("[data-models-login-choice]")!;
  picker.value = choice;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>("[data-models-login-start]")!.click();
  await waitForFast(() =>
    expect(page.querySelector<HTMLInputElement>('input[name="wizard-text"]')?.disabled).toBe(false),
  );
}

async function openLogin(page: ModelProvidersPageTestElement, choice = "example-secret") {
  await openPicker(page);
  await selectProvider(page, "example");
  await startSelectedLogin(page, choice);
}

async function searchProviders(page: ModelProvidersPageTestElement, query: string) {
  const input = page.querySelector<HTMLInputElement>("[data-models-login-search]")!;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
}

function providerChoices(page: Element) {
  return [...page.querySelectorAll<HTMLElement>("[data-models-login-provider]")].map(
    (button) => button.dataset.modelsLoginProvider,
  );
}

async function submitCredential(page: ModelProvidersPageTestElement) {
  const input = page.querySelector<HTMLInputElement>('input[name="wizard-text"]')!;
  input.value = "synthetic-test-credential";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await page.updateComplete;
  page.querySelector<HTMLButtonElement>('.wizard-step__form button[type="submit"]')!.click();
  await waitForFast(() => expect(input.disabled).toBe(true));
}

describe("Models provider login", () => {
  it("saves credentials through the selected manifest choice and refreshes the provider card", async () => {
    const { context, request, runtimeConfig, answer } = loginHarness();
    const page = appendPage(context);
    await openLogin(page);

    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      {
        authChoice: "example-secret",
        agentId: "writer",
        sessionId: expect.any(String),
      },
      { timeoutMs: null },
    );
    expect(page.querySelector('input[type="password"][name="wizard-text"]')).not.toBeNull();
    await submitCredential(page);
    answer.resolve({ done: true, status: "done" });

    await waitForFast(() => expect(page.textContent).toContain("Provider credentials saved."));
    await waitForFast(() =>
      expect(page.querySelector('[data-provider-id="example"]')).not.toBeNull(),
    );
    expect(page.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(context.navigate).not.toHaveBeenCalled();
    expect(runtimeConfig.patch).not.toHaveBeenCalled();
    expect(request.mock.calls.some(([method]) => method.startsWith("openclaw.setup."))).toBe(false);
  });

  it("keeps the dialog and saved result when dismissal is refused during persistence", async () => {
    const { context, answer, cancel } = loginHarness();
    const page = appendPage(context);
    await openLogin(page);
    await submitCredential(page);

    const dismissal = new CustomEvent("modal-cancel", { bubbles: true, cancelable: true });
    page.querySelector("openclaw-modal-dialog")!.dispatchEvent(dismissal);
    expect(dismissal.defaultPrevented).toBe(true);
    cancel.resolve({ status: "running" });
    await waitForFast(() => expect(page.textContent).toContain("Credentials are being saved."));
    expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);

    answer.resolve({ done: true, status: "done" });
    await waitForFast(() => expect(page.textContent).toContain("Provider credentials saved."));
    expect(page.textContent).not.toContain("cancelled");
    await waitForFast(() =>
      expect(page.querySelector('[data-provider-id="example"]')).not.toBeNull(),
    );
  });

  it("releases a saved login on disposal while Cancel is pending and allows a second login", async () => {
    const { context, request } = loginHarness();
    const client = context.gateway.snapshot.client!;
    const initialAuth = await client.request<ModelAuthStatusResult>("models.authStatus");
    const originalRequest = request.getMockImplementation()!;
    const cancelled = deferred<{ status: "running" }>();
    const cancelReceived = deferred();
    const sessions = new Map<string, WizardSession>();
    const profiles = new Set<string>();
    request.mockImplementation(
      async (method, params?: Partial<WizardNextParams & WizardCancelParams>) => {
        if (method === "models.authStatus") {
          return {
            ...initialAuth,
            providers: profiles.size
              ? [
                  {
                    provider: "example",
                    displayName: "Example provider",
                    status: "ok",
                    profiles: [...profiles].map((profileId) => ({
                      profileId,
                      type: "api_key",
                      status: "ok",
                    })),
                  },
                ]
              : [],
          };
        }
        if (!method.startsWith("wizard.") && method !== "models.authLogin") {
          return originalRequest(method);
        }
        if (!params?.sessionId) {
          throw new Error("Wizard request has no session ID");
        }
        if (method === "models.authLogin") {
          if ([...sessions.values()].some((session) => !session.isSettled())) {
            throw new Error("Another login is still running");
          }
          const profileId = `example:${sessions.size + 1}`;
          const session = new WizardSession(async (prompter, _signal, owner) => {
            await prompter.text({ message: "Enter your key", sensitive: true });
            owner.lockCancellation();
            profiles.add(profileId);
            await prompter.note("Credentials saved. Continue to finish.", "Provider notes");
          });
          sessions.set(params.sessionId, session);
          return { sessionId: params.sessionId, done: false, status: "running" };
        }
        const session = sessions.get(params.sessionId);
        if (!session) {
          throw new Error("Unknown wizard session");
        }
        if (method === "wizard.next") {
          if (params.answer) {
            await session.answer(params.answer.stepId, params.answer.value);
          }
          return session.next();
        }
        if (method === "wizard.cancel") {
          if (!params.closeInput) {
            session.cancel();
            cancelReceived.resolve();
            return cancelled.promise;
          }
          session.close(new Error("Provider credentials were saved, but the view closed."));
          await session.whenSettled();
        }
        return { status: session.getStatus(), error: session.getError() };
      },
    );

    const page = appendPage(context);
    await openLogin(page);
    await submitCredential(page);
    await waitForFast(() =>
      expect(page.textContent).toContain("Credentials saved. Continue to finish."),
    );
    page.querySelector<HTMLButtonElement>(".wizard-step__actions .btn")!.click();
    await cancelReceived.promise;
    const first = [...sessions.values()][0]!;
    expect(first.isSettled()).toBe(false);

    page.remove();
    await waitForFast(() => expect(first.isSettled()).toBe(true));
    expect(first.getStatus()).toBe("error");
    expect(first.getError()).toContain("credentials were saved");
    expect(profiles.has("example:1")).toBe(true);
    const replacement = appendPage(context);
    await openLogin(replacement);
    expect(replacement.querySelector('[data-provider-id="example"]')).not.toBeNull();
    cancelled.resolve({ status: "running" });
    await replacement.updateComplete;
    expect(context.gateway.snapshot.client).toBe(client);
    expect(replacement.textContent).not.toContain("Provider credentials saved.");
    expect(replacement.querySelector<HTMLInputElement>('input[name="wizard-text"]')?.disabled).toBe(
      false,
    );

    await submitCredential(replacement);
    await waitForFast(() =>
      expect(replacement.textContent).toContain("Credentials saved. Continue to finish."),
    );
    replacement.querySelector<HTMLButtonElement>(".wizard-step__actions .btn.primary")!.click();
    await waitForFast(() =>
      expect(replacement.textContent).toContain("Provider credentials saved."),
    );
    expect(sessions.size).toBe(2);
    expect([...profiles]).toEqual(["example:1", "example:2"]);
  });

  it.each(["settled", "purged"])(
    "keeps Connect disabled until cancellation is %s",
    async (outcome) => {
      const { context, request, cancel, status } = loginHarness();
      const page = appendPage(context);
      await openLogin(page);
      page.querySelector<HTMLButtonElement>(".wizard-step__actions .btn")!.click();
      cancel.resolve({ status: "cancelled" });
      await waitForFast(() =>
        expect(request.mock.calls.some(([method]) => method === "wizard.status")).toBe(true),
      );
      expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
      expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(true);
      if (outcome === "purged") {
        status.reject(
          new GatewayRequestError({
            code: "INVALID_REQUEST",
            message: "Wizard session not found",
            details: { code: "WIZARD_NOT_FOUND" },
          }),
        );
      } else {
        status.resolve({ status: "cancelled" });
      }

      await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());
      expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(false);
      expect(page.textContent).not.toContain("Provider credentials saved.");
      page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
      await page.updateComplete;
      expect(page.querySelector("[data-models-login-search]")).not.toBeNull();
    },
  );

  it("does not publish a previous agent's completion after selection changes", async () => {
    const { context, agentSelection, notifySelection, answer, cancel } = loginHarness();
    const mutations = vi.spyOn(context.runtimeConfig, "runExternalMutation");
    const page = appendPage(context);
    await openLogin(page);
    await submitCredential(page);
    agentSelection.state.selectedId = "main";
    agentSelection.state.scopeId = "main";
    notifySelection();
    await waitForFast(() => expect(page.querySelector("openclaw-modal-dialog")).toBeNull());

    cancel.resolve({ status: "running" });
    answer.resolve({ done: true, status: "done" });
    await mutations.mock.results.at(-1)?.value;
    await page.updateComplete;
    expect(page.textContent).not.toContain("Provider credentials saved.");
    expect(page.querySelector<HTMLInputElement>('input[name="wizard-text"]')).toBeNull();
  });

  it("groups and searches advertised providers before selecting their supported sign-in method", async () => {
    const base = loginHarness();
    const auth =
      await base.context.gateway.snapshot.client!.request<ModelAuthStatusResult>(
        "models.authStatus",
      );
    const example = auth.providerCapabilities![0]!;
    const { context, request } = loginHarness({
      capabilities: [
        {
          provider: "zebra",
          apiKeySupported: false,
          quickApiKeySetup: false,
          loginOptions: [
            {
              id: "plugin/zebra-login",
              brandId: "zebra",
              groupLabel: "Zebra",
              label: "Device sign-in",
              kind: "device-code",
              featured: true,
            },
          ],
        },
        example,
        { ...example, provider: "example-alias" },
        {
          provider: "alpha",
          apiKeySupported: true,
          quickApiKeySetup: true,
          loginOptions: [
            {
              id: "plugin/alpha-key",
              brandId: "alpha",
              groupLabel: "Alpha",
              label: "Account key",
              kind: "secret",
              featured: false,
            },
          ],
        },
        { provider: "unsupported", apiKeySupported: false, quickApiKeySetup: false },
      ],
    });
    const page = appendPage(context);
    await openPicker(page);
    expect(providerChoices(page)).toEqual(["alpha", "example", "zebra"]);
    expect(page.querySelector("[data-models-login-choice]")).toBeNull();
    expect(page.querySelector("[data-models-login-discover]")).not.toBeNull();
    expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);

    await searchProviders(page, "  EXAMPLE  ");
    expect(providerChoices(page)).toEqual(["example"]);
    await searchProviders(page, "browser sign-in");
    expect(providerChoices(page)).toEqual(["example"]);
    await searchProviders(page, "your Example account key");
    expect(providerChoices(page)).toEqual(["example"]);
    await selectProvider(page, "example");
    expect(
      [...page.querySelectorAll<HTMLOptionElement>("[data-models-login-choice] option")].map(
        (option) => option.value,
      ),
    ).toEqual(["", "example-browser", "example-secret"]);
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-choice]"));
    expect(page.querySelector<HTMLButtonElement>("[data-models-login-start]")?.disabled).toBe(true);
    expect(page.querySelector("[data-models-login-discover]")).toBeNull();

    page.querySelector<HTMLButtonElement>("[data-models-login-back]")!.click();
    await page.updateComplete;
    expect(document.activeElement).toBe(page.querySelector("[data-models-login-search]"));
    expect(page.querySelector<HTMLInputElement>("[data-models-login-search]")!.value).toBe(
      "your Example account key",
    );
    await searchProviders(page, "no such provider");
    expect(providerChoices(page)).toEqual([]);
    expect(page.querySelector(".model-provider-login [role=status]")?.textContent).toContain(
      "No providers match",
    );
    await searchProviders(page, "");
    expect(providerChoices(page)).toEqual(["alpha", "example", "zebra"]);
    await selectProvider(page, "zebra");
    await startSelectedLogin(page, "plugin/zebra-login");
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      {
        authChoice: "plugin/zebra-login",
        agentId: "writer",
        sessionId: expect.any(String),
      },
      { timeoutMs: null },
    );
  });

  it("prefilters an existing account's provider while allowing another account login", async () => {
    const { context, request } = loginHarness({ saved: true });
    const page = appendPage(context);
    await waitForFast(() =>
      expect(page.querySelector('[data-provider-id="example"]')).not.toBeNull(),
    );
    const addAccount = [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Add account",
    );
    expect(addAccount?.disabled).toBe(false);
    addAccount!.click();
    await page.updateComplete;
    expect(page.querySelector("[data-models-login-search]")).toBeNull();
    expect(page.querySelector(".model-provider-login__provider")?.textContent).toContain(
      "Example provider",
    );
    await startSelectedLogin(page, "example-browser");
    expect(request).toHaveBeenCalledWith(
      "models.authLogin",
      {
        authChoice: "example-browser",
        agentId: "writer",
        sessionId: expect.any(String),
      },
      { timeoutMs: null },
    );
  });

  it.each([false, true])(
    "preserves quick API-key setup alongside browser login: %s",
    async (withBrowser) => {
      const { context, request, runtimeConfig } = loginHarness({
        capabilities: [
          {
            provider: "quick-key",
            apiKeySupported: true,
            quickApiKeySetup: true,
            loginOptions: withBrowser
              ? [
                  {
                    id: "fixture/browser",
                    brandId: "quick-key",
                    label: "Browser sign-in",
                    kind: "oauth",
                    featured: true,
                  },
                ]
              : [],
          },
          { provider: "unsupported", apiKeySupported: true, quickApiKeySetup: false },
        ],
      });
      const page = appendPage(context);
      await openPicker(page);
      expect(providerChoices(page)).toEqual(["quick-key"]);
      await selectProvider(page, "quick-key");
      if (withBrowser) {
        expect(
          [...page.querySelectorAll<HTMLOptionElement>("[data-models-login-choice] option")].map(
            (option) => option.value,
          ),
        ).toEqual(["", "fixture/browser"]);
        const apiKey = page.querySelector<HTMLButtonElement>("[data-models-login-api-key]");
        expect(apiKey).not.toBeNull();
        apiKey!.click();
        await page.updateComplete;
      }
      expect(page.querySelector("[data-models-login-search]")).toBeNull();
      expect(page.querySelector("[data-models-login-choice]")).toBeNull();
      expect(page.querySelector('openclaw-modal-dialog input[type="password"]')).not.toBeNull();
      expect(page.addProviderId).toBe("quick-key");
      expect(page.addProviderOpen).toBe(true);
      expect(runtimeConfig.patch).not.toHaveBeenCalled();
      expect(request.mock.calls.some(([method]) => method === "models.authLogin")).toBe(false);
      expect(request.mock.calls.some(([method]) => method.startsWith("openclaw.setup."))).toBe(
        false,
      );
    },
  );

  it("offers optional discovery without login choices and releases the picker before handing off", () => {
    const { context, request } = loginHarness({ capabilities: [] });
    const onDiscover = vi.fn(() => expect(controller.busy).toBe(false));
    const controller = new ModelProviderLoginController(
      {
        addController: vi.fn(),
        removeController: vi.fn(),
        requestUpdate: vi.fn(),
        updateComplete: Promise.resolve(true),
      },
      {
        getScope: () => ({ context, agentId: "writer", data: EMPTY_MODEL_PROVIDERS_DATA }),
        canStart: () => true,
        canContinue: () => true,
        refresh: async () => undefined,
        onDiscover,
      },
    );
    const container = document.createElement("div");
    document.body.append(container);
    expect(controller.pageActions.connectDisabled).toBe(false);
    controller.pageActions.onConnect();
    render(controller.render(), container);
    expect(providerChoices(container)).toEqual([]);
    expect(controller.busy).toBe(true);
    container.querySelector<HTMLButtonElement>("[data-models-login-discover]")!.click();
    expect(onDiscover).toHaveBeenCalledOnce();
    expect(controller.busy).toBe(false);
    expect(
      request.mock.calls.some(
        ([method]) => method === "models.authLogin" || method.startsWith("openclaw.setup."),
      ),
    ).toBe(false);
    render(controller.render(), container);
    expect(container.querySelector("[data-models-login-search]")).toBeNull();
  });
});

it("keeps provider access scoped below global defaults and connects without navigation", async () => {
  const { context } = createHarness("main");
  const page = appendPage(context);
  await waitForFast(() => expect(page.data?.updatedAt).toEqual(expect.any(Number)));
  await waitForFast(() =>
    expect(page.querySelector<HTMLButtonElement>("[data-models-connect]")?.disabled).toBe(false),
  );
  const defaults = page.querySelector("#settings-model-behavior")!;
  const agent = page.querySelector("openclaw-agent-select")!;
  expect(defaults.contains(agent)).toBe(false);
  expect(defaults.compareDocumentPosition(agent) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(agent.closest(".settings-section")?.textContent).toContain("Provider access");
  expect(
    [...page.querySelectorAll("button")].some(
      (button) => button.textContent?.trim() === "Model setup",
    ),
  ).toBe(false);
  page.querySelector<HTMLButtonElement>("[data-models-connect]")!.click();
  await page.updateComplete;
  expect(page.querySelector("openclaw-modal-dialog")).not.toBeNull();
  expect(context.navigate).not.toHaveBeenCalled();
  expect(defaults.isConnected).toBe(true);
});
