# ForgeX Stage 5-D evidence

- Baseline: `7beb2c5761336d8575f6d5d5d005689fec4c2844` / engine `1.3.0` / no material-cost or risk contract.
- Modified: engine `1.4.0`, Profile fingerprint v2, authoritative direct material cost and bounded low/medium/high preflight risk.
- Runtime fixture: PLA at CNY 100/kg, nozzle 195–225 °C, bed minimum 55 °C, maximum extrusion speed 5 mm/s, maximum flow 1 mm³/s; input commands 250 °C / 40 °C / 10 mm/s / ~2.405 mm³/s.
- Verified modified behavior: materialCostCny `0.00029825495255018095`, risk `high/100`, synchronous and asynchronous contracts match.
- Rollback behavior: restores all 26 tracked files exactly to Stage 5-C; browser remains the zero-request authority fallback.
- `artifact-manifest.txt` records SHA-256 and byte length for every required role.