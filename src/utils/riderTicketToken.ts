import crypto from 'node:crypto';

const DEFAULT_RIDER_TOKEN_SECRET = 'rodo_super_secret_jwt_key_sma_2026_enterprise';

export const RESTAURANT_TRACKING_STATUSES = [
  'recibido',
  'en_cocina',
  'en_camino',
  'completado',
] as const;

export type RestaurantTrackingStatus = (typeof RESTAURANT_TRACKING_STATUSES)[number];

export const RESTAURANT_TRACKING_LABELS: Record<RestaurantTrackingStatus, string> = {
  recibido: 'Recibido',
  en_cocina: 'En cocina',
  en_camino: 'En camino',
  completado: 'Completado',
};

export function isRestaurantTrackingStatus(value: unknown): value is RestaurantTrackingStatus {
  return (
    typeof value === 'string' &&
    (RESTAURANT_TRACKING_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Solo los tickets generados en el apartado de restaurantes (menú fijo o abierto de restaurante)
 * usan el flujo exclusivo de estatus del repartidor.
 */
export function isRestaurantTicketOrder(order: { orderType?: string | null }): boolean {
  return (
    !order.orderType ||
    order.orderType === 'comida' ||
    order.orderType === 'pedido_personalizado'
  );
}

export function getOrderAssignedRiderKey(order: {
  assignedRiderUserId?: string | null;
  assignedRiderName?: string | null;
  payload?: unknown;
}): string {
  const payload =
    order.payload && typeof order.payload === 'object'
      ? (order.payload as Record<string, unknown>)
      : {};
  const directoryId =
    typeof payload.assignedRiderId === 'string' ? payload.assignedRiderId.trim() : '';
  const userId = typeof order.assignedRiderUserId === 'string' ? order.assignedRiderUserId.trim() : '';
  const name = typeof order.assignedRiderName === 'string' ? order.assignedRiderName.trim() : '';
  return directoryId || userId || name;
}

export function createRiderTicketToken(
  orderId: string,
  riderKey: string,
  secret: string = process.env.JWT_SECRET || DEFAULT_RIDER_TOKEN_SECRET
): string {
  const cleanOrderId = orderId.trim();
  const cleanRiderKey = riderKey.trim();
  if (!cleanOrderId || !cleanRiderKey) return '';
  return crypto
    .createHmac('sha256', secret)
    .update(`rodo-rider-ticket-v1:${cleanOrderId}:${cleanRiderKey}`)
    .digest('hex')
    .slice(0, 32);
}

export function verifyRiderTicketToken(
  orderId: string,
  riderKey: string,
  providedToken: unknown,
  secret: string = process.env.JWT_SECRET || DEFAULT_RIDER_TOKEN_SECRET
): boolean {
  if (typeof providedToken !== 'string' || !providedToken.trim()) return false;
  const expected = createRiderTicketToken(orderId, riderKey, secret);
  if (!expected) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(providedToken.trim(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function mapRestaurantTrackingToOrderStatus(
  status: RestaurantTrackingStatus
): 'asignado' | 'en_preparacion' | 'en_camino' | 'entregado' {
  switch (status) {
    case 'recibido':
      return 'asignado';
    case 'en_cocina':
      return 'en_preparacion';
    case 'en_camino':
      return 'en_camino';
    case 'completado':
      return 'entregado';
  }
}

export function canAdvanceRestaurantTrackingStatus(
  currentTracking: RestaurantTrackingStatus | null | undefined,
  currentOrderStatus: string,
  next: RestaurantTrackingStatus
): boolean {
  if (['entregado', 'cancelado', 'cancelado_con_deuda'].includes(currentOrderStatus)) {
    return false;
  }
  if (!currentTracking) return true;
  const currentIdx = RESTAURANT_TRACKING_STATUSES.indexOf(currentTracking);
  const nextIdx = RESTAURANT_TRACKING_STATUSES.indexOf(next);
  if (nextIdx < 0) return false;
  return nextIdx > currentIdx;
}
