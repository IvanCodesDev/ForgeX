# ForgeX Stage 6-B capacity plan

## Reproducible fixture baseline

On 2026-08-12, `npm run dotnet:capacity` exercised 16 concurrent synchronous analyses, each with a
98,153-byte / 4,000-move G-code fixture. The local gate observed 36.9 ms p50, 40.2 ms p95, 40.2 ms
p99, and 395.39 completed requests/second. It also verified owner and tenant admission rejection,
idempotent replay, terminal processing, metric changes, and the 10-second p95 engineering budget.

These results characterize one local fixture and are not a production capacity promise. Host CPU,
storage latency, payload mix, network, runtime warmup, and scraping overhead must be measured in the
target environment.

## Initial bounded settings

| Control | Default | Purpose |
| --- | ---: | --- |
| queue capacity | 64 | bounded memory/work backlog |
| active jobs per owner | 4 | noisy-owner containment |
| active jobs per tenant | 16 | tenant fairness |
| worker parallelism | 1 | single durable file-repository writer |
| accepted body | 16 MiB | existing request boundary |

Keep `tenant >= owner`. Invalid or unbounded values fail startup. A 429 response and
`Retry-After: 5` are overload signals, not failures to retry in a tight loop.

## Measurement and scale decisions

Capture p50/p95/p99 duration, queue ratio, 429 counts, failure ratio, CPU, memory, and storage latency
for at least one peak cycle. Add capacity before sustained queue ratio exceeds 60%, p95 consumes 70%
of the SLO, or quota rejections exceed 1% of valid submissions. Lower admission first if storage or
CPU saturation precedes queue pressure. Multiple replicas require a shared repository and exclusive
job claiming; the current file provider remains a single-authority topology.
