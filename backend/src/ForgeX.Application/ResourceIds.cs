using System.Text.RegularExpressions;

namespace ForgeX.Application;

/// <summary>
/// 资源 id 的安全字符集：文件腿把 id 直接当文件名，PostgreSQL 腿的 CHECK 约束也只接受这个子集。
/// 不满足的 id 在端点层直接按「不存在」处理，永远不会触到存储。
/// </summary>
public static partial class ResourceIds
{
    public static bool IsSafe(string? id) =>
        !string.IsNullOrEmpty(id) && SafeIdPattern().IsMatch(id) && !id.Contains("..", StringComparison.Ordinal);

    [GeneratedRegex("^[A-Za-z0-9_.-]{1,96}$")]
    private static partial Regex SafeIdPattern();
}
