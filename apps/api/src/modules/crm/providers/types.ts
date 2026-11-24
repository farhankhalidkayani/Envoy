export interface CrmPushResult {
  success: boolean;
  externalId?: string;
  error?: string;
}

export interface CrmLookupResult {
  success: boolean;
  found?: boolean;
  /** The only contact detail the agent runtime ever surfaces — deliberately minimal. */
  firstName?: string;
  error?: string;
}

export interface CrmProvider {
  readonly name: string;
  /** `record` is already mapped from capturedData keys to the CRM's own property names. */
  pushRecord(accessToken: string, record: Record<string, unknown>): Promise<CrmPushResult>;
  /** Looks a contact up by exact email. Read-only. */
  findContact(accessToken: string, email: string): Promise<CrmLookupResult>;
}
