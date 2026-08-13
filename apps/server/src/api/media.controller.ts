import {
  BadRequestException,
  Controller,
  Inject,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { WorkspaceGuard, type AuthedRequest } from "../auth/workspace.guard.js";
import { loadEnv } from "../config.js";

/**
 * Image uploads.
 *
 * Local disk rather than object storage: a self-hosted tool should not require
 * an S3 account to attach a picture. `MEDIA_DIR` points somewhere persistent in
 * a container deployment; the default is fine for a laptop.
 */

const ALLOWED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_BYTES = 8 * 1024 * 1024;

@Controller("api/v1")
@UseGuards(WorkspaceGuard)
export class MediaController {
  @Post("media")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_BYTES } }))
  async upload(
    @Req() req: AuthedRequest,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ url: string }> {
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

    return { url: `${env.BETTER_AUTH_URL}/media/${req.workspaceId}/${name}` };
  }
}
