export interface CrmPushResult {
  success: boolean;
  externalId?: string;
  error?: string;
}

export interface CrmProvider {
  readonly name: string;
  /** `record` is already mapped from capturedData keys to the CRM's own property names. */
  pushRecord(accessToken: string, record: Record<string, unknown>): Promise<CrmPushResult>;
}
