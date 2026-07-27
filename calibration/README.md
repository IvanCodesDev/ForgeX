# 校准包 / Calibration bundles

校准包是带版本、带作用域的声明式 JSON 时间模型，不执行任何代码。

能够被自动选择的模型必须：

- provenance 为 `real-anonymized` 或 `real-consented`；
- 状态为 `active`；
- 精确声明 `machineId`、固件和可选材料作用域；
- 至少保留五个 holdout 任务；
- holdout MAPE 与中位偏差都不超过模型声明的阈值。

`synthetic-conformance` bundle 只能是 `demonstration-only`。它可以用于检查格式，
但注册表不会把它自动应用到用户任务。

浏览器把已导入 bundle 和每模型最多 50 条后续观测保存到 localStorage。达到最小观测数后，
中位绝对误差与中位偏差会形成 `stable`、`warning` 或 `drift`；已漂移模型会停止后续自动匹配。

生命周期：真实观测先进入 holdout → 在浏览器外训练 `candidate` → 以至少五个未参与训练的
任务评估 → 通过阈值后提升为 `active` → 用更高 bundle revision 发布 → 持续监测后续任务。
固件或材料发生变化时，应建立新作用域，不应静默覆盖历史。

仓库内的 [`example-bundle.json`](./example-bundle.json) 来自 P6 合成兼容性夹具，只演示格式，
不具备生产匹配资格。

## P8 服务端审核发布

服务模式提供以下接口：

- `GET /api/calibrations`：公开读取已经批准的 active bundle；
- `POST /api/calibrations/submissions`：使用 API Key 提交全部为 `candidate` 的 bundle；
- `GET /api/calibrations/submissions`：使用 API Key 查看候选与审计记录；
- `POST /api/calibrations/:id/revisions/:revision/review`：使用另一把 API Key
  提交 `{ "decision": "approve|reject", "reason": "..." }`。

写接口在未配置 `API_KEYS` 时返回 503。批准遵守四眼原则，提交者不能自批；服务端会重新执行
P7 active 准入校验，而不是采信客户端的状态。审核状态、内容摘要和当前发布版本原子写入
`DATA_DIR/calibrations.json`。这套机制提供可追溯复核，但不会自动验证数据权利或匿名化是否真实，
审核人仍需检查外部证据。

## English

Calibration bundles are versioned, declarative JSON packages for scoped print
time models. They contain data only and cannot execute code.

An automatically selectable model must:

- use `real-anonymized` or `real-consented` provenance;
- have `status: "active"`;
- target an exact `machineId` and firmware, with an optional material scope;
- include at least five holdout jobs;
- keep holdout MAPE and median bias within its declared thresholds.

Bundles marked `synthetic-conformance` are restricted to
`demonstration-only`. They can be inspected, but the registry never
automatically applies them to user jobs.

The browser stores imported bundles and up to 50 later observations per model
in local storage. Once the minimum observation count is reached, robust median
absolute error and median bias drive `stable`, `warning`, or `drift`. A drifted
model remains visible for diagnosis and should be retired or retrained; future
automatic selection will be blocked by the UI lifecycle.

## Lifecycle

1. Import new real observations as holdout.
2. Fit a `candidate` outside the browser and preserve the training-set SHA-256.
3. Evaluate at least five untouched holdout jobs.
4. Promote to `active` only if the declared thresholds pass.
5. Import the higher bundle `revision`.
6. Monitor later paired jobs for drift; firmware or material changes should
   usually create a new scope rather than silently replacing history.

The bundled [`example-bundle.json`](./example-bundle.json) is derived from P6
synthetic compatibility fixtures. It demonstrates the format and is not
eligible for production matching.

## P8 server review and distribution

`GET /api/calibrations` publicly serves approved active bundles. Candidate
submission, review-queue access, and approve/reject actions require configured
API keys. Approval follows a four-eyes rule: the submitting key cannot approve
its own bundle. The server promotes candidates to active only after re-running
the P7 provenance and holdout gates, then atomically persists the release and
audit events in `DATA_DIR/calibrations.json`.
