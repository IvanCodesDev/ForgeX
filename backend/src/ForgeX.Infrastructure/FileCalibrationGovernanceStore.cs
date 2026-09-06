using System.Text.Json;
using System.Text.Json.Serialization;
using ForgeX.Application;

namespace ForgeX.Infrastructure;

/// <summary>
/// Node <c>forgex-calibration-service-state</c> v1 单文件状态（决策 A1：与 Node 同格式，
/// Node→C# 接管时直接拷贝 <c>DATA_DIR/calibrations.json</c>）。键序 / 字段名 / 缺省键行为与
/// Node <c>JSON.stringify</c> 一致：<c>reviewedBy</c> / <c>reviewReason</c> 审核前不输出。
/// </summary>
public sealed class CalibrationServiceState
{
    public const string ExpectedFormat = "forgex-calibration-service-state";
    public const int ExpectedVersion = 1;

    [JsonPropertyName("format")]
    public string Format { get; set; } = ExpectedFormat;

    [JsonPropertyName("version")]
    public int Version { get; set; } = ExpectedVersion;

    /// <summary>Insertion-ordered like a JS object so stable sorts tie-break exactly as Node does.</summary>
    [JsonPropertyName("submissions")]
    public OrderedDictionary<string, CalibrationSubmission> Submissions { get; set; } = new(StringComparer.Ordinal);

    [JsonPropertyName("approved")]
    public OrderedDictionary<string, CalibrationRelease> Approved { get; set; } = new(StringComparer.Ordinal);

    public bool IsRecognized => Format == ExpectedFormat && Version == ExpectedVersion;
}

public sealed class FileCalibrationGovernanceStore : ICalibrationGovernanceStore
{
    private readonly JsonFileDocument<CalibrationServiceState> _document;
    private readonly int _maxSubmissions;

    public FileCalibrationGovernanceStore(string stateFilePath, int maxSubmissions = CalibrationGovernanceRules.DefaultMaxSubmissions)
    {
        if (maxSubmissions < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(maxSubmissions), maxSubmissions, "maxSubmissions must be at least 1.");
        }

        _document = new JsonFileDocument<CalibrationServiceState>(stateFilePath);
        _maxSubmissions = maxSubmissions;
    }

    public string StateFilePath => _document.FilePath;

    public Task ProbeAsync(CancellationToken cancellationToken) => LoadAsync(cancellationToken);

    public async Task<IReadOnlyList<CalibrationRelease>> ListApprovedAsync(CancellationToken cancellationToken)
    {
        using var _ = await _document.LockAsync(cancellationToken);
        var state = await LoadAsync(cancellationToken);
        return state.Approved.Values.OrderBy(static release => release.Id, StringComparer.Ordinal).ToList();
    }

    public async Task<IReadOnlyList<CalibrationSubmission>> ListSubmissionsAsync(CancellationToken cancellationToken)
    {
        using var _ = await _document.LockAsync(cancellationToken);
        var state = await LoadAsync(cancellationToken);
        return state.Submissions.Values.OrderByDescending(static record => record.CreatedAt).ToList();
    }

    public async Task<CalibrationGovernanceStats> StatsAsync(CancellationToken cancellationToken)
    {
        using var _ = await _document.LockAsync(cancellationToken);
        var state = await LoadAsync(cancellationToken);
        return new CalibrationGovernanceStats(
            state.Approved.Count,
            state.Submissions.Values.Count(static record => record.Status == "pending"));
    }

    public async Task<CalibrationGovernanceOutcome> SubmitAsync(JsonElement? bundle, JsonElement? note, string actor, CancellationToken cancellationToken)
    {
        var preparation = CalibrationGovernanceRules.PrepareSubmit(bundle);
        if (preparation.Failure is not null)
        {
            return preparation.Failure;
        }

        using var _ = await _document.LockAsync(cancellationToken);
        var state = await LoadAsync(cancellationToken);
        var key = CalibrationGovernanceRules.SubmissionKey(preparation.Id, preparation.Revision);
        var approvedRevision = state.Approved.TryGetValue(preparation.Id, out var current) ? current.Revision : (int?)null;
        var outcome = CalibrationGovernanceRules.CompleteSubmit(
            preparation,
            note,
            actor,
            state.Submissions.ContainsKey(key),
            approvedRevision,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        if (!outcome.Ok)
        {
            return outcome;
        }

        state.Submissions[key] = outcome.Submission!;
        foreach (var evicted in CalibrationGovernanceRules.EvictNonPending(state.Submissions.Values, _maxSubmissions))
        {
            state.Submissions.Remove(evicted.Key);
        }

        await _document.SaveAsync(state, cancellationToken);
        return outcome;
    }

    public async Task<CalibrationGovernanceOutcome> ReviewAsync(string id, int revision, JsonElement? decision, JsonElement? reason, string actor, CancellationToken cancellationToken)
    {
        using var _ = await _document.LockAsync(cancellationToken);
        var state = await LoadAsync(cancellationToken);
        var key = CalibrationGovernanceRules.SubmissionKey(id, revision);
        state.Submissions.TryGetValue(key, out var existing);
        var approvedRevision = existing is not null && state.Approved.TryGetValue(existing.Id, out var current) ? current.Revision : (int?)null;
        var outcome = CalibrationGovernanceRules.DecideReview(
            existing,
            decision,
            reason,
            actor,
            approvedRevision,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            out var release);
        if (!outcome.Ok)
        {
            return outcome;
        }

        if (release is not null)
        {
            state.Approved[release.Id] = release;
        }

        state.Submissions[key] = outcome.Submission!;
        await _document.SaveAsync(state, cancellationToken);
        return outcome;
    }

    private async Task<CalibrationServiceState> LoadAsync(CancellationToken cancellationToken)
    {
        var state = await _document.LoadAsync(cancellationToken) ?? new CalibrationServiceState();
        if (!state.IsRecognized)
        {
            // Node silently resets an unrecognised file; governance state is long-lived, so refuse instead of wiping it.
            throw new InvalidDataException(
                $"Calibration state file '{_document.FilePath}' is not {CalibrationServiceState.ExpectedFormat} v{CalibrationServiceState.ExpectedVersion}.");
        }

        return state;
    }
}
