export type CalibrationProvenance = "real-anonymized" | "real-consented" | "synthetic-conformance";
export type CalibrationStatus = "pending" | "approved" | "rejected";
export type CalibrationReviewDecision = "approve" | "reject";

export interface CalibrationScope {
  readonly machineId: string;
  readonly firmware: string;
  readonly material?: string;
}

export interface CalibrationValidationEvidence {
  readonly holdoutSamples: number;
  readonly mape: number;
  readonly maxApe: number;
  readonly medianBias: number;
  readonly evaluatedAt: string;
}

export interface CalibrationThresholds {
  readonly maxMape: number;
  readonly maxBias: number;
  readonly minDriftSamples: number;
}

export interface CalibrationModel {
  readonly id: string;
  readonly status: "candidate" | "active" | "retired" | "demonstration-only";
  readonly scope: CalibrationScope;
  readonly algorithm: "theil-sen";
  readonly trainedAt: string;
  readonly coefficients: {
    readonly motionScale: number;
    readonly fixedOverheadSec: number;
    readonly sampleCount: number;
  };
  readonly validation: CalibrationValidationEvidence;
  readonly thresholds: CalibrationThresholds;
  readonly trainingSetSha256: string;
}

export interface CalibrationBundle {
  readonly format: "forgex-calibration-bundle";
  readonly version: 1;
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly provenance: CalibrationProvenance;
  readonly source: {
    readonly license: string;
    readonly note: string;
  };
  readonly models: readonly CalibrationModel[];
}

export interface PublishedCalibration {
  readonly id: string;
  readonly revision: number;
  readonly digest: string;
  readonly bundle: CalibrationBundle;
  readonly approvedAt: number;
  readonly approvedBy: string;
}

export interface CalibrationCatalog {
  readonly format: "forgex-calibration-catalog";
  readonly version: 1;
  readonly items: readonly PublishedCalibration[];
}

export interface CalibrationAuditEvent {
  readonly action: "submitted" | "approved" | "rejected";
  readonly at: number;
  readonly actor: string;
  readonly reason: string;
}

export interface CalibrationSubmission {
  readonly key: string;
  readonly id: string;
  readonly revision: number;
  readonly status: CalibrationStatus;
  readonly digest: string;
  readonly bundle: CalibrationBundle;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly submittedBy: string;
  readonly note: string;
  readonly events: readonly CalibrationAuditEvent[];
  readonly reviewedBy?: string;
  readonly reviewReason?: string;
}

export interface CalibrationReviewResult {
  readonly id: string;
  readonly revision: number;
  readonly status: "approved" | "rejected";
  readonly reviewedBy: string;
  readonly reviewReason: string;
}

export interface CalibrationReviewInput {
  readonly id: string;
  readonly revision: number;
  readonly decision: CalibrationReviewDecision;
  readonly reason: string;
}
