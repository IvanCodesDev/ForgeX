// Stage 3 渐进迁移边界：浏览器 Worker 复用现有几何切片和质量算法，
// React 组件只消费 DTO，不读取 FX* 全局，也不接触 layers/paths 大对象。
import "../../../js/util.js";
import "../../../js/machine-profile.js";
import "../../../js/profile-registry.js";
import "../../../js/slicer.js";
import "../../../js/models.js";
import "../../../js/sim.js";

const slicer = globalThis.FXSlicer;
const models = globalThis.FXModels;
const simulator = globalThis.FXSim;
const profiles = globalThis.FXProfiles;

if (!slicer || !models || !simulator || !profiles) {
  throw new Error("FORGE·X legacy quick simulator failed to initialize");
}

const FIXED_OVERHEAD_SECONDS = 95;

function materialForLegacy(material) {
  return {
    ...material,
    nozzleTemp: material.nozzleTemp ?? material.nozzle.default,
    nozzleRange: material.nozzleRange ?? [material.nozzle.min, material.nozzle.max],
    bedTemp: material.bedTemp ?? material.bed.default,
    bedMin: material.bedMin ?? material.bed.min,
  };
}

function round(value) {
  return Math.round(value * 1e9) / 1e9;
}

function findModel(modelId) {
  const model = models.createBuiltins().find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`未知内置模型：${modelId}`);
  return model;
}

export const legacyQuickSimulator = {
  simulate(input) {
    const previousMaterial = profiles.materials[input.material.id];
    // MATERIALS in sim.js retains this registry map by reference, so assigning the
    // validated snapshot also supports community materials inside the isolated Worker.
    profiles.materials[input.material.id] = materialForLegacy(input.material);
    try {
      const model = findModel(input.modelId);
      const started = globalThis.performance.now();
      const slice = slicer.slice(model, input.tf, input.settings);
      const quality = simulator.computeQuality(input.settings, model);
      const runtimeMs = globalThis.performance.now() - started;
      const filamentMassG = slice.stats.volumeCm3 * input.material.densityG;
      const materialCostCny = (filamentMassG * input.material.priceCnyKg) / 1000;
      const pathCount = slice.layers.reduce((total, layer) => total + layer.paths.length, 0);

      return {
        authority: {
          kind: "instant-preview",
          authoritative: false,
          label: "浏览器即时预览（非权威）",
        },
        engine: {
          name: "FXSlicer + FXSim.computeQuality",
          source: "legacy-js-adapter",
          version: "legacy-js-preview/1",
        },
        input: {
          modelId: input.modelId,
          machineProfile: { id: input.machine.id, source: input.machine.source },
          materialProfile: { id: input.material.id, source: input.material.source },
          settings: { ...input.settings },
          tf: { ...input.tf },
        },
        model: { id: model.id, name: model.name, dimensions: model.dims },
        profiles: { machineId: input.machine.id, materialId: input.material.id },
        summary: {
          totalLayers: slice.totalLayers,
          pathCount,
          heightMm: round(slice.height),
          extrusionLengthMm: round(slice.stats.extLenMm),
          travelLengthMm: round(slice.stats.travelMm),
          pathTimeSeconds: round(slice.stats.timeSec),
          fixedOverheadSeconds: FIXED_OVERHEAD_SECONDS,
          estimatedTimeSeconds: round(slice.stats.timeSec + FIXED_OVERHEAD_SECONDS),
          volumeCm3: round(slice.stats.volumeCm3),
          filamentLengthM: round(slice.stats.filamentM),
          filamentMassG: round(filamentMassG),
          materialCostCny: round(materialCostCny),
        },
        quality,
        evidence: [
          {
            code: "FIXED_PROCESS_OVERHEAD",
            value: FIXED_OVERHEAD_SECONDS,
            unit: "s",
            note: "沿用旧预览引擎的预热与调平固定开销口径。",
          },
        ],
        runtimeMs: round(runtimeMs),
        warnings: [
          {
            code: "SIMPLIFIED_MOTION_MODEL",
            message: "即时预览未模拟固件加速度、输入整形、压力提前或设备宏。",
          },
          {
            code: "BED_BOUNDS_NOT_ENFORCED",
            message: `本切片未执行平台越界裁剪；所选 Profile 包络为 ${input.machine.buildVolume.x} × ${input.machine.buildVolume.y} mm。`,
          },
          {
            code: "STATE_MACHINE_NOT_RUN",
            message: "自动调平、Z 偏移和机台物理特征保留在输入快照中，但不参与本次快速摘要。",
          },
        ],
      };
    } finally {
      if (previousMaterial === undefined) delete profiles.materials[input.material.id];
      else profiles.materials[input.material.id] = previousMaterial;
    }
  },
};
