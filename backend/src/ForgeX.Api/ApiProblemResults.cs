using System.Diagnostics;
using ForgeX.Contracts;
using ForgeX.Domain;

namespace ForgeX.Api;

internal static class ApiProblemResults
{
    public static IResult Create(
        HttpContext context,
        int status,
        string code,
        string title,
        string? detail = null,
        IReadOnlyDictionary<string, string[]>? errors = null)
    {
        var problem = Build(context, status, code, title, detail, errors);
        return Results.Json(problem, statusCode: status, contentType: "application/problem+json");
    }

    public static async Task WriteExceptionAsync(HttpContext context, Exception exception)
    {
        var (status, code, title, detail) = Classify(context, exception);
        var result = Create(context, status, code, title, detail);
        await result.ExecuteAsync(context);
    }

    private static ApiProblem Build(
        HttpContext context,
        int status,
        string code,
        string title,
        string? detail,
        IReadOnlyDictionary<string, string[]>? errors)
    {
        var traceId = Activity.Current?.TraceId.ToHexString() ?? context.TraceIdentifier;
        return new ApiProblem(
            $"urn:forgex:problem:{code}",
            title,
            status,
            code,
            traceId,
            detail,
            context.Request.Path,
            errors);
    }

    private static (int Status, string Code, string Title, string? Detail) Classify(
        HttpContext context,
        Exception exception)
    {
        if (exception is OperationCanceledException && context.RequestAborted.IsCancellationRequested)
        {
            return (499, "request_cancelled", "Request cancelled", null);
        }

        if (exception is BadHttpRequestException badRequest)
        {
            var status = badRequest.StatusCode;
            return status == StatusCodes.Status413PayloadTooLarge
                ? (status, "payload_too_large", "G-code payload is too large", "The request body limit is 67108864 bytes.")
                : (status, "invalid_request", "Invalid request", badRequest.Message);
        }

        if (exception is GCodeAnalysisException analysisException)
        {
            var status = IsPayloadLimitCode(analysisException.Code)
                ? StatusCodes.Status413PayloadTooLarge
                : StatusCodes.Status422UnprocessableEntity;
            var title = status == StatusCodes.Status413PayloadTooLarge
                ? "G-code payload is too large"
                : "G-code analysis failed";
            return (status, analysisException.Code, title, analysisException.Message);
        }

        if (exception is InvalidDataException or FormatException or ArgumentException)
        {
            return (StatusCodes.Status422UnprocessableEntity, "gcode_invalid", "G-code analysis failed", exception.Message);
        }

        return (
            StatusCodes.Status500InternalServerError,
            "internal_error",
            "Unexpected server error",
            null);
    }

    private static bool IsPayloadLimitCode(string code) =>
        code.Contains("too_large", StringComparison.OrdinalIgnoreCase) ||
        code.Contains("max_bytes", StringComparison.OrdinalIgnoreCase) ||
        code.Contains("payload", StringComparison.OrdinalIgnoreCase);
}
