using System.Text;
using System.Text.Json;
using ForgeX.Api;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace ForgeX.ResourceGate;

/// <summary>Shared state for every gate section: check bookkeeping, fixtures, temp root, HTTP and app hosting.</summary>
internal sealed class Gate : IAsyncDisposable
{
    public const string InternalSecret = "resource-gate-internal-secret-32-bytes-min";

    private readonly List<WebApplication> _apps = [];

    public Gate()
    {
        PostgresUrl = Environment.GetEnvironmentVariable("POSTGRES_URL") ?? string.Empty;
        if (string.IsNullOrWhiteSpace(PostgresUrl))
        {
            Skipped.Add("postgres");
        }
        else
        {
            Legs.Add("postgres");
        }

        Root = Path.Combine(Path.GetTempPath(), "forgex-resource-gate-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Root);
        Http = new HttpClient(new HttpClientHandler { UseCookies = false, AllowAutoRedirect = false });
    }

    public List<object> Checks { get; } = [];

    public int Passed { get; private set; }

    public List<string> Legs { get; } = ["file"];

    public List<string> Skipped { get; } = [];

    public string PostgresUrl { get; }

    public bool HasPostgres => PostgresUrl.Length > 0;

    public string Root { get; }

    public HttpClient Http { get; }

    public void Check(string name, bool condition, object? actual = null)
    {
        Checks.Add(new { name, pass = condition, actual = actual?.ToString() });
        if (!condition)
        {
            throw new InvalidOperationException($"{name} failed: {actual}");
        }

        Passed++;
        Console.WriteLine($"  PASS  {name}");
    }

    public void Section(string title) => Console.WriteLine($"[{title}]");

    public string TempDir(string name)
    {
        var path = Path.Combine(Root, name);
        Directory.CreateDirectory(path);
        return path;
    }

    public static JsonElement Fixture(string name)
    {
        var path = Path.Combine(AppContext.BaseDirectory, "fixtures", name);
        using var document = JsonDocument.Parse(File.ReadAllText(path));
        return document.RootElement.Clone();
    }

    public static JsonElement Parse(string body) => JsonDocument.Parse(body).RootElement.Clone();

    /// <summary>
    /// Boots a real Kestrel pipeline with the SAME boundary middleware as ForgeX.Api, letting the caller
    /// register services and map the production endpoint handlers under test.
    /// </summary>
    public async Task<WebApplication> StartApiAsync(
        Dictionary<string, string?> settings,
        Action<WebApplicationBuilder> configureServices,
        Action<WebApplication> mapEndpoints,
        string secret = InternalSecret,
        string previousSecret = "")
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Configuration.AddInMemoryCollection(settings);
        builder.Services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
            options.SerializerOptions.DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull;
        });
        // Same wiring as Program.cs: one DirectAuthOptions instance feeds both the boundary
        // middleware and the calibration governance endpoints.
        var directAuth = DirectAuthOptions.FromConfiguration(builder.Configuration);
        builder.Services.AddSingleton(directAuth);
        configureServices(builder);
        var app = builder.Build();
        _apps.Add(app);
        app.Use(CallerContextBoundary.BuildMiddleware(secret, previousSecret, directAuth));
        mapEndpoints(app);
        await app.StartAsync();
        return app;
    }

    public static string Origin(WebApplication app) =>
        app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!.Addresses.First();

    public async Task<(HttpResponseMessage Response, string Body)> SendAsync(
        string origin,
        HttpMethod method,
        string pathAndQuery,
        string? jsonBody = null,
        params (string Name, string Value)[] headers)
    {
        using var request = new HttpRequestMessage(method, origin + pathAndQuery);
        foreach (var (name, value) in headers)
        {
            request.Headers.TryAddWithoutValidation(name, value);
        }

        if (jsonBody is not null)
        {
            request.Content = new StringContent(jsonBody, Encoding.UTF8, "application/json");
        }

        var response = await Http.SendAsync(request);
        return (response, await response.Content.ReadAsStringAsync());
    }

    /// <summary>Trusted-channel headers the Node proxy would forward for (tenant, owner).</summary>
    public static (string Name, string Value)[] Trusted(string tenantId, string ownerId, string? actorKeyId = null, string? actorRole = null)
    {
        var headers = new List<(string, string)>
        {
            ("X-ForgeX-Internal-Token", InternalSecret),
            ("X-ForgeX-Tenant-Id", tenantId),
            ("X-ForgeX-Owner-Id", ownerId),
        };
        if (actorKeyId is not null)
        {
            headers.Add(("X-ForgeX-Actor-Key-Id", actorKeyId));
        }

        if (actorRole is not null)
        {
            headers.Add(("X-ForgeX-Actor-Role", actorRole));
        }

        return headers.ToArray();
    }

    public static string Tenant(char fill) => "tn_" + new string(fill, 32);

    public static string Owner(char fill) => "ow_" + new string(fill, 32);

    public async Task WriteArtifactAsync()
    {
        var report = new
        {
            schemaVersion = "1.0",
            generatedAtUtc = DateTimeOffset.UtcNow,
            legs = Legs,
            skipped = Skipped,
            result = "pass",
            passed = Passed,
            total = Checks.Count,
            checks = Checks,
        };
        var artifact = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "artifacts", "resource-authority-gate.json"));
        Directory.CreateDirectory(Path.GetDirectoryName(artifact)!);
        await File.WriteAllTextAsync(artifact, JsonSerializer.Serialize(report, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
        Console.WriteLine($"Resource authority gate PASS: {Passed}/{Checks.Count} (legs: {string.Join(",", Legs)}; skipped: {string.Join(",", Skipped)})");
        Console.WriteLine(artifact);
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var app in _apps)
        {
            try
            {
                await app.StopAsync();
                await app.DisposeAsync();
            }
            catch
            {
                // best effort teardown
            }
        }

        Http.Dispose();
        try
        {
            Directory.Delete(Root, recursive: true);
        }
        catch
        {
            // temp dir cleanup is best effort
        }
    }
}
