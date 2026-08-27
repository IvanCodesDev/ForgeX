using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using ForgeX.Contracts;
using ForgeX.Infrastructure;

namespace ForgeX.Api;

/// <summary>
/// Stage 8.1: share endpoints migrated from server/routes/share.js. Creation and
/// revocation run under the trusted caller context; the share page itself is public.
/// Response keys and the rendered HTML mirror the Node implementation so the
/// migration proxy can pass results through unchanged.
/// </summary>
internal static class ShareEndpoints
{
    /// <summary>Report snapshots ride analytics results, so reuse the 5 MiB analytics cap.</summary>
    private const long MaxCreateBodyBytes = 5L * 1024 * 1024;
    private const long MaxRevokeBodyBytes = 4L * 1024;

    public static async Task<IResult> CreateAsync(HttpContext context, PostgresShareRepository shares)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        if (context.Request.ContentLength is > MaxCreateBodyBytes)
        {
            return ApiProblemResults.Create(context, 413, "payload_too_large", "Share payload is too large");
        }

        ShareCreateRequestDto? request;
        try
        {
            request = await JsonSerializer.DeserializeAsync<ShareCreateRequestDto>(
                LimitedBody(context, MaxCreateBodyBytes),
                new JsonSerializerOptions(JsonSerializerDefaults.Web),
                context.RequestAborted);
        }
        catch (JsonException)
        {
            return ApiProblemResults.Create(context, 400, "invalid_json", "Request body must be valid JSON");
        }
        catch (InvalidDataException)
        {
            return ApiProblemResults.Create(context, 413, "payload_too_large", "Share payload is too large");
        }

        if (request is null || request.Report.ValueKind != JsonValueKind.Object)
        {
            return ApiProblemResults.Create(context, 400, "invalid_report", "report must be a JSON object");
        }

        // varchar(500) / varchar(64) schema constraints; reject up front instead of
        // surfacing a PostgreSQL check violation as a 500.
        var question = request.Question ?? string.Empty;
        var engine = string.IsNullOrWhiteSpace(request.Engine) ? "local" : request.Engine!;
        if (question.Length > 500)
        {
            return ApiProblemResults.Create(context, 400, "invalid_question", "question exceeds 500 characters");
        }
        if (engine.Length > 64)
        {
            return ApiProblemResults.Create(context, 400, "invalid_engine", "engine exceeds 64 characters");
        }
        var upstreamTaskId = string.IsNullOrWhiteSpace(request.UpstreamTaskId) ? null : request.UpstreamTaskId;
        if (upstreamTaskId is { Length: > 128 })
        {
            return ApiProblemResults.Create(context, 400, "invalid_upstream_task_id", "upstreamTaskId exceeds 128 characters");
        }

        var created = await shares.CreateAsync(
            caller.TenantId,
            caller.OwnerId,
            request.Report.GetRawText(),
            question,
            engine,
            upstreamTaskId,
            request.TtlMs,
            context.RequestAborted);

        // Without a configured public base the path is returned as-is; the Node
        // migration proxy rewrites publicUrl against its own origin either way.
        var publicBase = context.RequestServices.GetService<SharePublicBase>()?.Value ?? string.Empty;
        var response = new ShareCreateResponseDto(
            publicBase + "/share/" + created.Token,
            created.Token,
            created.RevokeKey,
            created.ExpiresAt.ToUnixTimeMilliseconds(),
            publicBase.Length > 0 ? null : "publicUrl 为相对路径；部署时请配置 Shares:PublicBase 或由代理改写。");
        return Results.Json(response, statusCode: StatusCodes.Status201Created);
    }

    public static async Task<IResult> RevokeAsync(HttpContext context, string token, PostgresShareRepository shares)
    {
        var caller = CallerContextBoundary.GetRequired(context);
        if (context.Request.ContentLength is > MaxRevokeBodyBytes)
        {
            return ApiProblemResults.Create(context, 413, "payload_too_large", "Revoke payload is too large");
        }

        ShareRevokeRequestDto? request;
        try
        {
            request = await JsonSerializer.DeserializeAsync<ShareRevokeRequestDto>(
                LimitedBody(context, MaxRevokeBodyBytes),
                new JsonSerializerOptions(JsonSerializerDefaults.Web),
                context.RequestAborted);
        }
        catch (JsonException)
        {
            return ApiProblemResults.Create(context, 400, "invalid_json", "Request body must be valid JSON");
        }
        catch (InvalidDataException)
        {
            return ApiProblemResults.Create(context, 413, "payload_too_large", "Revoke payload is too large");
        }

        var outcome = await shares.RevokeAsync(
            token,
            request?.RevokeKey,
            caller.TenantId,
            caller.OwnerId,
            context.RequestAborted);

        return outcome switch
        {
            ShareRevokeOutcome.Revoked => Results.Json(new ShareRevokeResponseDto(true)),
            ShareRevokeOutcome.NotFound => ApiProblemResults.Create(context, 404, "share_not_found", "分享不存在或已过期"),
            _ => ApiProblemResults.Create(context, 403, "bad_revoke_key", "撤销密钥不正确"),
        };
    }

    public static async Task<IResult> RenderAsync(HttpContext context, string token, PostgresShareRepository shares)
    {
        var record = await shares.GetPublicAsync(token, context.RequestAborted);
        if (record is null)
        {
            return ApiProblemResults.Create(context, 404, "share_not_found", "分享页不存在、已过期或已被撤销");
        }

        context.Response.Headers.CacheControl = "no-cache";
        return Results.Content(RenderShareHtml(record), "text/html; charset=utf-8");
    }

    private static Stream LimitedBody(HttpContext context, long maxBytes)
    {
        var feature = context.Features.Get<Microsoft.AspNetCore.Http.Features.IHttpMaxRequestBodySizeFeature>();
        if (feature is { IsReadOnly: false })
        {
            feature.MaxRequestBodySize = maxBytes;
        }
        return context.Request.Body;
    }

    // ── 服务端渲染：renderShareHtml 的 C# 移植，结构与样式保持一致，全部文本转义 ──

    private static readonly HtmlEncoder Html = HtmlEncoder.Default;

    private static string RenderShareHtml(ShareRecord share)
    {
        using var document = JsonDocument.Parse(share.ReportJson);
        var report = document.RootElement;
        var title = GetString(report, "title") ?? "分析报告";
        var verdict = GetString(report, "verdict") ?? string.Empty;
        var confidence = GetString(report, "confidence");
        var rowCount = report.TryGetProperty("rowCount", out var rows) && rows.ValueKind == JsonValueKind.Number
            ? rows.GetRawText()
            : "0";
        var engineLabel = share.Engine switch
        {
            "openai-compatible" => "OpenAI 兼容 AI",
            _ => "规则引擎（统计，无 AI）",
        };

        var sections = new StringBuilder();
        if (report.TryGetProperty("sections", out var sectionArray) && sectionArray.ValueKind == JsonValueKind.Array)
        {
            foreach (var section in sectionArray.EnumerateArray())
            {
                sections.Append("<div class=\"sec\"><h3>").Append(Html.Encode(GetString(section, "h") ?? string.Empty)).Append("</h3>");
                if (section.TryGetProperty("lines", out var lines) && lines.ValueKind == JsonValueKind.Array)
                {
                    foreach (var line in lines.EnumerateArray())
                    {
                        sections.Append("<p>").Append(Html.Encode(line.ValueKind == JsonValueKind.String ? line.GetString()! : line.GetRawText())).Append("</p>");
                    }
                }
                sections.Append("</div>");
            }
        }

        var upstream = share.UpstreamTaskId is { Length: > 0 }
            ? "<p class=\"meta\">上游任务 taskId：<code>" + Html.Encode(share.UpstreamTaskId) + "</code></p>"
            : string.Empty;

        var synthetic = string.Empty;
        if (report.TryGetProperty("provenance", out var provenance) &&
            provenance.ValueKind == JsonValueKind.Object &&
            provenance.TryGetProperty("synthetic", out var syntheticFlag) &&
            syntheticFlag.ValueKind == JsonValueKind.True)
        {
            var badge = GetString(provenance, "badge") ?? "合成";
            synthetic = "<p class=\"meta warn\">⚠ 本报告基于" + Html.Encode(badge) + "数据，非真实产线数据。</p>";
        }

        return "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">" +
            "<title>" + Html.Encode(title) + " — FORGE·X 智造洞察</title><style>" +
            "body{margin:0;background:#e8ebf0;font:15px/1.7 'Segoe UI','Microsoft YaHei UI',sans-serif;color:#1d222b}" +
            ".wrap{max-width:720px;margin:32px auto;padding:0 16px}" +
            ".card{background:rgba(255,255,255,.82);border:1px solid rgba(29,34,43,.08);border-radius:14px;padding:28px;box-shadow:0 8px 32px rgba(29,34,43,.08)}" +
            ".brand{font-weight:700;letter-spacing:.12em;color:#f0561a;font-size:12px;margin-bottom:6px}" +
            "h1{font-size:22px;margin:0 0 4px}h3{font-size:14px;margin:18px 0 6px;color:#3a4150}" +
            ".verdict{background:rgba(240,86,26,.08);border-left:3px solid #f0561a;padding:10px 14px;border-radius:0 8px 8px 0;margin:14px 0}" +
            ".meta{color:#5a6270;font-size:12px}p{margin:4px 0}code{background:rgba(29,34,43,.06);padding:1px 6px;border-radius:4px}" +
            ".chart{margin:16px 0}.ch-title{font-size:12px;color:#5a6270;margin-bottom:8px}" +
            ".row{display:flex;align-items:center;gap:10px;margin:6px 0}.lab{width:96px;font-size:12px;text-align:right;flex:none}" +
            ".track{flex:1;height:12px;background:rgba(29,34,43,.08);border-radius:6px;overflow:hidden}" +
            ".track i{display:block;height:100%;background:rgba(79,131,224,.65);border-radius:6px}" +
            ".track i.hot{background:#f0561a}.val{width:64px;font-size:12px;color:#5a6270;flex:none}" +
            ".meta.warn{color:#8a5214;background:rgba(217,131,36,.12);padding:6px 10px;border-radius:6px}" +
            ".foot{text-align:center;color:#8a93a2;font-size:12px;margin:18px 0}" +
            "</style></head><body><div class=\"wrap\"><div class=\"card\">" +
            "<div class=\"brand\">FORGE·X 智造洞察</div>" +
            "<h1>" + Html.Encode(title) + "</h1>" +
            "<p class=\"meta\">提问：" + Html.Encode(share.Question.Length > 0 ? share.Question : "—") +
            " · 引擎：" + engineLabel + " · 样本 " + Html.Encode(rowCount) + " 行</p>" + upstream +
            "<div class=\"verdict\">" + Html.Encode(verdict) + "</div>" +
            (confidence is { Length: > 0 } ? "<p class=\"meta\">可信度：" + Html.Encode(confidence) + "</p>" : string.Empty) +
            synthetic +
            ChartHtml(report) + sections +
            "</div><div class=\"foot\">由 FORGE·X 智造洞察生成 · 工业 3D 打印仿真 × 数据分析</div></div></body></html>";
    }

    private static string ChartHtml(JsonElement report)
    {
        if (!report.TryGetProperty("chart", out var chart) || chart.ValueKind != JsonValueKind.Object ||
            !chart.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array ||
            items.GetArrayLength() == 0)
        {
            return string.Empty;
        }

        var isRate = GetString(chart, "kind") == "bar-rate";
        double maxValue = 0;
        foreach (var item in items.EnumerateArray())
        {
            maxValue = Math.Max(maxValue, GetNumber(item, "value"));
        }
        if (maxValue <= 0) maxValue = 1;

        var rows = new StringBuilder();
        foreach (var item in items.EnumerateArray())
        {
            var value = GetNumber(item, "value");
            var fraction = isRate ? Math.Min(1, value) : value / maxValue;
            var valueText = isRate
                ? (value * 100).ToString("F1", CultureInfo.InvariantCulture) + "%"
                : (Math.Round(value * 100) / 100).ToString(CultureInfo.InvariantCulture);
            var hot = isRate && value >= 0.15;
            rows.Append("<div class=\"row\"><span class=\"lab\">")
                .Append(Html.Encode(GetString(item, "label") ?? string.Empty))
                .Append("</span><span class=\"track\"><i style=\"width:")
                .Append((fraction * 100).ToString("F1", CultureInfo.InvariantCulture))
                .Append("%\" class=\"").Append(hot ? "hot" : string.Empty).Append("\"></i></span><span class=\"val\">")
                .Append(Html.Encode(valueText))
                .Append("</span></div>");
        }

        return "<div class=\"chart\"><div class=\"ch-title\">" +
            Html.Encode(GetString(chart, "title") ?? string.Empty) + "</div>" + rows + "</div>";
    }

    private static string? GetString(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(property, out var value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static double GetNumber(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(property, out var value) &&
        value.ValueKind == JsonValueKind.Number
            ? value.GetDouble()
            : 0;
}

/// <summary>Configured public origin for share links (Shares:PublicBase), empty when unset.</summary>
internal sealed record SharePublicBase(string Value);
