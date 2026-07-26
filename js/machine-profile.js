/* FORGE·X — 机台固有物理特征（纯逻辑，node 可测；不得引用 DOM 或 THREE）

   这个模块存在的理由：让故障**从物理过程中涌现**，而不是概率抽样出来。

   旧的合成数据生成器是这么造故障的：
       machineFailBase = { "FX-256-03": 0.2, ... }   // 直接写死某台机故障率 20%
       failed = rnd() < pFail;
   于是「分析引擎发现 03 号机故障率高」这件事毫无信息量——它只是把生成参数读了回来。

   这里换一条路：每台机器有一组**确定性的固有物理特征**（磨损、加热器健康度、
   料架阻力、环境温度…），仿真过程按这些特征真实演化，
   故障是「热端积碳 + 低温 + 高流量 → 挤出负载超限」这条因果链的结果。
   同一台机器的特征稳定（像真实设备一样），但故障发生在哪一单、哪一层，
   取决于那一单的材料、层高、速度、模型——这才是值得分析的数据。

   契约：profile 完全由 machineId 决定（确定性），因此数据集可复现。 */
(function (root) {
  "use strict";

  var P = {};

  /** 机型 → 结构性属性（不是随机的，由机型决定） */
  P.MODEL_TRAITS = {
    "FX-256": { enclosed: true, buildMm: 256, label: "CoreXY 封闭式" },
    "FX-220": { enclosed: false, buildMm: 220, label: "i3 龙门 开放式" },
    "FX-Δ260": { enclosed: false, buildMm: 260, label: "Delta 并联臂" },
    "FX-500": { enclosed: true, buildMm: 500, label: "工业大幅面龙门" },
  };
  P.DEFAULT_TRAITS = { enclosed: false, buildMm: 256, label: "未知机型" };

  /** 从机台编号里取出机型标签，如 "FX-256-03" → "FX-256" */
  P.modelTagOf = function (machineId) {
    var s = String(machineId || "");
    var m = s.match(/^(.*)-\d+$/);
    return m ? m[1] : s;
  };

  function hashSeed(str) {
    var seed = 0x9e3779b9;
    var s = String(str);
    for (var i = 0; i < s.length; i++) {
      seed = Math.imul(seed ^ s.charCodeAt(i), 0x01000193) >>> 0;
    }
    return seed >>> 0;
  }

  var cache = {};

  /**
   * 机台固有物理特征。同一个 machineId 永远返回同一组值——
   * 这是「设备有个性」的建模方式，也是数据集可复现的前提。
   *
   * 各字段的物理含义与影响路径：
   *   hotendFouling  热端积碳/内壁粗糙度 0..1 → 挤出阻力↑ → 堵料
   *   feederGrip     送料齿轮咬合力 1..0.6  → 咬合不足 → 打滑 → 断料
   *   spoolDrag      料架转动阻力 0..1     → 抽料力↑   → 断料
   *   heaterHealth   加热器有效功率 0.7..1 → 高温材料够不到目标 → 热失控保护
   *   heaterTauMul   热时间常数倍率        → 升温慢、抗扰动差
   *   beltWear       皮带磨损 0..1         → 尺寸精度（不直接致故障）
   *   ambientC       环境温度              → 翘边
   *   draft          环境风扰 0..1         → 翘边
   */
  P.of = function (machineId, overrides) {
    var id = String(machineId || "UNKNOWN-01");
    if (!overrides && cache[id]) return cache[id];

    var tag = P.modelTagOf(id);
    var traits = P.MODEL_TRAITS[tag] || P.DEFAULT_TRAITS;
    var seed = hashSeed(id);
    var rnd = FXU.mulberry32(seed);

    // 每台机器抽一次「出厂 + 使用史」，之后终身不变
    var prof = {
      id: id,
      modelTag: tag,
      seed: seed,
      enclosed: traits.enclosed,
      buildMm: traits.buildMm,

      hotendFouling: round3(Math.pow(rnd(), 1.7)), // 偏向健康，少数机器积碳重
      feederGrip: round3(1 - Math.pow(rnd(), 2) * 0.4), // 0.6..1
      spoolDrag: round3(Math.pow(rnd(), 1.5)),
      // 0.80..1.00 → 稳态上限约 245..300°C：
      // PLA(210)/TPU(225) 全机群都跑得动，PETG(240) 少数机器吃力，ABS(255) 只有健康机器能稳住。
      // 于是「某台机跑 ABS 老是热失控」成为一个真实可发现的规律，而不是抽样结果。
      heaterHealth: round3(0.8 + rnd() * 0.2),
      beltWear: round3(rnd()),

      // 封闭腔体温度更高更稳；开放式受车间环境影响大
      ambientC: round1(traits.enclosed ? 30 + rnd() * 8 : 18 + rnd() * 8),
      draft: round3(traits.enclosed ? rnd() * 0.25 : 0.25 + rnd() * 0.75),
    };
    prof.heaterTauMul = round3(1 + (1 - prof.heaterHealth) * 2.2);

    if (overrides) {
      for (var k in overrides) prof[k] = overrides[k];
      return prof; // 覆盖版本不入缓存，避免污染
    }
    cache[id] = prof;
    return prof;
  };

  /** 清空缓存（测试用） */
  P.resetCache = function () {
    cache = {};
  };

  function round3(v) {
    return Math.round(v * 1000) / 1000;
  }
  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  /* ══ 故障机理模型 ══════════════════════════════════
     每个函数返回一个无量纲的「负载/风险」值，1.0 = 该机制的报警阈值。
     所有输入都是仿真过程中真实存在的量，没有任何概率抽样。 */

  /**
   * 热端挤出阻力。返回值 1.0 = 报警阈值，持续超过即判堵料。
   *
   * 标定原则（重要）：**磨损本身不制造故障，它只让机器易感**。
   * 一台积碳严重的机器在合适的温度与流量下应当能正常跑完；
   * 只有当它再叠加「温度不足」或「流量过大」时才越线——
   * 而同样的工况在干净机器上仍然安全。这个差异正是数据分析要发现的东西。
   *
   *   基线    0.30（干净）… 0.60（重度积碳）
   *   温度项  低于材料推荐温度每 10°C 显著抬升（堵料头号原因）
   *   流量项  超过材料舒适体积流量后抬升（熔不透）
   *   累积项  挤出里程越长，积碳影响越明显（长活更容易堵）
   */
  P.hotendLoad = function (prof, s) {
    var base = 0.3 + prof.hotendFouling * 0.3;

    var tempDef = Math.max(0, s.nozzleTarget - s.nozzleNow); // 够不到设定值
    var below = Math.max(0, s.materialNominalC - s.nozzleNow); // 设定值本身就偏低
    var tempFactor = 1 + Math.pow(Math.max(tempDef, below) / 10, 1.6) * 0.42;

    var flowRatio = s.flowMm3s / Math.max(1e-6, s.materialFlowMm3s);
    var flowFactor = 1 + Math.max(0, flowRatio - 1) * 0.85;

    var progressive = 1 + (s.extrudedMm3 / 250000) * prof.hotendFouling;

    return base * tempFactor * flowFactor * progressive;
  };

  /**
   * 送料侧打滑风险。返回值 1.0 = 报警阈值，持续超过即判断料。
   *
   * 与堵料同一套标定逻辑：咬合力弱 / 料架阻力大的机器基线更高，
   * 但要真正打滑还需要叠加高流量需求，或料盘将空（卷径变小、弯折阻力剧增）。
   */
  P.feedSlipRisk = function (prof, s) {
    var base = 0.3 + (1 - prof.feederGrip) * 0.9 + prof.spoolDrag * 0.35;

    var flowRatio = s.flowMm3s / Math.max(1e-6, s.materialFlowMm3s);
    var demand = 1 + Math.max(0, flowRatio - 0.6) * 0.5;

    // 料盘越空，料卷半径越小、弯折半径越小，抽料阻力越大（真实现象）
    var nearEmpty = 1 + Math.max(0, 1 - s.spoolRemainFrac / 0.15) * 0.6;

    return base * demand * nearEmpty;
  };

  /**
   * 加热器能达到的稳态上限。健康度低的加热器够不到高温材料的目标温度，
   * 持续偏差会被既有的热失控监测器发现——这就是「热失控」的涌现路径。
   */
  P.heaterCeilingC = function (prof, ambientC) {
    var amb = ambientC == null ? 26 : ambientC;
    return amb + (300 - amb) * prof.heaterHealth;
  };

  /**
   * 翘边风险（打印结束时评估，>1 判为翘边报废）。
   * 真实成因：床温不足、环境冷/有风、材料收缩率高、大平面、首层不均。
   */
  P.warpRisk = function (prof, s) {
    var bedDef = Math.max(0, s.bedMinC - s.bedNow); // 床温低于材料下限多少度
    // 指数放缓：床温差 12°C 时约为 1.0，差 35°C 时约为 4——判废结论不变，
    // 但风险指数落在可读区间，报告里给出的数字才有比较意义。
    var bedTerm = Math.pow(bedDef / 12, 1.35);

    // 环境：开放式机器 + 低室温 + 有风，对高收缩材料是致命组合
    var coldness = Math.max(0, 28 - prof.ambientC) / 20;
    var envTerm = (coldness + prof.draft * 0.7) * s.shrinkage * (prof.enclosed ? 0.45 : 1);

    // 大平面翘得厉害：用首层面积的等效半径衡量
    var sizeTerm = Math.min(1.4, Math.sqrt(Math.max(0, s.firstLayerAreaMm2) / 3600));

    // 首层不均 → 附着面积不足
    var adhesion = Math.min(1.2, s.firstLayerUnevenMm / 0.18);

    // 高风扇对 ABS 是雪上加霜，对 PLA 无害
    var fanTerm = s.fanFrac * s.shrinkage * 0.55;

    var risk = (bedTerm + envTerm * 1.25 + fanTerm) * (0.55 + sizeTerm * 0.45) * (1 + adhesion * 0.35);
    return Math.min(risk, 5); // 封顶：超过这个量级只是「必然翘边」的不同说法，无需继续放大
  };

  /**
   * 悬垂塌陷风险（打印结束时评估，>1 判为塌陷报废）。
   * 无支撑的大悬垂是确定性失败；有支撑时看冷却是否跟得上。
   */
  P.overhangRisk = function (prof, s) {
    if (!s.needSupport) return 0;
    if (!s.supportEnabled) return 2.0; // 需要支撑却不开 → 必然塌陷，不是概率问题
    // 有支撑：冷却不足 + 层高大 + 速度快 → 桥接段下垂
    var cooling = Math.max(0, 0.75 - s.fanFrac) * 1.6;
    var layerTerm = Math.max(0, s.layerHeightMm - 0.2) * 2.2;
    var speedTerm = Math.max(0, s.speedMmS / 200 - 0.6) * 0.8;
    return cooling + layerTerm + speedTerm;
  };

  /** 材料收缩倾向（翘边模型输入）。数量级参考各材料典型收缩率。 */
  P.SHRINKAGE = { PLA: 0.25, PETG: 0.45, ABS: 1.0, TPU: 0.35 };
  /** 各材料的「舒适体积流量」上限（mm³/s），超过即熔不透 */
  P.FLOW_MM3S = { PLA: 11, PETG: 9, ABS: 10, TPU: 3.5 };

  root.FXMachineProfile = P;
})(typeof window !== "undefined" ? window : globalThis);
