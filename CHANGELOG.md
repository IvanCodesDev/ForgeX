# Changelog

All notable ForgeX changes are recorded here. Entries describe reviewed repository stages rather
than implying that an unreleased build is already deployed.

## Unreleased

### Added

- Stage 6-B adds atomic per-owner/per-tenant active-job admission, stable 429 rejection codes,
  durable-state gauges, job-duration metrics, and a repeatable 16-request capacity fixture. Default
  limits are 4 active jobs per owner, 16 per tenant, and 64 queued items.
- Stage 6-C accepts one bounded previous internal secret during rotation, adds a lockfile/install
  script/registry/secret/container audit, and enables weekly npm, Actions, and Docker update review.
- Stage 6-D defines measurable availability, completion, failure, RPO, and RTO objectives plus six
  Prometheus alerts, incident procedures, a verified recovery drill, and image-tag rollback controls.

- Stage 6-A persists G-code job attempt counts, retry budgets, next-attempt timestamps, and
  dead-letter timestamps in the file repository and exposes them through the additive OpenAPI
  `retry` snapshot object.
- The C# worker classifies deterministic analysis failures separately from transient stream,
  storage, timeout, and unexpected failures; transient failures use bounded exponential backoff
  and become `failed / dead-letter / gcode_retry_exhausted` after the configured budget.
- Worker restart now requeues durable `running` jobs instead of immediately failing them. Prometheus
  output includes bounded queue depth/capacity plus retry, recovery, and dead-letter counters.

### Operations

- Added `security:audit`, `ops:check`, `dotnet:capacity`, and `dotnet:recovery-drill` release gates;
  their JSON artifacts are retained by CI for 14 days.
- Added `deploy/capacity-plan.md`, `deploy/SLO.md`, `deploy/RUNBOOK.md`, and Prometheus rules under
  `deploy/alerts/`. Stage 6 production hardening is now complete for the single-authority file-store
  topology; multi-replica execution still requires shared storage and exclusive job claiming.

- Added `GCodeJobs:QueueCapacity` and `GCodeJobs:Retry:*` configuration with fail-fast bounds.
- Expanded JobGate from 20 checks in Stage 5-D to 37 checks for retry policy, persistence migration,
  retry metadata, bounded queueing, and owner/tenant admission.
