// Canonical v2/v3 evidence shapes and occurrence binding validation.
import { z } from "zod";
import { qaEvidenceAssertionSchema, qaEvidenceCoverageSchema } from "./evidence-assertion.js";
import { resolveQaEvidenceContainment } from "./evidence-containment.js";
import { qaProfileEvidencePlan } from "./profile-evidence-plan.js";
import { qaRuntimePairLaneSchema } from "./scenario-catalog.js";
import { qaScorecardEvidenceModeSchema } from "./scorecard-taxonomy.js";

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
  // Direct members of a retained producer bundle; nested ownership stays local.
  childOccurrenceIds: z.array(nonEmptyStringSchema).min(1).optional(),
  // The enclosing catalog caps qualifying claims without rewriting captured rows.
  childCoverage: z.array(qaEvidenceCoverageSchema).optional(),
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
  resolveQaEvidenceContainment(summary.occurrences, summary.entries);
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
export {
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  qaEvidenceRttMeasurementSchema,
  qaEvidenceSummarySchema,
  qaEvidenceSummaryV3Schema,
  qaVersionedEvidenceSummarySchema,
};
export type { QaEvidenceProfile, QaEvidenceSummaryV2Entry };
