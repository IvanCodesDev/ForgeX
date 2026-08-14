namespace ForgeX.Analytics.Calibration;

public sealed record CalibrationSample(
    string Id,
    double PlannedTimeSec,
    double ActualTimeSec,
    string MachineId,
    string Firmware);

public sealed record CalibrationScope(string MachineId, string Firmware);

public sealed record CalibrationMetrics(
    int SampleCount,
    double MaeSec,
    double Mape,
    double RmseSec,
    double MaxApe,
    double? R2);

public sealed record CalibrationCoefficients(
    double MotionScale,
    double FixedOverheadSec,
    int SampleCount);

public sealed record CalibrationDrift(
    string Status,
    int SampleCount,
    int RequiredSamples,
    double? MedianApe,
    double? MedianBias,
    double? P90Ape,
    double? MaxMape,
    double? MaxBias);

public sealed record CalibrationTrainingResult(
    string Format,
    int Version,
    string Method,
    CalibrationScope Scope,
    CalibrationCoefficients Coefficients,
    CalibrationMetrics TrainingMetrics,
    CalibrationMetrics? CrossValidation,
    CalibrationMetrics? HoldoutMetrics,
    CalibrationDrift? Drift);
