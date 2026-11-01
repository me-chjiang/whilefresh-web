import exifr from "exifr";
import sharp from "sharp";

import type { ImageInput } from "./types.js";

export const MAX_IMAGE_WIDTH = 1300;
export const SLICE_HEIGHT = 1500;
export const SLICE_OVERLAP = 200;
export const JPEG_QUALITY = 85;

export interface PreparedImage {
  imageIndex: number;
  sliceIndex: number;
  sliceCount: number;
  captureDate?: string | null;
  jpeg: Uint8Array;
}

export interface BatchLimits {
  maxImages: number;
  maxBytes: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  maxImages: 40,
  maxBytes: 40 * 1024 * 1024,
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function imageError(index: number, detail: string): Error {
  return new Error(`image #${index + 1}: ${detail}`);
}

export function sliceTops(height: number): number[] {
  if (height <= 0) {
    return [];
  }

  const tops: number[] = [];
  let top = 0;
  for (;;) {
    tops.push(top);
    const bottom = Math.min(top + SLICE_HEIGHT, height);
    if (bottom >= height) {
      return tops;
    }
    top = bottom - SLICE_OVERLAP;
  }
}

async function loadOrientedImage(
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  throwIfAborted(signal);

  let orientation: number | undefined;
  try {
    orientation = await exifr.orientation(path);
  } catch {
    orientation = undefined;
  }
  throwIfAborted(signal);

  let image = sharp(path, { failOn: "error" });
  if (orientation !== 1) {
    image = image.rotate();
  }

  const { data } = await image
    .resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true })
    .png()
    .toBuffer({ resolveWithObject: true });
  throwIfAborted(signal);
  return data;
}

export async function loadImage(
  path: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    return await loadOrientedImage(path, signal);
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw new Error("cannot read image");
  }
}

export async function* prepareImages(
  inputs: readonly ImageInput[],
  signal?: AbortSignal,
): AsyncGenerator<PreparedImage> {
  for (let imageIndex = 0; imageIndex < inputs.length; imageIndex += 1) {
    throwIfAborted(signal);

    let oriented: Buffer;
    try {
      oriented = await loadOrientedImage(inputs[imageIndex].path, signal);
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      throw imageError(imageIndex, "cannot read image");
    }

    const metadata = await sharp(oriented).metadata();
    const height = metadata.height ?? 0;
    const tops = sliceTops(height);

    for (let sliceIndex = 0; sliceIndex < tops.length; sliceIndex += 1) {
      throwIfAborted(signal);

      let jpeg: Buffer;
      try {
        jpeg = await sharp(oriented)
          .extract({
            left: 0,
            top: tops[sliceIndex],
            width: metadata.width,
            height: Math.min(SLICE_HEIGHT, height - tops[sliceIndex]),
          })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: JPEG_QUALITY })
          .toBuffer();
      } catch {
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException("Aborted", "AbortError");
        }
        throw imageError(imageIndex, "JPEG encoding failed");
      }

      throwIfAborted(signal);
      yield {
        imageIndex,
        sliceIndex,
        sliceCount: tops.length,
        captureDate: inputs[imageIndex].captureDate ?? null,
        jpeg,
      };
    }
  }
}

export function encodedSize(image: Pick<PreparedImage, "jpeg">): number {
  return Math.floor((image.jpeg.byteLength * 4 + 2) / 3) + 128;
}

export function planBatches(
  images: readonly PreparedImage[],
  limits: Partial<BatchLimits> = {},
): PreparedImage[][] {
  const maxImages = limits.maxImages ?? DEFAULT_BATCH_LIMITS.maxImages;
  const maxBytes = limits.maxBytes ?? DEFAULT_BATCH_LIMITS.maxBytes;
  const batches: PreparedImage[][] = [];
  let current: PreparedImage[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    if (current.length > 0) {
      batches.push(current);
    }
    current = [];
    currentBytes = 0;
  };
  const fits = (count: number, bytes: number): boolean =>
    current.length + count <= maxImages && currentBytes + bytes <= maxBytes;
  const add = (image: PreparedImage): void => {
    const bytes = encodedSize(image);
    if (!fits(1, bytes)) {
      flush();
    }
    current.push(image);
    currentBytes += bytes;
  };

  let index = 0;
  while (index < images.length) {
    let end = index;
    let groupBytes = 0;
    while (end < images.length && images[end].imageIndex === images[index].imageIndex) {
      groupBytes += encodedSize(images[end]);
      end += 1;
    }
    const groupCount = end - index;

    if (!fits(groupCount, groupBytes)) {
      flush();
    }
    if (fits(groupCount, groupBytes)) {
      for (let sliceIndex = index; sliceIndex < end; sliceIndex += 1) {
        current.push(images[sliceIndex]);
        currentBytes += encodedSize(images[sliceIndex]);
      }
    } else {
      for (let sliceIndex = index; sliceIndex < end; sliceIndex += 1) {
        add(images[sliceIndex]);
      }
    }
    index = end;
  }
  flush();
  return batches;
}
