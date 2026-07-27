# FORGE·X Insight — 90 秒演示

配套自动录制脚本：`node tools/record-demo.js`。默认生成
`doc/assets/forgex-p5-demo.webm`；录屏无配音，下面的讲解词可直接用于字幕或旁白。

## 分镜与讲解词

| 时间     | 画面                                          | 讲解词                                                                 |
| -------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| 00–08 秒 | 3D 机台总览，切换相机视角                     | FORGE·X 把切片、设备仿真、任务复盘与生产分析放进同一个浏览器工作流。   |
| 08–20 秒 | 导入一份真实 G-code，出现层数、耗材和时间摘要 | 导入真实切片器输出后，系统解析每一条挤出路径和真实 E 增量。            |
| 20–32 秒 | 拖动逐层预览，2D 面板与 3D 视口同步           | 任意层都能在二维和三维中同步检查，路径类型、速度和坐标保持同源。       |
| 32–44 秒 | 展示切片器声明与本地重算的差异                | 切片器自报值和本地重算并列；差异会解释口径，但不武断判断谁对谁错。     |
| 44–56 秒 | 导入真机日志，出现计划/实测对比               | 再接入 JSON 或 CSV 真机日志，就能比较实际时长、耗材和完成层数。        |
| 56–68 秒 | 导入社区 Profile，切换新机器与材料            | 机器和材料用声明式 Profile 扩展，带 schema、来源与安全范围校验。       |
| 68–80 秒 | 启动回放，展示温度、调平、路径生长和实时监控  | 同一份 G-code 直接进入预热、调平和逐层回放，过程遥测继续进入质量评估。 |
| 80–90 秒 | 打开智造洞察，展示 KPI、统计证据和机群定位    | 从单条路径到机群结论，数据来源、统计证据和产品边界都保留在报告里。     |

## English voice-over

| Time      | Voice-over                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------- |
| 00–08 sec | FORGE·X brings slicing, machine simulation, job review, and production analytics into one browser flow. |
| 08–20 sec | Import real slicer G-code to recover every extrusion path and its actual E increment.                   |
| 20–32 sec | Inspect any layer in synchronized 2D and 3D views using the same toolpath data.                         |
| 32–44 sec | Slicer claims and local recalculation stay side by side, with differences explained rather than hidden. |
| 44–56 sec | Add a JSON or CSV machine log to compare planned and actual time, material, and completed layers.       |
| 56–68 sec | Declarative machine and material profiles extend the simulator through schemas and bounded validation.  |
| 68–80 sec | Replay the same G-code through preheat, leveling, deposition, telemetry, and quality assessment.        |
| 80–90 sec | From one path to fleet insight, provenance and statistical evidence remain attached to every result.    |

## 录制前检查

```bash
npm test
npm run test:e2e
node tools/record-demo.js
```

录屏只展示当前代码能走通的入口。它不应出现“控制真机”“精确预测打印时长”或“自动证明数据真实”
等超出实现边界的文案。
