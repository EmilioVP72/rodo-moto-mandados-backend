import bcrypt from 'bcryptjs';
import { prisma } from '../infra/prisma.js';
import { env } from '../config/env.js';

const INITIAL_PARTNER_LOCALS = [
  {
    id: 'loc-101',
    code: '101',
    name: 'Tacos Sebastián',
    phone: '4151234567',
    serviceFee: 35,
    address: {
      calle: 'Calle Hidalgo',
      numero: '45-B',
      colonia: 'Centro',
      referencias: 'Frente a la plazuela, puerta de madera grande',
      lat: 20.9144,
      lng: -100.7437,
      mapsUrl: 'https://maps.google.com/?q=20.9144,-100.7437',
    },
    contactPerson: 'Don Sebastián Cruz',
    notes: 'Preparación de 10 a 15 min. Sacar primero órdenes de bistec.',
    isActive: true,
  },
  {
    id: 'loc-102',
    code: '102',
    name: 'Little Caesars Pizza',
    phone: '4159876543',
    serviceFee: 40,
    address: {
      calle: 'Calzada de la Aurora',
      numero: '12',
      colonia: 'La Aurora',
      referencias: 'Junto a la gasolinera',
      lat: 20.9205,
      lng: -100.7380,
      mapsUrl: 'https://maps.google.com/?q=20.9205,-100.7380',
    },
    contactPerson: 'Gerente en Turno',
    notes: 'Entregar ticket en mostrador de salida rápida.',
    isActive: true,
  },
  {
    id: 'loc-103',
    code: '103',
    name: 'Tacos Don Santos',
    phone: '4151122334',
    serviceFee: 40,
    address: {
      calle: 'Calzada de la Estación',
      numero: '28',
      colonia: 'San Antonio',
      referencias: 'Cerca del puente, puesto tradicional',
      lat: 20.9112,
      lng: -100.7511,
      mapsUrl: 'https://maps.google.com/?q=20.9112,-100.7511',
    },
    contactPerson: 'Don Santos',
    notes: 'Tacos calientes empacados en aluminio para viaje.',
    isActive: true,
  },
  {
    id: 'loc-104',
    code: '104',
    name: 'Comida China Mesones',
    phone: '4151526789',
    serviceFee: 40,
    address: {
      calle: 'Calle Mesones',
      numero: '38',
      colonia: 'Centro',
      referencias: 'Entre Relox e Hidalgo',
      lat: 20.9158,
      lng: -100.7442,
      mapsUrl: 'https://maps.google.com/?q=20.9158,-100.7442',
    },
    contactPerson: 'Encargado de Mostrador',
    notes: 'Platillos en charola sellada con guisados seleccionados.',
    isActive: true,
  },
  {
    id: 'loc-105',
    code: '105',
    name: 'Ferechiken Las Alamedas',
    phone: '4151019920',
    serviceFee: 40,
    address: {
      calle: 'Avenida Central',
      numero: '96',
      colonia: 'Santa Cruz de La Paz',
      referencias: 'Frente a Las Alamedas',
      lat: 20.9023,
      lng: -100.7634,
      mapsUrl: 'https://maps.google.com/?q=20.9023,-100.7634',
    },
    contactPerson: 'Ferechiken Encargado',
    notes: 'Llevar salsas, tortillas y complementos bien empacados.',
    isActive: true,
  },
];

const INITIAL_DEBTOR_ACCOUNTS = [
  {
    id: 'cust-fraud-1',
    name: 'Roberto Gómez M.',
    phone: '4151998877',
    email: 'roberto.g@ejemplo.com',
    ineVerified: true,
    ine10Digits: '8942105434',
    inePhotoUploaded: true,
    pendingDebt: 340,
    debtReason:
      'Repartidor esperó 10 min en domicilio con pedido de tacos y el cliente no salió ni contestó.',
    debtOrderFolio: 'RD-261027-0091',
    debtDate: '27 Oct 2026',
    status: 'bloqueado_fraude' as const,
    completedOrdersCount: 0,
  },
  {
    id: 'cust-debt-2',
    name: 'Carlos Mendoza L.',
    phone: '4151332211',
    email: 'carlos.mza@ejemplo.com',
    ineVerified: true,
    ine10Digits: '5512349872',
    inePhotoUploaded: true,
    pendingDebt: 280,
    debtReason: 'Cancelación tardía en puerta al momento de entrega en efectivo.',
    debtOrderFolio: 'RD-261026-0045',
    debtDate: '26 Oct 2026',
    status: 'bloqueado_fraude' as const,
    completedOrdersCount: 1,
  },
];

export async function runInitialDatabaseSeed(): Promise<void> {
  try {
    // 1. Asegurar cuenta maestra de Administrador con contraseña encriptada (Bcrypt)
    const adminEmail = env.ADMIN_EMAIL.toLowerCase();
    const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
    if (!existingAdmin) {
      const passwordHash = await bcrypt.hash(env.ADMIN_INITIAL_PASSWORD, 10);
      await prisma.user.create({
        data: {
          id: 'admin-master-rodo',
          name: 'Edson Cruz · Admin Central RODO',
          phone: '4151019920',
          email: adminEmail,
          passwordHash,
          role: 'ADMIN',
          ineVerified: true,
          status: 'activo',
        },
      });
      console.log(`[Seed] Master Admin account initialized (${adminEmail})`);
    }

    // 2. Asegurar cuentas de muestra en lista de control antifraude / deudas INE
    for (const acc of INITIAL_DEBTOR_ACCOUNTS) {
      const exists = await prisma.user.findUnique({ where: { email: acc.email } });
      if (!exists) {
        await prisma.user.create({
          data: {
            ...acc,
            role: 'CUSTOMER',
          },
        });
      }
    }

    // 3. Asegurar Locales Asociados por defecto
    const partnerCount = await prisma.partnerLocal.count();
    if (partnerCount === 0) {
      for (const loc of INITIAL_PARTNER_LOCALS) {
        await prisma.partnerLocal.create({
          data: {
            id: loc.id,
            code: loc.code,
            name: loc.name,
            phone: loc.phone,
            serviceFee: loc.serviceFee,
            address: loc.address,
            contactPerson: loc.contactPerson,
            notes: loc.notes,
            isActive: loc.isActive,
          },
        });
      }
      console.log(`[Seed] ${INITIAL_PARTNER_LOCALS.length} Partner Locals seeded`);
    }
  } catch (err) {
    console.error('[Seed] Warning during initial database seed:', err);
  }
}
