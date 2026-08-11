using System.Globalization;
using ForgeX.Application;
using ForgeX.Contracts;
using ForgeX.Domain;
using Microsoft.AspNetCore.Http.Features;

namespace ForgeX.Api;

internal static class GCodeEndpoints
{
    internal const long MaxGCodeBytes = 64L * 1024 * 1024;
    private const double DefaultBedSizeMm = 256;
    private const double DefaultDensityGPerCm3 = 1.24;

    public static async Task<IResult> AnalyzeAsync(HttpContext context, IGCodeAnalyzer analyzer)
    {
        var mediaType = context.Request.ContentType?.Split(';', 2)[0].Trim();
        if (!string.Equals(mediaType, "application/x-gcode", StringComparison.OrdinalIgnoreCase))
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status415UnsupportedMediaType,
                "unsupported_media_type",
                "Unsupported media type",
                "Use Content-Type: application/x-gcode.");
        }

        if (context.Request.ContentLength is > MaxGCodeBytes)
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status413PayloadTooLarge,
                "payload_too_large",
                "G-code payload is too large",
                $"The request body limit is {MaxGCodeBytes} bytes.");
        }

        var maxBodySizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
        if (maxBodySizeFeature is { IsReadOnly: false })
        {
            maxBodySizeFeature.MaxRequestBodySize = MaxGCodeBytes;
        }

        if (!TryReadOptions(context.Request, out var options, out var errors))
        {
            return ApiProblemResults.Create(
                context,
                StatusCodes.Status400BadRequest,
                "invalid_parameters",
                "Invalid analysis parameters",
                errors.Values.SelectMany(static messages => messages).FirstOrDefault(),
                errors);
        }

        var result = await analyzer.AnalyzeAsync(context.Request.Body, options, context.RequestAborted);

        return Results.Ok(ToResponse(result, options));
    }

    internal static GCodeAnalysisResponse ToResponse(GCodeAnalysisResult result, GCodeAnalysisOptions options) =>
        new(
            "1.0",
            new GCodeEngineDto(result.EngineVersion, result.Source),
            new GCodeInputSummaryDto(result.Sha256, result.BytesRead, result.LinesRead),
            new GCodeAnalyzeParametersDto(
                options.BedSizeMm,
                options.CoordinateOrigin.ToString().ToLowerInvariant(),
                options.MaterialDensityGPerCm3),
            new GCodeAnalysisSummaryDto(
                result.TotalLayers,
                result.HeightMm,
                result.Statistics.ExtrusionLengthMm,
                result.Statistics.TravelLengthMm,
                result.Statistics.TimeSeconds,
                result.Statistics.VolumeCm3,
                result.Statistics.FilamentLengthM,
                result.Statistics.FilamentMassG),
            new GCodeBoundsDto(
                result.Bounds.MinX,
                result.Bounds.MaxX,
                result.Bounds.MinY,
                result.Bounds.MaxY),
            result.Claims,
            result.PathTypeCounts,
            [.. result.Warnings
                .Select(static warning => new GCodeWarningDto(warning.Code, warning.Message))]);

    internal static bool TryReadOptions(
        HttpRequest request,
        out GCodeAnalysisOptions options,
        out IReadOnlyDictionary<string, string[]> errors)
    {
        var validationErrors = new Dictionary<string, string[]>(StringComparer.Ordinal);

        var bedSize = ParseDouble(request, "bedSizeMm", DefaultBedSizeMm, validationErrors);
        if (bedSize is not (>= 1 and <= 2000))
        {
            validationErrors["bedSizeMm"] = ["bedSizeMm must be between 1 and 2000."];
        }

        var density = ParseDouble(request, "filamentDensityGPerCm3", DefaultDensityGPerCm3, validationErrors);
        if (density is not (> 0 and <= 20))
        {
            validationErrors["filamentDensityGPerCm3"] = ["filamentDensityGPerCm3 must be greater than 0 and at most 20."];
        }

        var originText = request.Query["coordinateOrigin"].ToString();
        var origin = CoordinateOrigin.Corner;
        if (!string.IsNullOrWhiteSpace(originText) &&
            !Enum.TryParse(originText, ignoreCase: true, out origin))
        {
            validationErrors["coordinateOrigin"] = ["coordinateOrigin must be corner or center."];
        }

        errors = validationErrors;
        options = new GCodeAnalysisOptions(
            bedSize,
            origin,
            density,
            MaxGCodeBytes);
        return validationErrors.Count == 0;
    }

    private static double ParseDouble(
        HttpRequest request,
        string name,
        double defaultValue,
        Dictionary<string, string[]> errors)
    {
        var text = request.Query[name].ToString();
        if (string.IsNullOrWhiteSpace(text))
        {
            return defaultValue;
        }

        if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ||
            !double.IsFinite(value))
        {
            errors[name] = [$"{name} must be a finite number using '.' as the decimal separator."];
            return double.NaN;
        }

        return value;
    }
}
