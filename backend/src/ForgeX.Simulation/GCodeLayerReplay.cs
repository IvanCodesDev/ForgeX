using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using ForgeX.Domain;

namespace ForgeX.Simulation;

/// <summary>Deterministic motion-only layer plan. Sampled display geometry never supplies authority.</summary>
public sealed class GCodeLayerReplay
{
    public const string ModelVersion = "forgex-gcode-layer-timeline/1";
    private readonly GCodeTimelineBasis _basis;
    private readonly GCodeTimelineLayer[] _layers;
    private readonly string _fingerprint;
    private readonly double _leading, _total, _positive;
    private static readonly string[] Warnings = [
        "仅按 G-code 运动时长定位层，不含预热、等待和固件加速度；不代表实际打印进度。",
        "层耗丝为 XY 挤出运动的正向 E 增量；作业净耗丝另含回抽及纯 E 指令，两者不可互换。",
        "检查点只累计已完成层的正向耗丝，不按时间比例推算当前层材料或喷头坐标。"];

    public GCodeLayerReplay(string jobId, GCodeAnalysisResult source, CancellationToken ct = default)
    {
        static bool Hash(string? value, int length) => value?.Length == length && value.All(char.IsAsciiHexDigit);
        static bool Valid(double value, double max) => double.IsFinite(value) && value >= 0 && value <= max;
        if (!Hash(jobId, 32) || !Hash(source.Sha256, 64) || source.Profile is null || !Hash(source.Profile.Fingerprint, 64) ||
            string.IsNullOrWhiteSpace(source.EngineVersion) || source.EngineVersion.Length > 100 || source.EngineVersion.Any(c => c < 33 || c > 126) || source.Statistics is null ||
            !Valid(source.Statistics.TimeSeconds, 31_536_000) || !Valid(source.Statistics.FilamentLengthM, 1e9) ||
            !Valid(source.Statistics.FilamentMassG, 1_000_000) || source.Layers is null || source.TotalLayers < 1 ||
            source.TotalLayers > 100_000 || source.TotalLayers != source.Layers.Count)
            throw Invalid();
        if (source.Layers.Any(layer => layer is null)) throw Invalid();
        if (source.Layers.Any(layer => layer.SourceOrder is null))
            throw new GCodeReplayException("replay_source_order_unavailable", "该分析未保存执行层顺序，请重新分析原始 G-code");
        var ordered = new GCodeLayerSummary[source.TotalLayers];
        double duration = 0;
        for (var i = 0; i < source.Layers.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var layer = source.Layers[i];
            var order = layer.SourceOrder!.Value;
            if (order < 0 || order >= ordered.Length || ordered[order] is not null || layer.Index != i ||
                !double.IsFinite(layer.ZMm) || Math.Abs(layer.ZMm) > 1e9 || layer.PathCount < 0 ||
                !Valid(layer.TimeSeconds, 31_536_000) || !Valid(layer.FilamentLengthMm, 1e12)) throw Invalid();
            ordered[order] = layer;
            duration += layer.TimeSeconds;
        }
        var tolerance = Math.Max(1e-9, source.Statistics.TimeSeconds * 1e-9);
        if (duration > source.Statistics.TimeSeconds + tolerance) throw Invalid();
        _leading = Math.Max(0, source.Statistics.TimeSeconds - duration);
        _basis = new(jobId.ToLowerInvariant(), source.Sha256, source.Profile.Fingerprint, source.EngineVersion,
            source.Statistics.TimeSeconds, source.Statistics.FilamentLengthM, source.Statistics.FilamentMassG);
        _layers = new GCodeTimelineLayer[ordered.Length];
        var time = _leading;
        double filament = 0;
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void Add(object value) => hash.AppendData(Encoding.UTF8.GetBytes(
            (value is double d ? d.ToString("R", CultureInfo.InvariantCulture) : Convert.ToString(value, CultureInfo.InvariantCulture)) + "\n"));
        Add(ModelVersion); Add(_basis.JobId); Add(_basis.InputSha256); Add(_basis.ProfileFingerprint);
        Add(_basis.AnalysisEngineVersion); Add(_basis.SourceMotionSeconds); Add(_basis.NetFilamentLengthM); Add(_basis.NetFilamentMassG); Add(_leading);
        for (var i = 0; i < ordered.Length; i++)
        {
            ct.ThrowIfCancellationRequested();
            var layer = ordered[i];
            var end = time + layer.TimeSeconds;
            _layers[i] = new(i, layer.Index, layer.ZMm, time, end, layer.TimeSeconds, layer.PathCount, layer.FilamentLengthMm, filament);
            Add(i); Add(layer.Index); Add(layer.ZMm); Add(time); Add(end); Add(layer.TimeSeconds); Add(layer.PathCount); Add(layer.FilamentLengthMm); Add(filament);
            time = end;
            filament += layer.FilamentLengthMm;
        }
        _total = time;
        _positive = filament;
        _fingerprint = Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    public GCodeLayerTimeline Page(int offset = 0, int limit = 50)
    {
        if (offset < 0 || offset > _layers.Length || limit < 1 || limit > 200)
            throw new GCodeReplayException("replay_page_invalid", "offset 须在层数范围内，limit 须为 1–200");
        var count = Math.Min(limit, _layers.Length - offset);
        return new("1.0", ModelVersion, _fingerprint, _basis, _leading, _total, _positive,
            _layers.Length, offset, limit, offset + count < _layers.Length ? offset + count : null,
            _layers.AsSpan(offset, count).ToArray(), Warnings);
    }

    public GCodeReplayCheckpoint Seek(double elapsedSeconds)
    {
        if (!double.IsFinite(elapsedSeconds) || elapsedSeconds < 0 || elapsedSeconds > _total)
            throw new GCodeReplayException("replay_time_invalid", "回放时间须在 0 与计划总时长之间");
        var low = 0;
        var high = _layers.Length;
        while (low < high)
        {
            var mid = low + (high - low) / 2;
            if (_layers[mid].EndSeconds <= elapsedSeconds) low = mid + 1;
            else high = mid;
        }
        var completed = low;
        GCodeTimelineLayer? active = elapsedSeconds < _leading || low == _layers.Length ? null : _layers[low];
        var phase = elapsedSeconds >= _total ? "completed" : active is null ? "initial-travel" : "layer";
        var material = completed == _layers.Length ? _positive : _layers[completed].CompletedPositiveExtrusionMm;
        return new("1.0", ModelVersion, _fingerprint, _basis, elapsedSeconds, Math.Max(0, _total - elapsedSeconds), phase,
            completed, material, active, active is null ? null : elapsedSeconds - active.StartSeconds,
            active is null ? null : (elapsedSeconds - active.StartSeconds) / active.DurationSeconds);
    }

    private static GCodeReplayException Invalid() => new("replay_source_invalid", "层计划来源或数值不一致");
}
