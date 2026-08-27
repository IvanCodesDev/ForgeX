using System.Text.Json;

namespace ForgeX.Analytics.Calibration;

/// <summary>
/// 版本化校准包的声明式验证——经典 `calibration-registry.js` validateBundle 的逐分支移植。
/// 错误文案与推入顺序都是契约的一部分：Node 侧把 errors.join("；") 直接作为 400 响应体，
/// 服务端测试与调用方都断言这些字符串。JS 值语义（Number(null)=0、undefined&lt;5 为假、
/// 属性枚举序）由 <see cref="JsValue"/> 承担。
/// </summary>
public static class CalibrationBundleValidator
{
    private static readonly string[] BundleKeys =
        ["$schema", "format", "version", "id", "revision", "createdAt", "provenance", "source", "models"];

    private static readonly string[] ModelKeys =
        ["id", "status", "scope", "algorithm", "trainedAt", "coefficients", "validation", "thresholds", "trainingSetSha256"];

    private static readonly string[] ProvenanceValues =
        ["synthetic-conformance", "real-anonymized", "real-consented"];

    private static readonly string[] StatusValues =
        ["candidate", "active", "retired", "demonstration-only"];

    public static CalibrationBundleValidation Validate(JsonElement? bundle)
    {
        var errors = new List<string>();
        if (!OwnKeys(bundle, BundleKeys, "bundle", errors))
        {
            return new CalibrationBundleValidation(false, errors);
        }
        var raw = bundle!.Value;

        if (!IsString(Prop(raw, "format"), "forgex-calibration-bundle"))
        {
            errors.Add("format 必须是 forgex-calibration-bundle");
        }
        if (!IsNumber(Prop(raw, "version"), 1)) errors.Add("version 必须是 1");
        if (!IdOk(Prop(raw, "id"))) errors.Add("bundle.id 格式无效");
        var revision = Prop(raw, "revision");
        if (!JsValue.IsInteger(revision) || JsValue.ToNumber(revision) < 1)
        {
            errors.Add("revision 必须是正整数");
        }
        if (!DateOk(Prop(raw, "createdAt"))) errors.Add("createdAt 必须是 ISO 日期");
        var provenance = StringOf(Prop(raw, "provenance"));
        if (provenance is null || !ProvenanceValues.Contains(provenance, StringComparer.Ordinal))
        {
            errors.Add("provenance 不受支持");
        }
        var source = Prop(raw, "source");
        if (OwnKeys(source, ["license", "note"], "source", errors))
        {
            if (Text(Prop(source!.Value, "license")).Length == 0) errors.Add("source.license 必填");
            if (Text(Prop(source.Value, "note")).Length < 20) errors.Add("source.note 至少 20 个字符");
        }
        var models = Prop(raw, "models");
        if (models is null || models.Value.ValueKind != JsonValueKind.Array || models.Value.GetArrayLength() == 0)
        {
            errors.Add("models 至少需要一项");
            return new CalibrationBundleValidation(false, errors);
        }

        var seenIds = new HashSet<string>(StringComparer.Ordinal);
        var index = 0;
        foreach (var model in models.Value.EnumerateArray())
        {
            var at = $"models[{index}]";
            index++;
            if (!OwnKeys(model, ModelKeys, at, errors)) continue;

            var id = Prop(model, "id");
            if (!IdOk(id)) errors.Add($"{at}.id 格式无效");
            var idKey = JsValue.ToJsString(id);
            if (!seenIds.Add(idKey)) errors.Add($"{at}.id 重复");

            var status = StringOf(Prop(model, "status"));
            if (status is null || !StatusValues.Contains(status, StringComparer.Ordinal))
            {
                errors.Add($"{at}.status 不受支持");
            }
            if (!IsString(Prop(model, "algorithm"), "theil-sen")) errors.Add($"{at}.algorithm 仅支持 theil-sen");
            if (!DateOk(Prop(model, "trainedAt"))) errors.Add($"{at}.trainedAt 必须是 ISO 日期");
            if (!Sha256Ok(Prop(model, "trainingSetSha256")))
            {
                errors.Add($"{at}.trainingSetSha256 必须是 SHA-256");
            }

            var scope = Prop(model, "scope");
            if (OwnKeys(scope, ["machineId", "firmware", "material"], $"{at}.scope", errors))
            {
                if (Text(Prop(scope!.Value, "machineId")).Length == 0) errors.Add($"{at}.scope.machineId 必填");
                if (Text(Prop(scope.Value, "firmware")).Length == 0) errors.Add($"{at}.scope.firmware 必填");
                var material = Prop(scope.Value, "material");
                if (material is not null && material.Value.ValueKind != JsonValueKind.Null &&
                    Text(material).Length == 0)
                {
                    errors.Add($"{at}.scope.material 不能为空");
                }
            }

            var coefficients = Prop(model, "coefficients");
            if (OwnKeys(coefficients, ["motionScale", "fixedOverheadSec", "sampleCount"], $"{at}.coefficients", errors))
            {
                if (!InRange(Prop(coefficients!.Value, "motionScale"), 0.1, 10))
                {
                    errors.Add($"{at}.coefficients.motionScale 超出 0.1–10");
                }
                if (!InRange(Prop(coefficients.Value, "fixedOverheadSec"), 0, 7200))
                {
                    errors.Add($"{at}.coefficients.fixedOverheadSec 超出 0–7200");
                }
                var sampleCount = Prop(coefficients.Value, "sampleCount");
                if (!JsValue.IsInteger(sampleCount) || JsValue.ToNumber(sampleCount) < 3)
                {
                    errors.Add($"{at}.coefficients.sampleCount 至少为 3");
                }
            }

            var validation = Prop(model, "validation");
            if (OwnKeys(
                validation,
                ["holdoutSamples", "mape", "maxApe", "medianBias", "evaluatedAt"],
                $"{at}.validation",
                errors))
            {
                var holdout = Prop(validation!.Value, "holdoutSamples");
                if (!JsValue.IsInteger(holdout) || JsValue.ToNumber(holdout) < 0)
                {
                    errors.Add($"{at}.validation.holdoutSamples 必须是非负整数");
                }
                if (!InRange(Prop(validation.Value, "mape"), 0, 1)) errors.Add($"{at}.validation.mape 超出 0–1");
                if (!InRange(Prop(validation.Value, "maxApe"), 0, 5)) errors.Add($"{at}.validation.maxApe 超出 0–5");
                if (!InRange(Prop(validation.Value, "medianBias"), -1, 1))
                {
                    errors.Add($"{at}.validation.medianBias 超出 -1–1");
                }
                if (!DateOk(Prop(validation.Value, "evaluatedAt")))
                {
                    errors.Add($"{at}.validation.evaluatedAt 必须是 ISO 日期");
                }
            }

            var thresholds = Prop(model, "thresholds");
            if (OwnKeys(thresholds, ["maxMape", "maxBias", "minDriftSamples"], $"{at}.thresholds", errors))
            {
                if (!InRange(Prop(thresholds!.Value, "maxMape"), 0.01, 0.5))
                {
                    errors.Add($"{at}.thresholds.maxMape 超出 0.01–0.5");
                }
                if (!InRange(Prop(thresholds.Value, "maxBias"), 0.01, 0.5))
                {
                    errors.Add($"{at}.thresholds.maxBias 超出 0.01–0.5");
                }
                var minDrift = Prop(thresholds.Value, "minDriftSamples");
                if (!JsValue.IsInteger(minDrift) || JsValue.ToNumber(minDrift) < 3)
                {
                    errors.Add($"{at}.thresholds.minDriftSamples 至少为 3");
                }
            }

            if (status == "active")
            {
                if (provenance is not ("real-anonymized" or "real-consented"))
                {
                    errors.Add($"{at} active 模型必须来自真实数据");
                }
                // 经典：model.validation && model.validation.holdoutSamples < 5
                //（undefined<5 为假、null<5 为真——null 已在上面的整数检查里单独报错，两条都要出）
                if (JsValue.Truthy(validation) &&
                    JsValue.ToNumber(PropThrough(validation, "holdoutSamples")) < 5)
                {
                    errors.Add($"{at} active 模型至少需要 5 个 holdout");
                }
                if (JsValue.Truthy(validation) && JsValue.Truthy(thresholds))
                {
                    var mape = JsValue.ToNumber(PropThrough(validation, "mape"));
                    var maxMape = JsValue.ToNumber(PropThrough(thresholds, "maxMape"));
                    var bias = Math.Abs(JsValue.ToNumber(PropThrough(validation, "medianBias")));
                    var maxBias = JsValue.ToNumber(PropThrough(thresholds, "maxBias"));
                    if (mape > maxMape || bias > maxBias)
                    {
                        errors.Add($"{at} holdout 指标未通过启用阈值");
                    }
                }
            }
            if (status == "demonstration-only" && provenance != "synthetic-conformance")
            {
                errors.Add($"{at} demonstration-only 必须使用 synthetic-conformance");
            }
            if (provenance == "synthetic-conformance" && status != "demonstration-only")
            {
                errors.Add($"{at} 合成校准只能是 demonstration-only");
            }
        }

        return new CalibrationBundleValidation(errors.Count == 0, errors);
    }

    /// <summary>属性读取：非对象或键不存在 → null（undefined 语义）。</summary>
    private static JsonElement? Prop(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value)
            ? value
            : null;

    private static JsonElement? PropThrough(JsonElement? element, string name) =>
        element is null ? null : Prop(element.Value, name);

    private static bool OwnKeys(JsonElement? element, string[] allowed, string at, List<string> errors)
    {
        if (element is null || element.Value.ValueKind != JsonValueKind.Object)
        {
            errors.Add($"{at} 必须是对象");
            return false;
        }
        var keys = element.Value.EnumerateObject().Select(static property => property.Name);
        foreach (var key in JsValue.OrderKeys(keys))
        {
            if (!allowed.Contains(key, StringComparer.Ordinal)) errors.Add($"{at} 含未知字段 {key}");
        }
        return true;
    }

    private static string Text(JsonElement? element) =>
        element is { ValueKind: JsonValueKind.String } value
            ? JsValue.Trim(value.GetString() ?? string.Empty)
            : string.Empty;

    private static string? StringOf(JsonElement? element) =>
        element is { ValueKind: JsonValueKind.String } value ? value.GetString() : null;

    private static bool IsString(JsonElement? element, string expected) =>
        StringOf(element) == expected;

    private static bool IsNumber(JsonElement? element, double expected) =>
        element is { ValueKind: JsonValueKind.Number } value && value.GetDouble() == expected;

    private static bool IdOk(JsonElement? element)
    {
        var text = Text(element);
        if (text.Length is < 3 or > 64) return false;
        if (!char.IsAsciiLetterOrDigit(text[0])) return false;
        for (var i = 1; i < text.Length; i++)
        {
            var c = text[i];
            if (!char.IsAsciiLetterOrDigit(c) && c is not ('.' or '_' or '-')) return false;
        }
        return true;
    }

    /// <summary>经典 dateOk：text(v) 非空 且 Date.parse(原始字符串) 有限。</summary>
    private static bool DateOk(JsonElement? element)
    {
        if (Text(element).Length == 0) return false;
        return JsDate.IsParsable(StringOf(element) ?? string.Empty);
    }

    private static bool Sha256Ok(JsonElement? element)
    {
        var text = Text(element);
        if (text.Length != 64) return false;
        foreach (var c in text)
        {
            if (c is not ((>= 'a' and <= 'f') or (>= '0' and <= '9'))) return false;
        }
        return true;
    }

    private static bool InRange(JsonElement? element, double min, double max)
    {
        var number = JsValue.ToNumber(element);
        return double.IsFinite(number) && number >= min && number <= max;
    }
}

public sealed record CalibrationBundleValidation(bool Ok, IReadOnlyList<string> Errors);
