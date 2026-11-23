import { FastifyInstance } from 'fastify';
import { getCache, setCache } from '../../infra/redis.js';

const SMA_ROAD_CURVATURE_FACTOR = 1.28;
const EXPRESS_BASE_KM = 2.0;
const EXPRESS_BASE_FEE = 30;
const EXPRESS_PER_EXTRA_KM = 10;
const EXPRESS_SURCHARGE_MXN = 25;

// Bounding box de San Miguel de Allende, Guanajuato (oeste, norte, este, sur)
const SMA_NOMINATIM_VIEWBOX = '-100.92,21.05,-100.55,20.76';

function calcHaversineRoadKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const roadKm = R * c * SMA_ROAD_CURVATURE_FACTOR;
  return Math.max(0.5, Math.round(roadKm * 10) / 10);
}

function isValidCoordPair(c?: { lat?: unknown; lng?: unknown } | null): c is { lat: number; lng: number } {
  if (!c) return false;
  const lat = Number(c.lat);
  const lng = Number(c.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

async function geocodeAddressInSma(rawQuery: string): Promise<{ lat: number; lng: number } | null> {
  const cleaned = rawQuery.trim();
  if (!cleaned) return null;

  const normalizedKey = cleaned.toLowerCase().replace(/\s+/g, ' ');
  const cacheKey = `rodo:geo:fwd:${normalizedKey}`;
  const cached = await getCache<{ lat: number; lng: number } | null>(cacheKey);
  if (cached && isValidCoordPair(cached)) {
    return cached;
  }

  const queries = [
    `${cleaned}, San Miguel de Allende, Guanajuato, Mexico`,
    // Fallback usando colonia/zona si la calle exacta no aparece en OSM
    cleaned.includes(',')
      ? `${cleaned.split(',').slice(1).join(',').trim()}, San Miguel de Allende, Guanajuato, Mexico`
      : null,
  ].filter(Boolean) as string[];

  for (const q of queries) {
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=mx&viewbox=${SMA_NOMINATIM_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`;
      const response = await fetch(url, {
        headers: {
          'Accept-Language': 'es-MX,es;q=0.9',
          'User-Agent': 'RODO-MotoMandados-SMA-Server/1.0 (soporte@rodomotomandados.com)',
        },
      });
      if (!response.ok) continue;
      const results = (await response.json()) as any[];
      if (Array.isArray(results) && results.length > 0) {
        const lat = Number(results[0].lat);
        const lng = Number(results[0].lon);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          const coords = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
          await setCache(cacheKey, coords, 86400);
          return coords;
        }
      }
    } catch {
      // Continuar al siguiente intento
    }
  }

  return null;
}

async function fetchOsrmRouteData(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): Promise<any | null> {
  const cacheKey = `rodo:osrm:${from.lat.toFixed(4)},${from.lng.toFixed(4)}:${to.lat.toFixed(4)},${to.lng.toFixed(4)}`;
  const cached = await getCache<any>(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'RODO-MotoMandados-SMA-Server/1.0',
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    await setCache(cacheKey, data, 21600); // 6 horas en Redis
    return data;
  } catch {
    return null;
  }
}

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
      await setCache(cacheKey, data, 86400);
      return reply.send(data);
    } catch (err: any) {
      return reply.status(502).send({ error: err?.message || 'Error al consultar Nominatim.' });
    }
  });

  // 1.5 GEOCODIFICACIÓN DIRECTA (TEXTO -> COORDENADAS EN SMA) CON CACHÉ REDIS
  app.get('/api/routing/geocode', async (request, reply) => {
    const { q } = request.query as { q?: string };
    if (!q || !q.trim()) {
      return reply.status(400).send({ error: 'Dirección requerida para geocodificar.' });
    }

    const coords = await geocodeAddressInSma(q);
    if (!coords) {
      return reply.status(404).send({
        error: 'No encontramos esa dirección exacta en el mapa. Ubica el punto directamente en el mapa.',
      });
    }
    return reply.send(coords);
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

    const data = await fetchOsrmRouteData({ lat: fLat, lng: fLng }, { lat: tLat, lng: tLng });
    if (!data) {
      return reply.status(502).send({ error: 'OSRM no disponible temporalmente.' });
    }
    return reply.send(data);
  });

  // 3. COTIZACIÓN AUTOMÁTICA PUNTO A -> PUNTO B (ANTIFRAUDE: SIN SELECCIÓN MANUAL DE KM)
  app.post('/api/routing/express-quote', async (request, reply) => {
    const quote = await quoteExpressDelivery((request.body || {}) as ExpressQuoteInput);
    if (!quote) return reply.status(422).send({ error: 'Selecciona ambos puntos en el mapa.' });
    return reply.send(quote);
  });
}

type ExpressQuoteInput = {
      pickupCoords?: { lat?: number; lng?: number } | null;
      deliveryCoords?: { lat?: number; lng?: number } | null;
      pickupAddress?: string;
      deliveryAddress?: string;
      deliveryType?: 'normal' | 'express' | 'programada';
    };

export async function quoteExpressDelivery(body: ExpressQuoteInput) {
    const deliveryType =
      body.deliveryType === 'express' || body.deliveryType === 'programada'
        ? body.deliveryType
        : 'normal';

    const resolvedPickup = isValidCoordPair(body.pickupCoords)
      ? { lat: Number(body.pickupCoords.lat), lng: Number(body.pickupCoords.lng) }
      : await geocodeAddressInSma(body.pickupAddress || '');

    const resolvedDelivery = isValidCoordPair(body.deliveryCoords)
      ? { lat: Number(body.deliveryCoords.lat), lng: Number(body.deliveryCoords.lng) }
      : await geocodeAddressInSma(body.deliveryAddress || '');

    if (!resolvedPickup || !resolvedDelivery) return null;

    let distanceKm: number;
    let estimatedMinutes: number;
    let source: 'osrm' | 'haversine' = 'haversine';

    const osrm = await fetchOsrmRouteData(resolvedPickup, resolvedDelivery);
    const osrmDistanceMeters = Number(osrm?.routes?.[0]?.distance);
    const osrmDurationSec = Number(osrm?.routes?.[0]?.duration);

    if (Number.isFinite(osrmDistanceMeters) && osrmDistanceMeters > 0) {
      distanceKm = Math.max(0.5, Math.round((osrmDistanceMeters / 1000) * 10) / 10);
      const travelMin = Number.isFinite(osrmDurationSec)
        ? Math.max(3, Math.round(osrmDurationSec / 60))
        : Math.round(distanceKm * 4);
      estimatedMinutes = (deliveryType === 'express' ? 5 : 8) + travelMin;
      source = 'osrm';
    } else {
      distanceKm = calcHaversineRoadKm(
        resolvedPickup.lat,
        resolvedPickup.lng,
        resolvedDelivery.lat,
        resolvedDelivery.lng
      );
      estimatedMinutes = Math.round(
        (deliveryType === 'express' ? 5 : 8) + distanceKm * (deliveryType === 'express' ? 3 : 4)
      );
    }

    const extraKm = Math.max(0, Number((distanceKm - EXPRESS_BASE_KM).toFixed(1)));
    const baseCalculatedFee = Math.round(EXPRESS_BASE_FEE + extraKm * EXPRESS_PER_EXTRA_KM);
    const expressSurcharge = deliveryType === 'express' ? EXPRESS_SURCHARGE_MXN : 0;
    const totalFee = baseCalculatedFee + expressSurcharge;

    return {
      distanceKm,
      estimatedMinutes,
      baseFee: EXPRESS_BASE_FEE,
      extraKm,
      baseCalculatedFee,
      expressSurcharge,
      totalFee,
      source,
      pickupCoords: resolvedPickup,
      deliveryCoords: resolvedDelivery,
    };
}
