# RODO Moto Mandados · Backend API

Servidor API REST y de Tiempo Real para **RODO Moto Mandados (San Miguel de Allende, Guanajuato)**.

## Stack Tecnológico
* **Runtime & Framework:** Node.js 22 LTS + Fastify 5 + TypeScript
* **Base de Datos & ORM:** PostgreSQL 16 + Prisma ORM 6
* **Tiempo Real (Despacho y GPS):** Socket.IO 4
* **Caché & Proxy de Mapas:** Redis 7 (caché de catálogo, geocodificación Nominatim y rutas OSRM)
* **Seguridad:** JWT + BcryptJS + Zod + Helmet + Rate Limit + Recálculo Server-Side de precios y validación antifraude INE/SPEI

## Módulos Principales (`src/modules/`)
* `auth/`: Registro con validación matemática INE (OACI 9303 `7-3-1` / Luhn), Login JWT, lista negra centralizada en PostgreSQL y flujo de recuperación de cuentas.
* `catalog/`: Gestión de restaurantes, menús y locales asociados con PIN de 3 dígitos (con caché en Redis).
* `orders/`: Creación de órdenes con recálculo de precios server-side, validación de límites en efectivo, verificación anti-duplicados de claves SPEI, consumo único de cupones y emisión Socket.IO.
* `settings/`: Configuración operativa (tarifas base/km, pausa por lluvia en tiempo real, días festivos).
* `routing/`: Proxy con caché Redis para Nominatim (24 h) y OSRM (6 h).
* `notifications/`: Notificaciones masivas y bitácora inmutable de auditoría (`AuditLog`).
* `uploads/`: Persistencia segura de firmas digitales, fotos de entrega y documentos en volumen Docker.

## Pruebas Automatizadas
```bash
# Pruebas unitarias de reglas de dominio y seguridad (18 pruebas)
npm test

# Pruebas integrales End-to-End contra Docker Compose en vivo (8 pruebas)
npm run test:e2e
```

## Despliegue en Producción (VPS Hostinger)
La carpeta `deploy/` contiene `docker-compose.prod.yml`, `Caddyfile` (HTTPS Let's Encrypt automático) y `deploy-hostinger.sh`.


### Migraciones de PostgreSQL

Antes de actualizar el VPS, toma un respaldo de la base existente. El contenedor ejecuta `npm run db:deploy` (el mismo script se puede ejecutar manualmente) antes de arrancar la API. Una base vacía recibe las migraciones de `prisma/migrations` en orden.

Para una instalación que usaba `db push`, el primer arranque compara el esquema real con las cuatro versiones conocidas desde el índice de INE de `5cd45c4`. Solo registra como aplicadas las migraciones que ya están presentes y ejecuta las pendientes. Si el esquema difiere, el arranque se detiene antes de la adopción. Para diagnosticarlo desde la imagen del backend, ejecuta `npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/adoption/schema.prisma --script` y revisa su salida antes de preparar una migración específica.

Los despliegues posteriores usan el historial de Prisma. Para un nuevo cambio de esquema, agrega una migración SQL versionada. Conserva los archivos de adopción como referencia de las versiones antiguas.
