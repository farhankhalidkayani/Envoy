import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function deriveKey(): Buffer {
  const secret = process.env.CRM_TOKEN_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("CRM_TOKEN_ENCRYPTION_KEY must be set");
  }
  return scryptSync(secret, "envoy-crm-tokens", 32);
}

/**
 * CrmConnection.oauthTokens is documented in the schema as "encrypted at
 * rest by the application layer" — this is that layer. AES-256-GCM with a
 * random IV per encryption, packed as `iv:authTag:ciphertext` (base64,
 * colon-delimited) into the single string column.
 */
export function encryptToken(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptToken(packed: string): string {
  const key = deriveKey();
  const [ivB64, authTagB64, ciphertextB64] = packed.split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted token");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
