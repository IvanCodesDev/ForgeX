using ForgeX.Infrastructure;
using Npgsql;

namespace ForgeX.ResourceGate;

/// <summary>
/// POSTGRES_URL 在 Node（pg）和 C#（Npgsql）之间必须同义：libpq URI 归一化成 Npgsql keyword 形式。
/// 这一节不需要数据库，file 腿也跑，保证 CI 的 postgres service 连接串在两侧都能被接受。
/// </summary>
internal static class ConnectionStringSection
{
    public static void Run(Gate gate)
    {
        gate.Section("connection string: libpq URI -> Npgsql keyword form");

        var ci = new NpgsqlConnectionStringBuilder(PostgresConnectionString.Normalize("postgres://forgex:forgex@localhost:5432/forgex"));
        gate.Check("connstr-uri-host", ci.Host == "localhost", ci.Host);
        gate.Check("connstr-uri-port", ci.Port == 5432, ci.Port.ToString());
        gate.Check("connstr-uri-username", ci.Username == "forgex", ci.Username);
        gate.Check("connstr-uri-password", ci.Password == "forgex", ci.Password);
        gate.Check("connstr-uri-database", ci.Database == "forgex", ci.Database);

        var encoded = new NpgsqlConnectionStringBuilder(PostgresConnectionString.Normalize(
            "postgresql://app%40svc:p%40ss%2Fw0rd@db.internal/forgex_prod?sslmode=require&application_name=forgex-web&connect_timeout=7"));
        gate.Check("connstr-uri-percent-username", encoded.Username == "app@svc", encoded.Username);
        gate.Check("connstr-uri-percent-password", encoded.Password == "p@ss/w0rd", encoded.Password);
        gate.Check("connstr-uri-default-port", encoded.Port == 5432, encoded.Port.ToString());
        gate.Check("connstr-uri-database-underscore", encoded.Database == "forgex_prod", encoded.Database);
        gate.Check("connstr-uri-sslmode", encoded.SslMode == SslMode.Require, encoded.SslMode.ToString());
        gate.Check("connstr-uri-application-name", encoded.ApplicationName == "forgex-web", encoded.ApplicationName);
        gate.Check("connstr-uri-connect-timeout", encoded.Timeout == 7, encoded.Timeout.ToString());

        var verifyFull = new NpgsqlConnectionStringBuilder(PostgresConnectionString.Normalize("postgres://u@[::1]:6543/d?sslmode=verify-full"));
        gate.Check("connstr-uri-ipv6-host", verifyFull.Host == "::1", verifyFull.Host);
        gate.Check("connstr-uri-ipv6-port", verifyFull.Port == 6543, verifyFull.Port.ToString());
        gate.Check("connstr-uri-no-password", string.IsNullOrEmpty(verifyFull.Password), verifyFull.Password ?? "<null>");
        gate.Check("connstr-uri-sslmode-verify-full", verifyFull.SslMode == SslMode.VerifyFull, verifyFull.SslMode.ToString());

        const string keyword = "Host=127.0.0.1;Port=5433;Username=forgex;Password=s3cret;Database=forgex";
        gate.Check("connstr-keyword-passthrough", PostgresConnectionString.Normalize($"  {keyword} ") == keyword, PostgresConnectionString.Normalize(keyword));

        gate.Check("connstr-unknown-parameter-rejected",
            Throws<ArgumentException>(() => PostgresConnectionString.Normalize("postgres://forgex@localhost/forgex?channel_binding=require")),
            "channel_binding");
        gate.Check("connstr-bad-sslmode-rejected",
            Throws<ArgumentException>(() => PostgresConnectionString.Normalize("postgres://forgex@localhost/forgex?sslmode=maybe")),
            "sslmode=maybe");
        gate.Check("connstr-blank-rejected", Throws<ArgumentException>(() => PostgresConnectionString.Normalize("   ")), "blank");

        gate.Check("connstr-session-accepts-uri", SessionAcceptsUri("postgres://forgex:forgex@localhost:5432/forgex"), "constructed without opening a connection");
    }

    private static bool SessionAcceptsUri(string url)
    {
        try
        {
            var session = new PostgresSession(url);
            session.DisposeAsync().AsTask().GetAwaiter().GetResult();
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static bool Throws<T>(Action action) where T : Exception
    {
        try
        {
            action();
            return false;
        }
        catch (T)
        {
            return true;
        }
    }
}
