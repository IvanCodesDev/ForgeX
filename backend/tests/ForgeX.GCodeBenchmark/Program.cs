using System.Diagnostics;
using System.Text;
using System.Text.Json;
using ForgeX.Domain;
using ForgeX.Simulation;

const long targetBytes = 16L * 1024 * 1024;
var repositoryRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", ".."));
var artifactPath = Path.Combine(repositoryRoot, "backend", "artifacts", "gcode-stage5-benchmark.json");
var fixturePath = Path.Combine(Path.GetTempPath(), $"forgex-gcode-benchmark-{Guid.NewGuid():N}.gcode");

try
{
    await CreateFixtureAsync(fixturePath, targetBytes);
    var fixtureBytes = new FileInfo(fixturePath).Length;
    var analyzer = new StreamingGCodeAnalyzer();
    var options = new GCodeAnalysisOptions(
        BedSizeMm: 256,
        CoordinateOrigin: CoordinateOrigin.Corner,
        MaterialDensityGPerCm3: 1.24,
        MachineProfileId: "benchmark-machine",
        MaterialProfileId: "benchmark-material");

    GC.Collect();
    GC.WaitForPendingFinalizers();
    GC.Collect();
    var managedBefore = GC.GetTotalMemory(forceFullCollection: true);
    var process = Process.GetCurrentProcess();
    process.Refresh();
    var privateBefore = process.PrivateMemorySize64;
    var peakPrivate = privateBefore;
    var firstProgressMs = -1d;
    var stopwatch = Stopwatch.StartNew();
    using var samplingCancellation = new CancellationTokenSource();
    var sampler = Task.Run(async () =>
    {
        while (!samplingCancellation.IsCancellationRequested)
        {
            process.Refresh();
            peakPrivate = Math.Max(peakPrivate, process.PrivateMemorySize64);
            await Task.Delay(5, CancellationToken.None);
        }
    });

    GCodeAnalysisResult result;
    await using (var file = new FileStream(
        fixturePath,
        FileMode.Open,
        FileAccess.Read,
        FileShare.Read,
        64 * 1024,
        FileOptions.Asynchronous | FileOptions.SequentialScan))
    await using (var observed = new ObservingReadStream(
        file,
        onFirstRead: () => firstProgressMs = stopwatch.Elapsed.TotalMilliseconds))
    {
        result = await analyzer.AnalyzeAsync(observed, options, CancellationToken.None);
    }

    stopwatch.Stop();
    samplingCancellation.Cancel();
    await sampler;
    process.Refresh();
    peakPrivate = Math.Max(peakPrivate, process.PrivateMemorySize64);
    var managedAfter = GC.GetTotalMemory(forceFullCollection: false);
    var resultBytes = JsonSerializer.SerializeToUtf8Bytes(result, new JsonSerializerOptions(JsonSerializerDefaults.Web)).Length;

    var cancellationStopwatch = Stopwatch.StartNew();
    using var cancellation = new CancellationTokenSource();
    await using var cancellationFile = new FileStream(
        fixturePath,
        FileMode.Open,
        FileAccess.Read,
        FileShare.Read,
        4096,
        FileOptions.Asynchronous | FileOptions.SequentialScan);
    await using var slow = new ObservingReadStream(cancellationFile, maximumReadBytes: 4096, delayMs: 1);
    var cancellationTask = analyzer.AnalyzeAsync(slow, options, cancellation.Token);
    await Task.Delay(50);
    var cancellationIssuedMs = cancellationStopwatch.Elapsed.TotalMilliseconds;
    cancellation.Cancel();
    var cancelled = false;
    try
    {
        await cancellationTask;
    }
    catch (OperationCanceledException)
    {
        cancelled = true;
    }
    cancellationStopwatch.Stop();
    var cancellationLatencyMs = cancellationStopwatch.Elapsed.TotalMilliseconds - cancellationIssuedMs;

    var checks = new Dictionary<string, bool>
    {
        ["input-complete"] = result.BytesRead == fixtureBytes,
        ["first-progress-under-1000ms"] = firstProgressMs is >= 0 and < 1000,
        ["duration-under-30s"] = stopwatch.Elapsed < TimeSpan.FromSeconds(30),
        ["private-memory-delta-under-64MiB"] = peakPrivate - privateBefore < 64L * 1024 * 1024,
        ["result-under-64KiB"] = resultBytes < 64 * 1024,
        ["cancellation-under-500ms"] = cancelled && cancellationLatencyMs < 500,
        ["profile-bound"] = result.Profile.MachineProfileId == options.MachineProfileId &&
            result.Profile.MaterialProfileId == options.MaterialProfileId,
    };
    var pass = checks.Values.All(static value => value);
    var report = new
    {
        format = "forgex-gcode-stage5-benchmark",
        schemaVersion = 1,
        generatedAtUtc = DateTimeOffset.UtcNow,
        engineVersion = StreamingGCodeAnalyzer.EngineVersion,
        pass,
        inputBytes = fixtureBytes,
        linesRead = result.LinesRead,
        firstProgressMs,
        durationMs = stopwatch.Elapsed.TotalMilliseconds,
        throughputMiBPerSecond = fixtureBytes / 1024d / 1024d / stopwatch.Elapsed.TotalSeconds,
        privateMemoryBeforeBytes = privateBefore,
        peakPrivateMemoryBytes = peakPrivate,
        privateMemoryDeltaBytes = peakPrivate - privateBefore,
        managedMemoryBeforeBytes = managedBefore,
        managedMemoryAfterBytes = managedAfter,
        resultBytes,
        cancelled,
        cancellationLatencyMs,
        profileFingerprint = result.Profile.Fingerprint,
        checks,
    };
    Directory.CreateDirectory(Path.GetDirectoryName(artifactPath)!);
    await File.WriteAllTextAsync(
        artifactPath,
        JsonSerializer.Serialize(report, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
    Console.WriteLine(
        $"GCodeBenchmark: {(pass ? "PASS" : "FAIL")} — {fixtureBytes / 1024d / 1024d:F2} MiB in {stopwatch.Elapsed.TotalMilliseconds:F1} ms; " +
        $"firstProgress={firstProgressMs:F1} ms; memoryDelta={(peakPrivate - privateBefore) / 1024d / 1024d:F2} MiB; " +
        $"result={resultBytes} bytes; cancellation={cancellationLatencyMs:F1} ms");
    Console.WriteLine(artifactPath);
    return pass ? 0 : 1;
}
finally
{
    if (File.Exists(fixturePath)) File.Delete(fixturePath);
}

static async Task CreateFixtureAsync(string path, long targetBytes)
{
    var header = Encoding.ASCII.GetBytes("; ForgeX Stage 5 benchmark\nG90\nM83\nG1 X10 Y10 Z0.2 F1200\n");
    var first = Encoding.ASCII.GetBytes("G1 X20 Y20 E0.01 F1200\n");
    var second = Encoding.ASCII.GetBytes("G1 X10 Y10 E0.01 F1200\n");
    await using var stream = new FileStream(
        path,
        FileMode.CreateNew,
        FileAccess.Write,
        FileShare.None,
        64 * 1024,
        FileOptions.Asynchronous | FileOptions.SequentialScan);
    await stream.WriteAsync(header);
    var useFirst = true;
    while (stream.Length < targetBytes)
    {
        await stream.WriteAsync(useFirst ? first : second);
        useFirst = !useFirst;
    }
}

internal sealed class ObservingReadStream(
    Stream inner,
    Action? onFirstRead = null,
    int maximumReadBytes = int.MaxValue,
    int delayMs = 0) : Stream
{
    private int _firstReadObserved;

    public override bool CanRead => inner.CanRead;
    public override bool CanSeek => inner.CanSeek;
    public override bool CanWrite => false;
    public override long Length => inner.Length;
    public override long Position { get => inner.Position; set => inner.Position = value; }
    public override void Flush() => inner.Flush();
    public override int Read(byte[] buffer, int offset, int count)
    {
        var read = inner.Read(buffer, offset, Math.Min(count, maximumReadBytes));
        Observe(read);
        return read;
    }
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        if (delayMs > 0) await Task.Delay(delayMs, cancellationToken);
        var read = await inner.ReadAsync(buffer[..Math.Min(buffer.Length, maximumReadBytes)], cancellationToken);
        Observe(read);
        return read;
    }
    private void Observe(int read)
    {
        if (read > 0 && Interlocked.Exchange(ref _firstReadObserved, 1) == 0) onFirstRead?.Invoke();
    }
    public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    protected override void Dispose(bool disposing)
    {
        if (disposing) inner.Dispose();
        base.Dispose(disposing);
    }
    public override async ValueTask DisposeAsync()
    {
        await inner.DisposeAsync();
        GC.SuppressFinalize(this);
    }
}
