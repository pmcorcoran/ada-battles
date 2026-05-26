/**
 * Client-side Hydra key generation (offline, non-authoritative).
 *
 * Each player mints their OWN Hydra key pair in the browser when they
 * enter matchmaking. The secret key never leaves the tab; only the
 * verification key (vk) is handed to the runner currently, where it 
 * identifies the player as a Head participant.
 */

export interface HydraKeypair {
  vkHex: string;          // raw 32-byte Ed25519 public key, hex
  vkEnvelope: string;     // hydra-node text-envelope JSON
  privateKey: CryptoKey;  // retained in-memory for slice 2; never transmitted
}

const HYDRA_VK_ENVELOPE_TYPE = 'HydraVerificationKey_ed25519';
const CBOR_BYTESTRING_32 = '5820';

export async function generateHydraKey(): Promise<HydraKeypair> {
  let pair: CryptoKeyPair;
  try {
    pair = (await crypto.subtle.generateKey(
      { name: 'Ed25519' }, true, ['sign', 'verify'],
    )) as CryptoKeyPair;
  } catch (err) {
    throw new Error(
      `Hydra key generation failed (Ed25519 unsupported in this browser?): ${(err as Error).message}`,
    );
  }

  const rawVk = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  if (rawVk.length !== 32) {
    throw new Error(`unexpected Ed25519 vk length ${rawVk.length}, expected 32`);
  }

  const vkHex = toHex(rawVk);
  const vkEnvelope = JSON.stringify({
    type: HYDRA_VK_ENVELOPE_TYPE,
    description: '',
    cborHex: CBOR_BYTESTRING_32 + vkHex,
  });

  return { vkHex, vkEnvelope, privateKey: pair.privateKey };
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}