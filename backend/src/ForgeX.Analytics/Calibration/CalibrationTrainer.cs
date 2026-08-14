namespace ForgeX.Analytics.Calibration;

public static class CalibrationTrainer
{
    public const int MinSamples = 3;

    public static CalibrationTrainingResult Train(
        IReadOnlyList<CalibrationSample> samples,
        CalibrationScope scope,
        IReadOnlyList<CalibrationSample>? holdoutSamples = null,
        int minDriftSamples = 5,
        double maxMape = 0.2,
        double maxBias = 0.12)
    {
        ArgumentNullException.ThrowIfNull(samples);
        ArgumentNullException.ThrowIfNull(scope);
        var rows = Normalize(samples);
        var line = FitLine(rows);
        var coefficients = new CalibrationCoefficients(line.MotionScale, line.FixedOverheadSec, rows.Count);
        var training = Evaluate(coefficients, rows);
        CalibrationMetrics? crossValidation = rows.Count >= 4 ? LeaveOneOut(rows) : null;
        CalibrationMetrics? holdout = holdoutSamples is { Count: > 0 }
            ? Evaluate(coefficients, Normalize(holdoutSamples))
            : null;
        CalibrationDrift? drift = holdoutSamples is { Count: > 0 }
            ? DetectDrift(coefficients, Normalize(holdoutSamples), minDriftSamples, maxMape, maxBias)
            : null;
        return new CalibrationTrainingResult(
            "forgex-time-calibration",
            1,
            "theil-sen",
            scope,
            coefficients,
            training,
            crossValidation,
            holdout,
            drift);
    }

    public static double Predict(CalibrationCoefficients coefficients, double plannedTimeSec)
    {
        if (!double.IsFinite(plannedTimeSec) || plannedTimeSec < 0)
            throw new ArgumentOutOfRangeException(nameof(plannedTimeSec));
        return Math.Max(0, coefficients.FixedOverheadSec + coefficients.MotionScale * plannedTimeSec);
    }

    public static CalibrationMetrics Evaluate(
        CalibrationCoefficients coefficients,
        IReadOnlyList<CalibrationSample> samples)
    {
        var rows = Normalize(samples);
        if (rows.Count == 0) throw new ArgumentException("Evaluation samples cannot be empty.", nameof(samples));
        var mean = rows.Average(static row => row.ActualTimeSec);
        var absolute = new double[rows.Count];
        var ape = new double[rows.Count];
        var squared = new double[rows.Count];
        var ssTotal = 0d;
        for (var index = 0; index < rows.Count; index++)
        {
            var row = rows[index];
            var error = Predict(coefficients, row.PlannedTimeSec) - row.ActualTimeSec;
            absolute[index] = Math.Abs(error);
            ape[index] = Math.Abs(error) / row.ActualTimeSec;
            squared[index] = error * error;
            ssTotal += Math.Pow(row.ActualTimeSec - mean, 2);
        }
        var ssResidual = squared.Sum();
        return new CalibrationMetrics(
            rows.Count,
            absolute.Average(),
            ape.Average(),
            Math.Sqrt(squared.Average()),
            ape.Max(),
            ssTotal > 0 ? 1 - ssResidual / ssTotal : null);
    }

    public static CalibrationDrift DetectDrift(
        CalibrationCoefficients coefficients,
        IReadOnlyList<CalibrationSample> samples,
        int minSamples = 5,
        double maxMape = 0.2,
        double maxBias = 0.12)
    {
        var rows = Normalize(samples);
        minSamples = Math.Max(MinSamples, minSamples);
        if (rows.Count < minSamples)
        {
            return new CalibrationDrift("insufficient", rows.Count, minSamples, null, null, null, maxMape, maxBias);
        }
        var absolute = new double[rows.Count];
        var signed = new double[rows.Count];
        for (var index = 0; index < rows.Count; index++)
        {
            var predicted = Predict(coefficients, rows[index].PlannedTimeSec);
            var error = predicted > 0 ? (rows[index].ActualTimeSec - predicted) / predicted : 0;
            signed[index] = error;
            absolute[index] = Math.Abs(error);
        }
        Array.Sort(absolute);
        var medianApe = Median(absolute);
        Array.Sort(signed);
        var medianBias = Median(signed);
        var p90Index = Math.Min(absolute.Length - 1, (int)Math.Ceiling(absolute.Length * 0.9) - 1);
        var warning = medianApe > maxMape * 0.8 || Math.Abs(medianBias) > maxBias * 0.8;
        var drift = medianApe > maxMape || Math.Abs(medianBias) > maxBias;
        return new CalibrationDrift(
            drift ? "drift" : warning ? "warning" : "stable",
            rows.Count,
            minSamples,
            medianApe,
            medianBias,
            absolute[p90Index],
            maxMape,
            maxBias);
    }

    private static CalibrationMetrics LeaveOneOut(IReadOnlyList<CalibrationSample> rows)
    {
        var predictions = new List<CalibrationSample>(rows.Count);
        for (var index = 0; index < rows.Count; index++)
        {
            var training = rows.Where((_, rowIndex) => rowIndex != index).ToArray();
            var line = FitLine(training);
            predictions.Add(rows[index] with
            {
                ActualTimeSec = Math.Max(0, line.FixedOverheadSec + line.MotionScale * rows[index].PlannedTimeSec),
            });
        }
        // Evaluate expects ActualTimeSec to be observed values. Rebuild metrics from explicit predictions.
        var absolute = new double[rows.Count];
        var ape = new double[rows.Count];
        var squared = new double[rows.Count];
        var mean = rows.Average(static row => row.ActualTimeSec);
        for (var index = 0; index < rows.Count; index++)
        {
            var predicted = predictions[index].ActualTimeSec;
            var error = predicted - rows[index].ActualTimeSec;
            absolute[index] = Math.Abs(error);
            ape[index] = Math.Abs(error) / rows[index].ActualTimeSec;
            squared[index] = error * error;
        }
        var ssTotal = rows.Sum(row => Math.Pow(row.ActualTimeSec - mean, 2));
        return new CalibrationMetrics(rows.Count, absolute.Average(), ape.Average(), Math.Sqrt(squared.Average()), ape.Max(), ssTotal > 0 ? 1 - squared.Sum() / ssTotal : null);
    }

    private static IReadOnlyList<CalibrationSample> Normalize(IReadOnlyList<CalibrationSample> samples)
    {
        if (samples.Count == 0) return [];
        var rows = new List<CalibrationSample>(samples.Count);
        for (var index = 0; index < samples.Count; index++)
        {
            var row = samples[index];
            if (!double.IsFinite(row.PlannedTimeSec) || row.PlannedTimeSec <= 0 ||
                !double.IsFinite(row.ActualTimeSec) || row.ActualTimeSec <= 0)
            {
                throw new ArgumentException($"Sample {index + 1} must contain positive finite planned and actual times.", nameof(samples));
            }
            rows.Add(row with
            {
                Id = string.IsNullOrWhiteSpace(row.Id) ? $"sample-{index + 1}" : row.Id,
                MachineId = row.MachineId ?? string.Empty,
                Firmware = row.Firmware ?? string.Empty,
            });
        }
        return rows;
    }

    private static (double MotionScale, double FixedOverheadSec) FitLine(IReadOnlyList<CalibrationSample> rows)
    {
        if (rows.Count < MinSamples) throw new ArgumentException($"At least {MinSamples} calibration samples are required.");
        if (rows.Select(static row => row.PlannedTimeSec).Distinct().Count() < MinSamples)
            throw new ArgumentException($"At least {MinSamples} distinct planned durations are required.");
        var slopes = new List<double>();
        for (var i = 0; i < rows.Count; i++)
        {
            for (var j = i + 1; j < rows.Count; j++)
            {
                var dx = rows[j].PlannedTimeSec - rows[i].PlannedTimeSec;
                if (Math.Abs(dx) > 1e-9) slopes.Add((rows[j].ActualTimeSec - rows[i].ActualTimeSec) / dx);
            }
        }
        var slope = Median(slopes);
        if (!double.IsFinite(slope) || slope <= 0) throw new ArgumentException("Calibration samples must produce a positive motion scale.");
        var intercept = Median(rows.Select(row => row.ActualTimeSec - slope * row.PlannedTimeSec).ToArray());
        if (intercept < 0)
        {
            intercept = 0;
            slope = Median(rows.Select(row => row.ActualTimeSec / row.PlannedTimeSec).ToArray());
        }
        return (slope, intercept);
    }

    private static double Median(IReadOnlyList<double> values)
    {
        if (values.Count == 0) throw new ArgumentException("Median requires at least one value.");
        var sorted = values.ToArray();
        Array.Sort(sorted);
        var middle = sorted.Length / 2;
        return sorted.Length % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    }
}
