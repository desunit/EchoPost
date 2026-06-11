/**
 * Minimal header-based dimension extraction for PNG, JPEG, GIF, and WebP.
 * Avoids a native dependency for the common case; returns undefined when the
 * format is unknown.
 */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24) return undefined;

  // PNG: 8-byte signature, IHDR at offset 16
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // GIF87a / GIF89a
  if (buf.toString("ascii", 0, 3) === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }

  // WebP: RIFF....WEBP
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const format = buf.toString("ascii", 12, 16);
    if (format === "VP8 " && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (format === "VP8L" && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (format === "VP8X" && buf.length >= 30) {
      return {
        width: 1 + ((buf[26]! | (buf[27]! << 8) | (buf[28]! << 16)) & 0xffffff),
        height: 1 + ((buf[27 + 2]! | (buf[30 - 1]! << 8) | (buf[31 - 1]! << 16)) & 0xffffff),
      };
    }
  }

  // JPEG: walk segments looking for SOF0/1/2
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(offset + 7), height: buf.readUInt16BE(offset + 5) };
      }
      const length = buf.readUInt16BE(offset + 2);
      offset += 2 + length;
    }
  }

  return undefined;
}
