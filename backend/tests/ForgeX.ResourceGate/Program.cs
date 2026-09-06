// Stage 8.6a resource authority gate（数据源 / 知识库 / 校准治理 / shares 的 C# 权威腿）。
//
// 分段：
//   parity          —— JsJson / DatasetProvenanceSanitizer / Bm25Retrieval 与 Node 生成的夹具逐条对比
//                      （fixtures/resource-parity.json 由 tools/generate-resource-parity-fixtures.js 生成）
//   connection-string —— libpq URI（Node pg 的 POSTGRES_URL）归一化为 Npgsql keyword 形式，无库也跑
//   file-collection —— JsonFileCollection / JsonFileDocument 语义
//   shares-file     —— IShareRepository 的 file 腿（真 Kestrel + 同一套边界中间件 + 端点）
//   datasources / knowledge / calibration —— file 腿；有 POSTGRES_URL 时再跑 postgres 腿
//   sweeper         —— ResourceSweeper 与 /metrics gauge
// 产物：backend/artifacts/resource-authority-gate.json（legs / skipped 记录哪些腿真的跑过）。
using ForgeX.ResourceGate;

await using var gate = new Gate();
try
{
    ParitySection.Run(gate);
    ConnectionStringSection.Run(gate);
    await FileCollectionSection.RunAsync(gate);
    await SharesSection.RunAsync(gate);
    await DatasourcesSection.RunAsync(gate);
    await KnowledgeSection.RunAsync(gate);
    await CalibrationSection.RunAsync(gate);
    await SweeperSection.RunAsync(gate);
    await gate.WriteArtifactAsync();
}
catch (Exception exception)
{
    Console.Error.WriteLine($"Resource authority gate FAIL after {gate.Passed} checks: {exception.Message}");
    return 1;
}

return 0;
