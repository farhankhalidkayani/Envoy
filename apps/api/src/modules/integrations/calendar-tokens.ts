export interface CalendarTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
}

/** oauthTokens holds this, JSON-stringified then AES-256-GCM encrypted by token-crypto.ts. */
export function packCalendarTokens(tokens: CalendarTokens): string {
  return JSON.stringify(tokens);
}

export function unpackCalendarTokens(packed: string): CalendarTokens {
  return JSON.parse(packed) as CalendarTokens;
}
