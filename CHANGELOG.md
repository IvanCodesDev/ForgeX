# Changelog

All notable ForgeX changes are recorded here. Entries describe reviewed repository stages rather
than implying that an unreleased build is already deployed.

## Unreleased

### Added

- Stage 6-A persists G-code job attempt counts, retry budgets, next-attempt timestamps, and
  dead-letter timestamps in the file repository and exposes them through the additive OpenAPI
  `retry` snapshot object.
- The C# worker classifies deterministic analysis failures separately from transient stream,
  storage, timeout, and unexpected failures; transient failures use bounded exponential backoff
  and become `failed / dead-letter / gcode_retry_exhausted` after the configured budget.
- Worker restart now requeues durable `running` jobs instead of immediately failing them. Prometheus
  output includes bounded queue depth/capacity plus retry, recovery, and dead-letter counters.

### Operations

- Added `GCodeJobs:QueueCapacity` and `GCodeJobs:Retry:*` configuration with fail-fast bounds.
- Expanded JobGate from 20 checks in Stage 5-D to 31 checks for retry policy, persistence migration,
  retry metadata, and queue depth/capacity. Tenant quota, load/capacity planning, alert rules, and
  security/dependency exercises remain Stage 6-B and later work.
