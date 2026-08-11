using System.Text.Json;
using ForgeX.Application;
using ForgeX.Infrastructure;

return await RunAsync(args);

static async Task<int> RunAsync(string[] arguments)
{
    try
    {
        if (arguments.Length == 0) return Usage();
        var command = arguments[0].ToLowerInvariant();
        var options = ParseOptions(arguments[1..]);
        JobBackupSummary summary;

        switch (command)
        {
            case "backup":
                {
                    var source = RequirePath(options, "source");
                    var output = RequirePath(options, "output");
                    var repository = new FileGCodeJobRepository(source);
                    var health = await repository.ProbeAsync(CancellationToken.None);
                    if (!health.Ready) throw new InvalidOperationException(health.ErrorCode ?? "JOB_REPOSITORY_UNAVAILABLE");
                    Directory.CreateDirectory(Path.GetDirectoryName(output)!);
                    await using var destination = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.None, 64 * 1024, FileOptions.Asynchronous);
                    summary = await repository.BackupAsync(destination, CancellationToken.None);
                    break;
                }
            case "verify":
                {
                    var input = RequireExistingFile(options, "input");
                    var repository = new FileGCodeJobRepository(Path.Combine(Path.GetTempPath(), "forgex-backup-verifier"));
                    await using var source = new FileStream(input, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.Asynchronous);
                    summary = await repository.VerifyBackupAsync(source, CancellationToken.None);
                    break;
                }
            case "restore":
                {
                    var input = RequireExistingFile(options, "input");
                    var target = RequirePath(options, "target");
                    var repository = new FileGCodeJobRepository(target);
                    await using var source = new FileStream(input, FileMode.Open, FileAccess.Read, FileShare.Read, 64 * 1024, FileOptions.Asynchronous);
                    summary = await repository.RestoreAsync(source, CancellationToken.None);
                    break;
                }
            default:
                return Usage();
        }

        Console.WriteLine(JsonSerializer.Serialize(new { result = "pass", command, summary }, GetJsonOptions()));
        return 0;
    }
    catch (Exception exception) when (exception is ArgumentException or IOException or InvalidDataException or InvalidOperationException or UnauthorizedAccessException)
    {
        Console.Error.WriteLine(JsonSerializer.Serialize(new
        {
            result = "fail",
            error = exception.Message,
            type = exception.GetType().Name,
        }, GetJsonOptions()));
        return 1;
    }
}

static Dictionary<string, string> ParseOptions(string[] arguments)
{
    if (arguments.Length % 2 != 0) throw new ArgumentException("Options must use --name value pairs.");
    var parsed = new Dictionary<string, string>(StringComparer.Ordinal);
    for (var index = 0; index < arguments.Length; index += 2)
    {
        if (!arguments[index].StartsWith("--", StringComparison.Ordinal) || arguments[index].Length < 3)
        {
            throw new ArgumentException("Options must use --name value pairs.");
        }
        if (!parsed.TryAdd(arguments[index][2..], arguments[index + 1]))
        {
            throw new ArgumentException($"Duplicate option: {arguments[index]}");
        }
    }
    return parsed;
}

static string RequirePath(IReadOnlyDictionary<string, string> options, string name)
{
    if (!options.TryGetValue(name, out var value) || string.IsNullOrWhiteSpace(value))
    {
        throw new ArgumentException($"Missing --{name}.");
    }
    return Path.GetFullPath(value);
}

static string RequireExistingFile(IReadOnlyDictionary<string, string> options, string name)
{
    var path = RequirePath(options, name);
    if (!File.Exists(path)) throw new FileNotFoundException($"Input file not found: {path}", path);
    return path;
}

static int Usage()
{
    Console.Error.WriteLine("Usage: backup --source <jobs-dir> --output <archive> | verify --input <archive> | restore --input <archive> --target <empty-jobs-dir>");
    return 2;
}

static JsonSerializerOptions GetJsonOptions() => new(JsonSerializerDefaults.Web) { WriteIndented = true };
