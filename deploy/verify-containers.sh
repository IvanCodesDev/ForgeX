#!/usr/bin/env sh
set -eu

node_image="${FORGEX_NODE_IMAGE:-forgex-node:ci}"
api_image="${FORGEX_API_IMAGE:-forgex-api:ci}"
suffix="${GITHUB_RUN_ID:-local}-$$"
network="forgex-contract-${suffix}"
node_volume="forgex-node-data-${suffix}"
api_volume="forgex-api-data-${suffix}"
node_name="forgex-node-${suffix}"
api_name="forgex-api-${suffix}"
postgres_name="forgex-postgres-${suffix}"
secret="container-contract-secret-${suffix}-0123456789abcdef"
port="${FORGEX_SMOKE_PORT:-18787}"

cleanup() {
  docker rm -f "$node_name" "$api_name" "$postgres_name" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$node_volume" "$api_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

fail() {
  echo "CONTAINER_CONTRACT_FAIL: $*" >&2
  docker logs "$api_name" 2>&1 || true
  docker logs "$node_name" 2>&1 || true
  exit 1
}

assert_eq() {
  expected="$1"
  actual="$2"
  label="$3"
  [ "$actual" = "$expected" ] || fail "$label expected=$expected actual=$actual"
}

wait_healthy() {
  name="$1"
  attempts=40
  while [ "$attempts" -gt 0 ]; do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$name" 2>/dev/null || true)"
    [ "$status" = "healthy" ] && return 0
    [ "$status" = "unhealthy" ] && fail "$name became unhealthy"
    attempts=$((attempts - 1))
    sleep 1
  done
  fail "$name did not become healthy"
}

docker network create "$network" >/dev/null
docker volume create "$node_volume" >/dev/null
docker volume create "$api_volume" >/dev/null

# 一次性数据库，仅测试网络可达；执行与生产一致的六份迁移。
docker run -d --name "$postgres_name" --network "$network" --network-alias postgres \
  -e POSTGRES_USER=forgex -e POSTGRES_PASSWORD="$secret" -e POSTGRES_DB=forgex \
  --health-cmd 'pg_isready -U forgex' --health-interval 1s --health-retries 30 \
  postgres:16-alpine >/dev/null
wait_healthy "$postgres_name"
for migration in backend/database/postgresql/migrations/*.sql; do
  docker exec -i "$postgres_name" psql -U forgex -d forgex -v ON_ERROR_STOP=1 < "$migration" >/dev/null
done

docker run -d \
  --name "$api_name" \
  --network "$network" \
  --network-alias forgex-api \
  --user 1654:1654 \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=volume,src=${api_volume},dst=/app/data" \
  -p "127.0.0.1:${port}:8787" \
  -e POSTGRES_URL="postgres://forgex:${secret}@postgres:5432/forgex" \
  -e InternalAuth__SharedSecret="$secret" \
  -e AllowedHosts="localhost;127.0.0.1;forgex-api" \
  "$api_image" >/dev/null
wait_healthy "$api_name"

docker run -d \
  --name "$node_name" \
  --network "$network" \
  --user 1000:1000 \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=volume,src=${node_volume},dst=/app/data" \
  -e PERSISTENCE_PROVIDER=postgres \
  -e POSTGRES_URL="postgres://forgex:${secret}@postgres:5432/forgex" \
  -e SHARES_AUTHORITY=csharp \
  -e DATASOURCES_AUTHORITY=csharp \
  -e KNOWLEDGE_AUTHORITY=csharp \
  -e CALIBRATION_GOVERNANCE_AUTHORITY=csharp \
  -e ANALYSIS_TASKS_AUTHORITY=csharp \
  -e GCODE_AUTHORITY_URL=http://forgex-api:8787 \
  -e GCODE_AUTHORITY_ALLOW_REMOTE=1 \
  -e GCODE_AUTHORITY_INTERNAL_SECRET="$secret" \
  -e GCODE_ASYNC_JOBS_ENABLED=1 \
  "$node_image" >/dev/null
wait_healthy "$node_name"
docker exec "$node_name" node -e "fetch('http://127.0.0.1:8787/healthz').then(async r=>{const j=await r.json();if(!r.ok||j.persistence!=='postgres')throw new Error('rollback gateway persistence')}).catch(e=>{console.error(e);process.exit(1)})"

assert_eq "1654" "$(docker exec "$api_name" id -u)" "authority uid"
assert_eq "1000" "$(docker exec "$node_name" id -u)" "gateway uid"

if docker exec "$api_name" sh -c 'touch /app/forbidden' >/dev/null 2>&1; then
  fail "authority root filesystem is writable"
fi
if docker exec "$node_name" sh -c 'touch /app/forbidden' >/dev/null 2>&1; then
  fail "gateway root filesystem is writable"
fi
docker exec "$api_name" sh -c 'touch /app/data/authority-write-probe && rm /app/data/authority-write-probe'
docker exec "$node_name" sh -c 'touch /app/data/gateway-write-probe && rm /app/data/gateway-write-probe'

docker exec "$node_name" node -e "fetch('http://forgex-api:8787/healthz').then(async r=>{if(!r.ok)throw new Error('ready '+r.status);const j=await r.json();if(!j.ok||j.persistence!=='postgres')throw new Error('not ready')}).catch(e=>{console.error(e);process.exit(1)})"
docker exec "$node_name" node -e "fetch('http://forgex-api:8787/metrics').then(async r=>{const t=await r.text();if(!r.ok||!t.includes('forgex_job_repository_ready 1'))throw new Error('metrics contract')}).catch(e=>{console.error(e);process.exit(1)})"

node_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/healthz")"
react_status="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/react/")"
assert_eq "200" "$node_status" "C# public health status"
assert_eq "200" "$react_status" "React entry status"

docker restart "$api_name" >/dev/null
wait_healthy "$api_name"
docker exec "$node_name" node -e "fetch('http://forgex-api:8787/healthz').then(r=>{if(!r.ok)throw new Error('restart readiness '+r.status)}).catch(e=>{console.error(e);process.exit(1)})"

echo "CONTAINER_CONTRACT_PASS node_uid=1000 api_uid=1654 health=200 react=200 restart=ready"
