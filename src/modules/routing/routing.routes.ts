import { FastifyInstance } from 'fastify';
import { getCache, setCache } from '../../infra/redis.js';

const SMA_ROAD_CURVATURE_FACTOR = 1.28;
const EXPRESS_BASE_KM = 2.0;
const EXPRESS_BASE_FEE = 30;
const EXPRESS_PER_EXTRA_KM = 10;
const EXPRESS_SURCHARGE_MXN = 25;

// Bounding box de San Miguel de Allende, Guanajuato (oeste, norte, este, sur)
const SMA_NOMINATIM_VIEWBOX = '-100.92,21.05,-100.55,20.76';

const ALLOWED_MAPS_HOSTS = new Set([
  'maps.app.goo.gl',
  'goo.gl',
  'google.com',
  'www.google.com',
  'maps.google.com',
  'google.com.mx',
  'www.google.com.mx',
  'maps.google.com.mx',
  'maps.apple.com',
  'openstreetmap.org',
  'www.openstreetmap.org',
  'osm.org',
]);

export function isAllowedMapsUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase();
    if (!ALLOWED_MAPS_HOSTS.has(host)) return null;
    if (host === 'goo.gl' && !parsed.pathname.toLowerCase().startsWith('/maps')) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function extractCoordsFromMapsText(input: string): { lat: number; lng: number } | null {
  if (!input) return null;
  const decoded = (() => {
    try {
      return decodeURIComponent(input);
    } catch {
      return input;
    }
  })();

  const toPair = (latStr: string, lngStr: string) => {
    const lat = Number(latStr);
    const lng = Number(lngStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
    return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
  };

  // 1. Coordenadas exactas del pin en URLs de Google Maps (!3dLAT!4dLNG)
  const bang = decoded.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (bang) return toPair(bang[1], bang[2]);

  // 2. Parámetros q/query/ll/destination/center
  const queryParam = decoded.match(
    /[?&](?:q|query|ll|destination|center)=(-?\d{1,2}\.\d+)[,\s]+(-?\d{1,3}\.\d+)/i
  );
  if (queryParam) return toPair(queryParam[1], queryParam[2]);

  // 3. OpenStreetMap (?mlat=lat&mlon=lng o #map=zoom/lat/lng)
  const osmParam = decoded.match(/[?&]mlat=(-?\d{1,2}\.\d+)&mlon=(-?\d{1,3}\.\d+)/i);
  if (osmParam) return toPair(osmParam[1], osmParam[2]);

  const osmHash = decoded.match(/#map=\d+\/(-?\d{1,2}\.\d+)\/(-?\d{1,3}\.\d+)/i);
  if (osmHash) return toPair(osmHash[1], osmHash[2]);

  // 4. Viewport de Google Maps (@lat,lng)
  const atMatch = decoded.match(/@(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/);
  if (atMatch) return toPair(atMatch[1], atMatch[2]);

  // 5. Fallback en HTML/og:image de Google Maps (center=LAT,LNG o ll=LAT,LNG o [null,null,LAT,LNG])
  const staticCenter = decoded.match(/(?:center|ll)=(-?\d{1,2}\.\d+),(-?\d{1,3}\.\d+)/i);
  if (staticCenter) return toPair(staticCenter[1], staticCenter[2]);

  const direct = decoded.match(/^\s*(-?\d{1,2}\.\d{3,})\s*[,\s]\s*(-?\d{1,3}\.\d{3,})\s*$/);
  if (direct) return toPair(direct[1], direct[2]);

  return null;
}

function extractPlaceQueryFromGoogleMapsUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    const placeMatch = parsed.pathname.match(/\/maps\/place\/([^/]+)/i);
    if (placeMatch?.[1]) {
      return decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
    }
    const q = parsed.searchParams.get('q') || parsed.searchParams.get('query') || '';
    if (q && !extractCoordsFromMapsText(q)) {
      return q.trim();
    }
  } catch {}
  return '';
}

async function reverseGeocodeRaw(latNum: number, lngNum: number): Promise<any | null> {
  const cacheKey = `rodo:geo:rev:${latNum.toFixed(4)}:${lngNum.toFixed(4)}`;
  const cached = await getCache<any>(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latNum}&lon=${lngNum}&zoom=18&addressdetails=1`;
    const response = await fetch(url, {
      headers: {
        'Accept-Language': 'es-MX,es;q=0.9',
        'User-Agent': 'RODO-MotoMandados-SMA-Server/1.0 (soporte@rodomotomandados.com)',
      },
    });
    if (!response.ok) return null;
    const data = await response.json();
    await setCache(cacheKey, data, 86400);
    return data;
  } catch {
    return null;
  }
}

export interface ResolvedMapsLinkPayload {
  lat: number;
  lng: number;
  mapsUrl: string;
  resolvedUrl: string;
  placeName: string;
  street: string;
  streetNumber: string;
  neighborhood: string;
  address: string;
}

async function resolveMapsLinkInSma(rawInput: string): Promise<ResolvedMapsLinkPayload | null> {
  const cleaned = rawInput.trim();
  if (!cleaned) return null;

  const cacheKey = `rodo:geo:mapsurl:${cleaned.toLowerCase()}`;
  const cached = await getCache<ResolvedMapsLinkPayload>(cacheKey);
  if (cached && isValidCoordPair(cached)) {
    return cached;
  }

  let resolvedUrl = cleaned;
  let coords = extractCoordsFromMapsText(cleaned);

  // Si es una URL de mapas válida (especialmente enlaces cortos maps.app.goo.gl / goo.gl/maps), resolvemos redirecciones
  const parsedUrl = isAllowedMapsUrl(cleaned);
  if (parsedUrl && (!coords || parsedUrl.hostname.includes('goo.gl'))) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);
    try {
      const res = await fetch(parsedUrl.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'es-MX,es;q=0.9',
        },
      });
      if (res.url && isAllowedMapsUrl(res.url)) {
        resolvedUrl = res.url;
        coords = extractCoordsFromMapsText(res.url) || coords;
      }
      if (!coords) {
        const html = (await res.text()).slice(0, 80000);
        coords = extractCoordsFromMapsText(html);
      }
    } catch {
      // Continuar con fallback de texto si la redirección falló
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const placeQuery = extractPlaceQueryFromGoogleMapsUrl(resolvedUrl);

  // Si todavía no hay coordenadas pero sí venía un nombre/dirección en /maps/place/..., geocodificar en SMA
  if (!coords && placeQuery) {
    coords = await geocodeAddressInSma(placeQuery);
  }

  if (!coords) return null;

  const rev = await reverseGeocodeRaw(coords.lat, coords.lng);
  const addr = rev?.address || {};

  let street = String(addr.road || addr.pedestrian || addr.street || addr.path || '').trim();
  let streetNumber = addr.house_number
    ? `#${String(addr.house_number).replace(/^#/, '').trim()}`
    : '';
  const neighborhood = String(
    addr.neighbourhood || addr.suburb || addr.quarter || addr.residential || ''
  ).trim();

  // Si el enlace de Google Maps traía calle + número en /maps/place/... y Nominatim no detectó número, extraerlo
  if (placeQuery) {
    const firstSegment = placeQuery.split(',')[0]?.trim() || '';
    if (!streetNumber) {
      const numMatch = firstSegment.match(/(?:#|no\.?\s*)?(\d+[a-zA-Z]?(?:-\w+)?)\s*$/);
      if (numMatch?.[1] && firstSegment.length > numMatch[1].length + 2) {
        streetNumber = `#${numMatch[1]}`;
      }
    }
    if (!street && firstSegment) {
      street = firstSegment
        .replace(/(?:#|no\.?\s*)?\b\d+[a-zA-Z]?(?:-\w+)?\s*$/i, '')
        .trim();
    }
  }

  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`;
  const addressParts = [
    street ? `${street}${streetNumber ? ` ${streetNumber}` : ''}` : '',
    neighborhood ? `Col. ${neighborhood}` : '',
  ].filter(Boolean);

  const payload: ResolvedMapsLinkPayload = {
    lat: coords.lat,
    lng: coords.lng,
    mapsUrl,
    resolvedUrl,
    placeName: placeQuery ? placeQuery.split(',')[0]?.trim() || '' : '',
    street,
    streetNumber,
    neighborhood,
    address: addressParts.join(', ') || `Ubicación (${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)})`,
  };

  await setCache(cacheKey, payload, 86400);
  return payload;
}

export interface SmaAddressSearchResult {
  id: string;
  label: string;
  subtitle: string;
  street: string;
  streetNumber: string;
  neighborhood: string;
  lat: number;
  lng: number;
}

function formatNominatimSuggestion(item: any, idx: number): SmaAddressSearchResult | null {
  const lat = Number(item?.lat);
  const lng = Number(item?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const addr = item?.address || {};
  const rawStreet =
    addr.road ||
    addr.pedestrian ||
    addr.street ||
    addr.path ||
    addr.footway ||
    addr.residential ||
    '';
  const streetNumber = addr.house_number ? `#${String(addr.house_number).replace(/^#/, '')}` : '';
  const neighborhood =
    addr.neighbourhood ||
    addr.suburb ||
    addr.quarter ||
    addr.village ||
    addr.hamlet ||
    '';
  const placeName = item?.name && item.name !== rawStreet ? String(item.name).trim() : '';

  const primaryParts: string[] = [];
  if (placeName && !rawStreet) {
    primaryParts.push(placeName);
  } else if (placeName && rawStreet && !rawStreet.toLowerCase().includes(placeName.toLowerCase())) {
    primaryParts.push(placeName);
    primaryParts.push(`${rawStreet}${streetNumber ? ` ${streetNumber}` : ''}`);
  } else if (rawStreet) {
    primaryParts.push(`${rawStreet}${streetNumber ? ` ${streetNumber}` : ''}`);
  } else if (neighborhood) {
    primaryParts.push(neighborhood);
  } else if (typeof item?.display_name === 'string') {
    primaryParts.push(item.display_name.split(',')[0]?.trim() || 'San Miguel de Allende');
  }

  const label = primaryParts.filter(Boolean).join(' · ') || 'San Miguel de Allende';
  const subtitleParts = [
    neighborhood && !label.toLowerCase().includes(neighborhood.toLowerCase()) ? neighborhood : '',
    addr.city || addr.town || 'San Miguel de Allende',
  ].filter(Boolean);

  return {
    id: String(item?.place_id || `osm-${idx}-${lat.toFixed(5)}-${lng.toFixed(5)}`),
    label,
    subtitle: subtitleParts.join(', '),
    street: rawStreet || placeName,
    streetNumber,
    neighborhood,
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
  };
}

async function searchAddressesInSma(rawQuery: string, limit: number = 6): Promise<SmaAddressSearchResult[]> {
  const cleaned = rawQuery.trim();
  if (cleaned.length < 2) return [];

  const safeLimit = Math.min(Math.max(limit, 1), 8);
  const normalizedKey = cleaned.toLowerCase().replace(/\s+/g, ' ');
  const cacheKey = `rodo:geo:search:${safeLimit}:${normalizedKey}`;
  const cached = await getCache<SmaAddressSearchResult[]>(cacheKey);
  if (Array.isArray(cached) && cached.length > 0) {
    return cached;
  }

  const withoutHouseNumber = cleaned.replace(/(?:#|no\.?\s*|núm\.?\s*)?\b\d+[a-zA-Z]?(?:-\w+)?\b/gi, '').replace(/\s+/g, ' ').trim();
  const hasSmaSuffix = /san\s+miguel/i.test(cleaned);

  const attemptUrls: string[] = [
    `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${safeLimit}&countrycodes=mx&viewbox=${SMA_NOMINATIM_VIEWBOX}&bounded=1&q=${encodeURIComponent(
      hasSmaSuffix ? cleaned : `${cleaned}, San Miguel de Allende, Guanajuato, Mexico`
    )}`,
  ];

  // Si incluye número exterior que OSM no tiene registrado, reintentar sin el número para ubicar la calle
  if (withoutHouseNumber.length >= 3 && withoutHouseNumber.toLowerCase() !== cleaned.toLowerCase()) {
    attemptUrls.push(
      `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${safeLimit}&countrycodes=mx&viewbox=${SMA_NOMINATIM_VIEWBOX}&bounded=1&q=${encodeURIComponent(
        `${withoutHouseNumber}, San Miguel de Allende, Guanajuato, Mexico`
      )}`
    );
  }

  // Fallback por colonia/zona si contiene coma
  if (cleaned.includes(',')) {
    const tail = cleaned.split(',').slice(1).join(',').trim();
    if (tail.length >= 3) {
      attemptUrls.push(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${safeLimit}&countrycodes=mx&viewbox=${SMA_NOMINATIM_VIEWBOX}&bounded=1&q=${encodeURIComponent(
          `${tail}, San Miguel de Allende, Guanajuato, Mexico`
        )}`
      );
    }
  }

  const collected: SmaAddressSearchResult[] = [];
  const seenKeys = new Set<string>();

  for (const url of attemptUrls) {
    try {
      const response = await fetch(url, {
        headers: {
          'Accept-Language': 'es-MX,es;q=0.9',
          'User-Agent': 'RODO-MotoMandados-SMA-Server/1.0 (soporte@rodomotomandados.com)',
        },
      });
      if (!response.ok) continue;
      const results = (await response.json()) as any[];
      if (!Array.isArray(results)) continue;

      for (let i = 0; i < results.length; i++) {
        const formatted = formatNominatimSuggestion(results[i], i);
        if (!formatted) continue;
        const dedupeKey = `${formatted.label.toLowerCase()}|${formatted.lat.toFixed(4)}|${formatted.lng.toFixed(4)}`;
        if (seenKeys.has(dedupeKey)) continue;
        seenKeys.add(dedupeKey);
        collected.push(formatted);
        if (collected.length >= safeLimit) break;
      }

      if (collected.length > 0) {
        break;
      }
    } catch {
      // Continuar al siguiente intento
    }
  }

  if (collected.length > 0) {
    await setCache(cacheKey, collected, 86400);
  }

  return collected;
}

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

    const data = await reverseGeocodeRaw(latNum, lngNum);
    if (!data) {
      return reply.status(502).send({ error: 'Servicio externo de geocodificación no disponible.' });
    }
    return reply.send(data);
  });

  // 1.7 RESOLVER ENLACE DE GOOGLE MAPS (INCLUYENDO ENLACES CORTOS maps.app.goo.gl)
  const handleResolveMapsUrl = async (rawUrl: string | undefined, reply: any) => {
    const cleaned = (rawUrl || '').trim();
    if (!cleaned) {
      return reply.status(400).send({ error: 'Pega un enlace de Google Maps válido.' });
    }

    if (!extractCoordsFromMapsText(cleaned) && !isAllowedMapsUrl(cleaned)) {
      return reply.status(400).send({
        error: 'Enlace no reconocido. Pega un enlace de Google Maps (ej. maps.app.goo.gl/... o google.com/maps/...).',
      });
    }

    const resolved = await resolveMapsLinkInSma(cleaned);
    if (!resolved) {
      return reply.status(422).send({
        error: 'No pudimos extraer la ubicación de ese enlace. Verifica que sea un enlace compartido desde Google Maps.',
      });
    }

    return reply.send(resolved);
  };

  app.post('/api/routing/resolve-maps-url', async (request, reply) => {
    const body = (request.body || {}) as { url?: string };
    return handleResolveMapsUrl(body.url, reply);
  });

  app.get('/api/routing/resolve-maps-url', async (request, reply) => {
    const query = (request.query || {}) as { url?: string };
    return handleResolveMapsUrl(query.url, reply);
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

  // 1.6 AUTOCOMPLETADO Y BÚSQUEDA DE DIRECCIONES EN SMA CON CACHÉ REDIS
  app.get('/api/routing/search', async (request, reply) => {
    const { q, limit } = request.query as { q?: string; limit?: string };
    const cleaned = (q || '').trim();
    if (cleaned.length < 2) {
      return reply.send({ results: [] });
    }

    const parsedLimit = limit ? Number(limit) : 6;
    const results = await searchAddressesInSma(
      cleaned,
      Number.isFinite(parsedLimit) ? parsedLimit : 6
    );
    return reply.send({ results });
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
