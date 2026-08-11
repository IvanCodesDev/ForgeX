using System.Text.Json;
using System.Text.Json.Serialization;
using ForgeX.Analytics;
using ForgeX.Contracts;
using Microsoft.AspNetCore.Http.Features;

namespace ForgeX.Api;

internal static class AnalyticsEndpoints
{
    internal const long MaxRequestBytes = 5L * 1024 * 1024;
    internal const int MaxRows = 5000;
    internal const string EngineVersion = "1.3.0";
    private const int MaxQuestionLength = 500;
    private const int MaxTextLength = 512;

    private static readonly JsonSerializerOptions ResponseJsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    public static async Task<IResult> AnalyzeAsync(HttpContext context)
    {
        var mediaType = context.Request.ContentType?.Split(';', 2)[0].Trim();
        if (!string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase))
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status415UnsupportedMediaType,
                "unsupported_media_type",
                "Unsupported media type",
                "Use Content-Type: application/json.");
        }

        if (context.Request.ContentLength is > MaxRequestBytes)
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status413PayloadTooLarge,
                "analytics_payload_too_large",
                "Analytics payload is too large",
                $"The request body limit is {MaxRequestBytes} bytes.");
        }

        var maxBodySizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (maxBodySizeFeature is { IsReadOnly: false })
        {
            maxBodySizeFeature.MaxRequestBodySize = MaxRequestBytes;
        }

        AnalyticsReportRequestDto? request;
        try
        {
            request = await context.Request.ReadFromJsonAsync<AnalyticsReportRequestDto>(
                cancellationToken: context.RequestAborted);
        }
        catch (JsonException exception)
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status400BadRequest,
                "invalid_analytics_json",
                "Analytics request JSON is invalid",
                exception.Message);
        }
        catch (BadHttpRequestException exception)
        {
            return ApiProblemResults.Create(
                context,
                exception.StatusCode,
                exception.StatusCode == StatusCodes.Status413PayloadTooLarge
                    ? "analytics_payload_too_large"
                    : "invalid_analytics_request",
                exception.StatusCode == StatusCodes.Status413PayloadTooLarge
                    ? "Analytics payload is too large"
                    : "Analytics request is invalid",
                exception.Message);
        }

        if (!TryValidate(request, out var question, out var rows, out var provenance, out var errors))
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status400BadRequest,
                "invalid_analytics_request",
                "Analytics request is invalid",
                errors.Values.SelectMany(static messages => messages).FirstOrDefault(),
                errors);
        }

        var report = AnalyticsReportEngine.AnalyzeMigratedIntent(question, rows, provenance);
        var response = new AnalyticsAuthorityResponseDto(
            "1.0",
            new AnalyticsAuthorityEngineDto("forgex-analytics-csharp", EngineVersion),
            report);
        return Results.Json(response, ResponseJsonOptions);
    }

    private static bool TryValidate(
        AnalyticsReportRequestDto? request,
        out string question,
        out IReadOnlyList<AnalyticsRow> rows,
        out AnalyticsProvenance? provenance,
        out IReadOnlyDictionary<string, string[]> errors)
    {
        var validation = new Dictionary<string, string[]>(StringComparer.Ordinal);
        question = request?.Question?.Trim() ?? string.Empty;
        rows = [];
        provenance = null;

        if (request is null)
        {
            validation["body"] = ["A JSON request body is required."];
        }
        else
        {
            if (!string.Equals(request.SchemaVersion, "1.0", StringComparison.Ordinal))
            {
                validation["schemaVersion"] = ["schemaVersion must be '1.0'."];
            }
            if (question.Length is < 1 or > MaxQuestionLength)
            {
                validation["question"] = [$"question must contain 1 to {MaxQuestionLength} characters."];
            }
            if (request.Rows is null || request.Rows.Count is < 1 or > MaxRows)
            {
                validation["rows"] = [$"rows must contain 1 to {MaxRows} items."];
            }
            else
            {
                var mapped = new List<AnalyticsRow>(request.Rows.Count);
                for (var index = 0; index < request.Rows.Count; index++)
                {
                    var row = request.Rows[index];
                    if (!TryMapRow(row, index, validation, out var mappedRow)) continue;
                    mapped.Add(mappedRow);
                }
                if (mapped.Count == request.Rows.Count) rows = mapped;
            }

            if (request.Provenance is not null &&
                TryMapProvenance(request.Provenance, request.Rows?.Count ?? 0, validation, out var mappedProvenance))
            {
                provenance = mappedProvenance;
            }
        }

        errors = validation;
        return validation.Count == 0;
    }

    private static bool TryMapRow(
        AnalyticsRowRequestDto row,
        int index,
        Dictionary<string, string[]> errors,
        out AnalyticsRow mapped)
    {
        var field = $"rows[{index}]";
        var valid = true;
        if (row.Status is not ("success" or "fail"))
        {
            errors[$"{field}.status"] = ["status must be 'success' or 'fail'."];
            valid = false;
        }
        foreach (var (name, value) in new (string Name, double? Value)[]
        {
            ("layer_height_mm", row.LayerHeightMm),
            ("duration_min", row.DurationMin),
            ("filament_g", row.FilamentG),
            ("cost_fen", row.CostFen),
            ("energy_kwh", row.EnergyKwh),
        })
        {
            if (value is not null && !double.IsFinite(value.Value))
            {
                errors[$"{field}.{name}"] = [$"{name} must be finite when provided."];
                valid = false;
            }
        }
        foreach (var (name, value) in new (string Name, string? Value)[]
        {
            ("job_id", row.JobId),
            ("date", row.Date),
            ("machine_id", row.MachineId),
            ("model_name", row.ModelName),
            ("material", row.Material),
            ("fail_reason", row.FailReason),
        })
        {
            if (value?.Length > MaxTextLength)
            {
                errors[$"{field}.{name}"] = [$"{name} must not exceed {MaxTextLength} characters."];
                valid = false;
            }
        }

        mapped = new AnalyticsRow(
            row.JobId,
            row.Date,
            row.MachineId,
            row.ModelName,
            row.Material,
            row.LayerHeightMm ?? 0,
            row.DurationMin ?? 0,
            row.FilamentG ?? 0,
            row.CostFen ?? 0,
            row.Status == "fail" ? AnalyticsStatus.Fail : AnalyticsStatus.Success,
            row.FailReason,
            row.EnergyKwh ?? 0);
        return valid;
    }

    private static bool TryMapProvenance(
        AnalyticsProvenanceRequestDto input,
        int rowCount,
        Dictionary<string, string[]> errors,
        out AnalyticsProvenance provenance)
    {
        var valid = true;
        if (string.IsNullOrEmpty(input.Source) || input.Source.Length > MaxTextLength)
        {
            errors["provenance.source"] = [$"source must contain 1 to {MaxTextLength} characters."];
            valid = false;
        }
        if (input.Synthetic is null)
        {
            errors["provenance.synthetic"] = ["synthetic is required."];
            valid = false;
        }
        if (input.Badge is null || input.Badge.Length > MaxTextLength)
        {
            errors["provenance.badge"] = [$"badge must not exceed {MaxTextLength} characters."];
            valid = false;
        }
        if (input.Note is null || input.Note.Length > MaxTextLength)
        {
            errors["provenance.note"] = [$"note must not exceed {MaxTextLength} characters."];
            valid = false;
        }
        if (string.IsNullOrEmpty(input.DatasetKey) || input.DatasetKey.Length > MaxTextLength)
        {
            errors["provenance.datasetKey"] = [$"datasetKey must contain 1 to {MaxTextLength} characters."];
            valid = false;
        }
        if (input.RowCount != rowCount)
        {
            errors["provenance.rowCount"] = ["rowCount must equal rows.length."];
            valid = false;
        }

        AnalyticsGenerator? generator = null;
        if (input.Generator is not null)
        {
            if (string.IsNullOrEmpty(input.Generator.Name) || input.Generator.Name.Length > MaxTextLength)
            {
                errors["provenance.generator.name"] = [$"name must contain 1 to {MaxTextLength} characters."];
                valid = false;
            }
            if (input.Generator.Version is null or < 0)
            {
                errors["provenance.generator.version"] = ["version must be a non-negative integer."];
                valid = false;
            }
            generator = new AnalyticsGenerator(
                input.Generator.Name ?? string.Empty,
                input.Generator.Version ?? 0,
                input.Generator.Seed);
        }

        provenance = new AnalyticsProvenance(
            input.Source ?? string.Empty,
            input.Synthetic ?? false,
            input.Badge ?? string.Empty,
            input.Note ?? string.Empty,
            generator,
            input.DatasetKey ?? string.Empty,
            input.RowCount ?? 0);
        return valid;
    }
}
