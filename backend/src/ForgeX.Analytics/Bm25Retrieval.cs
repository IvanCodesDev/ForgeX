using System.Text;
using System.Text.RegularExpressions;

namespace ForgeX.Analytics;

public sealed record RetrievalDocument(string Id, string Name, string Text);

public sealed record RetrievalHit(string Name, string Text, double Score);

/// <summary>
/// server/services/retrieval.js 的移植：BM25 + 覆盖率加权的关键词检索，中文用字符 bigram。
/// 浮点运算顺序、排序稳定性、分词与分段的正则语义都按 JS 原样保留——
/// 知识检索端点返回的 score 在 Node/C# 双跑中要求逐位相等。
/// </summary>
public static class Bm25Retrieval
{
    public const double K1 = 1.5;
    public const double B = 0.75;
    public const double CoverageWeight = 2;
    public const double ScoreFloor = 0.35;
    public const int DefaultTopK = 4;
    public const int DefaultChunkLength = 400;

    // JS \s = WhiteSpace ∪ LineTerminator（与 .NET \s 的差异：不含 U+0085，含 U+FEFF）
    private const string JsWhiteSpace = @"[\t\n\v\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]";

    private static readonly Regex WordPattern = new("[a-z0-9][a-z0-9._-]*", RegexOptions.CultureInvariant);
    // 源码里的 [一-鿿㐀-䶿] 即 U+4E00–U+9FFF 与 U+3400–U+4DBF
    private static readonly Regex CjkPattern = new("[\u4E00-\u9FFF\u3400-\u4DBF]+", RegexOptions.CultureInvariant);
    private static readonly Regex ParagraphSplit = new("\n" + JsWhiteSpace + "*\n|\n(?=#)", RegexOptions.CultureInvariant);
    private static readonly Regex SentenceSplit = new("(?<=[。！？；;.!?])", RegexOptions.CultureInvariant);

    /// <summary>文本 → 词元：英文/数字按词，中文按 bigram（单字成段时保留单字）。</summary>
    public static IReadOnlyList<string> Tokenize(string? text)
    {
        var lower = ToLowerCaseJs(text ?? string.Empty);
        var tokens = new List<string>();
        foreach (Match word in WordPattern.Matches(lower))
        {
            tokens.Add(word.Value);
        }
        foreach (Match run in CjkPattern.Matches(lower))
        {
            var value = run.Value;
            if (value.Length == 1)
            {
                tokens.Add(value);
                continue;
            }
            for (var index = 0; index + 1 < value.Length; index++)
            {
                tokens.Add(value.Substring(index, 2));
            }
        }
        return tokens;
    }

    /// <summary>按空行/标题分段，过长的段再按句末标点累积切分。</summary>
    public static IReadOnlyList<string> Chunk(string? text, int maxLength = DefaultChunkLength)
    {
        var limit = maxLength <= 0 ? DefaultChunkLength : maxLength; // JS: maxLen || 400
        var chunks = new List<string>();
        foreach (var raw in ParagraphSplit.Split(text ?? string.Empty))
        {
            var paragraph = JsValue.Trim(raw);
            if (paragraph.Length == 0) continue;
            if (paragraph.Length <= limit)
            {
                chunks.Add(paragraph);
                continue;
            }

            var buffer = new StringBuilder();
            foreach (var sentence in SentenceSplit.Split(paragraph))
            {
                if (buffer.Length + sentence.Length > limit && buffer.Length > 0)
                {
                    chunks.Add(JsValue.Trim(buffer.ToString()));
                    buffer.Clear();
                }
                buffer.Append(sentence);
            }
            var tail = JsValue.Trim(buffer.ToString());
            if (tail.Length > 0) chunks.Add(tail);
        }
        return chunks;
    }

    /// <summary>
    /// 给定文档集与问题返回 top-k 片段，score 保留三位小数；无命中返回空数组。
    /// <paramref name="topK"/> 采用 JS <c>Array.prototype.slice(0, topK)</c> 语义（负数从尾部截去）。
    /// </summary>
    public static IReadOnlyList<RetrievalHit> Retrieve(
        IReadOnlyList<RetrievalDocument> docs,
        string? question,
        int topK = DefaultTopK,
        double minScore = ScoreFloor)
    {
        if (docs.Count == 0) return [];
        var index = BuildIndex(docs);
        if (index.Entries.Count == 0) return [];

        var queryTokens = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var token in Tokenize(question))
        {
            if (seen.Add(token)) queryTokens.Add(token);
        }
        if (queryTokens.Count == 0) return [];

        var scored = new List<(string Name, string Text, int Matched, double Score)>(index.Entries.Count);
        foreach (var entry in index.Entries)
        {
            double bm25 = 0;
            var matched = 0;
            foreach (var token in queryTokens)
            {
                if (!entry.TermFrequency.TryGetValue(token, out var frequency)) continue;
                matched++;
                var n = index.DocumentFrequency.TryGetValue(token, out var df) ? df : 0;
                var idf = Math.Log(1 + (index.Count - n + 0.5) / (n + 0.5));
                var norm = (frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * entry.Length) / (index.AverageLength == 0 ? 1 : index.AverageLength)));
                bm25 += idf * norm;
            }
            var coverage = (double)matched / queryTokens.Count;
            scored.Add((entry.Name, entry.Text, matched, matched > 0 ? bm25 + coverage * CoverageWeight : 0));
        }

        var hits = scored
            .Where(candidate => candidate.Matched > 0 && candidate.Score >= minScore)
            .OrderByDescending(candidate => candidate.Score)
            .ToList();
        var end = topK < 0 ? Math.Max(hits.Count + topK, 0) : Math.Min(topK, hits.Count);
        var result = new List<RetrievalHit>(end);
        for (var position = 0; position < end; position++)
        {
            var hit = hits[position];
            result.Add(new RetrievalHit(hit.Name, hit.Text, JsFormat.Round(hit.Score * 1000) / 1000));
        }
        return result;
    }

    /// <summary>
    /// JS String.prototype.toLowerCase：逐 UTF-16 单元简单映射，唯一影响词元的特殊映射是
    /// U+0130（İ → i + U+0307），SpecialCasing 里其余无条件映射不会产生 [a-z0-9] 或 CJK 字符。
    /// </summary>
    private static string ToLowerCaseJs(string text)
    {
        var builder = new StringBuilder(text.Length);
        foreach (var character in text)
        {
            if (character == '\u0130')
            {
                builder.Append('i').Append('\u0307');
            }
            else if (char.IsSurrogate(character))
            {
                builder.Append(character);
            }
            else
            {
                builder.Append(char.ToLowerInvariant(character));
            }
        }
        return builder.ToString();
    }

    private sealed record IndexEntry(string Name, string Text, Dictionary<string, int> TermFrequency, int Length);

    private sealed record Index(List<IndexEntry> Entries, double AverageLength, Dictionary<string, int> DocumentFrequency, int Count);

    private static Index BuildIndex(IReadOnlyList<RetrievalDocument> docs)
    {
        var entries = new List<IndexEntry>();
        foreach (var doc in docs)
        {
            foreach (var text in Chunk(doc.Text))
            {
                var tokens = Tokenize(text);
                var termFrequency = new Dictionary<string, int>(StringComparer.Ordinal);
                foreach (var token in tokens)
                {
                    termFrequency[token] = termFrequency.TryGetValue(token, out var current) ? current + 1 : 1;
                }
                entries.Add(new IndexEntry(doc.Name, text, termFrequency, tokens.Count));
            }
        }

        double averageLength = 0;
        if (entries.Count > 0)
        {
            double total = 0;
            foreach (var entry in entries) total += entry.Length;
            averageLength = total / entries.Count;
        }

        var documentFrequency = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var entry in entries)
        {
            foreach (var token in entry.TermFrequency.Keys)
            {
                documentFrequency[token] = documentFrequency.TryGetValue(token, out var current) ? current + 1 : 1;
            }
        }
        return new Index(entries, averageLength, documentFrequency, entries.Count);
    }
}
