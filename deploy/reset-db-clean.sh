#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# RODO MOTO MANDADOS · LIMPIEZA COMPLETA DE LA BD DE PRODUCCIÓN
# Limpia únicamente la BD configurada en .env (${POSTGRES_DB}) dentro del
# contenedor PostgreSQL existente (${POSTGRES_CONTAINER}) sin tocar otras BDs,
# limpia caché Redis y deja SOLO la cuenta de Administrador de .env.
# ==============================================================================

if [ ! -f ".env" ]; then
  echo "ERROR: No se encontro .env en el directorio actual ($(pwd))."
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env
set +a

PG_CONTAINER="${POSTGRES_CONTAINER:-rodo-db-1}"
PG_DB="${POSTGRES_DB:-rodo_db}"
PG_USER="${POSTGRES_USER:-rodo_user}"

echo "========================================================================"
echo "  LIMPIEZA DE BASE DE DATOS RODO"
echo "  Contenedor Postgres : ${PG_CONTAINER}"
echo "  Base de datos       : ${PG_DB}"
echo "  Admin a conservar   : ${ADMIN_EMAIL}"
echo "========================================================================"
read -r -p "Esta accion borrara pedidos, clientes, direcciones, logs y sesiones de '${PG_DB}'. Escribe LIMPIAR para confirmar: " CONFIRM
if [ "$CONFIRM" != "LIMPIAR" ]; then
  echo "Operacion cancelada."
  exit 0
fi

# 1. Respaldo preventivo automatico antes de limpiar
mkdir -p backups/postgres
TS="$(date +%Y%m%d_%H%M%S)"
echo "[1/4] Creando respaldo preventivo en backups/postgres/${PG_DB}_pre_clean_${TS}.sql.gz..."
docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" "$PG_CONTAINER" \
  pg_dump -U "$PG_USER" -d "$PG_DB" | gzip > "backups/postgres/${PG_DB}_pre_clean_${TS}.sql.gz"

# 2. Vaciar todas las tablas de RODO (conserva estructura Prisma; NO toca otras BDs del servidor)
echo "[2/4] Limpiando tablas de '${PG_DB}'..."
docker exec -i -e PGPASSWORD="${POSTGRES_PASSWORD}" "$PG_CONTAINER" \
  psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$PG_DB" <<'SQL'
TRUNCATE TABLE
  order_items,
  order_status_history,
  orders,
  refresh_sessions,
  password_reset_tokens,
  customer_addresses,
  user_favorites,
  coupons,
  audit_logs,
  broadcast_notifications,
  account_recovery_requests,
  partner_locals,
  users
RESTART IDENTITY CASCADE;
SQL

# 3. Limpiar cache de Redis
echo "[3/4] Limpiando cache en rodo-redis..."
docker exec rodo-redis redis-cli FLUSHALL >/dev/null

# 4. Reiniciar rodo-api para recrear UNICAMENTE el usuario Admin desde .env
echo "[4/4] Reiniciando rodo-api para inicializar cuenta Admin desde .env..."
docker compose -f docker-compose.prod.yml restart rodo-api

sleep 4
echo ""
echo "Verificando usuarios actuales en '${PG_DB}':"
docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" "$PG_CONTAINER" \
  psql -U "$PG_USER" -d "$PG_DB" -c "SELECT id, email, role, status FROM users;"
echo ""
echo "Listo: la BD quedo limpia y solo existe la cuenta Admin (${ADMIN_EMAIL}) con la contrasena de tu .env."
