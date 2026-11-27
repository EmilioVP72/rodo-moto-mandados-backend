const TIME_ZONE = 'America/Mexico_City';

function timeParts(now: Date): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIME_ZONE,
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === 'weekday')?.value || 'Sun';
  return {
    day: Math.max(0, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)),
    minutes: Number(parts.find((part) => part.type === 'hour')?.value || 0) * 60
      + Number(parts.find((part) => part.type === 'minute')?.value || 0),
  };
}

function parseTime(value: unknown): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
}

export function getRestaurantUnavailableReason(payload: any, now = new Date()): string | null {
  const current = timeParts(now);
  if (Array.isArray(payload?.workingDays) && !payload.workingDays.includes(current.day)) {
    return 'El restaurante no recibe pedidos hoy, es su día de descanso.';
  }
  const hours = payload?.customServiceHours;
  if (hours?.enabled === true) {
    const open = parseTime(hours.open);
    const close = parseTime(hours.close);
    if (open !== null && close !== null) {
      const withinHours = close > open
        ? current.minutes >= open && current.minutes < close
        : current.minutes >= open || current.minutes < close;
      if (!withinHours) {
        return `El restaurante está fuera de su horario de atención (${hours.open} a ${hours.close}, hora de San Miguel de Allende).`;
      }
    }
  }
  return null;
}
