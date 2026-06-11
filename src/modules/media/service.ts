import fs from "node:fs";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import type { DB } from "../../db/index.js";
import { config } from "../../config/index.js";
import { newId } from "../../lib/ids.js";
import { nowIso } from "../../lib/time.js";
import { imageSize } from "../../lib/image-size.js";
import type { MediaRow } from "../types.js";

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
};

const ALLOWED_MIME_PREFIXES = ["image/", "video/", "audio/"];

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
  }
  const parts = ip.split(".").map(Number);
  const [a, b] = [parts[0]!, parts[1]!];
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export class MediaService {
  constructor(private db: DB) {
    if (config.media.driver === "local") {
      fs.mkdirSync(config.media.storagePath, { recursive: true });
    }
  }

  forPost(postId: string): MediaRow[] {
    return this.db
      .prepare("SELECT * FROM media WHERE post_id = ? ORDER BY sort_order")
      .all(postId) as MediaRow[];
  }

  getById(id: string): MediaRow | undefined {
    return this.db.prepare("SELECT * FROM media WHERE id = ?").get(id) as MediaRow | undefined;
  }

  /**
   * Delete a media row. The underlying file is content-addressed and may be
   * shared (dedupe), so it is only unlinked when no other row references it.
   */
  removeUpload(id: string): void {
    const media = this.getById(id);
    if (!media) return;
    this.db.prepare("DELETE FROM media WHERE id = ?").run(id);
    const stillUsed = this.db
      .prepare("SELECT 1 FROM media WHERE storage_path = ? LIMIT 1")
      .get(media.storage_path);
    if (!stillUsed) {
      const absolute = path.join(config.media.storagePath, media.storage_path);
      if (absolute.startsWith(config.media.storagePath)) fs.rmSync(absolute, { force: true });
    }
  }

  /**
   * Mirror a remote file locally (PRD 5.5). Enforces host allowlist,
   * blocks private addresses (SSRF), caps size, validates MIME, dedupes by
   * SHA-256, and extracts image dimensions.
   */
  async mirrorRemote(input: {
    postId: string;
    sourceUrl: string;
    sourceType: string;
    altText?: string | null;
    sortOrder?: number;
  }): Promise<MediaRow> {
    const url = new URL(input.sourceUrl);
    if (url.protocol !== "https:") throw new Error(`Refusing non-HTTPS media URL: ${input.sourceUrl}`);
    if (!config.media.allowedHosts.includes(url.hostname)) {
      throw new Error(`Media host not in allowlist: ${url.hostname}`);
    }
    if (isIP(url.hostname)) throw new Error("IP-literal media URLs are not allowed");
    const resolved = await lookup(url.hostname);
    if (isPrivateAddress(resolved.address)) throw new Error("Media host resolves to a private address");

    const res = await fetch(input.sourceUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Media download failed (${res.status}): ${input.sourceUrl}`);

    const declaredLength = Number(res.headers.get("content-length") ?? 0);
    if (declaredLength > config.media.maxDownloadBytes) throw new Error("Media exceeds size cap");

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > config.media.maxDownloadBytes) throw new Error("Media exceeds size cap");

    const mime = (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
    if (!ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p))) {
      throw new Error(`Unsupported media MIME type: ${mime}`);
    }

    return this.persist({
      postId: input.postId,
      buffer: buf,
      mime,
      sourceType: input.sourceType,
      sourceUrl: input.sourceUrl,
      altText: input.altText ?? null,
      sortOrder: input.sortOrder ?? 0,
    });
  }

  /**
   * Store an admin-uploaded file (already in memory). Same dedupe/storage path as
   * {@link mirrorRemote} but skips the network/SSRF checks since the bytes are local.
   */
  storeUpload(input: {
    postId: string;
    buffer: Buffer;
    mime: string;
    fileName?: string | null;
    altText?: string | null;
    sortOrder?: number;
  }): MediaRow {
    const mime = (input.mime || "application/octet-stream").split(";")[0]!.trim();
    if (!ALLOWED_MIME_PREFIXES.some((p) => mime.startsWith(p))) {
      throw new Error(`Unsupported media MIME type: ${mime}`);
    }
    if (input.buffer.length > config.media.maxDownloadBytes) throw new Error("Media exceeds size cap");
    return this.persist({
      postId: input.postId,
      buffer: input.buffer,
      mime,
      sourceType: "upload",
      sourceUrl: input.fileName ? `upload:${input.fileName}` : "upload",
      altText: input.altText ?? null,
      sortOrder: input.sortOrder ?? 0,
    });
  }

  /** Write bytes to content-addressed storage (deduped) and insert a media row. */
  private persist(input: {
    postId: string;
    buffer: Buffer;
    mime: string;
    sourceType: string;
    sourceUrl: string;
    altText: string | null;
    sortOrder: number;
  }): MediaRow {
    const { buffer: buf, mime } = input;
    const checksum = createHash("sha256").update(buf).digest("hex");

    // dedupe identical bytes: reuse the stored file, still create a media row per post
    const existing = this.db
      .prepare("SELECT * FROM media WHERE checksum_sha256 = ? LIMIT 1")
      .get(checksum) as MediaRow | undefined;

    let storagePath: string;
    let publicUrl: string;
    let width: number | null = null;
    let height: number | null = null;

    if (existing) {
      storagePath = existing.storage_path;
      publicUrl = existing.public_url;
      width = existing.width;
      height = existing.height;
    } else {
      const ext = EXTENSION_BY_MIME[mime] ?? "bin";
      const fileName = `${checksum.slice(0, 2)}/${checksum}.${ext}`;
      storagePath = fileName;
      publicUrl = `${config.media.publicUrl}/${fileName}`;
      const absolute = path.join(config.media.storagePath, fileName);
      if (!absolute.startsWith(config.media.storagePath)) throw new Error("Path traversal blocked");
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, buf);
      if (mime.startsWith("image/")) {
        const dims = imageSize(buf);
        width = dims?.width ?? null;
        height = dims?.height ?? null;
      }
    }

    const id = newId();
    this.db
      .prepare(
        `INSERT INTO media (id, post_id, source_type, source_url, storage_path, public_url,
          checksum_sha256, mime_type, width, height, alt_text, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.postId, input.sourceType, input.sourceUrl, storagePath, publicUrl,
        checksum, mime, width, height, input.altText, input.sortOrder, nowIso(),
      );
    return this.getById(id)!;
  }

  /** Files referenced in DB but missing on disk (for the daily verify job). */
  findMissingFiles(): MediaRow[] {
    if (config.media.driver !== "local") return [];
    const rows = this.db.prepare("SELECT * FROM media").all() as MediaRow[];
    return rows.filter((m) => !fs.existsSync(path.join(config.media.storagePath, m.storage_path)));
  }

  async redownload(media: MediaRow): Promise<void> {
    if (!media.source_url) throw new Error("No source URL recorded for media");
    this.db.prepare("DELETE FROM media WHERE id = ?").run(media.id);
    await this.mirrorRemote({
      postId: media.post_id,
      sourceUrl: media.source_url,
      sourceType: media.source_type,
      altText: media.alt_text,
      sortOrder: media.sort_order,
    });
  }

  storageUsage(): { files: number; bytes: number } {
    if (config.media.driver !== "local" || !fs.existsSync(config.media.storagePath)) {
      return { files: 0, bytes: 0 };
    }
    let files = 0;
    let bytes = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          files++;
          bytes += fs.statSync(full).size;
        }
      }
    };
    walk(config.media.storagePath);
    return { files, bytes };
  }
}
