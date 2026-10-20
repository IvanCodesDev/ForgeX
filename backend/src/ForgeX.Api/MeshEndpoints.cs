using System.Text;
using System.Xml;
using ForgeX.Domain;
using ForgeX.Simulation;
using Microsoft.AspNetCore.Http.Features;

namespace ForgeX.Api;

/// <summary>One bounded mesh inspection per process; no uploaded bytes are persisted.</summary>
internal sealed class MeshAnalysisAdmission : IDisposable
{
    internal SemaphoreSlim Slot { get; } = new(1, 1);
    public void Dispose() => Slot.Dispose();
}

internal static class MeshEndpoints
{
    public static async Task<IResult> AnalyzeAsync(HttpContext context, MeshAnalysisAdmission admission)
    {
        var format = context.Request.Query["format"].ToString();
        if (format is not ("stl" or "3mf"))
            return ApiProblemResults.Create(context, 400, "mesh_format_required", "请指定 format=stl 或 format=3mf");
        var contentType = context.Request.ContentType?.Split(';', 2)[0].Trim();
        var allowed = string.Equals(contentType, "application/octet-stream", StringComparison.OrdinalIgnoreCase) ||
            (format == "stl" && string.Equals(contentType, "model/stl", StringComparison.OrdinalIgnoreCase)) ||
            (format == "3mf" && string.Equals(contentType, "model/3mf", StringComparison.OrdinalIgnoreCase));
        if (!allowed) return ApiProblemResults.Create(context, 415, "unsupported_media_type", "请发送原始网格字节，Content-Type: application/octet-stream");
        if (context.Request.ContentLength > MeshAnalyzer.MaxBytes)
            return ApiProblemResults.Create(context, 413, "mesh_limit", "网格文件超过 64 MB");
        if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } feature)
            feature.MaxRequestBodySize = MeshAnalyzer.MaxBytes;
        if (!await admission.Slot.WaitAsync(0, context.RequestAborted))
        {
            context.Response.Headers.RetryAfter = "2";
            return ApiProblemResults.Create(context, 429, "mesh_busy", "网格校验繁忙，请稍后重试");
        }
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        try
        {
            return Results.Ok(await new MeshAnalyzer().AnalyzeAsync(context.Request.Body, format, timeout.Token));
        }
        catch (MeshAnalysisException exception)
        {
            return ApiProblemResults.Create(context, exception.IsLimit ? 413 : 422, exception.Code, exception.Message);
        }
        catch (BadHttpRequestException exception) when (exception.StatusCode == 413)
        {
            return ApiProblemResults.Create(context, 413, "mesh_limit", "网格文件超过 64 MB");
        }
        catch (Exception exception) when (exception is InvalidDataException or XmlException or DecoderFallbackException or UriFormatException)
        {
            return ApiProblemResults.Create(context, 422, "mesh_invalid", "网格容器或几何数据损坏，无法完成权威校验");
        }
        catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
        {
            return ApiProblemResults.Create(context, 408, "mesh_timeout", "网格权威校验超时，请精简模型后重试");
        }
        finally { admission.Slot.Release(); }
    }
}
