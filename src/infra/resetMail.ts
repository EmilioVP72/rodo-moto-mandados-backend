import nodemailer from 'nodemailer';

export const recoveryReceipt = {
  ok: true,
  message: 'Si la cuenta existe, recibirás en su correo un código válido por 15 minutos.',
};

export function resetMailTransport(config: NodeJS.ProcessEnv = process.env) {
  if (!config.SMTP_HOST || !config.SMTP_FROM) return null;
  const port = Number(config.SMTP_PORT || 587);
  return nodemailer.createTransport({
    host: config.SMTP_HOST, port, secure: port === 465,
    requireTLS: config.NODE_ENV !== 'test',
    connectionTimeout: 8000, socketTimeout: 10000,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
  });
}

export function recoveryMessage(to: string, code: string, from: string) {
  return { to, from, subject: 'Recuperación de contraseña RODO',
    text: 'Tu código de recuperación de RODO es ' + code + '. Vence en 15 minutos.' };
}
