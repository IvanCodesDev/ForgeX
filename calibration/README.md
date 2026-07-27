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
