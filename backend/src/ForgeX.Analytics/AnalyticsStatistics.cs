namespace ForgeX.Analytics;

public static class AnalyticsStatistics
{
    public const int DefaultMinSample = 5;
    public const double DefaultAlpha = 0.05;

    private static readonly double[] Lanczos =
    [
        0.99999999999980993,
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7,
    ];

    public static RateInterval Wilson(int k, int n, double confidence = 0.95)
    {
        if (n <= 0) return new RateInterval(0, 0, 1, 0, 0, 1);
        var z = ZFor(confidence);
        var p = (double)k / n;
        var z2 = z * z;
        var denominator = 1 + z2 / n;
        var center = (p + z2 / (2 * n)) / denominator;
        var margin = z / denominator * Math.Sqrt(p * (1 - p) / n + z2 / (4 * n * n));
        var lo = Math.Max(0, center - margin);
        var hi = Math.Min(1, center + margin);
        return new RateInterval(p, lo, hi, n, k, hi - lo);
    }

    public static FisherResult FisherExact(int a, int b, int c, int d)
    {
        var n = a + b + c + d;
        if (n <= 0) return new FisherResult(1, null, a, b, c, d, 0);

        var row1 = a + b;
        var row2 = c + d;
        var column1 = a + c;
        var denominator = LnChoose(n, column1);
        var observed = Math.Exp(LnChoose(row1, a) + LnChoose(row2, c) - denominator);
        var lo = Math.Max(0, column1 - row2);
        var hi = Math.Min(row1, column1);
        var pValue = 0d;
        const double epsilon = 1e-7;
        for (var value = lo; value <= hi; value++)
        {
            var probability = Math.Exp(
                LnChoose(row1, value) + LnChoose(row2, column1 - value) - denominator);
            if (probability <= observed * (1 + epsilon)) pValue += probability;
        }

        var oddsRatio = b * c == 0 || a * d == 0
            ? (a + 0.5) * (d + 0.5) / ((b + 0.5) * (c + 0.5))
            : (double)(a * d) / (b * c);
        return new FisherResult(Math.Min(1, pValue), oddsRatio, a, b, c, d, n);
    }

    public static RateComparison CompareRates(
        int kA,
        int nA,
        int kB,
        int nB,
        int minSample = DefaultMinSample,
        double alpha = DefaultAlpha)
    {
        var left = Wilson(kA, nA);
        var right = Wilson(kB, nB);
        var fisher = FisherExact(kA, nA - kA, kB, nB - kB);
        var enough = nA >= minSample && nB >= minSample;
        return new RateComparison(
            left,
            right,
            left.P - right.P,
            fisher.PValue,
            fisher.OddsRatio,
            enough && fisher.PValue < alpha,
            enough);
    }

    public static RateRanking RankByRate(
        IReadOnlyList<RateGroup> groups,
        int minSample = DefaultMinSample,
        double alpha = DefaultAlpha)
    {
        var totalK = groups.Sum(static group => group.K);
        var totalN = groups.Sum(static group => group.N);
        var ranked = new List<(RankedRate Value, int Index)>();
        var skipped = new List<SkippedRate>();

        for (var index = 0; index < groups.Count; index++)
        {
            var group = groups[index];
            var ci = Wilson(group.K, group.N);
            if (group.N < minSample)
            {
                skipped.Add(new SkippedRate(
                    group.Key,
                    group.K,
                    group.N,
                    ci,
                    $"样本量 {group.N} < {minSample}"));
                continue;
            }

            var restK = totalK - group.K;
            var restN = totalN - group.N;
            var fisher = restN > 0
                ? FisherExact(group.K, group.N - group.K, restK, restN - restK)
                : new FisherResult(1, null, 0, 0, 0, 0, 0);
            ranked.Add((new RankedRate(
                group.Key,
                group.K,
                group.N,
                ci.P,
                ci,
                new RateVsRest(restK, restN, restN > 0 ? (double)restK / restN : 0),
                fisher.PValue,
                fisher.OddsRatio,
                restN >= minSample && fisher.PValue < alpha), index));
        }

        var ordered = ranked
            .OrderByDescending(static item => item.Value.Rate)
            .ThenByDescending(static item => item.Value.N)
            .ThenBy(static item => item.Index)
            .Select(static item => item.Value)
            .ToArray();
        var worst = ordered.Length > 0 && ordered[0].Significant ? ordered[0] : null;
        return new RateRanking(
            ordered,
            skipped,
            worst,
            minSample,
            alpha,
            new FleetRate(totalK, totalN, totalN > 0 ? (double)totalK / totalN : 0));
    }

    private static double ZFor(double confidence)
    {
        if (confidence >= 0.99) return 2.5758293035489004;
        if (confidence >= 0.98) return 2.3263478740408408;
        if (confidence >= 0.95) return 1.959963984540054;
        if (confidence >= 0.9) return 1.6448536269514722;
        return 1.959963984540054;
    }

    private static double LnGamma(double value)
    {
        if (value < 0.5)
        {
            return Math.Log(Math.PI / Math.Sin(Math.PI * value)) - LnGamma(1 - value);
        }
        value -= 1;
        var accumulator = Lanczos[0];
        var term = value + 7.5;
        for (var index = 1; index < Lanczos.Length; index++)
        {
            accumulator += Lanczos[index] / (value + index);
        }
        return 0.5 * Math.Log(2 * Math.PI) + (value + 0.5) * Math.Log(term) - term + Math.Log(accumulator);
    }

    private static double LnChoose(int n, int k)
    {
        if (k < 0 || k > n) return double.NegativeInfinity;
        return LnGamma(n + 1) - LnGamma(k + 1) - LnGamma(n - k + 1);
    }
}
