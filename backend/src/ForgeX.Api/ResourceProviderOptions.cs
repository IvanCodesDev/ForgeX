namespace ForgeX.Api;

/// <summary>Resolved <c>{Section}:Provider</c> / <c>{Section}:PostgresUrl</c> pair for one resource family.</summary>
internal sealed record ResourceProvider(string Name, string PostgresUrl)
{
    public bool Enabled => Name != "disabled";

    public bool IsFile => Name == "file";

    public bool IsPostgres => Name == "postgres";
}

/// <summary>
/// Stage 8.6a：资源存储提供者的统一读法。每个资源族（Shares / Datasources / Knowledge / Calibrations）
/// 都遵守同一条规则：默认 <c>disabled</c>（不注册端点，行为与迁移前完全一致）；
/// <c>file</c> 走 Storage:Root 下的单进程文件存储；<c>postgres</c> 复用 Node 侧同一张表与 RLS 策略，
/// 连接串取 <c>{Section}:PostgresUrl</c>，缺省回退环境变量 <c>POSTGRES_URL</c>。
/// </summary>
internal static class ResourceProviderOptions
{
    public static ResourceProvider Read(IConfiguration configuration, string section)
    {
        var name = (configuration[$"{section}:Provider"] ?? "disabled").Trim().ToLowerInvariant();
        if (name is not ("disabled" or "file" or "postgres"))
        {
            throw new InvalidOperationException($"{section}:Provider must be 'disabled', 'file' or 'postgres'.");
        }

        var postgresUrl = configuration[$"{section}:PostgresUrl"]
            ?? Environment.GetEnvironmentVariable("POSTGRES_URL")
            ?? string.Empty;
        if (name == "postgres" && string.IsNullOrWhiteSpace(postgresUrl))
        {
            throw new InvalidOperationException($"{section}:PostgresUrl (or POSTGRES_URL) is required when {section}:Provider=postgres.");
        }

        return new ResourceProvider(name, postgresUrl);
    }
}
