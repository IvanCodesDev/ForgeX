using System.Reflection;

namespace ForgeX.Api;

internal static class OpenApiDocument
{
    private const string ResourceName = "ForgeX.Api.openapi.v1.json";
    private static readonly Lazy<string> CachedJson = new(LoadJson, LazyThreadSafetyMode.ExecutionAndPublication);

    public static string Json => CachedJson.Value;

    private static string LoadJson()
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var stream = assembly.GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Embedded OpenAPI resource is missing: {ResourceName}");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }
}
