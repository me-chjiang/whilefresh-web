import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import exifr from "exifr";

import type {
  ImportImageUpload,
  ImportImagesRequest,
} from "../../shared/api.js";
import {
  CapturedAtSource,
  resolveCapturedAt,
  type ImageDateHints,
} from "./captured-at.js";

export const MAX_IMAGES_PER_IMPORT = 30;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

const KNOWN_IMAGE_TYPES = [
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["image/gif", "gif"],
  ["image/bmp", "bmp"],
] as const;

export interface StoredImportFile {
  path: string;
  sha256: string;
  mimeType: string;
  capturedAt: Date | null;
  capturedAtSource: CapturedAtSource;
}

export interface ImportFilesResult {
  files: StoredImportFile[];
  failures: string[];
}

export interface SaveImportOptions {
  origin: ImportImagesRequest["origin"];
  now?: Date;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function imageExtension(
  mimeType: string,
  displayName: string,
): string {
  const mime = mimeType.trim().toLowerCase();
  for (const [knownMime, extension] of KNOWN_IMAGE_TYPES) {
    if (mime === knownMime) {
      return extension;
    }
  }
  if (mime === "image/jpg" || mime === "image/pjpeg") {
    return "jpg";
  }

  const suffix = /\.([A-Za-z0-9]{1,5})$/.exec(displayName.trim());
  if (!suffix) {
    return "img";
  }
  return suffix[1].toLowerCase() === "jpeg" ? "jpg" : suffix[1].toLowerCase();
}

export function imageMimeType(extension: string): string {
  const normalized = extension.trim().toLowerCase();
  for (const [mime, knownExtension] of KNOWN_IMAGE_TYPES) {
    if (normalized === knownExtension) {
      return mime;
    }
  }
  return "";
}

export async function initializeImportFiles(
  directory: string,
  now = new Date(),
): Promise<number> {
  await mkdir(directory, { recursive: true });
  return cleanupStaleParts(directory, now);
}

export async function cleanupStaleParts(
  directory: string,
  now = new Date(),
): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) {
      return 0;
    }
    throw error;
  }

  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".part")) {
      continue;
    }
    const path = join(directory, entry.name);
    try {
      const info = await lstat(path);
      if (info.mtimeMs < cutoff) {
        await unlink(path);
        removed += 1;
      }
    } catch (error) {
      if (!isMissing(error)) {
        continue;
      }
    }
  }
  return removed;
}

function stringTag(tags: Record<string, unknown>, key: string): string {
  const value = tags[key];
  return typeof value === "string" ? value : "";
}

async function imageDateHints(
  upload: ImportImageUpload,
  origin: ImportImagesRequest["origin"],
): Promise<ImageDateHints> {
  if (origin === "camera") {
    return { camera: true };
  }

  let exifDateTimeOriginal = "";
  let exifOffsetTimeOriginal = "";
  try {
    const tags = await exifr.parse(new Uint8Array(upload.data), {
      pick: ["DateTimeOriginal", "OffsetTimeOriginal"],
      translateValues: false,
      reviveValues: false,
    });
    if (tags && typeof tags === "object") {
      const record = tags as Record<string, unknown>;
      exifDateTimeOriginal = stringTag(record, "DateTimeOriginal");
      exifOffsetTimeOriginal = stringTag(record, "OffsetTimeOriginal");
    }
  } catch {
    // Not every image contains EXIF; the client timestamp remains the fallback.
  }
  return {
    exifDateTimeOriginal,
    exifOffsetTimeOriginal,
    lastModified: upload.lastModified,
  };
}

export async function saveImportFile(
  directory: string,
  upload: ImportImageUpload,
  options: SaveImportOptions,
): Promise<StoredImportFile> {
  const size = upload.data.byteLength;
  if (size === 0) {
    throw new Error("导入的文件不存在或为空");
  }
  if (size > MAX_IMAGE_BYTES) {
    throw new Error("图片超过 50 MB");
  }

  await mkdir(directory, { recursive: true });
  const extension = imageExtension(upload.mimeType, upload.filename);
  const baseName = `${randomUUID()}.${extension}`;
  const finalPath = join(directory, baseName);
  const partPath = `${finalPath}.part`;
  const bytes = new Uint8Array(upload.data);

  try {
    await writeFile(partPath, bytes, { flag: "wx", mode: 0o600 });
    await rename(partPath, finalPath);
  } catch {
    try {
      await unlink(partPath);
    } catch {}
    throw new Error("无法保存导入的文件");
  }

  const declaredMime = upload.mimeType.trim().toLowerCase();
  const mimeType =
    !declaredMime || declaredMime.endsWith("/*")
      ? imageMimeType(extension)
      : declaredMime;
  const now = options.now ?? new Date();
  const capturedAt = resolveCapturedAt(
    await imageDateHints(upload, options.origin),
    now,
  );

  return {
    path: finalPath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType,
    capturedAt: capturedAt.when,
    capturedAtSource: capturedAt.source,
  };
}

export async function saveImportFiles(
  directory: string,
  uploads: readonly ImportImageUpload[],
  options: SaveImportOptions,
): Promise<ImportFilesResult> {
  const files: StoredImportFile[] = [];
  const failures: string[] = [];
  const now = options.now ?? new Date();
  let usedBytes = 0;

  for (let index = 0; index < uploads.length; index += 1) {
    if (index >= MAX_IMAGES_PER_IMPORT) {
      failures.push("单次最多导入 30 张");
      continue;
    }

    const upload = uploads[index];
    const size = upload.data.byteLength;
    if (size > MAX_IMAGE_BYTES) {
      failures.push("图片超过 50 MB");
      continue;
    }
    if (usedBytes + size > MAX_IMPORT_BYTES) {
      failures.push("本次导入超过 200 MB");
      continue;
    }

    try {
      files.push(await saveImportFile(directory, upload, { ...options, now }));
      usedBytes += size;
    } catch (error) {
      failures.push(
        error instanceof Error ? error.message : "无法保存导入的文件",
      );
    }
  }

  return { files, failures };
}
