using System.Text.Json;
using System.Text.Json.Nodes;
using ForgeX.Analytics;
using ForgeX.Analytics.Calibration;
using ForgeX.Application;

namespace ForgeX.Infrastructure;

/// <summary>
/// 校准治理状态机——Node <c>server/services/calibration.js</c>（file 版，决策 A6）的纯函数移植，
/// file / PostgreSQL 两条存储腿共用：校验顺序、文案、记录形状、淘汰规则全部在这里，
/// 存储腿只负责「查现状 → 应用裁决 → 持久化」。
/// </summary>
public static class CalibrationGovernanceRules
{
    public const int DefaultMaxSubmissions = 200;
    private const int TextLimit = 500;

    private static readonly string[] AcceptedProvenance = ["real-anonymized", "real-consented"];

    public static string Digest(JsonElement bundle) => JsJson.Sha256Hex(JsJson.Stable(bundle));

    public static string SubmissionKey(string id, int revision) => id + "@" + revision;

    /// <summary>
    /// 提交第一阶段（不依赖存储现状）：Validate → provenance → 全部 candidate。
    /// 通过后返回 bundle 身份，存储腿据此查重复 / 已发布版本，再调用 <see cref="CompleteSubmit"/>。
    /// </summary>
    public static SubmitPreparation PrepareSubmit(JsonElement? bundle)
    {
        var checked_ = CalibrationBundleValidator.Validate(bundle);
        if (!checked_.Ok)
        {
            return SubmitPreparation.Rejected(CalibrationGovernanceOutcome.Failure(400, string.Join("；", checked_.Errors)));
        }

        var raw = bundle!.Value;
        var provenance = raw.GetProperty("provenance").GetString();
        if (provenance is null || !AcceptedProvenance.Contains(provenance, StringComparer.Ordinal))
        {
            return SubmitPreparation.Rejected(CalibrationGovernanceOutcome.Failure(400, "服务端只接受具有真实数据来源声明的候选校准包"));
        }

        foreach (var model in raw.GetProperty("models").EnumerateArray())
        {
            if (!(model.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.String && status.GetString() == "candidate"))
            {
                return SubmitPreparation.Rejected(CalibrationGovernanceOutcome.Failure(400, "提交到审批队列的模型必须全部为 candidate"));
            }
        }

        var id = JsValue.ToJsString(raw.GetProperty("id"));
        var revisionNumber = JsValue.ToNumber(raw.GetProperty("revision"));
        if (revisionNumber > int.MaxValue)
        {
            // Node file mode would accept any safe integer; the PG column and the C# route are int32.
            return SubmitPreparation.Rejected(CalibrationGovernanceOutcome.Failure(400, "revision 必须是正整数"));
        }

        return SubmitPreparation.Accepted(id, (int)revisionNumber, raw);
    }

    /// <summary>提交第二阶段：重复 / 版本单调性检查后构造 pending 记录。</summary>
    public static CalibrationGovernanceOutcome CompleteSubmit(
        SubmitPreparation preparation,
        JsonElement? note,
        string actor,
        bool duplicateExists,
        int? approvedRevision,
        long nowMs)
    {
        if (preparation.Failure is not null)
        {
            return preparation.Failure;
        }

        if (duplicateExists)
        {
            return CalibrationGovernanceOutcome.Failure(409, "该 bundle revision 已经提交");
        }

        if (approvedRevision is { } current && current >= preparation.Revision)
        {
            return CalibrationGovernanceOutcome.Failure(409, "新提交的 revision 必须高于当前已发布版本");
        }

        var noteText = Slice(JsValue.Truthy(note) ? JsValue.ToJsString(note) : string.Empty, TextLimit);
        var bundle = preparation.Bundle.Clone();
        var record = new CalibrationSubmission(
            SubmissionKey(preparation.Id, preparation.Revision),
            preparation.Id,
            preparation.Revision,
            "pending",
            Digest(bundle),
            bundle,
            nowMs,
            nowMs,
            actor,
            noteText,
            [Event("submitted", nowMs, actor, note)]);
        return CalibrationGovernanceOutcome.Success(201, record);
    }

    /// <summary>
    /// 审核裁决（Node file 版顺序）：404 → 已审核 409 → decision 400 → reason 400 → 自审 409 →
    /// approve：active 准入 409 → 版本单调 409。成功时 <paramref name="release"/> 在 approve 分支非空。
    /// 提交记录里的 <c>bundle</c> 保持提交时的 candidate 版（Node file 版语义）。
    /// </summary>
    public static CalibrationGovernanceOutcome DecideReview(
        CalibrationSubmission? existing,
        JsonElement? decision,
        JsonElement? reason,
        string actor,
        int? approvedRevision,
        long nowMs,
        out CalibrationRelease? release)
    {
        release = null;
        if (existing is null)
        {
            return CalibrationGovernanceOutcome.Failure(404, "校准包提交不存在");
        }

        if (existing.Status != "pending")
        {
            return CalibrationGovernanceOutcome.Failure(409, "该提交已经完成审核");
        }

        var decisionText = decision is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;
        if (decisionText is not ("approve" or "reject"))
        {
            return CalibrationGovernanceOutcome.Failure(400, "decision 必须是 approve 或 reject");
        }

        var reasonText = JsValue.Truthy(reason) ? JsValue.ToJsString(reason) : string.Empty;
        if (JsValue.Trim(reasonText).Length < 10)
        {
            return CalibrationGovernanceOutcome.Failure(400, "审核原因至少需要 10 个字符");
        }

        var approve = decisionText == "approve";
        if (approve && existing.SubmittedBy == actor)
        {
            return CalibrationGovernanceOutcome.Failure(409, "提交者不能审批自己提交的校准包");
        }

        if (approve)
        {
            var published = Publish(existing.Bundle);
            var checked_ = CalibrationBundleValidator.Validate(published);
            if (!checked_.Ok)
            {
                return CalibrationGovernanceOutcome.Failure(409, "候选模型未达到 active 准入条件：" + string.Join("；", checked_.Errors));
            }

            if (approvedRevision is { } current && current >= existing.Revision)
            {
                return CalibrationGovernanceOutcome.Failure(409, "审批版本不高于当前已发布版本");
            }

            release = new CalibrationRelease(existing.Id, existing.Revision, Digest(published), published, nowMs, actor);
        }

        var events = new List<CalibrationEvent>(existing.Events) { Event(approve ? "approved" : "rejected", nowMs, actor, reason) };
        var updated = existing with
        {
            Status = approve ? "approved" : "rejected",
            UpdatedAt = nowMs,
            ReviewedBy = actor,
            ReviewReason = Slice(JsValue.ToJsString(reason), TextLimit),
            Events = events,
        };
        return CalibrationGovernanceOutcome.Success(200, updated);
    }

    /// <summary>
    /// Node <c>_evict</c>：总数超过 <paramref name="max"/> 时，非 pending 记录按 updatedAt 升序（稳定）
    /// 删除到不超限为止；pending 永不淘汰。返回应删除的记录。
    /// </summary>
    public static IReadOnlyList<CalibrationSubmission> EvictNonPending(IEnumerable<CalibrationSubmission> all, int max)
    {
        var records = all as IReadOnlyList<CalibrationSubmission> ?? all.ToList();
        if (records.Count <= max)
        {
            return [];
        }

        var excess = records.Count - max;
        return records
            .Where(static record => record.Status != "pending")
            .OrderBy(static record => record.UpdatedAt)
            .Take(excess)
            .ToList();
    }

    /// <summary>深拷贝并把每个 models[i].status 置为 active（键序、数字字面量原样保留）。</summary>
    public static JsonElement Publish(JsonElement bundle)
    {
        var node = JsonNode.Parse(bundle.GetRawText()) ?? throw new InvalidDataException("bundle must be a JSON object");
        if (node["models"] is JsonArray models)
        {
            foreach (var model in models)
            {
                if (model is JsonObject item)
                {
                    item["status"] = "active";
                }
            }
        }

        return JsonSerializer.SerializeToElement(node);
    }

    private static CalibrationEvent Event(string action, long at, string actor, JsonElement? reason) =>
        new(
            action,
            at,
            string.IsNullOrEmpty(actor) ? "unknown" : actor,
            Slice(JsValue.Truthy(reason) ? JsValue.ToJsString(reason) : string.Empty, TextLimit));

    private static string Slice(string value, int length) => value.Length <= length ? value : value[..length];
}

/// <summary>提交第一阶段结果：<see cref="Failure"/> 非空表示 400 拒绝，否则携带 bundle 身份。</summary>
public sealed record SubmitPreparation(CalibrationGovernanceOutcome? Failure, string Id, int Revision, JsonElement Bundle)
{
    public static SubmitPreparation Rejected(CalibrationGovernanceOutcome failure) => new(failure, string.Empty, 0, default);

    public static SubmitPreparation Accepted(string id, int revision, JsonElement bundle) => new(null, id, revision, bundle);
}
