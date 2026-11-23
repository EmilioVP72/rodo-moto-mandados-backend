#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# RODO MOTO MANDADOS · SCRIPT DE DESPLIEGUE AUTOMATIZADO PARA VPS HOSTINGER
# Compatible con Ubuntu 22.04 / 24.04 LTS y Debian 12
# - Reutiliza el contenedor PostgreSQL 16 existente (ej. rodo-db-1)
# - NO toca los puertos 80 ni 443 (expone la app en WEB_PORT, default 8080)
# ==============================================================================

BACKEND_REPO="https://github.com/EmilioVP72/rodo-moto-mandados-backend.git"
FRONTEND_REPO="https://github.com/EmilioVP72/rodo-moto-mandados-frontend.git"
DEFAULT_PG_CONTAINER="${POSTGRES_CONTAINER:-rodo-db-1}"

echo "========================================================================"
echo "  RODO Moto Mandados · Despliegue Produccion (Hostinger VPS)"
echo "  - PostgreSQL existente: ${DEFAULT_PG_CONTAINER} (sin duplicar Postgres)"
echo "  - Puerto dedicado (respeta tus puertos 80 y 443 ocupados)"
echo "========================================================================"

# 1. Verificar Docker y Docker Compose Plugin
if ! command -v docker >/dev/null 2>&1; then
  echo "[1/6] Instalando Docker Engine y Docker Compose..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
else
  echo "[1/6] Docker detectado: $(docker --version)"
fi

# 2. Clonar o actualizar los repositorios de Backend y Frontend desde GitHub
echo "[2/6] Sincronizando repositorios desde GitHub..."
if [ -d "backend/.git" ]; then
  git -C backend pull --ff-only origin main
else
  rm -rf backend
  git clone "$BACKEND_REPO" backend
fi

if [ -d "frontend/.git" ]; then
  git -C frontend pull --ff-only origin main
else
  rm -rf frontend
  git clone "$FRONTEND_REPO" frontend
fi

# Asegurar que los archivos de despliegue en la raiz coincidan con backend/deploy
cp -f backend/deploy/docker-compose.prod.yml ./docker-compose.prod.yml
cp -f backend/deploy/.env.example ./.env.example

# 3. Detectar contenedor PostgreSQL 16 existente y su red Docker
echo "[3/6] Verificando contenedor PostgreSQL 16 existente..."
if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PG_CONTAINER="${POSTGRES_CONTAINER:-$DEFAULT_PG_CONTAINER}"
if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  echo "ERROR: No se encontro en ejecucion el contenedor '$PG_CONTAINER'."
  echo "Contenedores activos actualmente:"
  docker ps --format '  - {{.Names}} ({{.Image}})'
  read -r -p "Ingresa el nombre exacto de tu contenedor PostgreSQL 16: " PG_CONTAINER
  if ! docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    echo "ERROR: El contenedor '$PG_CONTAINER' no esta corriendo. Inicia Postgres primero."
    exit 1
  fi
fi
echo "    -> Contenedor PostgreSQL encontrado y activo: $PG_CONTAINER"

# Detectar red definida por usuario (la red 'bridge' por defecto NO resuelve nombres por DNS)
DETECTED_NET="$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{if ne $k "bridge"}}{{$k}} {{end}}{{end}}' "$PG_CONTAINER" | awk '{print $1}')"
if [ -z "$DETECTED_NET" ]; then
  DETECTED_NET="rodo-shared-pg"
  echo "    -> '$PG_CONTAINER' solo estaba en 'bridge'. Creando red compartida '$DETECTED_NET' y conectando el contenedor..."
  docker network inspect "$DETECTED_NET" >/dev/null 2>&1 || docker network create "$DETECTED_NET" >/dev/null
  docker network connect "$DETECTED_NET" "$PG_CONTAINER" >/dev/null 2>&1 || true
else
  echo "    -> Red Docker compartida detectada automaticamente: $DETECTED_NET"
fi

# 4. Generar archivo .env seguro si no existe
if [ ! -f ".env" ]; then
  echo "[4/6] Generando archivo .env de produccion..."
  read -r -p "Puerto HTTP libre en tu VPS para RODO (no usa 80 ni 443) [8080]: " USER_WEB_PORT
  USER_WEB_PORT="${USER_WEB_PORT:-8080}"

  read -r -p "Dominio publico para CORS (ej. rodomotomandados.com, o deja vacio para permitir todos '*'): " USER_DOMAIN
  if [ -z "$USER_DOMAIN" ]; then
    CORS_VALUE="*"
  else
    CORS_VALUE="https://${USER_DOMAIN},https://www.${USER_DOMAIN}"
  fi

  read -r -p "Nombre de la nueva BD dentro de ${PG_CONTAINER} [rodo_db]: " USER_DB
  USER_DB="${USER_DB:-rodo_db}"

  read -r -p "Usuario dedicado de Postgres para RODO [rodo_user]: " USER_PG_USER
  USER_PG_USER="${USER_PG_USER:-rodo_user}"

  read -r -p "Correo administrador maestro [edsoncruz14999@gmail.com]: " USER_ADMIN_EMAIL
  USER_ADMIN_EMAIL="${USER_ADMIN_EMAIL:-edsoncruz14999@gmail.com}"

  read -r -s -p "Contrasena inicial del Administrador (min 6 chars) [RODO2026]: " USER_ADMIN_PASS
  echo ""
  USER_ADMIN_PASS="${USER_ADMIN_PASS:-RODO2026}"

  PG_PASS="$(openssl rand -hex 24)"
  JWT_KEY="$(openssl rand -hex 32)"
  INE_KEY="$(openssl rand -hex 32)"

  cat > .env <<EOF
WEB_PORT=${USER_WEB_PORT}

POSTGRES_CONTAINER=${PG_CONTAINER}
POSTGRES_HOST=${PG_CONTAINER}
POSTGRES_PORT=5432
POSTGRES_NETWORK=${DETECTED_NET}
POSTGRES_USER=${USER_PG_USER}
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_DB=${USER_DB}

NODE_ENV=production
JWT_SECRET=${JWT_KEY}
INE_ENCRYPTION_KEY=${INE_KEY}
ADMIN_EMAIL=${USER_ADMIN_EMAIL}
ADMIN_INITIAL_PASSWORD=${USER_ADMIN_PASS}
CORS_ORIGIN=${CORS_VALUE}
BACKUP_KEEP_DAYS=14
EOF
  chmod 600 .env
  echo "    -> Archivo .env generado y protegido (permisos 600)."

  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo "[4/6] Usando archivo .env existente."
  if ! grep -q '^WEB_PORT=' .env; then
    echo "WEB_PORT=8080" >> .env
  fi
  if ! grep -q '^POSTGRES_NETWORK=' .env; then
    echo "POSTGRES_NETWORK=${DETECTED_NET}" >> .env
  fi
  if ! grep -q '^POSTGRES_HOST=' .env; then
    echo "POSTGRES_HOST=${PG_CONTAINER}" >> .env
  fi
  if ! grep -q '^INE_ENCRYPTION_KEY=' .env; then
    echo "INE_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env
  fi
fi

# 5. Crear usuario y base de datos de forma segura e idempotente dentro del Postgres existente
echo "[5/6] Creando/verificando usuario '${POSTGRES_USER}' y base de datos '${POSTGRES_DB}' en '${PG_CONTAINER}'..."
PG_SUPERUSER="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$PG_CONTAINER" | awk -F= '$1=="POSTGRES_USER"{print $2}' | head -n1)"
PG_SUPERUSER="${PG_SUPERUSER:-postgres}"

docker exec -i "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d postgres <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${POSTGRES_USER}') THEN
    CREATE ROLE "${POSTGRES_USER}" LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  ELSE
    ALTER ROLE "${POSTGRES_USER}" WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  END IF;
END
\$\$;
SQL

DB_EXISTS="$(docker exec "$PG_CONTAINER" psql -U "$PG_SUPERUSER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB}'")"
if [ "$DB_EXISTS" != "1" ]; then
  docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d postgres \
    -c "CREATE DATABASE \"${POSTGRES_DB}\" OWNER \"${POSTGRES_USER}\";"
  echo "    -> Base de datos '${POSTGRES_DB}' creada exitosamente dentro de '${PG_CONTAINER}'."
else
  echo "    -> Base de datos '${POSTGRES_DB}' ya existia en '${PG_CONTAINER}' (conservando datos intactos)."
fi

docker exec "$PG_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PG_SUPERUSER" -d "${POSTGRES_DB}" \
  -c "GRANT ALL PRIVILEGES ON DATABASE \"${POSTGRES_DB}\" TO \"${POSTGRES_USER}\";" \
  -c "ALTER SCHEMA public OWNER TO \"${POSTGRES_USER}\";" \
  -c "GRANT ALL ON SCHEMA public TO \"${POSTGRES_USER}\";"

# 6. Compilar y desplegar stack de produccion (sin tocar 80/443 ni duplicar Postgres)
echo "[6/6] Compilando e iniciando contenedores de produccion (rodo-redis, rodo-api, rodo-web, rodo-backup)..."
mkdir -p backups/postgres
docker compose -f docker-compose.prod.yml up -d --build --remove-orphans

echo ""
echo "========================================================================"
echo "  DESPLIEGUE COMPLETADO EXITOSAMENTE (Puerto host: ${WEB_PORT:-8080})"
echo "========================================================================"
docker compose -f docker-compose.prod.yml ps
echo ""
echo "Verificacion rapida:"
echo "  curl -s http://127.0.0.1:${WEB_PORT:-8080}/api/health"
echo "  docker compose -f docker-compose.prod.yml logs -f rodo-api"
echo ""
echo "Para publicarlo con tu proxy principal (puertos 80/443):"
echo "  Apunta tu dominio hacia http://127.0.0.1:${WEB_PORT:-8080} (activa soporte WebSockets para /socket.io/)."
