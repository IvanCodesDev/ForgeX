using System.Text;
using ForgeX.Domain;
using ForgeX.Simulation;

namespace ForgeX.ResourceGate;

internal static class GCodeUnitsSection
{
    public static async Task RunAsync(Gate gate)
    {
        gate.Section("gcode-units: inch normalization and unsupported extrusion modes");
        const string mm = "G21\nG90\nM82\nG92 X0 Y0 Z0 E0\nG1 X25.4 Z0.254 E2.54 F1524\nG91\nM83\nG1 X25.4 Y25.4 E2.54\nG92 X0 Y0 E0\nG90\nM82\nG1 X25.4 E2.54\n";
        const string inch = "G20\nG90\nM82\nG92 X0 Y0 Z0 E0\nG1 X1 Z0.01 E0.1 F60\nG91\nM83\nG1 X1 Y1 E0.1\nG92 X0 Y0 E0\nG90\nM82\nG1 X1 E0.1\n";
        async Task<GCodeAnalysisResult> Parse(string text) => await new StreamingGCodeAnalyzer().AnalyzeAsync(new MemoryStream(Encoding.UTF8.GetBytes(text)), new(), CancellationToken.None);
        var expected = await Parse(mm);
        var actual = await Parse(inch);
        gate.Check("units-statistics-equivalent", expected.Statistics == actual.Statistics);
        gate.Check("units-bounds-height-equivalent", expected.Bounds == actual.Bounds && expected.HeightMm == actual.HeightMm);
        gate.Check("units-layer-motion-equivalent", expected.Layers[0].TimeSeconds == actual.Layers[0].TimeSeconds && expected.Layers[0].FilamentLengthMm == actual.Layers[0].FilamentLengthMm);
        gate.Check("units-raw-file-still-bound", expected.Sha256 != actual.Sha256 && actual.Warnings.Any(w => w.Code == "GCODE_INCH_UNITS_NORMALIZED"));
        var mixed = await Parse("G20\nM83\nG1 X1 Z0.01 E0.1 F60\nG21\nG1 X50.8 E2.54\nG20\nG1 X3 E0.1\n");
        gate.Check("units-switch-preserves-feed", Math.Abs(mixed.Statistics.TimeSeconds - 3) < 1e-10);
        gate.Check("units-switch-preserves-extrusion", Math.Abs(mixed.Statistics.FilamentLengthM - 0.00762) < 1e-12);
        foreach (var command in new[] { "M200 D0", "M200 S0", "M200 S0 D1.75", "T0", "G21" })
            gate.Check("units-supported-" + command, (await Parse(command + "\n" + mm)).Statistics == expected.Statistics);
        foreach (var command in new[] { "M200 D1.75", "M200 S1", "M200 S1 D0", "M200", "T1", "T7", "G20\nG1 X1000000000000" })
        {
            try { await Parse(command + "\n" + mm); gate.Check("units-rejected-" + command, false); }
            catch (GCodeAnalysisException e) { gate.Check("units-rejected-" + command, e.Code is "GCODE_UNSUPPORTED_VOLUMETRIC_EXTRUSION" or "GCODE_UNSUPPORTED_TOOL" or "GCODE_NUMERIC_RANGE"); }
        }
    }
}
