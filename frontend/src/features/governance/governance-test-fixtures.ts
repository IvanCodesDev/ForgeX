import type { CalibrationBundle, CalibrationCatalog, CalibrationSubmission } from "./governance-types";

export function calibrationBundle(status: "candidate" | "active" = "active"): CalibrationBundle {
  return {
    format: "forgex-calibration-bundle",
    version: 1,
    id: "factory-line-a",
    revision: 2,
    createdAt: "2026-08-01T08:00:00.000Z",
    provenance: "real-anonymized",
    source: {
      license: "CC-BY-4.0",
      note: "Anonymized production observations reviewed for the calibration release.",
    },
    models: [
      {
        id: "factory-line-a-pla",
        status,
        scope: { machineId: "FX-LINE-A", firmware: "Klipper 0.12", material: "PLA" },
        algorithm: "theil-sen",
        trainedAt: "2026-08-01T08:00:00.000Z",
        coefficients: { motionScale: 1.12, fixedOverheadSec: 45, sampleCount: 16 },
        validation: {
          holdoutSamples: 6,
          mape: 0.1,
          maxApe: 0.18,
          medianBias: 0.02,
          evaluatedAt: "2026-08-02T08:00:00.000Z",
        },
        thresholds: { maxMape: 0.2, maxBias: 0.12, minDriftSamples: 5 },
        trainingSetSha256: "b".repeat(64),
      },
    ],
  };
}

export function calibrationCatalog(): CalibrationCatalog {
  return {
    format: "forgex-calibration-catalog",
    version: 1,
    items: [
      {
        id: "factory-line-a",
        revision: 2,
        digest: "a".repeat(64),
        bundle: calibrationBundle("active"),
        approvedAt: Date.UTC(2026, 7, 3, 8),
        approvedBy: "key-reviewer-2",
      },
    ],
  };
}

export function calibrationSubmission(status: "pending" | "approved" | "rejected" = "pending"): CalibrationSubmission {
  const base = {
    key: "factory-line-a@2",
    id: "factory-line-a",
    revision: 2,
    status,
    digest: "c".repeat(64),
    bundle: calibrationBundle("candidate"),
    createdAt: Date.UTC(2026, 7, 2, 8),
    updatedAt: Date.UTC(2026, 7, 2, 8),
    submittedBy: "key-submitter-1",
    note: "Production candidate for independent review.",
    events: [
      {
        action: "submitted" as const,
        at: Date.UTC(2026, 7, 2, 8),
        actor: "key-submitter-1",
        reason: "Production candidate for independent review.",
      },
    ],
  };
  return status === "pending"
    ? base
    : {
        ...base,
        reviewedBy: "key-reviewer-2",
        reviewReason: "Independent holdout evidence and source were reviewed.",
      };
}
