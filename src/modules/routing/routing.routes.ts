import { FastifyInstance } from 'fastify';
import { getCache, setCache } from '../../infra/redis.js';

/**
 * Proxy de Geocodificación (Nominatim) y Rutas (OSRM) con Caché en Redis
 * Evita límites de tasa (rate-limits) de OpenStreetMap y acelera las consultas a < 5 ms en San Miguel de Allende.
 */
export async function routingRoutes(app: FastifyInstance): Promise<void> {
  // 1. GEOCODIFICACIÓN INVERSA CON CACHÉ REDIS (TTL 24 HORAS)
  app.get('/api/routing/reverse-geocode', async (request, reply) => {
    const { lat, lng } = request.query as { lat?: string; lng?: string };
    const latNum = Number(lat);
    const lngNum = Number(lng);

    if (isNaN(latNum) || isNaN(lngNum)) {
      return reply.status(400).send({ error: 'Coordenadas inválidas.' });
    }

    // Redondear a 4 decimales (~11 metros de precisión) para maximizar hits en caché Redis
    const cacheKey = `rodo:geo:rev:${latNum.toFixed(4)}:${lngNum.toFixed(4)}`;
    const cached = await getCache<any>(cacheKey);
    if (cached) {
      return reply.send({ ...cached, cached: true });
    }

    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latNum}&lon=${lngNum}&zoom=18&addressdetails=1`;
      const response = await fetch(url, {
        headers: {
          'Accept-Language': 'es-MX,es;q=0.9',
          'User-Agent': 'RODO-MotoMandados-SMA-Server/1.0 (soporte@rodomotomandados.com)',
        },
      });

      if (!response.ok) {
        return reply.status(502).send({ error: 'Servicio externo de geocodificación no disponible.' });
      }

      const data = await response.json();
      await setCache(cacheKey, data, 86400); // 24 horas en Redis
      return reply.send(data);
    } catch (err: any) {
      return reply.status(502).send({ error: err?.message || 'Error al consultar Nominatim.' });
    }
  });

  // 2. TRAZADO DE RUTA EN MOTO OSRM CON CACHÉ REDIS (TTL 6 HORAS)
  app.get('/api/routing/osrm', async (request, reply) => {
    const { fromLat, fromLng, toLat, toLng } = request.query as {
      fromLat?: string;
      fromLng?: string;
      toLat?: string;
      toLng?: string;
    };

    const fLat = Number(fromLat);
    const fLng = Number(fromLng);
    const tLat = Number(toLat);
    const tLng = Number(toLng);

    if ([fLat, fLng, tLat, tLng].some((n) => isNaN(n))) {
      return reply.status(400).send({ error: 'Coordenadas de ruta inválidas.' });
    }

    const cacheKey = `rodo:osrm:${fLat.toFixed(4)},${fLng.toFixed(4)}:${tLat.toFixed(4)},${tLng.toFixed(4)}`;
    const cached = await getCache<any>(cacheKey);
    if (cached) {
      return reply.send({ ...cached, cached: true });
    }

    try {
      const url = `https://router.project-osrm.org/route/v1/driving/${fLng},${fLat};${tLng},${tLat}?overview=full&geometries=geojson`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'RODO-MotoMandados-SMA-Server/1.0',
        },
      });

      if (!response.ok) {
        return reply.status(502).send({ error: 'OSRM no disponible temporalmente.' });
      }

      const data = await response.json();
      await setCache(cacheKey, data, 21600); // 6 horas en Redis
      return reply.send(data);
    } catch (err: any) {
      return reply.status(502).send({ error: err?.message || 'Error al calcular ruta OSRM.' });
    }
  });
}
