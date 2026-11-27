export const REFRESH_COOKIE_NAME = 'rodo_rt';
const REFRESH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 días

export function parseCookieValue(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const parts = cookieHeader.split(';');
  for (const rawPart of parts) {
    const eqIdx = rawPart.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = rawPart.slice(0, eqIdx).trim();
    if (key !== cookieName) continue;
    const rawVal = rawPart.slice(eqIdx + 1).trim();
    if (!rawVal) return null;
    try {
      return decodeURIComponent(rawVal);
    } catch {
      return rawVal;
    }
  }
  return null;
}

export function isSecureCookieRequest(
  protocol?: string,
  forwardedProtoHeader?: string | string[],
  forceSecure = false
): boolean {
  if (forceSecure) return true;
  if (protocol === 'https') return true;
  const rawForwarded = Array.isArray(forwardedProtoHeader)
    ? forwardedProtoHeader[0]
    : forwardedProtoHeader;
  if (typeof rawForwarded === 'string') {
    const firstProto = rawForwarded.split(',')[0]?.trim().toLowerCase();
    if (firstProto === 'https') return true;
  }
  return false;
}

export function buildRefreshTokenCookieHeader(refreshToken: string, isSecure: boolean): string {
  const encoded = encodeURIComponent(refreshToken);
  return `${REFRESH_COOKIE_NAME}=${encoded}; Max-Age=${REFRESH_COOKIE_MAX_AGE_SECONDS}; Path=/api/auth; HttpOnly; SameSite=Strict${
    isSecure ? '; Secure' : ''
  }`;
}

export function buildClearRefreshTokenCookieHeader(isSecure: boolean): string {
  return `${REFRESH_COOKIE_NAME}=; Max-Age=0; Path=/api/auth; HttpOnly; SameSite=Strict${
    isSecure ? '; Secure' : ''
  }`;
}
