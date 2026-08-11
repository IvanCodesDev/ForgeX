# ForgeX production SLO

## Service level indicators and objectives

| SLI | Objective | Window | Source |
| --- | --- | --- | --- |
| Authority availability | successful non-5xx responses **99.5%** | rolling 30 days | `forgex_http_requests_total` |
| Accepted G-code completion | **99%** of accepted jobs up to 16 MiB reach a terminal state within **60 秒** | rolling 7 days | durable timestamps and duration histogram |
| Job correctness | failed plus dead-letter jobs below **1%** | rolling 7 days | `forgex_gcode_jobs` |
| Metadata durability | **RPO 0** after the API returns HTTP 202 | per incident | verified repository backup |
| Recovery | **RTO 5 minutes** for verified file-repository restore | per drill | `recovery-drill.json` |

The latency objective excludes rejected 4xx admission requests. The local Stage 6-B fixture is a
repeatable engineering gate, not a production traffic forecast; deployments must establish their
own baseline before raising concurrency or quotas.

## 错误预算

99.5% monthly availability permits about 3 hours 39 minutes of unavailability in a 30-day window.
At 50% budget consumption, freeze nonessential changes and inspect the dominant route/status. At
100%, permit only incident mitigation and verified rollback until the 30-day burn rate recovers.
Alert thresholds deliberately use sustained windows to avoid paging on one scrape.

## Measurement and review

- Scrape `/metrics` every 30 seconds and retain at least 35 days.
- Review the SLO and capacity plan monthly, after an incident, or after a 2x traffic change.
- Run `npm run dotnet:recovery-drill`, `npm run security:audit`, `npm run ops:check`, and
  `npm run rollback:rehearse` before a production release. Archive their JSON outputs with the
  release.
