using Npgsql;

namespace ForgeX.Infrastructure;

/// <summary>
/// 部署把同一个 <c>POSTGRES_URL</c> 同时喂给 Node（pg 接受 libpq URI）和 C#（Npgsql 只接受
/// <c>Keyword=Value;</c>）。这里把 <c>postgres://user:pass@host:port/db?sslmode=require</c> 归一化成
/// Npgsql 连接串；已经是 keyword 形式的原样返回。不认识的 URI 查询参数直接报错，而不是悄悄丢掉。
/// </summary>
public static class PostgresConnectionString
{
    public static string Normalize(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArgumentException("A PostgreSQL connection string is required.", nameof(value));
        }

        var trimmed = value.Trim();
        if (!IsLibpqUri(trimmed))
        {
            return trimmed;
        }

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
        {
            throw new ArgumentException("POSTGRES_URL is not a valid postgres:// URI.", nameof(value));
        }

        var builder = new NpgsqlConnectionStringBuilder();

        if (!string.IsNullOrEmpty(uri.Host))
        {
            builder.Host = uri.HostNameType == UriHostNameType.IPv6 ? uri.Host.Trim('[', ']') : uri.Host;
        }

        if (uri.Port > 0)
        {
            builder.Port = uri.Port;
        }

        if (!string.IsNullOrEmpty(uri.UserInfo))
        {
            var separator = uri.UserInfo.IndexOf(':');
            var user = separator < 0 ? uri.UserInfo : uri.UserInfo[..separator];
            builder.Username = Uri.UnescapeDataString(user);
            if (separator >= 0)
            {
                builder.Password = Uri.UnescapeDataString(uri.UserInfo[(separator + 1)..]);
            }
        }

        var database = uri.AbsolutePath.TrimStart('/');
        if (database.Length > 0)
        {
            builder.Database = Uri.UnescapeDataString(database);
        }

        foreach (var (key, parameter) in ParseQuery(uri.Query))
        {
            ApplyQueryParameter(builder, key, parameter);
        }

        return builder.ConnectionString;
    }

    public static bool IsLibpqUri(string value)
    {
        return value.StartsWith("postgres://", StringComparison.OrdinalIgnoreCase)
            || value.StartsWith("postgresql://", StringComparison.OrdinalIgnoreCase);
    }

    private static IEnumerable<(string Key, string Value)> ParseQuery(string query)
    {
        if (string.IsNullOrEmpty(query) || query == "?")
        {
            yield break;
        }

        foreach (var pair in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var separator = pair.IndexOf('=');
            var key = Uri.UnescapeDataString(separator < 0 ? pair : pair[..separator]);
            var parameter = separator < 0 ? "" : Uri.UnescapeDataString(pair[(separator + 1)..]);
            yield return (key.Trim().ToLowerInvariant(), parameter);
        }
    }

    private static void ApplyQueryParameter(NpgsqlConnectionStringBuilder builder, string key, string value)
    {
        switch (key)
        {
            case "sslmode":
                builder.SslMode = ParseSslMode(value);
                break;
            case "host":
            case "hostaddr":
                builder.Host = value;
                break;
            case "port":
                builder.Port = int.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
                break;
            case "user":
                builder.Username = value;
                break;
            case "password":
                builder.Password = value;
                break;
            case "dbname":
                builder.Database = value;
                break;
            case "application_name":
                builder.ApplicationName = value;
                break;
            case "connect_timeout":
                builder.Timeout = int.Parse(value, System.Globalization.CultureInfo.InvariantCulture);
                break;
            case "options":
                builder.Options = value;
                break;
            case "search_path":
                builder.SearchPath = value;
                break;
            case "sslrootcert":
                builder.RootCertificate = value;
                break;
            case "sslcert":
                builder.SslCertificate = value;
                break;
            case "sslkey":
                builder.SslKey = value;
                break;
            case "sslpassword":
                builder.SslPassword = value;
                break;
            default:
                throw new ArgumentException($"Unsupported PostgreSQL URI parameter \"{key}\"; use the Npgsql keyword form for anything beyond sslmode/application_name/connect_timeout/options/search_path/ssl* .");
        }
    }

    private static SslMode ParseSslMode(string value)
    {
        return value.Trim().ToLowerInvariant() switch
        {
            "disable" => SslMode.Disable,
            "allow" => SslMode.Allow,
            "prefer" => SslMode.Prefer,
            "require" => SslMode.Require,
            "verify-ca" => SslMode.VerifyCA,
            "verify-full" => SslMode.VerifyFull,
            _ => throw new ArgumentException($"Unsupported sslmode \"{value}\" in POSTGRES_URL."),
        };
    }
}
