using System.Buffers;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using ForgeX.Application;
using ForgeX.Domain;

namespace ForgeX.Simulation;

/// <summary>
/// Deterministic G-code analyzer that hashes raw bytes and decodes/processes them incrementally.
/// The caller retains ownership of the input stream; seek support is not required.
/// </summary>
public sealed partial class StreamingGCodeAnalyzer : IGCodeAnalyzer
{
    public const string EngineVersion = "1.2.0";

    private const int ReadBufferSize = 64 * 1024;
    private static readonly Encoding StrictUtf8 = new UTF8Encoding(
        encoderShouldEmitUTF8Identifier: false,
        throwOnInvalidBytes: true);

    public async Task<GCodeAnalysisResult> AnalyzeAsync(
        Stream gcode,
        GCodeAnalysisOptions options,
        CancellationToken ct)
    {
        if (gcode is null)
        {
            throw new GCodeAnalysisException("GCODE_NULL_STREAM", "G-code stream is required.");
        }

        if (!gcode.CanRead)
        {
            throw new GCodeAnalysisException("GCODE_STREAM_NOT_READABLE", "G-code stream must be readable.");
        }

        if (options is null)
        {
            throw new GCodeAnalysisException("GCODE_NULL_OPTIONS", "G-code analysis options are required.");
        }

        ValidateOptions(options);
        ct.ThrowIfCancellationRequested();

        var parser = new ParserState(options);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var decoder = StrictUtf8.GetDecoder();
        var byteBuffer = ArrayPool<byte>.Shared.Rent(ReadBufferSize);
        var charBuffer = ArrayPool<char>.Shared.Rent(StrictUtf8.GetMaxCharCount(ReadBufferSize));
        long bytesRead = 0;

        try
        {
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                var count = await gcode
                    .ReadAsync(byteBuffer.AsMemory(0, ReadBufferSize), ct)
                    .ConfigureAwait(false);
                if (count == 0)
                {
                    break;
                }

                if (bytesRead > options.MaxBytes - count)
                {
                    throw new GCodeAnalysisException(
                        "GCODE_MAX_BYTES_EXCEEDED",
                        FormattableString.Invariant($"G-code exceeds the configured {options.MaxBytes}-byte limit."));
                }

                bytesRead += count;
                hash.AppendData(byteBuffer, 0, count);

                int charsDecoded;
                try
                {
                    charsDecoded = decoder.GetChars(
                        byteBuffer.AsSpan(0, count),
                        charBuffer.AsSpan(),
                        flush: false);
                }
                catch (DecoderFallbackException ex)
                {
                    throw InvalidUtf8(ex);
                }

                parser.Consume(charBuffer.AsSpan(0, charsDecoded), ct);
            }

            try
            {
                var finalChars = decoder.GetChars(
                    [],
                    charBuffer.AsSpan(),
                    flush: true);
                parser.Consume(charBuffer.AsSpan(0, finalChars), ct);
            }
            catch (DecoderFallbackException ex)
            {
                throw InvalidUtf8(ex);
            }

            ct.ThrowIfCancellationRequested();
            var sha256 = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
            return parser.Finish(sha256, bytesRead, ct);
        }
        catch (GCodeAnalysisException)
        {
            throw;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (IOException ex)
        {
            throw new GCodeAnalysisException(
                "GCODE_STREAM_READ_FAILED",
                "The G-code stream could not be read.",
                ex);
        }
        catch (ObjectDisposedException ex)
        {
            throw new GCodeAnalysisException(
                "GCODE_STREAM_READ_FAILED",
                "The G-code stream was closed while it was being read.",
                ex);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(byteBuffer, clearArray: true);
            ArrayPool<char>.Shared.Return(charBuffer, clearArray: true);
        }
    }

    private static GCodeAnalysisException InvalidUtf8(DecoderFallbackException ex) =>
        new("GCODE_INVALID_UTF8", "G-code must contain strictly valid UTF-8.", ex);

    private static void ValidateOptions(GCodeAnalysisOptions options)
    {
        if (!double.IsFinite(options.BedSizeMm) || options.BedSizeMm <= 0d)
        {
            InvalidOption(nameof(options.BedSizeMm));
        }

        if (!Enum.IsDefined(options.CoordinateOrigin))
        {
            InvalidOption(nameof(options.CoordinateOrigin));
        }

        if (!double.IsFinite(options.MaterialDensityGPerCm3) || options.MaterialDensityGPerCm3 <= 0d)
        {
            InvalidOption(nameof(options.MaterialDensityGPerCm3));
        }

        if (options.MaxBytes <= 0)
        {
            InvalidOption(nameof(options.MaxBytes));
        }

        if (options.MaxLines <= 0)
        {
            InvalidOption(nameof(options.MaxLines));
        }

        if (options.MaxLineLength <= 0)
        {
            InvalidOption(nameof(options.MaxLineLength));
        }

        if (options.MaxLayers is <= 0 or > 100_000)
        {
            InvalidOption(nameof(options.MaxLayers));
        }

        if (!IsValidProfileId(options.MachineProfileId))
        {
            InvalidOption(nameof(options.MachineProfileId));
        }

        if (!IsValidProfileId(options.MaterialProfileId))
        {
            InvalidOption(nameof(options.MaterialProfileId));
        }
    }

    private static bool IsValidProfileId(string value) =>
        !string.IsNullOrWhiteSpace(value) &&
        value.Length <= 80 &&
        char.IsAsciiLetterOrDigit(value[0]) &&
        value.All(static character =>
            char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-');

    private static void InvalidOption(string name) =>
        throw new GCodeAnalysisException(
            "GCODE_INVALID_OPTIONS",
            FormattableString.Invariant($"Invalid G-code analysis option: {name}."));

    private sealed class ParserState
    {
        private const double EpsilonE = 1e-9;
        private const double EpsilonDistance = 1e-6;
        private const double FilamentArea175 = Math.PI * 0.875d * 0.875d;

        private readonly GCodeAnalysisOptions _options;
        private readonly double _halfBed;
        private readonly double _offset;
        private readonly StringBuilder _line = new();
        private readonly List<MutableLayer> _layers = [];
        private readonly Dictionary<string, string> _claims = new(StringComparer.Ordinal);
        private readonly List<GCodeWarning> _warnings = [];

        private bool _absoluteXyz = true;
        private bool _absoluteE = true;
        private double _x;
        private double _y;
        private double _z;
        private double _e;
        private double _feed = 1200d;
        private bool _homed;

        private MutableLayer? _currentLayer;
        private bool _pathOpen;
        private string _currentPathType = "infill";
        private string? _openPathType;
        private string? _pendingType;

        private double _totalExtrusionMm;
        private double _totalTravelMm;
        private double _totalTimeSeconds;
        private double _totalFilamentMm;
        private double _minX = double.PositiveInfinity;
        private double _maxX = double.NegativeInfinity;
        private double _minY = double.PositiveInfinity;
        private double _maxY = double.NegativeInfinity;
        private long _arcCount;
        private bool _lastWasCarriageReturn;
        private bool _atStart = true;
        private long _lineCount = 1;
        private bool _finished;

        public ParserState(GCodeAnalysisOptions options)
        {
            _options = options;
            _halfBed = options.BedSizeMm / 2d;
            _offset = options.CoordinateOrigin == CoordinateOrigin.Center ? 0d : _halfBed;
        }

        public void Consume(ReadOnlySpan<char> chars, CancellationToken ct)
        {
            if (_finished)
            {
                throw new InvalidOperationException("The G-code parser has already finished.");
            }

            for (var index = 0; index < chars.Length; index++)
            {
                if ((index & 0x0fff) == 0)
                {
                    ct.ThrowIfCancellationRequested();
                }

                var value = chars[index];
                if (_atStart)
                {
                    _atStart = false;
                    if (value == '\ufeff')
                    {
                        continue;
                    }
                }

                if (value == '\r')
                {
                    EmitLine();
                    _lastWasCarriageReturn = true;
                    continue;
                }

                if (value == '\n')
                {
                    if (_lastWasCarriageReturn)
                    {
                        _lastWasCarriageReturn = false;
                    }
                    else
                    {
                        EmitLine();
                    }

                    continue;
                }

                _lastWasCarriageReturn = false;
                if (_line.Length >= _options.MaxLineLength)
                {
                    throw new GCodeAnalysisException(
                        "GCODE_MAX_LINE_LENGTH_EXCEEDED",
                        FormattableString.Invariant(
                            $"G-code line {_lineCount} exceeds the configured {_options.MaxLineLength}-character limit."));
                }

                _line.Append(value);
            }
        }

        public GCodeAnalysisResult Finish(string sha256, long bytesRead, CancellationToken ct)
        {
            if (_finished)
            {
                throw new InvalidOperationException("The G-code parser has already finished.");
            }

            _finished = true;
            ct.ThrowIfCancellationRequested();
            ProcessLine(_line.ToString());
            _line.Clear();
            ClosePath();

            if (_layers.Count == 0)
            {
                throw new GCodeAnalysisException(
                    "GCODE_NO_EXTRUSION_PATH",
                    "No extrusion path was found; the input is not a supported FDM G-code job.");
            }

            _layers.Sort(static (left, right) => left.ZMm.CompareTo(right.ZMm));
            if (!_homed)
            {
                _warnings.Add(new GCodeWarning(
                    "GCODE_NO_HOME",
                    "No G28 homing command was found; coordinates might not be absolute machine coordinates."));
            }

            if (_arcCount > 0)
            {
                _warnings.Add(new GCodeWarning(
                    "GCODE_ARC_LINEARIZED",
                    FormattableString.Invariant(
                        $"{_arcCount} G2/G3 arc command(s) were approximated by endpoint chords.")));
            }

            var centeredMinX = _minX - _offset;
            var centeredMaxX = _maxX - _offset;
            var centeredMinY = _minY - _offset;
            var centeredMaxY = _maxY - _offset;
            if (centeredMinX < -_halfBed || centeredMaxX > _halfBed ||
                centeredMinY < -_halfBed || centeredMaxY > _halfBed)
            {
                _warnings.Add(new GCodeWarning(
                    "GCODE_BOUNDS_EXCEEDED",
                    FormattableString.Invariant(
                        $"Extrusion bounds exceed the configured {_options.BedSizeMm} mm print bed.")));
            }

            if (_layers.Count < 2)
            {
                _warnings.Add(new GCodeWarning(
                    "GCODE_SINGLE_LAYER",
                    "Only one extrusion layer was found; verify that the file is complete."));
            }

            var netFilamentMm = Math.Max(0d, _totalFilamentMm);
            var volumeMm3 = netFilamentMm * FilamentArea175;
            var aggregateTypes = new Dictionary<string, long>(StringComparer.Ordinal);
            var layerResults = new List<GCodeLayerSummary>(_layers.Count);
            for (var index = 0; index < _layers.Count; index++)
            {
                ct.ThrowIfCancellationRequested();
                var layer = _layers[index];
                foreach (var entry in layer.PathTypeCounts)
                {
                    aggregateTypes[entry.Key] = aggregateTypes.GetValueOrDefault(entry.Key) + entry.Value;
                }

                layerResults.Add(new GCodeLayerSummary(
                    Index: index,
                    ZMm: layer.ZMm,
                    PathCount: layer.PathCount,
                    ExtrusionLengthMm: layer.ExtrusionLengthMm,
                    TravelLengthMm: layer.TravelLengthMm,
                    TimeSeconds: layer.TimeSeconds,
                    FilamentLengthMm: layer.FilamentLengthMm,
                    PathTypeCounts: GCodeReadOnly.Dictionary(layer.PathTypeCounts)));
            }

            return new GCodeAnalysisResult(
                Sha256: sha256,
                EngineVersion: StreamingGCodeAnalyzer.EngineVersion,
                Source: "gcode-import",
                Profile: GCodeProfileSummary.Create(_options),
                CoordinateOrigin: _options.CoordinateOrigin,
                BytesRead: bytesRead,
                LinesRead: _lineCount,
                TotalLayers: layerResults.Count,
                HeightMm: _layers[^1].ZMm,
                Bounds: new GCodeBounds(centeredMinX, centeredMaxX, centeredMinY, centeredMaxY),
                Statistics: new GCodeStatistics(
                    ExtrusionLengthMm: _totalExtrusionMm,
                    TravelLengthMm: _totalTravelMm,
                    TimeSeconds: _totalTimeSeconds,
                    VolumeCm3: volumeMm3 / 1000d,
                    FilamentLengthM: netFilamentMm / 1000d,
                    FilamentMassG: (volumeMm3 / 1000d) * _options.MaterialDensityGPerCm3),
                Claims: GCodeReadOnly.Dictionary(_claims),
                PathTypeCounts: GCodeReadOnly.Dictionary(aggregateTypes),
                Layers: GCodeReadOnly.List(layerResults),
                Warnings: GCodeReadOnly.List(_warnings));
        }

        private void EmitLine()
        {
            ProcessLine(_line.ToString());
            _line.Clear();
            _lineCount++;
            if (_lineCount > _options.MaxLines)
            {
                throw new GCodeAnalysisException(
                    "GCODE_MAX_LINES_EXCEEDED",
                    FormattableString.Invariant(
                        $"G-code exceeds the configured {_options.MaxLines}-line limit."));
            }
        }

        private void ProcessLine(string raw)
        {
            if (raw.Length == 0)
            {
                return;
            }

            var line = raw.Trim();
            if (line.Length == 0)
            {
                return;
            }

            if (line[0] == ';')
            {
                ReadClaims(line);
                var type = TypeCommentRegex().Match(line);
                if (type.Success)
                {
                    _pendingType = MapType(type.Groups[1].Value);
                }

                return;
            }

            var semicolon = line.IndexOf(';', StringComparison.Ordinal);
            if (semicolon >= 0)
            {
                var inlineComment = line[semicolon..];
                var type = TypeCommentRegex().Match(inlineComment);
                if (type.Success)
                {
                    _pendingType = MapType(type.Groups[1].Value);
                }

                line = line[..semicolon].Trim();
                if (line.Length == 0)
                {
                    return;
                }
            }

            if (TryReadCommand(line, 'G', out var gCode))
            {
                ProcessGCode(gCode, line);
                return;
            }

            if (TryReadCommand(line, 'M', out var mCode))
            {
                ProcessMCode(mCode, line);
            }
        }

        private void ProcessGCode(int code, string line)
        {
            switch (code)
            {
                case 90:
                    _absoluteXyz = true;
                    return;
                case 91:
                    _absoluteXyz = false;
                    return;
                case 92:
                    SetPosition(line);
                    return;
                case 28:
                    _homed = true;
                    _x = 0d;
                    _y = 0d;
                    _z = 0d;
                    ClosePath();
                    return;
                case 2:
                case 3:
                    _arcCount++;
                    break;
                case 0:
                case 1:
                    break;
                default:
                    return;
            }

            var nextX = ReadWord(line, 'X');
            var nextY = ReadWord(line, 'Y');
            var nextZ = ReadWord(line, 'Z');
            var nextE = ReadWord(line, 'E');
            var nextFeed = ReadWord(line, 'F');
            if (nextFeed is > 0d)
            {
                _feed = nextFeed.Value;
            }

            var previousX = _x;
            var previousY = _y;
            if (nextX.HasValue)
            {
                _x = _absoluteXyz ? nextX.Value : _x + nextX.Value;
            }

            if (nextY.HasValue)
            {
                _y = _absoluteXyz ? nextY.Value : _y + nextY.Value;
            }

            if (nextZ.HasValue)
            {
                _z = _absoluteXyz ? nextZ.Value : _z + nextZ.Value;
            }

            var extrusionDelta = 0d;
            if (nextE.HasValue)
            {
                extrusionDelta = _absoluteE ? nextE.Value - _e : nextE.Value;
                _e = _absoluteE ? nextE.Value : _e + nextE.Value;
            }

            var distance = Hypotenuse(_x - previousX, _y - previousY);
            var speed = _feed / 60d;
            if (speed <= 0d)
            {
                speed = 20d;
            }

            _totalFilamentMm += extrusionDelta;
            if (extrusionDelta > EpsilonE && distance > EpsilonDistance)
            {
                if (_currentLayer is null || Math.Abs(_currentLayer.ZMm - _z) > EpsilonDistance)
                {
                    StartLayer(_z);
                }

                var pathType = _pendingType ?? _currentPathType;
                if (!_pathOpen || !StringComparer.Ordinal.Equals(_openPathType, pathType))
                {
                    ClosePath();
                    _currentPathType = pathType;
                    _openPathType = pathType;
                    _pathOpen = true;
                }

                _totalExtrusionMm += distance;
                _totalTimeSeconds += distance / speed;
                _currentLayer!.ExtrusionLengthMm += distance;
                _currentLayer.TimeSeconds += distance / speed;
                _currentLayer.FilamentLengthMm += extrusionDelta;

                UpdateBounds(previousX, previousY);
                UpdateBounds(_x, _y);
            }
            else
            {
                ClosePath();
                if (distance > EpsilonDistance)
                {
                    _totalTravelMm += distance;
                    _totalTimeSeconds += distance / speed;
                    if (_currentLayer is not null)
                    {
                        _currentLayer.TravelLengthMm += distance;
                        _currentLayer.TimeSeconds += distance / speed;
                    }
                }
            }
        }

        private void ProcessMCode(int code, string line)
        {
            switch (code)
            {
                case 82:
                    _absoluteE = true;
                    break;
                case 83:
                    _absoluteE = false;
                    break;
                case 104:
                case 109:
                    SetNumericClaimOnce("nozzleTemp", ReadWord(line, 'S'));
                    break;
                case 140:
                case 190:
                    SetNumericClaimOnce("bedTemp", ReadWord(line, 'S'));
                    break;
            }
        }

        private void SetPosition(string line)
        {
            var value = ReadWord(line, 'E');
            if (value.HasValue)
            {
                _e = value.Value;
            }

            value = ReadWord(line, 'X');
            if (value.HasValue)
            {
                _x = value.Value;
            }

            value = ReadWord(line, 'Y');
            if (value.HasValue)
            {
                _y = value.Value;
            }

            value = ReadWord(line, 'Z');
            if (value.HasValue)
            {
                _z = value.Value;
            }
        }

        private void StartLayer(double zMm)
        {
            ClosePath();
            if (_layers.Count >= _options.MaxLayers)
            {
                throw new GCodeAnalysisException(
                    "GCODE_MAX_LAYERS_EXCEEDED",
                    FormattableString.Invariant(
                        $"G-code exceeds the configured {_options.MaxLayers}-layer limit."));
            }

            _currentLayer = new MutableLayer(zMm);
            _layers.Add(_currentLayer);
        }

        private void ClosePath()
        {
            if (!_pathOpen || _currentLayer is null || _openPathType is null)
            {
                _pathOpen = false;
                _openPathType = null;
                return;
            }

            _currentLayer.PathCount++;
            _currentLayer.PathTypeCounts[_openPathType] =
                _currentLayer.PathTypeCounts.GetValueOrDefault(_openPathType) + 1L;
            _pathOpen = false;
            _openPathType = null;
        }

        private void UpdateBounds(double x, double y)
        {
            _minX = Math.Min(_minX, x);
            _maxX = Math.Max(_maxX, x);
            _minY = Math.Min(_minY, y);
            _maxY = Math.Max(_maxY, y);
        }

        private void ReadClaims(string line)
        {
            Match match;
            if (!_claims.ContainsKey("timeSec"))
            {
                match = TimeClaimRegex().Match(line);
                if (TryReadClaimNumber(match, 1, out var timeSeconds))
                {
                    SetNumber("timeSec", timeSeconds);
                    return;
                }

                match = DurationClaimRegex().Match(line);
                if (match.Success)
                {
                    var seconds = ClaimPart(match, 1) * 86_400d +
                                  ClaimPart(match, 2) * 3_600d +
                                  ClaimPart(match, 3) * 60d +
                                  ClaimPart(match, 4);
                    if (seconds > 0d)
                    {
                        SetNumber("timeSec", seconds);
                        return;
                    }
                }
            }

            if (!_claims.ContainsKey("filamentMm"))
            {
                match = FilamentMetresClaimRegex().Match(line);
                if (TryReadClaimNumber(match, 1, out var filamentMetres))
                {
                    SetNumber("filamentMm", filamentMetres * 1000d);
                    return;
                }

                match = FilamentMillimetresClaimRegex().Match(line);
                if (TryReadClaimNumber(match, 1, out var filamentMillimetres))
                {
                    SetNumber("filamentMm", filamentMillimetres);
                    return;
                }
            }

            if (!_claims.ContainsKey("filamentG"))
            {
                match = FilamentGramsClaimRegex().Match(line);
                if (TryReadClaimNumber(match, 1, out var filamentGrams))
                {
                    SetNumber("filamentG", filamentGrams);
                    return;
                }
            }

            if (!_claims.ContainsKey("layerHeightMm"))
            {
                match = LayerHeightClaimRegex().Match(line);
                if (TryReadClaimNumber(match, 1, out var layerHeight))
                {
                    SetNumber("layerHeightMm", layerHeight);
                    return;
                }
            }

            if (!_claims.ContainsKey("firmware"))
            {
                match = FirmwareClaimRegex().Match(line);
                if (match.Success)
                {
                    SetText("firmware", match.Groups[1].Value);
                    return;
                }
            }

            if (!_claims.ContainsKey("slicer"))
            {
                match = GeneratedByClaimRegex().Match(line);
                if (match.Success)
                {
                    SetText("slicer", match.Groups[1].Value);
                    return;
                }

                match = SlicerNameClaimRegex().Match(line);
                if (match.Success)
                {
                    SetText("slicer", match.Groups[1].Value);
                }
            }
        }

        private void SetNumericClaimOnce(string key, double? value)
        {
            if (value.HasValue && !_claims.ContainsKey(key))
            {
                SetNumber(key, value.Value);
            }
        }

        private void SetNumber(string key, double value) =>
            _claims[key] = value.ToString("R", CultureInfo.InvariantCulture);

        private void SetText(string key, string value)
        {
            var trimmed = value.Trim();
            _claims[key] = trimmed.Length <= 60 ? trimmed : trimmed[..60];
        }

        private static double ClaimPart(Match match, int groupIndex) =>
            double.TryParse(
                match.Groups[groupIndex].Value,
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out var value)
                ? value
                : 0d;

        private static bool TryReadClaimNumber(Match match, int groupIndex, out double value)
        {
            value = 0d;
            return match.Success &&
                   double.TryParse(
                       match.Groups[groupIndex].Value,
                       NumberStyles.Float,
                       CultureInfo.InvariantCulture,
                       out value) &&
                   double.IsFinite(value);
        }

        private static string MapType(string raw)
        {
            var value = raw.Trim();
            if (OuterPerimeterTypeRegex().IsMatch(value) || InnerPerimeterTypeRegex().IsMatch(value))
            {
                return "perimeter";
            }

            if (SolidTypeRegex().IsMatch(value))
            {
                return "solid";
            }

            if (SupportTypeRegex().IsMatch(value))
            {
                return "support";
            }

            if (SkirtTypeRegex().IsMatch(value))
            {
                return "skirt";
            }

            return "infill";
        }

        private static bool TryReadCommand(string line, char prefix, out int code)
        {
            code = 0;
            if (line.Length < 2 || char.ToUpperInvariant(line[0]) != prefix)
            {
                return false;
            }

            var end = 1;
            while (end < line.Length && char.IsAsciiDigit(line[end]))
            {
                end++;
            }

            return end > 1 && int.TryParse(
                line.AsSpan(1, end - 1),
                NumberStyles.None,
                CultureInfo.InvariantCulture,
                out code);
        }

        private static double? ReadWord(string line, char letter)
        {
            var searchFrom = 0;
            while (searchFrom < line.Length)
            {
                var relative = line.AsSpan(searchFrom).IndexOf(letter);
                if (relative < 0)
                {
                    return null;
                }

                var index = searchFrom + relative;
                if (index == 0 || line[index - 1] is ' ' or '\t')
                {
                    var number = line.AsSpan(index + 1);
                    var length = NumericPrefixLength(number);
                    if (length > 0 && double.TryParse(
                            number[..length],
                            NumberStyles.Float,
                            CultureInfo.InvariantCulture,
                            out var value) &&
                        double.IsFinite(value))
                    {
                        return value;
                    }
                }

                searchFrom = index + 1;
            }

            return null;
        }

        private static int NumericPrefixLength(ReadOnlySpan<char> value)
        {
            var index = 0;
            if (index < value.Length && value[index] is '+' or '-')
            {
                index++;
            }

            var integerStart = index;
            while (index < value.Length && char.IsAsciiDigit(value[index]))
            {
                index++;
            }

            var hasDigits = index > integerStart;
            if (index < value.Length && value[index] == '.')
            {
                index++;
                var fractionStart = index;
                while (index < value.Length && char.IsAsciiDigit(value[index]))
                {
                    index++;
                }

                hasDigits |= index > fractionStart;
            }

            if (!hasDigits)
            {
                return 0;
            }

            if (index < value.Length && value[index] is 'e' or 'E')
            {
                var exponentMarker = index++;
                if (index < value.Length && value[index] is '+' or '-')
                {
                    index++;
                }

                var exponentStart = index;
                while (index < value.Length && char.IsAsciiDigit(value[index]))
                {
                    index++;
                }

                if (index == exponentStart)
                {
                    index = exponentMarker;
                }
            }

            return index;
        }

        private static double Hypotenuse(double x, double y)
        {
            var absoluteX = Math.Abs(x);
            var absoluteY = Math.Abs(y);
            var maximum = Math.Max(absoluteX, absoluteY);
            if (maximum == 0d)
            {
                return 0d;
            }

            var scaledX = absoluteX / maximum;
            var scaledY = absoluteY / maximum;
            return maximum * Math.Sqrt((scaledX * scaledX) + (scaledY * scaledY));
        }

        private sealed class MutableLayer(double zMm)
        {
            public double ZMm { get; } = zMm;
            public long PathCount { get; set; }
            public double ExtrusionLengthMm { get; set; }
            public double TravelLengthMm { get; set; }
            public double TimeSeconds { get; set; }
            public double FilamentLengthMm { get; set; }
            public Dictionary<string, long> PathTypeCounts { get; } = new(StringComparer.Ordinal);
        }
    }

    [GeneratedRegex(@"^;\s*TYPE\s*:\s*(.+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TypeCommentRegex();

    [GeneratedRegex(@"^;\s*TIME\s*:\s*([\d.]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex TimeClaimRegex();

    [GeneratedRegex(@"^;\s*estimated printing time.*?=\s*(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DurationClaimRegex();

    [GeneratedRegex(@"^;\s*Filament\s+used\s*:\s*([\d.]+)m", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FilamentMetresClaimRegex();

    [GeneratedRegex(@"^;\s*filament\s+used\s*\[mm\]\s*=\s*([\d.]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FilamentMillimetresClaimRegex();

    [GeneratedRegex(@"^;\s*filament\s+used\s*\[g\]\s*=\s*([\d.]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FilamentGramsClaimRegex();

    [GeneratedRegex(@"^;\s*(?:Layer height|layer_height)\s*[:=]\s*([\d.]+)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex LayerHeightClaimRegex();

    [GeneratedRegex(@"^;\s*FLAVOR\s*:\s*(.+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FirmwareClaimRegex();

    [GeneratedRegex(@"^;\s*(?:generated by|Generated with)\s+(.+)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex GeneratedByClaimRegex();

    [GeneratedRegex(@"^;\s*(Cura_SteamEngine|PrusaSlicer|OrcaSlicer|SuperSlicer|Simplify3D)[^\n]*", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SlicerNameClaimRegex();

    [GeneratedRegex(@"wall-outer|external perimeter|outer wall", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex OuterPerimeterTypeRegex();

    [GeneratedRegex(@"wall-inner|^perimeter|inner wall|overhang perimeter", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex InnerPerimeterTypeRegex();

    [GeneratedRegex(@"skin|solid infill|top solid|bottom surface|top surface", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SolidTypeRegex();

    [GeneratedRegex("support", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SupportTypeRegex();

    [GeneratedRegex("skirt|brim", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SkirtTypeRegex();
}
