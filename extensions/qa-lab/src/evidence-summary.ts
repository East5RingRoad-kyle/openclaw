// QA Lab plugin module implements QA evidence summary behavior.
import { normalizeSortedUniqueTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { qaEvidenceAssertionSchema, qaEvidenceCoverageSchema } from "./evidence-assertion.js";
import { resolveQaEvidenceEnvironment } from "./evidence-environment.js";
import { splitQaModelRef } from "./model-selection.js";
import { qaProfileEvidencePlan, type QaProfileEvidencePlan } from "./profile-evidence-plan.js";
import { getQaProvider, type QaProviderMode } from "./providers/index.js";
import { qaRuntimePairLaneSchema, type QaRuntimePairLane } from "./scenario-catalog.js";
import {
  qaScorecardEvidenceModeSchema,
  readQaScorecardProfileOptions,
  type QaScorecardEvidenceMode,
} from "./scorecard-taxonomy.js";

export const QA_EVIDENCE_SUMMARY_KIND = "openclaw.qa.evidence-summary";
export const QA_EVIDENCE_FILENAME = "qa-evidence.json";
// Existing producers and historical artifacts retain their exact v2 contract.
// Only a producer with recorded invocation custody may construct v3.
const QA_EVIDENCE_SUMMARY_SCHEMA_VERSION = 2;

const qaEvidenceStatusSchema = z.enum(["pass", "fail", "blocked", "skipped"]);
const nonEmptyStringSchema = z.string().trim().min(1);
const nullableStringSchema = nonEmptyStringSchema.nullable();
const qaEvidenceProfileIdSchema = nonEmptyStringSchema;

const qaEvidenceProviderSchema = z.strictObject({
  id: nonEmptyStringSchema,
  live: z.boolean(),
  model: z.strictObject({
    name: nullableStringSchema,
    ref: nullableStringSchema,
  }),
  fixture: nonEmptyStringSchema.optional(),
  auth: nonEmptyStringSchema.optional(),
});

const qaEvidenceChannelSchema = z.strictObject({
  id: nonEmptyStringSchema,
  live: z.boolean(),
  driver: nonEmptyStringSchema.optional(),
});

const qaEvidenceEnvironmentSchema = z.strictObject({
  ref: nullableStringSchema,
  os: nonEmptyStringSchema,
  nodeVersion: nonEmptyStringSchema,
});

const qaEvidencePackageSourceSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  spec: nonEmptyStringSchema.optional(),
  sha: nonEmptyStringSchema.optional(),
});

const qaEvidenceFailureSchema = z.strictObject({
  class: nonEmptyStringSchema.optional(),
  reason: nonEmptyStringSchema,
});

const qaEvidenceTimingSchema = z.strictObject({
  wallMs: z.number().finite().positive().optional(),
  rttMs: z.number().finite().positive().optional(),
  avgMs: z.number().finite().positive().optional(),
  p50Ms: z.number().finite().positive().optional(),
  p95Ms: z.number().finite().positive().optional(),
  maxMs: z.number().finite().positive().optional(),
  samples: z.number().int().positive().optional(),
  failedSamples: z.number().int().nonnegative().optional(),
});

const qaEvidenceRttMeasurementSchema = z.strictObject({
  finalMatchedReplyRttMs: z.number().finite().positive(),
  requestStartedAt: nonEmptyStringSchema,
  responseObservedAt: nonEmptyStringSchema,
  source: nonEmptyStringSchema,
});

const qaEvidenceTestSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  source: z
    .strictObject({
      path: nonEmptyStringSchema,
    })
    .optional(),
});

const qaEvidenceRefSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
});

const qaEvidenceScorecardCountSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  fulfilled: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative().optional(),
  missing: z.number().int().nonnegative(),
  fulfillmentPercent: z.number().finite().nonnegative(),
});

const qaEvidenceScorecardCoverageCountSchema = qaEvidenceScorecardCountSchema.extend({
  secondaryOnly: z.number().int().nonnegative(),
});

const qaEvidenceScorecardCategorySchema = z.strictObject({
  id: nonEmptyStringSchema,
  surfaceId: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  status: z.enum(["fulfilled", "partial", "missing"]),
  features: qaEvidenceScorecardCountSchema,
  coverageIds: qaEvidenceScorecardCoverageCountSchema,
  missingCoverageIds: z.array(nonEmptyStringSchema),
});

const qaEvidenceScorecardSchema = z.strictObject({
  filters: z.strictObject({
    surface: nullableStringSchema,
    category: nullableStringSchema,
  }),
  run: z.strictObject({
    evidenceEntryCount: z.number().int().nonnegative(),
  }),
  categories: qaEvidenceScorecardCountSchema,
  features: qaEvidenceScorecardCountSchema,
  coverageIds: qaEvidenceScorecardCountSchema,
  categoryReports: z.array(qaEvidenceScorecardCategorySchema),
});

const qaEvidenceArtifactSchema = z.strictObject({
  kind: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  source: nonEmptyStringSchema,
});

const qaEvidenceExecutionSchema = z.strictObject({
  runner: nonEmptyStringSchema,
  environment: qaEvidenceEnvironmentSchema,
  provider: qaEvidenceProviderSchema,
  channel: qaEvidenceChannelSchema.optional(),
  packageSource: qaEvidencePackageSourceSchema,
  artifacts: z.array(qaEvidenceArtifactSchema),
});

const qaEvidenceResultSchema = z.strictObject({
  status: qaEvidenceStatusSchema,
  failure: qaEvidenceFailureSchema.optional(),
  timing: qaEvidenceTimingSchema.optional(),
  rttMeasurement: qaEvidenceRttMeasurementSchema.optional(),
});

const qaEvidencePostureSchema = z.enum(["direct-gateway", "native-approval", "user-path"]);

const qaEvidenceSummaryEntrySchema = z.strictObject({
  test: qaEvidenceTestSchema,
  coverage: z.array(qaEvidenceCoverageSchema),
  posture: qaEvidencePostureSchema.optional(),
  refs: z.array(qaEvidenceRefSchema).optional(),
  runtimePairLane: qaRuntimePairLaneSchema.optional(),
  execution: qaEvidenceExecutionSchema.optional(),
  result: qaEvidenceResultSchema,
});

const qaEvidenceSummarySchema = z.strictObject({
  kind: z.literal(QA_EVIDENCE_SUMMARY_KIND),
  schemaVersion: z.literal(QA_EVIDENCE_SUMMARY_SCHEMA_VERSION),
  generatedAt: nonEmptyStringSchema,
  evidenceMode: qaScorecardEvidenceModeSchema,
  entries: z.array(qaEvidenceSummaryEntrySchema),
  profile: qaEvidenceProfileIdSchema.optional(),
  profilePlan: qaProfileEvidencePlan.schema.optional(),
  scorecard: qaEvidenceScorecardSchema.optional(),
});

const qaEvidenceCellSchema = z.strictObject({
  scenarioId: nonEmptyStringSchema,
  executionKind: z.enum(["flow", "script", "vitest", "playwright"]),
  channel: nullableStringSchema,
});

const qaEvidenceIdentitySchema = z.strictObject({
  source: z.strictObject({ ref: nullableStringSchema, integrity: nullableStringSchema }),
  runtime: z.strictObject({ id: nullableStringSchema, version: nullableStringSchema }),
  package: z
    .strictObject({
      kind: nonEmptyStringSchema,
      spec: nullableStringSchema,
      version: nullableStringSchema,
      integrity: nullableStringSchema,
    })
    .nullable(),
  protocol: nullableStringSchema,
  accountRef: nullableStringSchema,
  proofClass: z
    .enum([
      "fixture-only",
      "real-plugin/local-protocol",
      "native-host",
      "packaged-install/upgrade",
      "live-channel",
      "live-provider",
    ])
    .nullable(),
});

const qaEvidenceOccurrenceSchema = z.strictObject({
  id: nonEmptyStringSchema,
  parentCell: qaEvidenceCellSchema.nullable(),
  scenario: z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("instance"),
        resultOccurrenceId: nullableStringSchema,
      }),
      z.strictObject({
        kind: z.literal("observation"),
        instanceOccurrenceId: nonEmptyStringSchema,
      }),
    ])
    .nullable(),
  retryOf: nullableStringSchema,
  terminalStatus: qaEvidenceStatusSchema.nullable(),
  // A missing declaration is unknown, not an empty successful assertion set.
  assertions: z.array(qaEvidenceAssertionSchema).nullable(),
  launch: qaEvidenceIdentitySchema,
  // Reporter metadata cannot stand in for a prepared or target-observed identity.
  receipts: z.array(
    z.strictObject({
      id: nonEmptyStringSchema,
      phase: z.enum(["prepared", "installed", "runtime"]),
      identity: qaEvidenceIdentitySchema,
      artifact: qaEvidenceArtifactSchema.extend({
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    }),
  ),
});

const qaEvidenceSummaryV3EntrySchema = qaEvidenceSummaryEntrySchema.extend({
  binding: z.strictObject({
    occurrenceId: nonEmptyStringSchema,
    assertionId: nullableStringSchema,
    receiptId: nullableStringSchema,
  }),
  effective: z.boolean(),
});

const qaEvidenceSummaryV3Shape = qaEvidenceSummarySchema.extend({
  schemaVersion: z.literal(3),
  entries: z.array(qaEvidenceSummaryV3EntrySchema),
  occurrences: z.array(qaEvidenceOccurrenceSchema),
});

function validateOccurrenceBindings(summary: z.infer<typeof qaEvidenceSummaryV3Shape>) {
  const occurrences = new Map<string, QaEvidenceOccurrence>();
  const entries = new Map<string, QaEvidenceSummaryV3Entry[]>();
  const successors = new Map<string, string>();
  for (const occurrence of summary.occurrences) {
    if (occurrences.has(occurrence.id)) {
      throw new Error(`duplicate evidence occurrence ${occurrence.id}`);
    }
    occurrences.set(occurrence.id, occurrence);
    if (
      new Set(occurrence.assertions?.map((assertion) => assertion.id)).size !==
      (occurrence.assertions?.length ?? 0)
    ) {
      throw new Error(`duplicate assertion declaration in ${occurrence.id}`);
    }
    if (
      new Set(occurrence.receipts.map((receipt) => receipt.id)).size !== occurrence.receipts.length
    ) {
      throw new Error(`duplicate target receipt in ${occurrence.id}`);
    }
    if ((occurrence.scenario === null) !== (occurrence.parentCell === null)) {
      throw new Error(`scenario ownership missing in ${occurrence.id}`);
    }
  }
  for (const entry of summary.entries) {
    const occurrence = occurrences.get(entry.binding.occurrenceId);
    if (!occurrence || occurrence.scenario?.kind === "instance") {
      throw new Error("evidence entries must bind to an observation, never a scheduling anchor");
    }
    if (
      entry.binding.receiptId !== null &&
      !occurrence.receipts.some((receipt) => receipt.id === entry.binding.receiptId)
    ) {
      throw new Error(`unknown target receipt in ${occurrence.id}`);
    }
    if (entry.binding.assertionId !== null) {
      const assertion = occurrence.assertions?.find(
        (candidate) => candidate.id === entry.binding.assertionId,
      );
      if (
        !assertion ||
        entry.coverage.some(
          (coverage) =>
            !assertion.coverage.some(
              (allowed) => allowed.id === coverage.id && allowed.role === coverage.role,
            ),
        )
      ) {
        throw new Error(`assertion binding exceeds captured declaration in ${occurrence.id}`);
      }
    }
    const prior = entries.get(occurrence.id) ?? [];
    if (prior.length > 0 && prior[0]!.effective !== entry.effective) {
      throw new Error(`mixed effective rows in ${occurrence.id}`);
    }
    prior.push(entry);
    entries.set(occurrence.id, prior);
  }
  for (const occurrence of summary.occurrences) {
    if (occurrence.scenario?.kind === "instance") {
      if (occurrence.retryOf !== null || occurrence.terminalStatus !== null) {
        throw new Error("scheduling anchors do not record terminal outcomes or retries");
      }
      const selectedId = occurrence.scenario.resultOccurrenceId;
      if (selectedId !== null) {
        const selected = occurrences.get(selectedId);
        if (
          selected?.scenario?.kind !== "observation" ||
          selected.scenario.instanceOccurrenceId !== occurrence.id
        ) {
          throw new Error(`invalid selected observation for ${occurrence.id}`);
        }
        if (entries.get(selectedId)?.some((entry) => !entry.effective)) {
          throw new Error(`selected observation is ineffective for ${occurrence.id}`);
        }
      }
    } else if (occurrence.scenario?.kind === "observation") {
      const anchor = occurrences.get(occurrence.scenario.instanceOccurrenceId);
      if (
        anchor?.scenario?.kind !== "instance" ||
        JSON.stringify(anchor.parentCell) !== JSON.stringify(occurrence.parentCell)
      ) {
        throw new Error(`cross-instance observation ${occurrence.id}`);
      }
    }
    if (occurrence.retryOf !== null) {
      const previous = occurrences.get(occurrence.retryOf);
      if (
        !previous ||
        previous.scenario?.kind === "instance" ||
        JSON.stringify(previous.parentCell) !== JSON.stringify(occurrence.parentCell) ||
        JSON.stringify(previous.scenario) !== JSON.stringify(occurrence.scenario) ||
        successors.has(previous.id)
      ) {
        throw new Error(`invalid retry predecessor for ${occurrence.id}`);
      }
      successors.set(previous.id, occurrence.id);
    }
  }
  for (const occurrence of summary.occurrences) {
    const visited = new Set<string>();
    let current: QaEvidenceOccurrence | undefined = occurrence;
    let effectiveCount = 0;
    while (current) {
      if (visited.has(current.id)) {
        throw new Error(`cyclic retry chain in ${occurrence.id}`);
      }
      visited.add(current.id);
      effectiveCount += entries.get(current.id)?.[0]?.effective ? 1 : 0;
      current = current.retryOf === null ? undefined : occurrences.get(current.retryOf);
    }
    if (effectiveCount > 1) {
      throw new Error("multiple effective attempts in one retry chain");
    }
  }
  // Selection is whole-attempt: a nonpassing retry never replaces its predecessor.
  for (const occurrence of summary.occurrences) {
    const nextId = successors.get(occurrence.id);
    if (!nextId) {
      continue;
    }
    const next = occurrences.get(nextId)!;
    const currentEffective = entries.get(occurrence.id)?.[0]?.effective;
    const nextEffective = entries.get(next.id)?.[0]?.effective;
    if (currentEffective && nextEffective) {
      throw new Error("multiple effective attempts in one retry chain");
    }
    if (
      occurrence.terminalStatus !== "fail" ||
      (next.terminalStatus !== "pass" && nextEffective) ||
      (next.terminalStatus === "pass" && currentEffective)
    ) {
      throw new Error("retry selection contradicts the recorded terminal outcomes");
    }
  }
}

const qaEvidenceSummaryV3Schema = qaEvidenceSummaryV3Shape.superRefine((summary, context) => {
  try {
    validateOccurrenceBindings(summary);
  } catch (error) {
    context.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
const qaVersionedEvidenceSummarySchema = z.discriminatedUnion("schemaVersion", [
  qaEvidenceSummarySchema,
  qaEvidenceSummaryV3Schema,
]);

type QaEvidenceProfile = z.infer<typeof qaEvidenceProfileIdSchema>;
export type QaEvidenceStatus = z.infer<typeof qaEvidenceStatusSchema>;
export type QaEvidenceTiming = z.infer<typeof qaEvidenceTimingSchema>;
export type QaEvidenceRttMeasurement = z.infer<typeof qaEvidenceRttMeasurementSchema>;
export type QaEvidencePackageSource = z.infer<typeof qaEvidencePackageSourceSchema>;
export type QaEvidenceScorecardJson = z.infer<typeof qaEvidenceScorecardSchema>;
type QaEvidenceSummaryV2Entry = z.infer<typeof qaEvidenceSummaryEntrySchema>;
export type QaEvidenceSummaryV3Entry = z.infer<typeof qaEvidenceSummaryV3EntrySchema>;
export type QaEvidenceSummaryEntry = QaEvidenceSummaryV2Entry | QaEvidenceSummaryV3Entry;
export type QaEvidenceSummaryV2Json = z.infer<typeof qaEvidenceSummarySchema>;
export type QaEvidenceSummaryV3Json = z.infer<typeof qaEvidenceSummaryV3Schema>;
export type QaEvidenceSummaryJson = QaEvidenceSummaryV2Json | QaEvidenceSummaryV3Json;
export type QaEvidenceOccurrence = z.infer<typeof qaEvidenceOccurrenceSchema>;
export type QaEvidenceAssertion = z.infer<typeof qaEvidenceAssertionSchema>;
export type QaEvidenceIdentity = z.infer<typeof qaEvidenceIdentitySchema>;
export type QaEvidenceScenarioOutcome = {
  scenarioId: string;
  scenarioInstanceId: string | null;
  occurrenceId: string | null;
  status: QaEvidenceStatus | null;
};

type QaEvidenceStatusInput = QaEvidenceStatus | "skip";

type QaEvidenceScenarioDefinitionInput = {
  id: string;
  title: string;
  sourcePath?: string;
  surface?: string;
  surfaces?: readonly string[];
  category?: string;
  coverage?: {
    primary?: readonly string[];
    secondary?: readonly string[];
  };
  runtimePairLane?: QaRuntimePairLane;
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
};

type QaEvidenceScenarioResultInput = {
  name: string;
  status: QaEvidenceStatusInput;
  details?: string;
  timing?: QaEvidenceTiming;
  rttMs?: number;
  rttMeasurement?: {
    finalMatchedReplyRttMs?: number;
    requestStartedAt?: string;
    responseObservedAt?: string;
    source?: string;
  };
};

type QaEvidenceRttInput = Pick<
  QaEvidenceScenarioResultInput,
  "rttMeasurement" | "rttMs" | "timing"
>;

type QaEvidenceTestTargetInput = {
  id: string;
  title: string;
  sourcePath: string;
  primaryCoverageIds?: readonly string[];
  secondaryCoverageIds?: readonly string[];
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
};

type QaEvidenceTestResultInput = {
  id?: string;
  title?: string;
  sourcePath?: string;
  status: QaEvidenceStatusInput;
  durationMs?: number;
  failureMessage?: string;
};

type QaEvidenceArtifactInput = {
  kind: string;
  path: string;
};

type QaEvidenceBuildBase = {
  artifactPaths: readonly QaEvidenceArtifactInput[];
  evidenceMode?: QaScorecardEvidenceMode;
  env?: NodeJS.ProcessEnv;
  generatedAt: string;
  primaryModel: string;
  providerId?: string;
  providerMode: QaProviderMode;
  channelDriver?: string;
  packageSource?: QaEvidencePackageSource;
  profile?: QaEvidenceProfile;
  repoRoot?: string;
  runner?: string;
};

function buildQaEvidenceRefs(params: {
  docsRefs?: readonly string[];
  codeRefs?: readonly string[];
}) {
  const refs = [
    ...(params.docsRefs ?? []).map((path) => ({ kind: "docs" as const, path })),
    ...(params.codeRefs ?? []).map((path) => ({ kind: "code" as const, path })),
  ];
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.path}`, ref])).values()];
}

function buildQaEvidenceCoverage(params: {
  primaryCoverageIds?: readonly string[];
  secondaryCoverageIds?: readonly string[];
}) {
  return [
    ...normalizeSortedUniqueTrimmedStringList(params.primaryCoverageIds ?? []).map((id) => ({
      id,
      role: "primary" as const,
    })),
    ...normalizeSortedUniqueTrimmedStringList(params.secondaryCoverageIds ?? []).map((id) => ({
      id,
      role: "secondary" as const,
    })),
  ];
}

function buildQaEvidenceArtifacts(paths: readonly QaEvidenceArtifactInput[], source: string) {
  return paths.map((artifact) => ({
    kind: artifact.kind,
    path: artifact.path,
    source,
  }));
}

export function resolveQaEvidenceProfile(params: {
  env?: NodeJS.ProcessEnv;
  explicit?: QaEvidenceProfile;
}) {
  if (params.explicit) {
    const explicit = params.explicit.trim();
    if (!explicit) {
      throw new Error("evidence profile must be a non-empty string.");
    }
    return explicit;
  }

  const envProfiles = [
    ["OPENCLAW_E2E_PROFILE", params.env?.OPENCLAW_E2E_PROFILE],
    ["OPENCLAW_QA_PROFILE", params.env?.OPENCLAW_QA_PROFILE],
  ] as const;
  for (const [, value] of envProfiles) {
    const normalized = value?.trim();
    if (!normalized) {
      continue;
    }
    return normalized;
  }

  return undefined;
}

function resolveQaEvidencePackageSource(env: NodeJS.ProcessEnv | undefined) {
  const spec = env?.OPENCLAW_QA_PACKAGE_SOURCE?.trim() || undefined;
  const sha = env?.OPENCLAW_QA_PACKAGE_SOURCE_SHA?.trim() || undefined;
  const explicitKind = env?.OPENCLAW_QA_PACKAGE_SOURCE_KIND?.trim();
  const kind =
    explicitKind ||
    (spec && spec.endsWith(".tgz") ? "packed-tarball" : spec ? "npm-package" : "source-checkout");
  return {
    kind,
    spec,
    sha,
  };
}

function buildQaEvidenceProvider(
  params: Pick<QaEvidenceBuildBase, "providerMode" | "primaryModel" | "providerId">,
) {
  const provider = getQaProvider(params.providerMode);
  const split = splitQaModelRef(params.primaryModel);
  const providerShape = {
    model: {
      name: split?.model ?? null,
      ref: params.primaryModel || null,
    },
  };
  if (provider.kind === "live") {
    return {
      ...providerShape,
      // A live run can know its provider even when its selected models differ.
      id: split?.provider ?? (params.providerId?.trim() || params.providerMode),
      live: true,
      auth: params.providerMode,
    };
  }
  const mockProviderId =
    split?.provider && split.provider !== params.providerMode
      ? split.provider
      : params.providerMode === "mock-openai"
        ? "openai"
        : (split?.provider ?? params.providerMode);
  return {
    ...providerShape,
    id: mockProviderId,
    live: false,
    fixture: params.providerMode,
  };
}

function resolveQaEvidenceBuildContext(params: QaEvidenceBuildBase, defaultRunner?: string) {
  return {
    profile: resolveQaEvidenceProfile({ env: params.env, explicit: params.profile }),
    executionBase: {
      runner: params.env?.OPENCLAW_QA_RUNNER?.trim() || (params.runner ?? defaultRunner) || "host",
      environment: resolveQaEvidenceEnvironment({ env: params.env, repoRoot: params.repoRoot }),
      provider: buildQaEvidenceProvider(params),
    },
    packageSource: params.packageSource ?? resolveQaEvidencePackageSource(params.env),
  };
}

function normalizeQaEvidenceStatus(status: QaEvidenceStatusInput): QaEvidenceStatus {
  return status === "skip" ? "skipped" : status;
}

function failureForResult(result: {
  details?: string;
  failureMessage?: string;
  status: QaEvidenceStatusInput;
}) {
  const status = normalizeQaEvidenceStatus(result.status);
  if (status === "pass") {
    return undefined;
  }
  return {
    reason: result.details?.trim() || result.failureMessage?.trim() || `${status} test`,
  };
}

function evidenceForRttResult(check: QaEvidenceRttInput) {
  const timing: QaEvidenceTiming = { ...check.timing };
  const parsedMeasurement = qaEvidenceRttMeasurementSchema.safeParse(check.rttMeasurement);
  const rttMeasurement = parsedMeasurement.success ? parsedMeasurement.data : undefined;
  const fallbackRttMs = check.rttMeasurement?.finalMatchedReplyRttMs ?? check.rttMs;
  if (rttMeasurement) {
    timing.rttMs = rttMeasurement.finalMatchedReplyRttMs;
  } else if (
    timing.rttMs === undefined &&
    typeof fallbackRttMs === "number" &&
    Number.isFinite(fallbackRttMs) &&
    fallbackRttMs > 0
  ) {
    timing.rttMs = fallbackRttMs;
  }
  return {
    timing: Object.keys(timing).length > 0 ? timing : undefined,
    rttMeasurement,
  };
}

function timingForTestResult(result: QaEvidenceTestResultInput) {
  return typeof result.durationMs === "number" &&
    Number.isFinite(result.durationMs) &&
    result.durationMs > 0
    ? { wallMs: result.durationMs }
    : undefined;
}

function resultForEvidence(
  result: { details?: string; failureMessage?: string; status: QaEvidenceStatusInput },
  timing?: QaEvidenceTiming,
  rttMeasurement?: QaEvidenceRttMeasurement,
) {
  return {
    status: normalizeQaEvidenceStatus(result.status),
    failure: failureForResult(result),
    timing,
    rttMeasurement,
  };
}

function buildQaEvidenceSummary(params: {
  entries: QaEvidenceSummaryV2Entry[];
  evidenceMode?: QaScorecardEvidenceMode;
  generatedAt: string;
  profile?: QaEvidenceProfile;
  profilePlan?: QaProfileEvidencePlan;
  scorecard?: QaEvidenceScorecardJson;
}): QaEvidenceSummaryV2Json {
  const profileOptions = readQaScorecardProfileOptions(params.profile);
  const evidenceMode = params.evidenceMode ?? profileOptions.evidenceMode;
  const entries =
    evidenceMode === "slim"
      ? params.entries.map((entry) => {
          const { execution: _execution, ...withoutExecution } = entry;
          return withoutExecution;
        })
      : params.entries;
  return qaEvidenceSummarySchema.parse({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    evidenceMode,
    entries,
    profile: params.profile,
    profilePlan: params.profilePlan,
    scorecard: params.scorecard,
  });
}

export function validateQaEvidenceSummaryJson(summary: unknown): QaEvidenceSummaryJson {
  return qaVersionedEvidenceSummarySchema.parse(summary);
}

/** Only the invocation owner can supply bindings; this constructor invents none. */
export function buildQaOccurrenceEvidenceSummary(params: {
  entries: QaEvidenceSummaryV3Entry[];
  occurrences: QaEvidenceOccurrence[];
  evidenceMode?: QaScorecardEvidenceMode;
  generatedAt: string;
  profile?: QaEvidenceProfile;
  profilePlan?: QaProfileEvidencePlan;
  scorecard?: QaEvidenceScorecardJson;
}): QaEvidenceSummaryV3Json {
  const evidenceMode =
    params.evidenceMode ?? readQaScorecardProfileOptions(params.profile).evidenceMode;
  return qaEvidenceSummaryV3Schema.parse({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: 3,
    generatedAt: params.generatedAt,
    evidenceMode,
    entries:
      evidenceMode === "slim"
        ? params.entries.map(({ execution: _execution, ...entry }) => entry)
        : params.entries,
    occurrences: params.occurrences,
    profile: params.profile,
    profilePlan: params.profilePlan,
    scorecard: params.scorecard,
  });
}

export function getEffectiveQaEvidenceEntries(
  summary: QaEvidenceSummaryJson,
): QaEvidenceSummaryEntry[] {
  return summary.schemaVersion === 2
    ? summary.entries
    : summary.entries.filter((entry) => entry.effective);
}

export function projectQaEvidenceScenarioOutcomes(
  summary: QaEvidenceSummaryJson,
): QaEvidenceScenarioOutcome[] {
  if (summary.schemaVersion === 2) {
    return summary.entries.map((entry) => ({
      scenarioId: entry.test.id,
      scenarioInstanceId: null,
      occurrenceId: null,
      status: entry.result.status,
    }));
  }
  const occurrences = new Map(summary.occurrences.map((occurrence) => [occurrence.id, occurrence]));
  const effective = new Set(
    summary.entries.filter((entry) => entry.effective).map((entry) => entry.binding.occurrenceId),
  );
  const outcomes: QaEvidenceScenarioOutcome[] = [];
  for (const occurrence of summary.occurrences) {
    if (occurrence.scenario?.kind !== "instance" || !occurrence.parentCell) {
      continue;
    }
    const selectedId = occurrence.scenario.resultOccurrenceId;
    // An unresolved first scheduled instance must not disappear behind a later pass.
    outcomes.push({
      scenarioId: occurrence.parentCell.scenarioId,
      scenarioInstanceId: occurrence.id,
      occurrenceId: selectedId,
      status:
        selectedId !== null && effective.has(selectedId)
          ? (occurrences.get(selectedId)?.terminalStatus ?? null)
          : null,
    });
  }
  return outcomes;
}

export function mergeQaEvidenceSummaries(params: {
  evidenceSummaries: readonly QaEvidenceSummaryJson[];
  generatedAt: string;
}) {
  const summaries = params.evidenceSummaries.map(validateQaEvidenceSummaryJson);
  const versions = new Set(summaries.map((summary) => summary.schemaVersion));
  if (versions.size > 1) {
    throw new Error("cannot merge v2 and v3 evidence without an invocation-owned import");
  }
  const occurrences = new Map<string, QaEvidenceOccurrence>();
  for (const summary of summaries) {
    if (summary.schemaVersion !== 3) {
      continue;
    }
    for (const occurrence of summary.occurrences) {
      const previous = occurrences.get(occurrence.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(occurrence)) {
        throw new Error(`conflicting evidence occurrence ${occurrence.id}`);
      }
      occurrences.set(occurrence.id, occurrence);
    }
  }
  const profiles = [
    ...new Set(
      summaries
        .map((summary) => summary.profile?.trim())
        .filter((profile): profile is string => Boolean(profile)),
    ),
  ];
  return validateQaEvidenceSummaryJson({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: versions.has(3) ? 3 : QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    evidenceMode:
      summaries.length > 0 && summaries.every((summary) => summary.evidenceMode === "slim")
        ? "slim"
        : "full",
    entries: summaries.flatMap((summary) => summary.entries),
    profile: profiles.length === 1 ? profiles[0] : undefined,
    ...(versions.has(3) ? { occurrences: [...occurrences.values()] } : {}),
  });
}

export function attachQaEvidenceScorecard(params: {
  evidenceMode?: QaScorecardEvidenceMode;
  summary: QaEvidenceSummaryJson;
  profile: QaEvidenceProfile;
  profilePlan: QaProfileEvidencePlan;
  scorecard: QaEvidenceScorecardJson;
}): QaEvidenceSummaryJson {
  if (params.summary.schemaVersion === 3) {
    return buildQaOccurrenceEvidenceSummary({
      entries: params.summary.entries,
      occurrences: params.summary.occurrences,
      evidenceMode: params.evidenceMode ?? params.summary.evidenceMode,
      generatedAt: params.summary.generatedAt,
      profile: params.profile,
      profilePlan: params.profilePlan,
      scorecard: params.scorecard,
    });
  }
  return buildQaEvidenceSummary({
    entries: params.summary.entries,
    evidenceMode: params.evidenceMode,
    generatedAt: params.summary.generatedAt,
    profile: params.profile,
    profilePlan: params.profilePlan,
    scorecard: params.scorecard,
  });
}

export function buildQaSuiteEvidenceSummary(
  params: QaEvidenceBuildBase & {
    channelId: string;
    scenarioDefinitions: readonly QaEvidenceScenarioDefinitionInput[];
    scenarioResults: readonly QaEvidenceScenarioResultInput[];
  },
): QaEvidenceSummaryV2Json {
  const { executionBase, packageSource, profile } = resolveQaEvidenceBuildContext(params);
  const channelDriver = params.channelDriver?.trim() || undefined;
  const entries = params.scenarioResults.map((result, index): QaEvidenceSummaryV2Entry => {
    const scenario = params.scenarioDefinitions[index];
    const primaryCoverageIds = normalizeSortedUniqueTrimmedStringList(
      scenario?.coverage?.primary ?? [],
    );
    const coverageIds = normalizeSortedUniqueTrimmedStringList([
      ...(scenario?.coverage?.primary ?? []),
      ...(scenario?.coverage?.secondary ?? []),
    ]);
    const runtimePairLane = scenario?.runtimePairLane;
    const testId = scenario?.id ?? `scenario-${index + 1}`;
    const refs = buildQaEvidenceRefs({
      docsRefs: scenario?.docsRefs,
      codeRefs: scenario?.codeRefs,
    });
    const { timing, rttMeasurement } = evidenceForRttResult(result);
    return {
      test: {
        kind: "qa-scenario",
        id: testId,
        title: scenario?.title ?? result.name,
        source: scenario?.sourcePath ? { path: scenario.sourcePath } : undefined,
      },
      coverage: buildQaEvidenceCoverage({
        primaryCoverageIds,
        secondaryCoverageIds: coverageIds.filter(
          (coverageId) => !primaryCoverageIds.includes(coverageId),
        ),
      }),
      refs: refs.length > 0 ? refs : undefined,
      runtimePairLane,
      execution: {
        ...executionBase,
        channel: {
          id: params.channelId,
          live: channelDriver === "live",
          driver: channelDriver,
        },
        packageSource,
        artifacts: buildQaEvidenceArtifacts(params.artifactPaths, "qa-suite"),
      },
      result: resultForEvidence(result, timing, rttMeasurement),
    };
  });
  return buildQaEvidenceSummary({
    entries,
    evidenceMode: params.evidenceMode,
    generatedAt: params.generatedAt,
    profile,
  });
}

function buildTestRunnerEvidenceSummary(
  params: QaEvidenceBuildBase & {
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
  defaultRunner: string,
  testKind: string,
): QaEvidenceSummaryV2Json {
  const { executionBase, packageSource, profile } = resolveQaEvidenceBuildContext(
    params,
    defaultRunner,
  );
  const targetById = new Map(params.targets.map((target) => [target.id, target]));
  const targetByPath = new Map(params.targets.map((target) => [target.sourcePath, target]));
  const entries = params.results.map((result, index): QaEvidenceSummaryV2Entry => {
    const target = result.id
      ? targetById.get(result.id)
      : result.sourcePath
        ? targetByPath.get(result.sourcePath)
        : undefined;
    const fallbackId = result.id ?? result.sourcePath ?? `test-${index + 1}`;
    const sourcePath = target?.sourcePath ?? result.sourcePath;
    const refs = buildQaEvidenceRefs({
      docsRefs: target?.docsRefs,
      codeRefs: target?.codeRefs,
    });
    const timing = timingForTestResult(result);
    return {
      test: {
        kind: testKind,
        id: target?.id ?? fallbackId,
        title: target?.title ?? result.title ?? fallbackId,
        source: sourcePath ? { path: sourcePath } : undefined,
      },
      coverage: buildQaEvidenceCoverage({
        primaryCoverageIds: target?.primaryCoverageIds ?? [],
        secondaryCoverageIds: target?.secondaryCoverageIds ?? [],
      }),
      refs: refs.length > 0 ? refs : undefined,
      execution: {
        ...executionBase,
        packageSource,
        artifacts: buildQaEvidenceArtifacts(params.artifactPaths, executionBase.runner),
      },
      result: resultForEvidence(result, timing),
    };
  });
  return buildQaEvidenceSummary({
    entries,
    evidenceMode: params.evidenceMode,
    generatedAt: params.generatedAt,
    profile,
  });
}

export function buildVitestEvidenceSummary(
  params: QaEvidenceBuildBase & {
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
): QaEvidenceSummaryV2Json {
  return buildTestRunnerEvidenceSummary(params, "vitest", "vitest-test");
}

export function buildPlaywrightEvidenceSummary(
  params: QaEvidenceBuildBase & {
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
): QaEvidenceSummaryV2Json {
  return buildTestRunnerEvidenceSummary(params, "playwright", "playwright-test");
}

export function buildScriptEvidenceSummary(
  params: QaEvidenceBuildBase & {
    targets: readonly QaEvidenceTestTargetInput[];
    results: readonly QaEvidenceTestResultInput[];
  },
): QaEvidenceSummaryV2Json {
  return buildTestRunnerEvidenceSummary(params, "script", "script-test");
}
