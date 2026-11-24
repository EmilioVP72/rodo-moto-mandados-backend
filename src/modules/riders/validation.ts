import { z } from 'zod';

export const riderRegistration = z.object({
  name: z.string().trim().min(2, 'Ingresa el nombre del repartidor.').max(120),
  phone: z.string().trim().max(32).regex(/^[+\d\s()-]+$/, 'Teléfono inválido.').refine(
    value => value.replace(/\D/g, '').length >= 8, 'Ingresa un teléfono de al menos 8 dígitos.'),
  email: z.string().trim().email('Ingresa un correo válido.').max(254).transform(value => value.toLowerCase()),
  password: z.string().min(8, 'La contraseña requiere al menos 8 caracteres.').max(128),
  available: z.boolean().optional(),
}).strict();
export const riderChanges = riderRegistration.partial().refine(value => Object.keys(value).length > 0, 'Faltan los cambios.');
