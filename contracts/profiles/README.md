# FORGE·X Profile 生态

Profile bundle 用一份声明式 JSON 扩展机器与材料参数。浏览器在「模型」面板中直接导入，
通过校验后写入本地存储；没有脚本求值，也不会加载远程代码。

## 快速开始

1. 复制 [`example-bundle.json`](./example-bundle.json)；
2. 按 [`profile-bundle.schema.json`](./profile-bundle.schema.json) 修改参数与来源；
3. 运行 `node tools/validate-ecosystem.js`；
4. 在 FORGE·X 的「机器 / 材料 Profile」中导入。

机器 Profile 只允许复用已实现的 `corexy`、`i3`、`delta`、`gantry` 运动学基座。
构建空间和物理参数会进入仿真，但 3D 外观仍使用对应基座机型，不宣称是目标设备的精确 CAD。

材料参数会参与温控、体积流量、耗材克重、收缩和速度约束；`priceCnyKg` 会进入生产成本
分析口径。`source` 必填；示例值不是打印建议或有效报价，贡献者应链接或描述制造商数据表、
采购/实测方法与适用批次。

## 安全与兼容

- 社区 Profile 不能覆盖内置 ID；
- 未知字段、未知运动学和越界数值会被拒绝；
- bundle 版本目前固定为 `1`；
- 导入只影响当前浏览器本地数据，可清除站点存储恢复。

提交贡献时，请同时说明测试机型、材料批次、参数来源和验证范围。不要提交含个人信息、
设备密钥、内网地址或生产客户数据的文件。
