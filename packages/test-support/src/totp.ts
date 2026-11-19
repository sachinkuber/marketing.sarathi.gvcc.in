import { createHmac } from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function base32Decode(input: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const index = BASE32.indexOf(ch)
    if (index < 0) throw new Error('not base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

// RFC 6238, six digits, thirty-second steps: the code an authenticator app would show.
export function totp(secretBase32: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const hash = createHmac('sha1', base32Decode(secretBase32)).update(message).digest()
  const offset = (hash[hash.length - 1] as number) & 0x0f
  const number =
    (((hash[offset] as number) & 0x7f) << 24) |
    (((hash[offset + 1] as number) & 0xff) << 16) |
    (((hash[offset + 2] as number) & 0xff) << 8) |
    ((hash[offset + 3] as number) & 0xff)
  return String(number % 1_000_000).padStart(6, '0')
}
