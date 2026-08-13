# 真机日志对比

导入真实 G-code 后，可再导入一份真机任务日志，把计划路径统计与实际任务结果并列。
标准 JSON 契约见 [`machine-log.schema.json`](./machine-log.schema.json)，最小示例见
[`example-machine-log.json`](./example-machine-log.json)。

也支持 CSV 遥测，推荐列名：

```csv
time_s,nozzle_c,bed_c,filament_mm,filament_g,completed_layers,status
0,25,25,0,0,0,running
4380,207.2,58.7,8240,24.7,120,success
```

`time_s`、`nozzle_c`、`bed_c` 可逐行记录；任务汇总字段可只在最后一行填写。

差异视图不会判定哪一侧“正确”：G-code 时间是按运动速度重算，真机日志通常还包含预热、
加速度、固件宏、暂停和换层；耗材也可能来自 E 值、编码器或称量，口径必须和日志来源一起解释。
