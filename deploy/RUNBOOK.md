# ForgeX operations runbook

## First response

1. Record the alert start time, release image tags, `/health/ready`, and `/metrics` output.
2. Stop rollout automation; preserve both named volumes and create an authority backup.
3. Change one control at a time, then recheck readiness, error rate, queue depth, and a synthetic job.

## ForgeXApiUnavailable

Check `docker compose ps` and authority JSON logs. If readiness reports repository unavailable,
verify the data-volume mount and restore only from a verified backup. If the process fails startup
validation, restore the previous environment and image tags.

## ForgeXHttp5xxBudgetBurn

Group `forgex_http_requests_total` by bounded `route` and `status`. Correlate the first increase with
the release and repository logs. Roll back the image pair when the error follows a deployment.

## ForgeXHttpLatencyHigh

Compare the duration histogram with queue saturation and host CPU/memory. Keep admission limits in
place. Scale replicas only when storage semantics preserve one durable owner for every job.

## ForgeXGCodeQueueSaturated

Confirm worker progress and `queued/running` gauges. Keep owner/tenant limits enabled. For a healthy
worker, lower submission rate or add tested capacity; for a stalled worker, restart once and verify
the recovery counter plus durable job events.

## ForgeXGCodeDeadLetters

Inspect the job's stable error code, attempts, and events without editing its JSON. Deterministic
input failures require a corrected upload. For transient exhaustion, preserve the record and logs,
fix the dependency, then use the bounded retry endpoint once.

## ForgeXGCodeFailureRatioHigh

Segment failures by error code and release. Compare with the capacity gate fixture. Freeze rollout
when failures are systemic; do not raise retry budgets to hide deterministic failures.

## 密钥轮换

1. Generate a new random secret of at least 32 bytes; keep the current value as
   `GCODE_AUTHORITY_INTERNAL_SECRET_PREVIOUS` and deploy the authority with the new current value.
2. Deploy the Node gateway with the new current value. During overlap, both secrets authenticate at
   the authority while only the new secret is sent by the gateway.
3. Verify `/health/ready` reports rotation overlap and run a synthetic synchronous plus asynchronous
   request with the gateway.
4. Clear the previous secret, redeploy the authority, and confirm the old secret now receives 401.
   Never keep more than two secrets or leave the overlap active after the change window.

## 备份与恢复

Run `npm run dotnet:recovery-drill`; archive `persistence-recovery-gate.fxbackup`, its SHA-256, and
`recovery-drill.json`. In an incident, restore only to an empty target volume, validate the backup
first, start one authority replica, then verify record count, tenant isolation, and a read-only job.

## 版本回滚

1. Preserve volumes and a verified authority backup.
2. Set `FORGEX_NODE_IMAGE` and `FORGEX_API_IMAGE` to the previously verified immutable tags.
3. Run `docker compose --env-file deploy/.env -f deploy/docker-compose.yml config --quiet`, then
   `docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --no-build`.
4. Verify `/healthz`, `/react/`, authority readiness, metrics, and one synthetic job. If contract
   compatibility is uncertain, set `GCODE_ASYNC_JOBS_ENABLED=0` before replacing the authority.
5. Record image tags, commands, outputs, exit statuses, and the decision to resume or stay rolled back.
