/* FORGE·X — 无头仿真驱动（node 专用）

   仿真状态机本身不依赖 DOM/THREE，只依赖一个满足 FXPrinterBase 契约的对象。
   这里提供一个「桩打印机」——只保留 sim 真正消费的那部分接口——
   于是完整的物理仿真（温控惯性、床面误差场、调平补偿、机构负载、故障链）
   可以在 node 里批量运行。

   这是虚拟机群（tools/farm-sim.js）的技术基础，也是 tests/sim-calib.test.js
   驱动全流程状态机的方式。两处共用本模块，避免桩实现漂移。 */
"use strict";

const path = require("path");
const J = (p) => path.join(__dirname, "..", "js", p);

require(J("util.js"));
require(J("slicer.js"));
require(J("models.js"));
require(J("machine-profile.js"));
require(J("sim.js"));

const FXU = globalThis.FXU;
const FXSim = globalThis.FXSim;
const FXModels = globalThis.FXModels;

/**
 * 桩打印机：只实现 sim 会调用的方法。
 * MODEL_TAG 决定机台编号与机型结构属性（是否封闭腔体等），必须传真实机型标签。
 */
function makeStubPrinter(modelTag) {
  const tag = modelTag || "FX-256";
  return {
    ID: tag,
    MODEL_NAME: tag,
    MODEL_TAG: tag,
    KIN_TAG: "headless",
    NOZZLE_Y: 200,
    bedTopY: 0,
    nozzleHotFrac: 0,
    bedHotFrac: 0,
    fanFrac: 0,
    extrudeRate: 0,
    setBedTopY(y) {
      this.bedTopY = y;
    },
    setHeadXY() {},
    setStateLED() {},
    setSpoolFrac() {},
    setFilamentColor() {},
    attachPart() {},
    updatePartTf() {},
    showGhost() {},
    showPart() {},
    beginLayer() {},
    endLayer() {},
    setLayerProgress() {},
    setGrownHeight() {},
    clearPart() {},
    hideSlicePreview() {},
    showSlicePreview() {},
  };
}

/**
 * 构造一台无头仿真机。
 * @param {object} opt
 *   opt.modelTag      机型标签，如 "FX-256" / "FX-220" / "FX-Δ260" / "FX-500"
 *   opt.instance      实例号（同机型的第几台），决定该机台的固有物理特征
 *   opt.profileOverride  仅测试用：强制指定物理特征
 *   opt.captureLog    是否收集日志行
 */
function createHeadlessSim(opt) {
  opt = opt || {};
  const printer = makeStubPrinter(opt.modelTag);
  const fx = {
    printer,
    swapPrinter(tag) {
      this.printer = makeStubPrinter(tag);
      return this.printer;
    },
  };
  const bus = new FXU.EventBus();
  const sim = new FXSim(fx, bus);
  sim.setMachineInstance(opt.instance || 1, opt.profileOverride || null);

  const logs = [];
  if (opt.captureLog) bus.on("log", (d) => logs.push(d));

  return { sim, bus, printer, logs };
}

/**
 * 跑完一整单打印，返回结果。**不做任何概率抽样**——
 * 成败完全由机台固有特征 + 本单工艺参数经物理演化决定。
 *
 * @param {object} o
 *   o.sim / o.bus         createHeadlessSim 的产物
 *   o.model               模型对象（FXModels.createBuiltins() 之一）
 *   o.settings            要覆盖的工艺参数
 *   o.tf                  摆放变换
 *   o.maxSteps            安全上限，防死循环
 * @returns {{status, fault, scrap, elapsedSec, usedG, telemetry, quality, layers}}
 */
function runJob(o) {
  const sim = o.sim;
  const bus = o.bus;
  const maxSteps = o.maxSteps || 400000;

  let record = null;
  const off = bus.on("job-record", (d) => {
    if (!record) record = d;
  });

  Object.assign(sim.settings, o.settings || {});
  if (o.tf) sim.tf = Object.assign({ scale: 1, rotZ: 0, offX: 0, offY: 0 }, o.tf);
  sim.setModel(o.model, !o.tf);

  sim.start();

  // dt 固定 0.25s，simMult 由 settings 决定；用机时而非墙钟时间推进
  let steps = 0;
  let tel = null;
  while (!record && steps++ < maxSteps) {
    sim.tick(0.25, 0);
    // 故障发生即中止本单（真实产线：无人值守时故障单直接报废）
    if (sim.state === "fault") {
      // 先扣下遥测快照：sim.stop() 会清空 _telemetry（中止无成品，不产出实测质量报告），
      // 但故障单的负载峰值恰恰是最有分析价值的物理证据，不能跟着一起丢。
      tel = sim._telemetry;
      sim.stop(); // stop() 会为未排除的故障发出 job-record(fail)
      break;
    }
  }
  if (typeof off === "function") off();

  if (!tel) tel = sim._telemetry;
  const out = {
    status: record ? record.status : "fail",
    fault: record ? record.fault : "未知",
    scrap: record ? record.scrap || null : null,
    timedOut: steps >= maxSteps,
    elapsedSec: sim.machineElapsed,
    usedG: sim.usedG - (tel ? tel.usedG0 : 0),
    layers: sim.slice ? sim.slice.totalLayers : 0,
    telemetry: tel,
    quality: sim.lastQuality,
    machineId: sim.machineId,
  };
  if (out.timedOut) out.fault = "仿真步数超限";
  return out;
}

/** 复位一台机器，准备跑下一单（保留机台固有特征与调平状态） */
function resetForNextJob(sim, opt) {
  opt = opt || {};
  if (sim.state !== "idle") sim.stop();
  if (opt.newSpool) {
    sim.usedG = 0;
    sim.usedLenMm = 0;
  }
  sim.faultInfo = null;
  sim.nozzleT.heaterBroken = false;
  sim._clogT = 0;
  sim._slipT = 0;
  sim._thermalT = 0;
  sim._lastNozzleNow = null;
  sim._nozzleRate = 0;
}

module.exports = {
  FXU,
  FXSim,
  FXModels,
  FXMachineProfile: globalThis.FXMachineProfile,
  FXInsightData: null, // 由调用方按需加载（避免无谓的模块耦合）
  makeStubPrinter,
  createHeadlessSim,
  runJob,
  resetForNextJob,
};
