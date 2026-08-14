using System.Text.Json;
using ForgeX.Analytics.Calibration;
using ForgeX.Contracts;
using Microsoft.AspNetCore.Http.Features;

namespace ForgeX.Api;

internal static class CalibrationEndpoints
{
    internal const long MaxRequestBytes = 2L * 1024 * 1024;
    internal const int MaxSamples = 500;
    internal const string EngineVersion = "1.0.0";
    private const int MaxTextLength = 256;

    public static async Task<IResult> TrainAsync(HttpContext context)
    {
        var mediaType = context.Request.ContentType?.Split(';', 2)[0].Trim();
        if (!string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase))
        {
            return ApiProblemResults.Create(context, StatusCodes.Status415UnsupportedMediaType,
                "unsupported_media_type", "Unsupported media type", "Use Content-Type: application/json.");
        }
        if (context.Request.ContentLength is > MaxRequestBytes)
        {
            return ApiProblemResults.Create(context, StatusCodes.Status413PayloadTooLarge,
                "calibration_payload_too_large", "Calibration payload is too large",
                $"The request body limit is {MaxRequestBytes} bytes.");
        }
        var maxBodySizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (maxBodySizeFeature is { IsReadOnly: false }) maxBodySizeFeature.MaxRequestBodySize = MaxRequestBytes;

        CalibrationTrainingRequestDto? request;
        try
        {
            request = await context.Request.ReadFromJsonAsync<CalibrationTrainingRequestDto>(
                cancellationToken: context.RequestAborted);
        }
        catch (JsonException exception)
        {
            return ApiProblemResults.Create(context, StatusCodes.Status400BadRequest,
                "invalid_calibration_json", "Calibration request JSON is invalid", exception.Message);
        }
        if (!TryMap(request, out var scope, out var samples, out var holdout, out var minDriftSamples, out var maxMape, out var maxBias, out var errors))
        {
            return ApiProblemResults.Create(context, StatusCodes.Status400BadRequest,
                "invalid_calibration_request", "Calibration request is invalid",
                errors.Values.SelectMany(static messages => messages).FirstOrDefault(), errors);
        }

        try
        {
            var training = CalibrationTrainer.Train(samples, scope, holdout, minDriftSamples, maxMape, maxBias);
            var response = new CalibrationAuthorityResponseDto(
                "1.0",
                new CalibrationAuthorityEngineDto("forgex-calibration-csharp", EngineVersion),
                training);
            return Results.Ok(response);
        }
        catch (ArgumentException exception)
        {
            return ApiProblemResults.Create(context, StatusCodes.Status422UnprocessableEntity,
                "calibration_training_failed", "Calibration training failed", exception.Message);
        }
    }

    private static bool TryMap(
        CalibrationTrainingRequestDto? request,
        out CalibrationScope scope,
        out IReadOnlyList<CalibrationSample> samples,
        out IReadOnlyList<CalibrationSample>? holdout,
        out int minDriftSamples,
        out double maxMape,
        out double maxBias,
        out IReadOnlyDictionary<string, string[]> errors)
    {
        var validation = new Dictionary<string, string[]>(StringComparer.Ordinal);
        scope = new CalibrationScope(string.Empty, string.Empty);
        samples = [];
        holdout = null;
        minDriftSamples = 5;
        maxMape = 0.2;
        maxBias = 0.12;

        if (request is null) validation["body"] = ["A JSON request body is required."];
        else
        {
            if (!string.Equals(request.SchemaVersion, "1.0", StringComparison.Ordinal))
                validation["schemaVersion"] = ["schemaVersion must be '1.0'."];
            if (request.Scope is null) validation["scope"] = ["scope is required."];
            else
            {
                var machine = request.Scope.MachineId?.Trim() ?? string.Empty;
                var firmware = request.Scope.Firmware?.Trim() ?? string.Empty;
                if (machine.Length is < 1 or > MaxTextLength) validation["scope.machineId"] = [$"machine_id must contain 1 to {MaxTextLength} characters."];
                if (firmware.Length is < 1 or > MaxTextLength) validation["scope.firmware"] = [$"firmware must contain 1 to {MaxTextLength} characters."];
                scope = new CalibrationScope(machine, firmware);
            }
            if (request.Samples is null || request.Samples.Count is < CalibrationTrainer.MinSamples or > MaxSamples)
                validation["samples"] = [$"samples must contain {CalibrationTrainer.MinSamples} to {MaxSamples} items."];
            else if (TryMapSamples(request.Samples, "samples", validation, out var mapped)) samples = mapped;
            if (request.HoldoutSamples is { Count: > MaxSamples })
                validation["holdout_samples"] = [$"holdout_samples must contain at most {MaxSamples} items."];
            else if (request.HoldoutSamples is { Count: > 0 } && TryMapSamples(request.HoldoutSamples, "holdout_samples", validation, out var mappedHoldout))
                holdout = mappedHoldout;

            if (request.Thresholds is not null)
            {
                minDriftSamples = request.Thresholds.MinDriftSamples ?? 5;
                maxMape = request.Thresholds.MaxMape ?? 0.2;
                maxBias = request.Thresholds.MaxBias ?? 0.12;
                if (minDriftSamples < CalibrationTrainer.MinSamples || minDriftSamples > MaxSamples)
                    validation["thresholds.min_drift_samples"] = [$"min_drift_samples must be between {CalibrationTrainer.MinSamples} and {MaxSamples}."];
                if (!double.IsFinite(maxMape) || maxMape <= 0 || maxMape > 1)
                    validation["thresholds.max_mape"] = ["max_mape must be finite and within (0, 1]."];
                if (!double.IsFinite(maxBias) || maxBias <= 0 || maxBias > 1)
                    validation["thresholds.max_bias"] = ["max_bias must be finite and within (0, 1]."];
            }
        }
        errors = validation;
        return validation.Count == 0;
    }

    private static bool TryMapSamples(
        IReadOnlyList<CalibrationSampleRequestDto> input,
        string prefix,
        Dictionary<string, string[]> errors,
        out IReadOnlyList<CalibrationSample> mapped)
    {
        var rows = new List<CalibrationSample>(input.Count);
        for (var index = 0; index < input.Count; index++)
        {
            var source = input[index];
            var planned = source.PlannedTimeSec ?? source.PlannedSec;
            var actual = source.ActualTimeSec ?? source.ActualSec;
            var field = $"{prefix}[{index}]";
            var valid = true;
            if (planned is null || !double.IsFinite(planned.Value) || planned <= 0)
            {
                errors[$"{field}.planned_time_sec"] = ["planned_time_sec must be a positive finite number."];
                valid = false;
            }
            if (actual is null || !double.IsFinite(actual.Value) || actual <= 0)
            {
                errors[$"{field}.actual_time_sec"] = ["actual_time_sec must be a positive finite number."];
                valid = false;
            }
            foreach (var (name, value) in new (string Name, string? Value)[]
            {
                ("id", source.Id), ("machine_id", source.MachineId), ("firmware", source.Firmware),
            })
            {
                if (value?.Length > MaxTextLength) { errors[$"{field}.{name}"] = [$"{name} must not exceed {MaxTextLength} characters."]; valid = false; }
            }
            if (valid)
            {
                rows.Add(new CalibrationSample(source.Id?.Trim() ?? string.Empty, planned!.Value, actual!.Value,
                    source.MachineId?.Trim() ?? string.Empty, source.Firmware?.Trim() ?? string.Empty));
            }
        }
        mapped = rows;
        return errors.Keys.All(key => !key.StartsWith(prefix + "[", StringComparison.Ordinal));
    }
}
