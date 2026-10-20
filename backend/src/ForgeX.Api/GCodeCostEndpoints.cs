using System.Text.Json;
using System.Text.Json.Serialization;
using ForgeX.Application;
using ForgeX.Domain;
using ForgeX.Simulation;
using Microsoft.AspNetCore.Http.Features;

namespace ForgeX.Api;

internal static class GCodeCostEndpoints
{
    public static async Task<IResult> EstimateAsync(HttpContext context, string id, IGCodeJobRepository repository)
    {
        if (id.Length != 32 || id.Any(c => !char.IsAsciiHexDigit(c)))
            return ApiProblemResults.Create(context, 404, "job_not_found", "Analysis job not found");
        var caller = CallerContextBoundary.GetRequired(context);
        var job = await repository.GetOwnedAsync(caller.TenantId, caller.OwnerId, id.ToLowerInvariant(), context.RequestAborted);
        if (job is null) return ApiProblemResults.Create(context, 404, "job_not_found", "Analysis job not found");
        if (job.Status != GCodeJobStatus.Succeeded || job.Result is null)
            return ApiProblemResults.Create(context, 409, "cost_job_not_ready", "仅已成功完成的 G-code 作业可估算成本");
        if (job.Result.Profile is null || job.Options is null || job.Result.EngineVersion != job.EngineVersion || job.Result.BytesRead != job.InputBytes ||
            !string.Equals(job.Result.Sha256, job.InputSha256, StringComparison.Ordinal) ||
            job.Result.Profile.Fingerprint != GCodeProfileSummary.Create(job.Options).Fingerprint)
            return ApiProblemResults.Create(context, 422, "cost_source_invalid", "作业结果与文件或分析参数指纹不一致");
        if (!string.Equals(context.Request.ContentType?.Split(';', 2)[0].Trim(), "application/json", StringComparison.OrdinalIgnoreCase))
            return ApiProblemResults.Create(context, 415, "unsupported_media_type", "请使用 application/json");
        const int maxBytes = 16 * 1024;
        if (context.Request.ContentLength > maxBytes) return ApiProblemResults.Create(context, 413, "cost_body_limit", "成本输入不得超过 16 KiB");
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } feature) feature.MaxRequestBodySize = maxBytes;
        try
        {
            using var body = new MemoryStream();
            var chunk = new byte[4096];
            int count;
            while ((count = await context.Request.Body.ReadAsync(chunk, context.RequestAborted)) != 0)
            {
                if (body.Length + count > maxBytes) return ApiProblemResults.Create(context, 413, "cost_body_limit", "成本输入不得超过 16 KiB");
                body.Write(chunk, 0, count);
            }
            var inputs = JsonSerializer.Deserialize<GCodeCostInputs>(body.ToArray(), new JsonSerializerOptions(JsonSerializerDefaults.Web) { PropertyNameCaseInsensitive = false, NumberHandling = JsonNumberHandling.Strict });
            if (inputs is null) return ApiProblemResults.Create(context, 400, "cost_inputs_invalid", "缺少成本输入");
            return Results.Ok(GCodeCostEstimator.Estimate(job.Id, job.Result, inputs));
        }
        catch (JsonException) { return ApiProblemResults.Create(context, 400, "cost_inputs_invalid", "成本输入 JSON 无效或包含未知字段"); }
        catch (GCodeCostException error) { return ApiProblemResults.Create(context, error.Code == "cost_source_invalid" ? 422 : 400, error.Code, error.Message); }
        catch (BadHttpRequestException error) when (error.StatusCode == 413) { return ApiProblemResults.Create(context, 413, "cost_body_limit", "成本输入不得超过 16 KiB"); }
    }
}
