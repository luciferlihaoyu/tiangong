import { createCipheriv, randomBytes } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { env } from "../lib/env";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type EncryptedEnvelope = {
  algorithm: string;
  keyId: string;
  envelopeVersion: string;
  nonce: string;
  authTag: string;
  ciphertext: string;
};

function failClosed(message: string): never {
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message });
}

function decodeKey(raw: string): Buffer {
  if (!raw) {
    failClosed("Secret vault key not configured");
  }
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  let decoded: Buffer;
  try {
    decoded = Buffer.from(normalized, "base64");
  } catch {
    failClosed("Invalid secret vault key encoding");
  }
  if (decoded.length !== KEY_BYTES) {
    failClosed("Invalid secret vault key length");
  }
  return decoded;
}

export function getVaultKey(): { key: Buffer; keyId: string } {
  return { key: decodeKey(env.secretVaultKey), keyId: env.secretVaultKeyId };
}

export function buildAad(
  workspaceId: number,
  projectId: number,
  name: string
): string {
  return `${ENVELOPE_VERSION}:${workspaceId}:${projectId}:${name}`;
}

export function encryptSecret(
  plaintext: string,
  workspaceId: number,
  projectId: number,
  name: string
): EncryptedEnvelope {
  const { key, keyId } = getVaultKey();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: TAG_BYTES,
  });
  const aad = buildAad(workspaceId, projectId, name);
  cipher.setAAD(Buffer.from(aad, "utf-8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    algorithm: ALGORITHM,
    keyId,
    envelopeVersion: ENVELOPE_VERSION,
    nonce: nonce.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
