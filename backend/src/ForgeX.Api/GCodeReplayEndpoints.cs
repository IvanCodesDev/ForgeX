using System.Globalization;
using System.Text.Json;
using ForgeX.Application;
using ForgeX.Domain;
using ForgeX.Simulation;

namespace ForgeX.Api;

internal static class GCodeReplayEndpoints
{
    private static readonly SemaphoreSlim Admission = new(2);

    public static Task<IResult> TimelineAsync(HttpContext context, string id, IGCodeJobRepository repository) => ReadAsync(context, id, repository, false);
    public static Task<IResult> CheckpointAsync(HttpContext context, string id, IGCodeJobRepository repository) => ReadAsync(context, id, repository, true);

    private static async Task<IResult> ReadAsync(HttpContext context, string id, IGCodeJobRepository repository, bool checkpoint)
    {
        if (id.Length != 32 || id.Any(c => !char.IsAsciiHexDigit(c)))
            return ApiProblemResults.Create(context, 404, "job_not_found", "Analysis job not found");
        var caller = CallerContextBoundary.GetRequired(context);
        var job = await repository.GetOwnedAsync(caller.TenantId, caller.OwnerId, id.ToLowerInvariant(), context.RequestAborted);
        if (job is null) return ApiProblemResults.Create(context, 404, "job_not_found", "Analysis job not found");
        if (job.Status != GCodeJobStatus.Succeeded || job.Result is null)
            return ApiProblemResults.Create(context, 409, "replay_job_not_ready", "仅已完成的 G-code 作业可生成层计划");
        var source = job.Result;
        if (source.Profile is null || job.Options is null || source.EngineVersion != job.EngineVersion || source.BytesRead != job.InputBytes ||
            source.Sha256 != job.InputSha256 || source.Profile.Fingerprint != GCodeProfileSummary.Create(job.Options).Fingerprint)
            return ApiProblemResults.Create(context, 422, "replay_source_invalid", "分析结果与源文件或参数不一致");
        if (!await Admission.WaitAsync(0, context.RequestAborted))
        {
            context.Response.Headers.RetryAfter = "1";
            return ApiProblemResults.Create(context, 429, "replay_busy", "层计划服务繁忙，请稍后重试");
        }
        try
        {
            GCodeReplayInputs? inputs = null;
            int offset = 0, limit = 50;
            if (checkpoint)
            {
                if (!string.Equals(context.Request.ContentType?.Split(';', 2)[0].Trim(), "application/json", StringComparison.OrdinalIgnoreCase))
                    return ApiProblemResults.Create(context, 415, "unsupported_media_type", "请使用 application/json");
                inputs = await StrictJsonBody.ReadAsync<GCodeReplayInputs>(context, 4096);
            }
            else
            {
                foreach (var field in context.Request.Query)
                {
                    if (field.Key is not ("offset" or "limit") || field.Value.Count != 1 ||
                        !int.TryParse(field.Value[0], NumberStyles.None, CultureInfo.InvariantCulture, out var value))
                        return ApiProblemResults.Create(context, 400, "replay_page_invalid", "分页参数无效");
                    if (field.Key == "offset") offset = value;
                    else limit = value;
                }
            }
            var plan = new GCodeLayerReplay(job.Id, source, context.RequestAborted);
            return checkpoint ? Results.Ok(plan.Seek(inputs!.ElapsedSeconds)) : Results.Ok(plan.Page(offset, limit));
        }
        catch (JsonException) { return ApiProblemResults.Create(context, 400, "replay_inputs_invalid", "回放 JSON 无效、字段重复或包含未知字段"); }
        catch (BadHttpRequestException error) when (error.StatusCode == 413) { return ApiProblemResults.Create(context, 413, "replay_body_limit", "回放输入不得超过 4 KiB"); }
        catch (GCodeReplayException error)
        {
            var status = error.Code == "replay_source_order_unavailable" ? 409 : error.Code == "replay_source_invalid" ? 422 : 400;
            return ApiProblemResults.Create(context, status, error.Code, error.Message);
        }
        finally { Admission.Release(); }
    }
}
