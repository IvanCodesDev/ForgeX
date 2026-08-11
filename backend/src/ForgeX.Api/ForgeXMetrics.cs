using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using ForgeX.Application;
using ForgeX.Domain;

namespace ForgeX.Api;

internal sealed class ForgeXMetrics
{
    private static readonly double[] DurationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    private readonly ConcurrentDictionary<HttpCounterKey, Counter> _httpRequests = new();
    private readonly ConcurrentDictionary<HttpDurationKey, DurationHistogram> _httpDurations = new();
    private readonly long _startedTimestamp = Stopwatch.GetTimestamp();
    private long _repositoryReady;
    private long _repositoryRecords;
    private long _jobRetries;
    private long _jobDeadLetters;
    private long _jobRecoveries;
    private long _jobSubmissions;
    private long _ownerQuotaRejections;
    private long _tenantQuotaRejections;

    public void ObserveHttp(string method, PathString path, int statusCode, TimeSpan elapsed)
    {
        var normalizedMethod = NormalizeMethod(method);
        var route = RouteLabel(path);
        var status = statusCode.ToString(CultureInfo.InvariantCulture);
        _httpRequests.GetOrAdd(new HttpCounterKey(normalizedMethod, route, status), static _ => new Counter()).Increment();
        _httpDurations.GetOrAdd(new HttpDurationKey(normalizedMethod, route), static _ => new DurationHistogram()).Observe(elapsed);
    }

    public void SetRepositoryHealth(bool ready, long records)
    {
        Interlocked.Exchange(ref _repositoryReady, ready ? 1 : 0);
        Interlocked.Exchange(ref _repositoryRecords, Math.Max(0, records));
    }

    public void RecordJobRetry() => Interlocked.Increment(ref _jobRetries);
    public void RecordJobDeadLetter() => Interlocked.Increment(ref _jobDeadLetters);
    public void RecordJobRecovery() => Interlocked.Increment(ref _jobRecoveries);
    public void RecordJobSubmission() => Interlocked.Increment(ref _jobSubmissions);
    public void RecordJobQuotaRejection(string code)
    {
        if (code == "gcode_owner_active_quota_exceeded") Interlocked.Increment(ref _ownerQuotaRejections);
        else if (code == "gcode_tenant_active_quota_exceeded") Interlocked.Increment(ref _tenantQuotaRejections);
    }

    public string Render(string serviceVersion, IGCodeJobQueue queue, IReadOnlyList<GCodeJobRecord> jobs)
    {
        var output = new StringBuilder(8 * 1024);
        output.AppendLine("# HELP forgex_build_info Build and service identity.");
        output.AppendLine("# TYPE forgex_build_info gauge");
        output.Append("forgex_build_info{service=\"forgex-authoritative-api\",version=\"")
            .Append(EscapeLabel(serviceVersion))
            .AppendLine("\"} 1");
        output.AppendLine("# HELP forgex_process_uptime_seconds Process uptime in seconds.");
        output.AppendLine("# TYPE forgex_process_uptime_seconds gauge");
        output.Append("forgex_process_uptime_seconds ")
            .Append(Stopwatch.GetElapsedTime(_startedTimestamp).TotalSeconds.ToString("0.000", CultureInfo.InvariantCulture))
            .AppendLine();
        output.AppendLine("# HELP forgex_job_repository_ready Whether the configured job repository passed its latest readiness probe.");
        output.AppendLine("# TYPE forgex_job_repository_ready gauge");
        output.Append("forgex_job_repository_ready ")
            .Append(Interlocked.Read(ref _repositoryReady).ToString(CultureInfo.InvariantCulture))
            .AppendLine();
        output.AppendLine("# HELP forgex_job_repository_records Job records observed by the latest readiness probe.");
        output.AppendLine("# TYPE forgex_job_repository_records gauge");
        output.Append("forgex_job_repository_records ")
            .Append(Interlocked.Read(ref _repositoryRecords).ToString(CultureInfo.InvariantCulture))
            .AppendLine();
        output.AppendLine("# HELP forgex_gcode_job_queue_depth G-code jobs currently waiting in the bounded in-process queue.");
        output.AppendLine("# TYPE forgex_gcode_job_queue_depth gauge");
        output.Append("forgex_gcode_job_queue_depth ").Append(queue.Depth.ToString(CultureInfo.InvariantCulture)).AppendLine();
        output.AppendLine("# HELP forgex_gcode_job_queue_capacity Configured bounded G-code job queue capacity.");
        output.AppendLine("# TYPE forgex_gcode_job_queue_capacity gauge");
        output.Append("forgex_gcode_job_queue_capacity ").Append(queue.Capacity.ToString(CultureInfo.InvariantCulture)).AppendLine();
        output.AppendLine("# HELP forgex_gcode_job_retries_total Persisted retry transitions after transient G-code job failures.");
        output.AppendLine("# TYPE forgex_gcode_job_retries_total counter");
        output.Append("forgex_gcode_job_retries_total ").Append(Interlocked.Read(ref _jobRetries).ToString(CultureInfo.InvariantCulture)).AppendLine();
        output.AppendLine("# HELP forgex_gcode_job_dead_letters_total G-code jobs moved to dead-letter terminal state after retry exhaustion.");
        output.AppendLine("# TYPE forgex_gcode_job_dead_letters_total counter");
        output.Append("forgex_gcode_job_dead_letters_total ").Append(Interlocked.Read(ref _jobDeadLetters).ToString(CultureInfo.InvariantCulture)).AppendLine();
        output.AppendLine("# HELP forgex_gcode_job_recoveries_total Running G-code jobs durably requeued after worker restart.");
        output.AppendLine("# TYPE forgex_gcode_job_recoveries_total counter");
        output.Append("forgex_gcode_job_recoveries_total ").Append(Interlocked.Read(ref _jobRecoveries).ToString(CultureInfo.InvariantCulture)).AppendLine();
        output.AppendLine("# HELP forgex_gcode_job_submissions_total Newly persisted G-code analysis jobs.");
        output.AppendLine("# TYPE forgex_gcode_job_submissions_total counter");
        output.Append("forgex_gcode_job_submissions_total ").Append(Interlocked.Read(ref _jobSubmissions).ToString(CultureInfo.InvariantCulture)).AppendLine();
        output.AppendLine("# HELP forgex_gcode_job_owner_quota_rejections_total Owner active-job admission rejections.");
        output.AppendLine("# TYPE forgex_gcode_job_owner_quota_rejections_total counter");
        output.Append("forgex_gcode_job_owner_quota_rejections_total ").Append(Interlocked.Read(ref _ownerQuotaRejections).ToString(CultureInfo.InvariantCulture)).AppendLine();
        output.AppendLine("# HELP forgex_gcode_job_tenant_quota_rejections_total Tenant active-job admission rejections.");
        output.AppendLine("# TYPE forgex_gcode_job_tenant_quota_rejections_total counter");
        output.Append("forgex_gcode_job_tenant_quota_rejections_total ").Append(Interlocked.Read(ref _tenantQuotaRejections).ToString(CultureInfo.InvariantCulture)).AppendLine();
        output.AppendLine("# HELP forgex_gcode_jobs Durable G-code jobs by bounded status.");
        output.AppendLine("# TYPE forgex_gcode_jobs gauge");
        foreach (var status in Enum.GetValues<GCodeJobStatus>())
        {
            var count = jobs.Count(job => job.Status == status);
            output.Append("forgex_gcode_jobs{status=\"")
                .Append(status.ToString().ToLowerInvariant())
                .Append("\"} ")
                .Append(count.ToString(CultureInfo.InvariantCulture))
                .AppendLine();
        }
        AppendJobDurationHistogram(output, jobs);
        output.AppendLine("# HELP forgex_http_requests_total Completed HTTP requests by bounded route label.");
        output.AppendLine("# TYPE forgex_http_requests_total counter");
        foreach (var item in _httpRequests.OrderBy(static item => item.Key.Method, StringComparer.Ordinal)
                     .ThenBy(static item => item.Key.Route, StringComparer.Ordinal)
                     .ThenBy(static item => item.Key.Status, StringComparer.Ordinal))
        {
            output.Append("forgex_http_requests_total{method=\"").Append(item.Key.Method)
                .Append("\",route=\"").Append(item.Key.Route)
                .Append("\",status=\"").Append(item.Key.Status)
                .Append("\"} ").Append(item.Value.Value.ToString(CultureInfo.InvariantCulture)).AppendLine();
        }
        output.AppendLine("# HELP forgex_http_request_duration_seconds Completed HTTP request duration by bounded route label.");
        output.AppendLine("# TYPE forgex_http_request_duration_seconds histogram");
        foreach (var item in _httpDurations.OrderBy(static item => item.Key.Method, StringComparer.Ordinal)
                     .ThenBy(static item => item.Key.Route, StringComparer.Ordinal))
        {
            var snapshot = item.Value.Snapshot();
            for (var index = 0; index < DurationBuckets.Length; index++)
            {
                AppendHistogramBucket(output, item.Key, DurationBuckets[index].ToString("0.###", CultureInfo.InvariantCulture), snapshot.Buckets[index]);
            }
            AppendHistogramBucket(output, item.Key, "+Inf", snapshot.Count);
            output.Append("forgex_http_request_duration_seconds_sum{method=\"").Append(item.Key.Method)
                .Append("\",route=\"").Append(item.Key.Route)
                .Append("\"} ").Append((snapshot.Microseconds / 1_000_000d).ToString("0.000000", CultureInfo.InvariantCulture)).AppendLine();
            output.Append("forgex_http_request_duration_seconds_count{method=\"").Append(item.Key.Method)
                .Append("\",route=\"").Append(item.Key.Route)
                .Append("\"} ").Append(snapshot.Count.ToString(CultureInfo.InvariantCulture)).AppendLine();
        }
        return output.ToString();
    }

    private static void AppendHistogramBucket(StringBuilder output, HttpDurationKey key, string upperBound, long count) =>
        output.Append("forgex_http_request_duration_seconds_bucket{method=\"").Append(key.Method)
            .Append("\",route=\"").Append(key.Route)
            .Append("\",le=\"").Append(upperBound)
            .Append("\"} ").Append(count.ToString(CultureInfo.InvariantCulture)).AppendLine();

    private static void AppendJobDurationHistogram(StringBuilder output, IReadOnlyList<GCodeJobRecord> jobs)
    {
        var durations = jobs
            .Where(static job => job.FinishedAtUtc is not null)
            .Select(static job => Math.Max(0, (job.FinishedAtUtc!.Value - job.CreatedAtUtc).TotalSeconds))
            .ToArray();
        output.AppendLine("# HELP forgex_gcode_job_duration_seconds Durable G-code job wall-clock duration from creation to terminal state.");
        output.AppendLine("# TYPE forgex_gcode_job_duration_seconds histogram");
        foreach (var upperBound in DurationBuckets)
        {
            var count = durations.LongCount(duration => duration <= upperBound);
            output.Append("forgex_gcode_job_duration_seconds_bucket{le=\"")
                .Append(upperBound.ToString("0.###", CultureInfo.InvariantCulture))
                .Append("\"} ")
                .Append(count.ToString(CultureInfo.InvariantCulture))
                .AppendLine();
        }
        output.Append("forgex_gcode_job_duration_seconds_bucket{le=\"+Inf\"} ").Append(durations.Length.ToString(CultureInfo.InvariantCulture)).AppendLine();
        output.Append("forgex_gcode_job_duration_seconds_sum ").Append(durations.Sum().ToString("0.000000", CultureInfo.InvariantCulture)).AppendLine();
        output.Append("forgex_gcode_job_duration_seconds_count ").Append(durations.Length.ToString(CultureInfo.InvariantCulture)).AppendLine();
    }

    private static string NormalizeMethod(string method) => method.ToUpperInvariant() switch
    {
        "GET" => "GET",
        "POST" => "POST",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    };

    public static string RouteLabel(PathString path)
    {
        var value = path.Value ?? string.Empty;
        if (value is "/health/live" or "/health/ready" or "/healthz" or "/metrics" or "/openapi/v1.json" or
            "/api/v1/gcode/analyze" or "/api/v1/gcode/analyses")
        {
            return value;
        }
        if (value.StartsWith("/api/v1/jobs/", StringComparison.Ordinal))
        {
            var suffix = value["/api/v1/jobs/".Length..];
            if (!suffix.Contains('/')) return "/api/v1/jobs/{id}";
            if (suffix.EndsWith("/events", StringComparison.Ordinal) && suffix.Count(static character => character == '/') == 1)
            {
                return "/api/v1/jobs/{id}/events";
            }
            if (suffix.EndsWith("/cancel", StringComparison.Ordinal) && suffix.Count(static character => character == '/') == 1)
            {
                return "/api/v1/jobs/{id}/cancel";
            }
        }
        return "other";
    }

    private static string EscapeLabel(string value) => value.Replace("\\", "\\\\", StringComparison.Ordinal)
        .Replace("\"", "\\\"", StringComparison.Ordinal)
        .Replace("\n", "\\n", StringComparison.Ordinal);

    private readonly record struct HttpCounterKey(string Method, string Route, string Status);
    private readonly record struct HttpDurationKey(string Method, string Route);

    private sealed class Counter
    {
        private long _value;
        public long Value => Interlocked.Read(ref _value);
        public void Increment() => Interlocked.Increment(ref _value);
    }

    private sealed class DurationHistogram
    {
        private readonly long[] _buckets = new long[DurationBuckets.Length];
        private long _count;
        private long _microseconds;

        public void Observe(TimeSpan elapsed)
        {
            var seconds = Math.Max(0, elapsed.TotalSeconds);
            Interlocked.Increment(ref _count);
            Interlocked.Add(ref _microseconds, Math.Max(0, (long)Math.Round(seconds * 1_000_000d)));
            for (var index = 0; index < DurationBuckets.Length; index++)
            {
                if (seconds <= DurationBuckets[index]) Interlocked.Increment(ref _buckets[index]);
            }
        }

        public HistogramSnapshot Snapshot()
        {
            var buckets = new long[_buckets.Length];
            for (var index = 0; index < _buckets.Length; index++) buckets[index] = Interlocked.Read(ref _buckets[index]);
            return new HistogramSnapshot(buckets, Interlocked.Read(ref _count), Interlocked.Read(ref _microseconds));
        }
    }

    private sealed record HistogramSnapshot(IReadOnlyList<long> Buckets, long Count, long Microseconds);
}
