# FORGE·X 视频演示素材

本目录是录屏专用素材包。所有数据均为可复现的合成演示内容，不代表真实设备、真实客户或真实产线。

## 推荐使用顺序

1. `profile/02-demo-profile.json`：导入社区机器与材料 Profile。
2. `assets/01-turbine-relief.png`：生成浮雕或剪影 3D 模型。
3. 调整工艺参数，展示不同切片路径。
4. 执行平台校准并启动仿真打印，打开实时监控。
5. `replay/03-demo-turbine.gcode`：导入 G-code，展示逐层复盘与对账。
6. `replay/04-demo-machine-log.json`：追加对应任务日志。
7. `calibration/05-demo-calibration.json`：展示校准包格式与合成模型准入保护。
8. `insight/06-demo-production.csv`：上传 72 条任务记录并运行自然语言分析。
9. `knowledge/07-demo-knowledge.md`：云端 AI provider 可用时复制到知识库入口。
10. 按 `DEMO-SCRIPT.zh-CN.md` 完成整段录制。

## 真实性边界

- 图片、Profile、CSV、日志和校准包均为录屏生成素材。
- G-code 的路径、E 增量、层数与自报统计会被应用实际解析。
- 对应日志通过 `gcodeSha256` 绑定该 G-code，但日志数值仍是合成示例。
- 校准包故意使用 `synthetic-conformance + demonstration-only`，用于展示系统不会把合成模型自动当作生产校准。
