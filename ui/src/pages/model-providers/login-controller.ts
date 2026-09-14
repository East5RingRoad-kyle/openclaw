import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import type { ProviderLoginOption } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { providerDisplayLabel, renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import "../../styles/model-setup.css";
import { initialWizardValue, type ModelSetupWizardState } from "../model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import { renderModelSetupWizard } from "../model-setup/wizard-view.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type { ModelProviderCard } from "./data.ts";
import type { ModelProvidersData } from "./load.ts";

type LoginControllerOptions = {
  getScope: () => { context: ApplicationContext; agentId: string; data: ModelProvidersData | null };
  canStart: () => boolean;
  canContinue: () => boolean;
  refresh: () => Promise<void>;
  onDiscover?: () => void;
  onApiKey?: (provider: string) => void;
};

type LoginProvider = {
  id: string;
  label: string;
  choices: ProviderLoginOption[];
  apiKeyProvider?: string;
};

export class ModelProviderLoginController implements ReactiveController {
  private picker: {
    providers?: string[];
    providerId: string;
    choice: string;
    query: string;
  } | null = null;
  private readonly searchInput = createRef<HTMLInputElement>();
  private readonly methodSelect = createRef<HTMLSelectElement>();
  private focusPicker: "search" | "method" | null = null;
  private state: ModelSetupWizardState = { phase: "idle" };
  private value: unknown;
  private generation = 0;
  private mutationActive = false;
  private cancellationPending = false;
  private cancellationNotice: string | null = null;
  private refreshWarning: string | null = null;
  private message: ModelProviderRowMessage | undefined;
  private readonly runner: ModelSetupWizardRunner;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: LoginControllerOptions,
  ) {
    host.addController(this);
    this.runner = new ModelSetupWizardRunner({
      getClient: () => options.getScope().context.gateway.snapshot.client,
      getAgentId: () => options.getScope().agentId,
      onChange: (next) => {
        const previousStep = this.state.phase === "step" ? this.state.step.id : null;
        this.state = next;
        if (next.phase === "step" && next.step.id !== previousStep) {
          this.value = initialWizardValue(next.step);
        } else if (next.phase !== "step") {
          this.value = undefined;
        }
        this.host.requestUpdate();
      },
      requestFailedMessage: () => t("modelProviders.requestFailed"),
      cancelledMessage: () => t("modelSetup.wizard.cancelled"),
      sessionExpiredMessage: () => t("modelProviders.login.sessionExpired"),
    });
  }

  get busy(): boolean {
    return (
      this.picker !== null ||
      this.mutationActive ||
      this.cancellationPending ||
      this.state.phase !== "idle"
    );
  }

  get providerActions() {
    return {
      canMutate: this.options.canStart(),
      loginBusy: this.busy,
      onConnect: (card: ModelProviderCard) => this.open([card.id, ...card.credentialProviderIds]),
      canConnect: (card: ModelProviderCard) =>
        this.loginProviders([card.id, ...card.credentialProviderIds]).length > 0,
    };
  }

  get pageActions() {
    return {
      selectedAgentId: this.options.getScope().agentId,
      onConnect: () => this.open(),
      connectDisabled:
        !this.options.canStart() ||
        this.busy ||
        (this.loginProviders().length === 0 && !this.options.onDiscover),
      login: this.render(),
      loginMessage: this.message,
    };
  }

  private loginProviders(providers?: string[]): LoginProvider[] {
    const groups = new Map<string, LoginProvider>();
    const choices = new Set<string>();
    for (const capability of this.options.getScope().data?.authStatus?.providerCapabilities ?? []) {
      if (providers && !providers.includes(capability.provider)) {
        continue;
      }
      for (const option of capability.loginOptions ?? []) {
        if (choices.has(option.id)) {
          continue;
        }
        choices.add(option.id);
        let group = groups.get(option.brandId);
        if (!group) {
          group = { id: option.brandId, label: "", choices: [] };
          groups.set(group.id, group);
        }
        group.label ||= option.groupLabel?.trim() ?? "";
        group.choices.push(option);
      }
      // Quick-key support is independent of wizard choices. Keep the exact
      // capability owner for the key form even when its login brand is an alias.
      if (capability.quickApiKeySetup && this.options.onApiKey) {
        const brands = capability.loginOptions?.length
          ? capability.loginOptions.map((option) => option.brandId)
          : [capability.provider];
        for (const id of new Set(brands)) {
          const group = groups.get(id) ?? { id, label: "", choices: [] };
          groups.set(id, { ...group, apiKeyProvider: group.apiKeyProvider ?? capability.provider });
        }
      }
    }
    for (const group of groups.values()) {
      group.label ||= providerDisplayLabel(group.id);
      group.choices.sort(
        (a, b) =>
          Number(b.featured) - Number(a.featured) ||
          a.label.localeCompare(b.label) ||
          a.id.localeCompare(b.id),
      );
    }
    return [...groups.values()].toSorted(
      (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
    );
  }

  open(providers?: string[], authChoice?: string): void {
    const groups = this.loginProviders(providers);
    if (
      !this.options.canStart() ||
      this.busy ||
      (!groups.length && (providers !== undefined || !this.options.onDiscover))
    ) {
      return;
    }
    const provider = authChoice
      ? groups.find((group) => group.choices.some((option) => option.id === authChoice))
      : providers && groups.length === 1
        ? groups[0]
        : undefined;
    if (provider?.apiKeyProvider && !provider.choices.length) {
      this.reset();
      this.options.onApiKey?.(provider.apiKeyProvider);
      return;
    }
    this.picker = {
      providers,
      providerId: provider?.id ?? "",
      choice:
        provider?.choices.find((option) => option.id === authChoice)?.id ??
        (provider?.choices.length === 1 ? provider.choices[0]!.id : ""),
      query: "",
    };
    // The modal owns initial focus and its original trigger. Only in-dialog
    // transitions move focus here, after the modal has captured that trigger.
    this.focusPicker = null;
    this.message = undefined;
    this.host.requestUpdate();
  }

  reset(): void {
    this.generation += 1;
    this.picker = null;
    this.focusPicker = null;
    this.mutationActive = false;
    this.cancellationPending = false;
    this.cancellationNotice = null;
    this.refreshWarning = null;
    this.message = undefined;
    // Cleanup addresses the original connection and wizard only. Late replies
    // cannot publish credentials or errors into another agent's view.
    void this.runner.cancel();
  }

  hostDisconnected(): void {
    this.reset();
  }

  hostUpdated(): void {
    if (!this.focusPicker || !this.picker) {
      return;
    }
    const target = this.focusPicker === "search" ? this.searchInput.value : this.methodSelect.value;
    this.focusPicker = null;
    target?.focus({ preventScroll: true });
  }

  render() {
    const picker = this.picker;
    if (picker) {
      const groups = this.loginProviders(picker.providers);
      const provider = groups.find((group) => group.id === picker.providerId);
      const selected = provider?.choices.find((option) => option.id === picker.choice);
      const query = picker.query.trim().toLocaleLowerCase();
      const matches = groups.filter((group) =>
        [
          group.id,
          group.label,
          ...(group.apiKeyProvider ? [t("modelProviders.status.apiKey")] : []),
          ...group.choices.flatMap((choice) => [choice.label, choice.hint ?? ""]),
        ].some((text) => text.toLocaleLowerCase().includes(query)),
      );
      return html`
        <openclaw-modal-dialog
          label=${t("modelProviders.login.title")}
          @modal-cancel=${() => this.reset()}
        >
          <div class="model-setup-wizard model-provider-login">
            <div class="model-setup-wizard__header">
              <h2>${t("modelProviders.login.title")}</h2>
            </div>
            <div class="model-setup-wizard__body">
              <p>${t("modelProviders.login.description")}</p>
              ${
                provider
                  ? html`
                      <h3 class="model-provider-login__provider">
                        ${renderProviderBrandIcon(provider.id)} ${provider.label}
                      </h3>
                      <label class="field">
                        <span>${t("modelProviders.login.method")}</span>
                        <select
                          class="settings-select"
                          data-models-login-choice
                          autofocus
                          ${ref(this.methodSelect)}
                          .value=${picker.choice}
                          ?disabled=${!this.options.canStart()}
                          @change=${(event: Event) => {
                            // SAFETY: This handler is attached directly to the select.
                            picker.choice = (event.currentTarget as HTMLSelectElement).value;
                            this.host.requestUpdate();
                          }}
                        >
                          <option value="">${t("modelProviders.login.selectMethod")}</option>
                          ${provider.choices.map(
                            (option) =>
                              html`<option
                                value=${option.id}
                                ?selected=${option.id === picker.choice}
                              >
                                ${option.label}
                              </option>`,
                          )}
                        </select>
                      </label>
                      ${selected?.hint ? html`<p class="muted">${selected.hint}</p>` : nothing}
                      ${
                        provider.apiKeyProvider
                          ? html`
                              <button
                                type="button"
                                class="btn"
                                data-models-login-api-key
                                ?disabled=${!this.options.canStart()}
                                @click=${() => {
                                  if (
                                    this.picker !== picker ||
                                    !provider.apiKeyProvider ||
                                    !this.options.canStart()
                                  ) {
                                    return;
                                  }
                                  this.reset();
                                  this.options.onApiKey?.(provider.apiKeyProvider);
                                }}
                              >
                                ${t("modelProviders.apiKey.set")}
                              </button>
                            `
                          : nothing
                      }
                    `
                  : html`
                      <label class="field">
                        <span>${t("modelProviders.search")}</span>
                        <input
                          type="search"
                          data-models-login-search
                          autofocus
                          autocomplete="off"
                          ${ref(this.searchInput)}
                          .value=${picker.query}
                          @input=${(event: Event) => {
                            // SAFETY: This handler is attached directly to the search input.
                            picker.query = (event.currentTarget as HTMLInputElement).value;
                            this.host.requestUpdate();
                          }}
                        />
                      </label>
                      <ul
                        class="model-provider-login__providers"
                        aria-label=${t("modelSetup.manual.provider")}
                      >
                        ${matches.map(
                          (group) => html`
                            <li>
                              <button
                                type="button"
                                class="btn model-provider-login__option"
                                data-models-login-provider=${group.id}
                                ?disabled=${!this.options.canStart()}
                                @click=${() => {
                                  if (this.picker !== picker || !this.options.canStart()) {
                                    return;
                                  }
                                  if (group.apiKeyProvider && !group.choices.length) {
                                    this.reset();
                                    this.options.onApiKey?.(group.apiKeyProvider);
                                    return;
                                  }
                                  picker.providerId = group.id;
                                  picker.choice =
                                    group.choices.length === 1 ? group.choices[0]!.id : "";
                                  this.focusPicker = "method";
                                  this.host.requestUpdate();
                                }}
                              >
                                ${renderProviderBrandIcon(group.id)}
                                <span class="model-provider-login__copy">
                                  <strong>${group.label}</strong>
                                  <span>
                                    ${[
                                      ...group.choices.map((choice) => choice.label),
                                      ...(group.apiKeyProvider
                                        ? [t("modelProviders.status.apiKey")]
                                        : []),
                                    ].join(" · ")}
                                  </span>
                                </span>
                              </button>
                            </li>
                          `,
                        )}
                      </ul>
                      ${
                        matches.length
                          ? nothing
                          : html`
                              <p class="muted" role="status">
                                ${t(query ? "modelProviders.noMatches" : "modelProviders.login.noProviders")}
                              </p>
                            `
                      }
                    `
              }
            </div>
            <div class="model-setup-wizard__footer">
              ${
                provider
                  ? html`
                      <button
                        class="btn model-provider-login__secondary"
                        data-models-login-back
                        @click=${() => {
                          picker.providers = undefined;
                          picker.providerId = "";
                          picker.choice = "";
                          this.focusPicker = "search";
                          this.host.requestUpdate();
                        }}
                      >
                        ${t("common.back")}
                      </button>
                    `
                  : !picker.providers && this.options.onDiscover
                    ? html`
                        <button
                          class="btn model-provider-login__secondary"
                          data-models-login-discover
                          ?disabled=${!this.options.canStart()}
                          @click=${() => {
                            if (this.picker !== picker || !this.options.canStart()) {
                              return;
                            }
                            this.reset();
                            this.options.onDiscover?.();
                          }}
                        >
                          ${t("modelProviders.login.discover")}
                        </button>
                      `
                    : nothing
              }
              <button class="btn" @click=${() => this.reset()}>${t("common.cancel")}</button>
              ${
                provider
                  ? html`<button
                      class="btn primary"
                      data-models-login-start
                      ?disabled=${!selected || !this.options.canStart()}
                      @click=${() => {
                        if (this.picker !== picker || !selected || !this.options.canStart()) {
                          return;
                        }
                        this.picker = null;
                        this.cancellationNotice = null;
                        this.refreshWarning = null;
                        void this.run(() => this.runner.start(selected.id, "models.authLogin"));
                      }}
                    >
                      ${t("modelProviders.login.action")}
                    </button>`
                  : nothing
              }
            </div>
          </div>
        </openclaw-modal-dialog>
      `;
    }
    // The Gateway can refuse cancellation during credential persistence. Keep
    // the modal open until its reply, including dismissal by Escape/backdrop.
    return html`<div @modal-cancel=${(event: Event) => event.preventDefault()}>
      ${renderModelSetupWizard({
        mode: "auth",
        state:
          this.state.phase === "step"
            ? { ...this.state, busy: this.state.busy || this.mutationActive }
            : this.state,
        refreshWarning: this.refreshWarning,
        cancellationNotice: this.cancellationNotice,
        value: this.value,
        onValueChange: (value) => {
          this.value = value;
          this.host.requestUpdate();
        },
        onAnswer: (value, includeValue) =>
          void this.run(() => this.runner.answer(value, includeValue)),
        onCancel: () => void this.cancel(),
        onClose: () => this.reset(),
      })}
    </div>`;
  }

  private async cancel(): Promise<void> {
    if (this.cancellationPending || this.state.phase === "done") {
      return;
    }
    const generation = this.generation;
    this.cancellationPending = true;
    this.cancellationNotice = null;
    try {
      const result = await this.runner.requestCancellation();
      if (generation !== this.generation) {
        return;
      }
      if (result === "running") {
        this.cancellationNotice = t("modelProviders.login.finishing");
      } else if (result === "cancelled") {
        this.reset();
      }
    } catch (error) {
      if (generation === this.generation) {
        this.cancellationNotice = t("modelSetup.wizard.cancelFailed", {
          error: formatUiError(error, t("modelProviders.requestFailed")),
        });
      }
    } finally {
      if (generation === this.generation) {
        this.cancellationPending = false;
        this.host.requestUpdate();
      }
    }
  }

  private async run(task: () => Promise<ModelSetupWizardCompletion | null>): Promise<void> {
    const client = this.options.getScope().context.gateway.snapshot.client;
    if (!client || this.mutationActive || !this.options.canContinue()) {
      return;
    }
    const generation = this.generation;
    this.mutationActive = true;
    this.host.requestUpdate();
    try {
      const mutation = await this.options.getScope().context.runtimeConfig.runExternalMutation(
        async (mutationClient) => {
          if (mutationClient !== client) {
            throw new Error(t("modelProviders.requestFailed"));
          }
          return task();
        },
        {
          canDispatch: () =>
            generation === this.generation &&
            this.options.getScope().context.gateway.snapshot.client === client &&
            this.options.canContinue(),
          dispatchError: t("modelProviders.requestFailed"),
        },
      );
      if (generation !== this.generation) {
        return;
      }
      if (!mutation.ok) {
        this.runner.fail(mutation.error);
        return;
      }
      this.refreshWarning = mutation.refresh.ok ? null : mutation.refresh.error;
      if (mutation.value) {
        this.runner.close();
        this.message = {
          kind: "success",
          text: t("modelProviders.login.done"),
          ...(this.refreshWarning ? { warning: this.refreshWarning } : {}),
        };
        await this.options.refresh();
      }
    } catch (error) {
      if (generation === this.generation) {
        this.runner.fail(formatUiError(error, t("modelProviders.requestFailed")));
      }
    } finally {
      if (generation === this.generation) {
        this.mutationActive = false;
        this.host.requestUpdate();
      }
    }
  }
}
