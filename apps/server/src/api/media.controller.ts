import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { type Database } from "@zest/db";
import { media } from "@zest/core";
import { DATABASE } from "../infra/database.module.js";
import { WorkspaceGuard, type AuthedRequest } from "../auth/workspace.guard.js";
import { loadEnv } from "../config.js";

/**
 * The media library.
 *
 * Local disk rather than object storage: a self-hosted tool should not require
 * an S3 account to attach a picture. `MEDIA_DIR` points somewhere persistent in
 * a container deployment; the default is fine for a laptop.
 *
 * Every upload is also recorded as a row, which is what makes the rest of this
 * controller possible — before that, an uploaded file left no trace and could
 * be neither found again nor safely removed.
 */

const ALLOWED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_BYTES = 8 * 1024 * 1024;

@Controller("api/v1")
@UseGuards(WorkspaceGuard)
export class MediaController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get("media")
  async list(@Req() req: AuthedRequest, @Query("before") before?: string) {
    return media.listMedia(this.db, req.workspaceId, { before });
  }

  @Post("media")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BYTES } }))
  async upload(
    @Req() req: AuthedRequest,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ url: string; id: string }> {
    if (!file) throw new BadRequestException("No file was uploaded");

    const extension = extname(file.originalname).toLowerCase();
    if (!ALLOWED.has(extension)) {
      throw new BadRequestException(
        `Only images are supported (${[...ALLOWED].join(", ")})`,
      );
    }
    if (!file.mimetype.startsWith("image/")) {
      throw new BadRequestException("That file is not an image");
    }

    const env = loadEnv();
    // Scoped per workspace so one tenant cannot guess another's filenames.
    const directory = join(env.MEDIA_DIR, req.workspaceId);
    await mkdir(directory, { recursive: true });

    const name = `${randomBytes(12).toString("hex")}${extension}`;
    await writeFile(join(directory, name), file.buffer);

    const url = `${env.BETTER_AUTH_URL}/media/${req.workspaceId}/${name}`;
    const dimensions = readDimensions(file.buffer, file.mimetype);
    const asset = await media.recordUpload(this.db, {
      workspaceId: req.workspaceId,
      url,
      storageKey: `${req.workspaceId}/${name}`,
      filename: file.originalname,
      mimeType: file.mimetype,
      bytes: file.size,
      ...dimensions,
      actor: req.actor,
    });

    return { url, id: asset.id };
  }

  /** What would break if this image went away. */
  @Get("media/:id/usage")
  async usage(@Req() req: AuthedRequest, @Param("id") id: string) {
    const { assets } = await media.listMedia(this.db, req.workspaceId, { limit: 200 });
    const asset = assets.find((a) => a.id === id);
    if (!asset) throw new BadRequestException("No such image");
    return { posts: await media.usedBy(this.db, req.workspaceId, asset.url) };
  }

  @Delete("media/:id")
  async remove(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Query("force") force?: string,
  ) {
    const result = await media.deleteMedia(this.db, req.workspaceId, id, {
      force: force === "true",
    });

    if (!result.deleted) {
      if (result.reason === "not_found") throw new BadRequestException("No such image");
      // Named rather than a bare 400: the UI offers to delete anyway, and needs
      // to say what it would be breaking.
      throw new BadRequestException({
        message: `Still used by ${result.posts.length} post(s)`,
        reason: "in_use",
        posts: result.posts,
      });
    }

    // The row is gone; a leftover file is untidy but harmless, and failing the
    // request here would leave the operator unable to remove it at all.
    await unlink(join(loadEnv().MEDIA_DIR, result.storageKey)).catch(() => undefined);
    return { ok: true };
  }

  /** Uploads no post references, so the operator can reclaim the space. */
  @Get("media/orphans")
  async orphans(@Req() req: AuthedRequest) {
    const orphans = await media.findOrphans(this.db, req.workspaceId);
    return {
      orphans,
      bytes: orphans.reduce((total, asset) => total + asset.bytes, 0),
    };
  }
}

/**
 * Dimensions straight from the file header.
 *
 * Three small readers rather than an image library: the headers are fixed-offset
 * for PNG and RIFF/WebP, and JPEG needs one walk over its segment chain. A
 * dependency that decodes entire images to learn two numbers would be a larger
 * attack surface than the feature is worth.
 */
function readDimensions(
  buffer: Buffer,
  mimeType: string,
): { width?: number; height?: number } {
  try {
    if (mimeType === "image/png" && buffer.length > 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    if (mimeType === "image/webp" && buffer.length > 30) {
      // VP8X and lossy VP8 differ; both keep the size 24-26 bytes in.
      if (buffer.toString("ascii", 12, 16) === "VP8X") {
        return {
          width: (buffer.readUIntLE(24, 3) & 0xffffff) + 1,
          height: (buffer.readUIntLE(27, 3) & 0xffffff) + 1,
        };
      }
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }

    if (mimeType === "image/jpeg") {
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1]!;
        const length = buffer.readUInt16BE(offset + 2);
        // SOF0-SOF15, skipping the four that are not frame headers.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7),
          };
        }
        offset += 2 + length;
      }
    }
  } catch {
    // A malformed header is not a reason to reject an upload the platform may
    // still accept; the dimensions are a convenience, not a gate.
  }
  return {};
}
