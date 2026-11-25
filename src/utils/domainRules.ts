/**
 * Reglas Puras de Dominio y Seguridad Server-Side para RODO Moto Mandados
 * Centraliza la lógica crítica de negocio para validación determinista y pruebas unitarias.
 */

export function calculateIneCicCheckDigit(first9: string): number {
  const weights = [7, 3, 1, 7, 3, 1, 7, 3, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(first9[i] || '0', 10) * weights[i];
  }
  return sum % 10;
}

export function verifyIneDigitsServer(digits: string): { valid: boolean; reason?: string } {
  const clean = String(digits || '').replace(/[^0-9]/g, '');
  if (clean.length !== 10) {
    return {
      valid: false,
      reason: 'El número del reverso del INE debe tener exactamente 10 dígitos.',
    };
  }
  if (
    /^(\d)\1{9}$/.test(clean) ||
    clean === '1234567890' ||
    clean === '0123456789' ||
    clean === '9876543210'
  ) {
    return {
      valid: false,
      reason: 'Secuencia numérica inválida. Ingresa los 10 dígitos reales del reverso de tu INE.',
    };
  }
  const uniqueCount = new Set(clean.split('')).size;
  if (uniqueCount < 3) {
    return {
      valid: false,
      reason: 'Los dígitos ingresados parecen repetitivos o no válidos. Verifica el reverso de tu INE.',
    };
  }

  const expectedCheckDigit = calculateIneCicCheckDigit(clean.slice(0, 9));
  const actualCheckDigit = parseInt(clean[9], 10);

  let luhnSum = 0;
  for (let i = 0; i < 9; i++) {
    let digit = parseInt(clean[i], 10);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    luhnSum += digit;
  }
  const expectedLuhn = (10 - (luhnSum % 10)) % 10;

  if (actualCheckDigit !== expectedCheckDigit && actualCheckDigit !== expectedLuhn) {
    return {
      valid: false,
      reason: `El dígito verificador final (${actualCheckDigit}) no coincide con el algoritmo de control matemático del INE (esperado ${expectedCheckDigit}).`,
    };
  }

  return { valid: true };
}

export function getServerCustomerCashLimit(completedOrdersCount: number): number {
  if (completedOrdersCount <= 0) return 300;
  if (completedOrdersCount === 1) return 400;
  if (completedOrdersCount === 2) return 500;
  return 1000;
}

const RIDER_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  asignado: ['recolectado'],
  recolectado: ['en_camino'],
  en_camino: ['afuera_del_domicilio'],
  afuera_del_domicilio: ['entregado'],
};

export function canRiderTransitionOrderStatus(fromStatus: string, toStatus: string): boolean {
  return RIDER_STATUS_TRANSITIONS[fromStatus]?.includes(toStatus) ?? false;
}

const ADMIN_TRANSITIONS: Record<string, readonly string[]> = {
  pendiente_cotizacion: ['cancelado'],
  nuevo: ['en_preparacion', 'asignado', 'afuera_del_domicilio', 'cancelado'],
  en_preparacion: ['asignado', 'afuera_del_domicilio', 'cancelado'],
  asignado: ['nuevo', 'recolectado', 'afuera_del_domicilio', 'cancelado'],
  recolectado: ['en_camino', 'afuera_del_domicilio', 'cancelado'],
  en_camino: ['afuera_del_domicilio', 'cancelado'],
  afuera_del_domicilio: ['entregado', 'cancelado', 'cancelado_con_deuda'],
  entregado: [], cancelado: [], cancelado_con_deuda: [],
};

export function isOrderStatus(status: string) { return Object.hasOwn(ADMIN_TRANSITIONS, status); }

export function allowedOrderTransitions(role: string, order: {
  status: string; assignedRiderUserId?: string | null; assignedRiderName?: string | null;
  paymentMethod: string; paymentStatus: string; quoteOffered?: boolean;
}): readonly string[] {
  if (!isOrderStatus(order.status)) return [];
  if (role === 'CUSTOMER' || role === 'PARTNER_LOCAL') {
    if (order.status === 'pendiente_cotizacion') return order.quoteOffered ? ['nuevo', 'cancelado'] : ['cancelado'];
    return [];
  }
  const targets = role === 'ADMIN' ? ADMIN_TRANSITIONS[order.status] : role === 'RIDER' ? RIDER_STATUS_TRANSITIONS[order.status] || [] : [];
  const hasAssignedRider = Boolean(order.assignedRiderUserId || order.assignedRiderName);
  return targets.filter(to => {
    if (role === 'ADMIN' && to === 'afuera_del_domicilio') {
      return true;
    }
    if (['asignado','recolectado','en_camino','afuera_del_domicilio','entregado'].includes(to)) {
      return hasAssignedRider && (order.paymentMethod !== 'transferencia' || order.paymentStatus === 'verificado');
    }
    return true;
  });
}

export function validateSpeiTrackingKeyFormat(rawKey: string): {
  valid: boolean;
  cleanKey: string;
  reason?: string;
} {
  const cleanKey = String(rawKey || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');

  if (!cleanKey || cleanKey.length < 6 || cleanKey.length > 35 || !/^[A-Z0-9_-]+$/.test(cleanKey)) {
    return {
      valid: false,
      cleanKey,
      reason:
        'Clave de rastreo SPEI o referencia inválida. Debe contener entre 6 y 35 caracteres alfanuméricos sin espacios.',
    };
  }

  if (
    /^([0-9A-Z])\1{5,}$/.test(cleanKey) ||
    /^(123456|1234567|12345678|654321|ABCDEF|PRUEBA|TEST00|000000|111111)$/.test(cleanKey)
  ) {
    return {
      valid: false,
      cleanKey,
      reason:
        'Alerta antifraude: La clave ingresada es una secuencia de prueba y no corresponde a una liquidación SPEI válida.',
    };
  }

  return { valid: true, cleanKey };
}

export function validateGpsCoordinates(
  lat: unknown,
  lng: unknown
): { valid: boolean; lat: number; lng: number; isWithinSmaRegion: boolean } {
  const latNum = Number(lat);
  const lngNum = Number(lng);

  if (
    typeof lat === 'boolean' ||
    typeof lng === 'boolean' ||
    lat === null ||
    lng === null ||
    lat === '' ||
    lng === '' ||
    Number.isNaN(latNum) ||
    Number.isNaN(lngNum) ||
    !Number.isFinite(latNum) ||
    !Number.isFinite(lngNum)
  ) {
    return { valid: false, lat: 0, lng: 0, isWithinSmaRegion: false };
  }

  if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
    return { valid: false, lat: latNum, lng: lngNum, isWithinSmaRegion: false };
  }

  // Región ampliada de San Miguel de Allende y alrededores (Guanajuato / Querétaro)
  const isWithinSmaRegion =
    latNum >= 20.7 && latNum <= 21.15 && lngNum >= -101.0 && lngNum <= -100.5;

  return {
    valid: true,
    lat: Number(latNum.toFixed(6)),
    lng: Number(lngNum.toFixed(6)),
    isWithinSmaRegion,
  };
}


export function getRiderGpsPing(
  user: { sub?: string; role?: string; sid?: string; exp?: number } | undefined,
  payload: { orderId?: unknown; lat?: unknown; lng?: unknown } | null,
  now = Date.now()
) {
  if (user?.role !== 'RIDER' || !user.sub || !user.sid || !user.exp || user.exp * 1000 <= now) return null;
  if (typeof payload?.orderId !== 'string' || !payload.orderId.trim()) return null;
  if (typeof payload.lat !== 'number' || typeof payload.lng !== 'number') return null;
  const point = validateGpsCoordinates(payload.lat, payload.lng);
  if (!point.valid) return null;
  return { riderId: user.sub, sessionId: user.sid, orderId: payload.orderId,
    coordinates: { lat: point.lat, lng: point.lng } };
}
