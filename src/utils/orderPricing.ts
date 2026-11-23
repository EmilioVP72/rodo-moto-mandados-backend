// Catalog values and route fees are loaded by the server. The order supplies selections only.
type Selection = { id: string; name: string; price?: number; type?: string; priceExtra?: number };
type Product = {
  id: string; name: string; price: number; surcharge?: number; isAvailable?: boolean; stockLevel?: number;
  customizations?: Selection[];
  isComboBuilder?: boolean;
  comboConfig?: { sideOptions?: Selection[]; mainDishOptions?: Selection[]; maxGuisados?: number };
};
type Item = {
  id: string; quantity: number; notes?: string; selectedModifiers?: { id: string }[];
  comboDetails?: { sideName: string; mainDishes: { name: string; quantity: number }[] };
  customizations?: string[];
};

const defaultExtras: Product[] = [
  { id: 'ext-coca-chk', name: 'Coca-Cola 600ml', price: 30 },
  { id: 'ext-agua-chk', name: 'Agua Fresca Natural 1L', price: 35 },
  { id: 'ext-papas-chk', name: 'Papas a la Francesa', price: 45 },
];
const defaultSides = ['Arroz Frito Cantonés','Espagueti Chino (Chow Mein)','Mitad y Mitad (Arroz + Espagueti)','Verduras Salteadas al Wok'];
const defaultMains = ['Pollo Naranja Crujiente','Res con Brócoli Tradicional','Pollo Kung Pao Picantito','Costillitas BBQ Cantonesas','Pollo Teriyaki con Ajonjolí','Cerdo Agridulce Imperial','Pollo con Champiñones','Camarones al Wok Especiales'];
export class PriceError extends Error {}
function quantity(value: number, max = 999) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new PriceError('Cantidad de artículos inválida.');
  return value;
}
export function money(value: number) {
  if (!Number.isFinite(value) || value < 0 || value > 1e8) throw new PriceError('Importe inválido.');
  return Math.round(value * 100) / 100;
}
function optionFee(name: string, options: Selection[] | undefined, defaults: string[]) {
  if (options?.length) {
    const option = options.find(x => x.name === name);
    if (option) return money(option.priceExtra ?? 0);
  } else if (defaults.includes(name)) return name === 'Camarones al Wok Especiales' ? 20 : 0;
  throw new PriceError('La opción del combo ya no está disponible.');
}
function linePrice(line: Item, products: Map<string, Product>) {
  const product = products.get(line?.id) ?? products.get(String(line?.id).replace(/(?:-combo)?-\d{13}$/, ''));
  if (!product || product.isAvailable === false || product.stockLevel === 0) throw new PriceError('Un producto ya no está disponible en el catálogo.');
  const qty = quantity(line.quantity);
  const choices = new Set((line.selectedModifiers || []).map(m => m.id));
  let extra = 0;
  for (const id of choices) {
    const modifier = product.customizations?.find(m => m.id === id);
    if (!modifier) throw new PriceError('Un modificador ya no está disponible.');
    if (modifier.type === 'extra') extra += money(modifier.price ?? 0);
  }
  const combo = line.comboDetails;
  if ((product.isComboBuilder || product.comboConfig || product.name.toLowerCase().includes('guisado')) && !combo) {
    throw new PriceError('Selecciona la guarnición y los guisados.');
  }
  if (combo) {
    const config = product.comboConfig;
    extra += optionFee(combo.sideName, config?.sideOptions, defaultSides);
    if (!Array.isArray(combo.mainDishes) || !combo.mainDishes.length) throw new PriceError('Selecciona los guisados.');
    let count = 0;
    for (const main of combo.mainDishes) {
      count += quantity(main.quantity, 4);
      extra += main.quantity * optionFee(main.name, config?.mainDishOptions, defaultMains);
    }
    if (count !== (config?.maxGuisados ?? Number(product.name.match(/([1-4]) guisado/i)?.[1] ?? 2))) throw new PriceError('Cantidad de guisados inválida.');
  }
  return { ...line, id: line.id, name: product.name, quantity: qty, unitExtraPrice: money(extra),
    price: money(product.price + extra), surcharge: product.surcharge };
}
const coupons: Record<string, number> = { RODO10: 10, RODO15: 15, RODO20: 20, SMA15: 15, ENVIOGRATIS: 100, ENVIO50: 50 };
export function priceFoodOrder(input: { items: Item[]; promoCode?: string; tipAmount?: number }, catalog: {
  menu: Product[]; suggestedExtras?: Product[]; deliveryFee: number; commissionRate: number; promoPercent: number;
}) {
  if (!Array.isArray(input.items) || !input.items.length) throw new PriceError('El pedido debe incluir productos.');
  const products = new Map([...catalog.menu, ...(catalog.suggestedExtras ?? defaultExtras)].map(p => [p.id, p]));
  const items = input.items.map(line => linePrice(line, products));
  const subtotal = money(items.reduce((n,i) => n + i.price * i.quantity, 0));
  const markup = items.reduce((n,i) => n + ((i.surcharge ?? 0) > 0 ? i.surcharge! : Math.round(i.price * 0.15)) * i.quantity, 0);
  const promotion = money(Math.round(markup * catalog.promoPercent / 100));
  const code = String(input.promoCode || '').trim().toUpperCase();
  if (code && !Object.hasOwn(coupons, code)) throw new PriceError('Cupón no válido.');
  const shippingCoupon = code === 'ENVIOGRATIS' || code === 'ENVIO50';
  const discount = Math.round((shippingCoupon ? catalog.deliveryFee : subtotal) * (coupons[code] || 0) / 100);
  const deliveryFee = money(catalog.deliveryFee - (shippingCoupon ? discount : 0));
  const tipAmount = money(input.tipAmount ?? 0);
  const total = money(Math.max(0, subtotal - promotion - (shippingCoupon ? 0 : discount)) + deliveryFee + tipAmount);
  return { items, subtotal, total, tipAmount, deliveryFee, promoDiscountApplied: promotion + discount,
    commissionAmount: money(Math.max(0, subtotal * catalog.commissionRate / 100 - promotion)) };
}
export function initialOrderPayment(method: string, reference?: string) {
  if (method === 'efectivo') return { paymentStatus: 'en_efectivo', bankVerification: null };
  if (method !== 'transferencia') throw new PriceError('Método de pago desconocido.');
  return { paymentStatus: 'pendiente', bankVerification: {
    trackingKey: reference || '', verified: false, statusMessage: 'Pendiente de confirmación por despacho.',
  } };
}

export function priceFuelRequest(liters: number, fuelType: string, settings: { magnaPricePerLiter?: number; premiumPricePerLiter?: number }) {
  if (![1, 2, 3].includes(liters) || !['magna', 'premium'].includes(fuelType)) throw new PriceError('Combustible o litros inválidos.');
  const fuelPricePerLiter = money(fuelType === 'magna' ? settings.magnaPricePerLiter ?? 24.5 : settings.premiumPricePerLiter ?? 26.8);
  return { liters, fuelType, fuelPricePerLiter, fuelTotal: money(liters * fuelPricePerLiter), serviceTravelFee: 0 };
}
