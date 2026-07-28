/**
 * Sealed-box crypto for client credential intake.
 *
 * The client's browser encrypts. Only a private key held outside this system can
 * decrypt. Nothing in Supabase, Cloudflare, or any environment variable can read
 * a payload produced here.
 *
 * Scheme: a fresh AES-256-GCM key per submission encrypts the payload; that key is
 * wrapped with RSA-OAEP-4096. Hybrid rather than raw RSA because RSA-OAEP-4096 caps
 * out near 446 bytes and a long notes field would fail at submit time.
 *
 * WebCrypto only. No npm dependency, nothing to keep patched.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_ALG = "RSA-OAEP-4096/AES-256-GCM";

export type CredentialPayload = {
  afm: string;
  amka: string;
  username: string;
  password: string;
  twoFactor: string;
  notes: string;
  submittedAt: string;
};

type Envelope = {
  v: number;
  alg: string;
  k: string;
  iv: string;
  ct: string;
};

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error("Web Crypto is unavailable. This page must be served over HTTPS.");
  }
  return c.subtle;
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const RSA_ALG = { name: "RSA-OAEP", hash: "SHA-256" } as const;

const RSA_KEYGEN_PARAMS: RsaHashedKeyGenParams = {
  name: "RSA-OAEP",
  modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

/**
 * Short, stable identifier for a public key. Stored on every submission so a
 * rotated keypair does not make older rows undecryptable by mistake.
 */
export async function keyFingerprint(publicKeyBase64: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", base64ToBuffer(publicKeyBase64));
  return Array.from(new Uint8Array(digest))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Generates a keypair entirely in the browser. The private key is returned once and
 * never persisted anywhere by this code. Losing it makes existing payloads
 * unreadable, which is recoverable only by asking clients to resubmit.
 */
export async function generateKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}> {
  const s = subtle();
  const pair = await s.generateKey(RSA_KEYGEN_PARAMS, true, ["encrypt", "decrypt"]);
  const publicKey = bufferToBase64(await s.exportKey("spki", pair.publicKey));
  const privateKey = bufferToBase64(await s.exportKey("pkcs8", pair.privateKey));
  return { publicKey, privateKey, fingerprint: await keyFingerprint(publicKey) };
}

export async function encryptPayload(
  payload: CredentialPayload,
  publicKeyBase64: string,
): Promise<string> {
  const s = subtle();

  const publicKey = await s.importKey("spki", base64ToBuffer(publicKeyBase64), RSA_ALG, false, [
    "encrypt",
  ]);

  const aesKey = await s.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await s.encrypt(
    { name: "AES-GCM", iv },
    aesKey,
    textEncoder.encode(JSON.stringify(payload)),
  );

  const wrappedKey = await s.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    await s.exportKey("raw", aesKey),
  );

  const envelope: Envelope = {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    k: bufferToBase64(wrappedKey),
    iv: bufferToBase64(iv.buffer),
    ct: bufferToBase64(ciphertext),
  };

  return btoa(JSON.stringify(envelope));
}

export async function decryptPayload(
  envelopeBase64: string,
  privateKeyBase64: string,
): Promise<CredentialPayload> {
  const s = subtle();

  let envelope: Envelope;
  try {
    envelope = JSON.parse(atob(envelopeBase64)) as Envelope;
  } catch {
    throw new Error("This payload is not a readable envelope.");
  }

  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope version: ${String(envelope.v)}.`);
  }

  let privateKey: CryptoKey;
  try {
    privateKey = await s.importKey("pkcs8", base64ToBuffer(privateKeyBase64), RSA_ALG, false, [
      "decrypt",
    ]);
  } catch {
    throw new Error("That does not look like a valid private key.");
  }

  let plaintext: ArrayBuffer;
  try {
    const rawAesKey = await s.decrypt({ name: "RSA-OAEP" }, privateKey, base64ToBuffer(envelope.k));
    const aesKey = await s.importKey("raw", rawAesKey, { name: "AES-GCM" }, false, ["decrypt"]);
    plaintext = await s.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(base64ToBuffer(envelope.iv)) },
      aesKey,
      base64ToBuffer(envelope.ct),
    );
  } catch {
    throw new Error("Wrong private key for this payload, or the payload is corrupt.");
  }

  return JSON.parse(textDecoder.decode(plaintext)) as CredentialPayload;
}
