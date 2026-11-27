import { z } from 'zod';

const FORBIDDEN_OBJECT_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'adminPasscode',
  'ridersList',
]);

/**
 * Valida que una URL de imagen o enlace externo use únicamente protocolos seguros:
 * - Rutas locales controladas (/uploads/... o /assets/..., sin traversal ni //)
 * - Imágenes raster en base64 (jpeg, jpg, png, webp; excluye svg/html)
 * - Enlaces http:// o https:// bien formados
 * Rechaza estrictamente javascript:, vbscript:, data:text/html, data:image/svg+xml, file:, etc.
 */
export function isSafeHttpOrUploadUrl(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;

  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (trimmed.length > 4096) return false;
  // Bloquear caracteres de control ASCII que algunos navegadores ignoran antes del esquema
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return false;

  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('/assets/')) {
    if (trimmed.startsWith('//') || trimmed.includes('..') || trimmed.includes('\\')) {
      return false;
    }
    return true;
  }

  if (/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export function stripDangerousKeysDeep<T>(input: T, depth = 0): T {
  if (depth > 12 || input === null || typeof input !== 'object') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => stripDangerousKeysDeep(item, depth + 1)) as unknown as T;
  }
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) continue;
    clean[key] = stripDangerousKeysDeep(val, depth + 1);
  }
  return clean as T;
}

const safeOptionalUrlSchema = z
  .string()
  .trim()
  .max(4096)
  .refine((val) => isSafeHttpOrUploadUrl(val), {
    message: 'URL no permitida. Solo se aceptan enlaces https://, http:// o rutas /uploads/.',
  })
  .optional();

const specialtyCategorySchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  iconType: z.enum([
    'super',
    'pizza',
    'desayuno',
    'pollo',
    'hamburguesa',
    'tacos',
    'mariscos',
    'pan',
    'tienda',
    'farmacia',
    'flores',
    'personalizado',
  ]),
  iconUrl: safeOptionalUrlSchema,
  active: z.boolean(),
  order: z.number().finite().min(0).max(1000),
  description: z.string().trim().max(300).optional(),
});

const coverageZoneSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(120),
  active: z.boolean(),
  radiusKm: z.number().finite().min(0).max(200),
  referenceStreet: z.string().trim().max(200),
  centerLat: z.number().finite().min(-90).max(90).optional(),
  centerLng: z.number().finite().min(-180).max(180).optional(),
});

const coordinateSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

const holidayThemeEnum = z.enum([
  'clasico_rodo',
  'navidad',
  'ano_nuevo',
  'nochebuena',
  'san_valentin',
  'dia_de_las_madres',
  'dia_del_padre',
  'dia_del_grito',
]);

export const dispatchSettingsUpdateSchema = z
  .object({
    defaultRider1Name: z.string().trim().max(120),
    defaultRider1Phone: z.string().trim().max(30),
    defaultRider2Name: z.string().trim().max(120),
    defaultRider2Phone: z.string().trim().max(30),
    clabeRodo: z.string().trim().max(40),
    bancoRodo: z.string().trim().max(100),
    titularRodo: z.string().trim().max(140),
    supportPhone: z.string().trim().max(30),
    expressDeliverySurcharge: z.number().finite().min(0).max(2000),
    expressDeliveryEnabled: z.boolean(),
    scheduledDeliveryEnabled: z.boolean(),
    magnaPricePerLiter: z.number().finite().min(0).max(500),
    premiumPricePerLiter: z.number().finite().min(0).max(500),
    festiveModeEnabled: z.boolean(),
    festiveModeMessage: z.string().trim().max(600),
    festiveEstimatedDelay: z.string().trim().max(80),
    rainPauseEnabled: z.boolean(),
    rainPauseMessage: z.string().trim().max(600),
    specialtiesCatalog: z.array(specialtyCategorySchema).max(60),
    coverageZones: z.array(coverageZoneSchema).max(100),
    coveragePolygon: z.array(coordinateSchema).max(500),
    baseDeliveryTariff: z.number().finite().min(0).max(2000),
    tariffPerKm: z.number().finite().min(0).max(500),
    globalMarkupPercent: z.number().finite().min(0).max(100),
    globalMarkupFixed: z.number().finite().min(0).max(1000),
    autoRoutingEnabled: z.boolean(),
    activeHolidayTheme: holidayThemeEnum,
    holidayThemeId: holidayThemeEnum,
  })
  .partial()
  .strip();

const productCustomizationSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  price: z.number().finite().min(0).max(10000),
  type: z.enum(['removal', 'extra']),
});

const menuItemOptionGroupSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  required: z.boolean().optional(),
  minSelect: z.number().int().min(0).max(50).optional(),
  maxSelect: z.number().int().min(0).max(50),
  hasLimit: z.boolean().optional(),
  allowRepeat: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(120)).min(1).max(60),
});

const comboSideOptionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).optional(),
  image: safeOptionalUrlSchema.default(''),
  priceExtra: z.number().finite().min(0).max(10000).optional(),
});

const comboMainDishOptionSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).optional(),
  image: safeOptionalUrlSchema.default(''),
  priceExtra: z.number().finite().min(0).max(10000).optional(),
  isSpicy: z.boolean().optional(),
});

const comboBuilderConfigSchema = z.object({
  maxGuisados: z.number().int().min(1).max(10),
  allowDuplicateGuisados: z.boolean().optional(),
  sideOptions: z.array(comboSideOptionSchema).max(40),
  mainDishOptions: z.array(comboMainDishOptionSchema).max(80),
});

const menuItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(600).default(''),
  price: z.number().finite().min(0).max(50000),
  originalPrice: z.number().finite().min(0).max(50000).optional(),
  surcharge: z.number().finite().min(0).max(10000).optional(),
  image: safeOptionalUrlSchema,
  category: z.string().trim().max(100).optional(),
  isAvailable: z.boolean().optional(),
  stockLevel: z.number().int().min(0).max(100000).optional(),
  optionGroups: z.array(menuItemOptionGroupSchema).max(20).optional(),
  customizations: z.array(productCustomizationSchema).max(40).optional(),
  isComboBuilder: z.boolean().optional(),
  comboConfig: comboBuilderConfigSchema.optional(),
});

const localAddressSchema = z.object({
  calle: z.string().trim().max(200).default('Centro'),
  numero: z.string().trim().max(60).default('S/N'),
  colonia: z.string().trim().max(160).default('Centro'),
  referencias: z.string().trim().max(400).optional(),
  lat: z.number().finite().min(-90).max(90).optional(),
  lng: z.number().finite().min(-180).max(180).optional(),
  mapsUrl: safeOptionalUrlSchema,
});

export const restaurantUpsertSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1, 'El nombre del establecimiento es obligatorio.').max(160),
    establishmentType: z.enum(['restaurante', 'motomandado']).default('restaurante'),
    category: z.string().trim().min(1).max(100).default('General'),
    rating: z.string().trim().max(20).default('4.8'),
    reviews: z.string().trim().max(40).default('Nuevo'),
    time: z.string().trim().max(60).default('25-35 min'),
    priceRange: z.enum(['$', '$$', '$$$', '$$$$']).optional(),
    schedule: z.string().trim().max(120).optional(),
    deliveryFee: z.number().finite().min(0).max(2000).default(35),
    commissionRate: z.number().finite().min(0).max(100).default(15),
    acceptsTransfer: z.boolean().default(true),
    acceptsCash: z.boolean().default(true),
    bankDetails: z.string().trim().max(300).optional(),
    image: safeOptionalUrlSchema.default(''),
    tags: z.array(z.string().trim().max(60)).max(30).default([]),
    badge: z.string().trim().max(100).optional(),
    description: z.string().trim().max(800).default(''),
    isActive: z.boolean().default(true),
    isOpen: z.boolean().default(true),
    workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    closureReason: z.string().trim().max(300).optional(),
    isPopular: z.boolean().optional(),
    popularityRank: z.number().int().min(0).max(10000).optional(),
    orderCount: z.number().int().min(0).max(10000000).optional(),
    suggestedExtras: z.array(menuItemSchema).max(40).optional(),
    promoActive: z.boolean().optional(),
    promoLabel: z.string().trim().max(120).optional(),
    promoDiscountPercent: z.number().finite().min(0).max(100).optional(),
    hasFixedMenu: z.boolean().optional(),
    customOrderHint: z.string().trim().max(400).optional(),
    prepTimeMinutes: z.number().int().min(0).max(600).optional(),
    address: localAddressSchema.optional(),
    coordinates: coordinateSchema.optional(),
    mapsUrl: safeOptionalUrlSchema,
    markupPercent: z.number().finite().min(0).max(100).optional(),
    markupFixed: z.number().finite().min(0).max(5000).optional(),
    customServiceHours: z
      .object({
        open: z.string().trim().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'La hora de apertura debe tener formato HH:MM.'),
        close: z.string().trim().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'La hora de cierre debe tener formato HH:MM.'),
        enabled: z.boolean(),
      })
      .refine((hours) => !hours.enabled || hours.open !== hours.close, 'La apertura y el cierre deben ser diferentes.')
      .optional(),
    localCode: z.string().trim().max(10).optional(),
    phone: z.string().trim().max(30).optional(),
    contactPerson: z.string().trim().max(120).nullable().optional(),
    menu: z.array(menuItemSchema).max(500).default([]),
  })
  .strip();

export const partnerLocalUpsertSchema = z
  .object({
    id: z.string().trim().min(1).max(120).optional(),
    code: z.string().trim().regex(/^\d{3,4}$/, 'El código de local debe tener 3 o 4 dígitos numéricos.'),
    name: z.string().trim().min(1, 'El nombre del local es obligatorio.').max(160),
    phone: z.string().trim().max(30).default(''),
    serviceFee: z.number().finite().min(0).max(2000).default(35),
    address: localAddressSchema.default({ calle: 'Centro', numero: 'S/N', colonia: 'Centro' }),
    contactPerson: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .strip();

export function validateDispatchSettingsPayload(raw: unknown):
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: false, error: 'Configuración inválida.' };
  }
  const stripped = stripDangerousKeysDeep(raw as Record<string, unknown>);
  const parsed = dispatchSettingsUpdateSchema.safeParse(stripped);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      success: false,
      error: issue?.message || 'Formato inválido en la configuración operativa.',
    };
  }
  return { success: true, data: parsed.data as Record<string, unknown> };
}

export function validateRestaurantPayload(raw: unknown):
  | { success: true; data: z.infer<typeof restaurantUpsertSchema> }
  | { success: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: false, error: 'Datos del restaurante inválidos.' };
  }
  const stripped = stripDangerousKeysDeep(raw as Record<string, unknown>);
  const parsed = restaurantUpsertSchema.safeParse(stripped);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      success: false,
      error: issue?.message || 'Datos del restaurante inválidos o con enlaces no permitidos.',
    };
  }
  return { success: true, data: parsed.data };
}

export function validatePartnerLocalPayload(raw: unknown):
  | { success: true; data: z.infer<typeof partnerLocalUpsertSchema> }
  | { success: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { success: false, error: 'Datos del local asociado inválidos.' };
  }
  const stripped = stripDangerousKeysDeep(raw as Record<string, unknown>);
  const parsed = partnerLocalUpsertSchema.safeParse(stripped);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      success: false,
      error: issue?.message || 'Nombre y código válido de 3 dígitos son obligatorios.',
    };
  }
  return { success: true, data: parsed.data };
}
