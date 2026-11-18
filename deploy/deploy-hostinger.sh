#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# RODO MOTO MANDADOS · SCRIPT DE DESPLIEGUE AUTOMATIZADO PARA VPS HOSTINGER
# Compatible con Ubuntu 22.04 / 24.04 LTS y Debian 12
# ==============================================================================

BACKEND_REPO="https://github.com/EmilioVP72/rodo-moto-mandados-backend.git"
FRONTEND_REPO="https://github.com/EmilioVP72/rodo-moto-mandados-frontend.git"

echo "================================================================"
echo "  RODO Moto Mandados · Instalador de Produccion (Hostinger VPS)"
echo "================================================================"

# 1. Instalar Docker & Docker Compose Plugin si no existen
if ! command -v docker >/dev/null 2>&1; then
  echo "[1/5] Instalando Docker Engine y Docker Compose..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
else
  echo "[1/5] Docker ya instalado: $(docker --version)"
fi

# 2. Configurar Firewall UFW (Solo SSH 22, HTTP 80, HTTPS 443)
if command -v ufw >/dev/null 2>&1; then
  echo "[2/5] Configurando reglas seguras de Firewall UFW..."
  ufw allow 22/tcp >/dev/null || true
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
  ufw allow 443/udp >/dev/null || true
  ufw --force enable >/dev/null || true
else
  echo "[2/5] UFW no detectado (asegurate de abrir puertos 80 y 443 en el panel de Hostinger)."
fi

# 3. Clonar o actualizar los repositorios de Backend y Frontend desde GitHub
echo "[3/5] Sincronizando repositorios desde GitHub..."
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

# 4. Generar archivo .env seguro en produccion si no existe
if [ ! -f ".env" ]; then
  echo "[4/5] Generando archivo .env con claves criptograficas seguras..."
  read -r -p "Ingresa tu dominio apuntado a este VPS (ej. rodomotomandados.com): " USER_DOMAIN
  USER_DOMAIN="${USER_DOMAIN:-localhost}"

  PG_PASS="$(openssl rand -hex 24)"
  JWT_KEY="$(openssl rand -hex 32)"

  cat > .env <<EOF
DOMAIN=${USER_DOMAIN}
POSTGRES_USER=rodo_user
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_DB=rodo_db
NODE_ENV=production
JWT_SECRET=${JWT_KEY}
ADMIN_EMAIL=edsoncruz14999@gmail.com
ADMIN_INITIAL_PASSWORD=RODO2026
BACKUP_KEEP_DAYS=14
EOF
  chmod 600 .env
  echo "    -> Archivo .env generado y protegido (permisos 600)."
  echo "    -> IMPORTANTE: Cambia ADMIN_INITIAL_PASSWORD en .env antes de operar en produccion."
else
  echo "[4/5] Usando archivo .env existente."
fi

# 5. Compilar y desplegar stack completo en Docker Produccion
echo "[5/5] Compilando e iniciando contenedores de produccion..."
mkdir -p backups/postgres
docker compose -f docker-compose.prod.yml up -d --build

echo ""
echo "================================================================"
echo "  DESPLIEGUE COMPLETADO EXITOSAMENTE"
echo "================================================================"
docker compose -f docker-compose.prod.yml ps
echo ""
echo "Verifica salud del servidor: docker compose -f docker-compose.prod.yml logs -f rodo-api"
