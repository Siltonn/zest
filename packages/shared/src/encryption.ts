import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Platform OAuth tokens are encrypted before they touch the database, so a
 * dump or a leaked backup does not hand an attacker live control of a user's
 * social accounts. GCM authenticates the ciphertext: tampering fails decryption
 * rather than yielding garbage that later code might act on.
 */
export class TokenVault {
  readonly #key: Buffer;

  constructor(secret: string) {
    if (!secret || secret.length < 16) {
      throw new Error(
        "ZEST_ENCRYPTION_KEY must be set to at least 16 characters",
      );
    }
    this.#key = createHash("sha256").update(secret).digest();
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.#key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    return [
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  decrypt(encoded: string): string {
    const parts = encoded.split(".");
    if (parts.length !== 3) {
      throw new Error("Malformed ciphertext: expected iv.tag.ciphertext");
    }
    const [ivPart, tagPart, dataPart] = parts as [string, string, string];
    const iv = Buffer.from(ivPart, "base64url");
    const tag = Buffer.from(tagPart, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error("Malformed ciphertext: bad iv or tag length");
    }
    const decipher = createDecipheriv(ALGORITHM, this.#key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}

let vault: TokenVault | undefined;

export function getTokenVault(): TokenVault {
  vault ??= new TokenVault(process.env.ZEST_ENCRYPTION_KEY ?? "");
  return vault;
}
