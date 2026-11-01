import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SLICE_HEIGHT,
  SLICE_OVERLAP,
  encodedSize,
  loadImage,
  planBatches,
  prepareImages,
  sliceTops,
  type PreparedImage,
} from "../../server/recognition/image-preprocessor.js";

let directory: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "whilefresh-image-preprocessor-"));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function fakeSlice(
  imageIndex: number,
  sliceIndex: number,
  sliceCount: number,
  bytes = 10,
): PreparedImage {
  return {
    imageIndex,
    sliceIndex,
    sliceCount,
    captureDate: null,
    jpeg: Buffer.alloc(bytes),
  };
}

function fakeImages(slicesPerImage: number[]): PreparedImage[] {
  return slicesPerImage.flatMap((sliceCount, imageIndex) =>
    Array.from({ length: sliceCount }, (_, sliceIndex) =>
      fakeSlice(imageIndex, sliceIndex, sliceCount),
    ),
  );
}

function batchSizes(batches: readonly PreparedImage[][]): number[] {
  return batches.map((batch) => batch.length);
}

async function collectImages(
  inputs: Parameters<typeof prepareImages>[0],
): Promise<PreparedImage[]> {
  const images: PreparedImage[] = [];
  for await (const image of prepareImages(inputs)) {
    images.push(image);
  }
  return images;
}

describe("slice boundaries", () => {
  it.each([
    { height: 1, tops: [0] },
    { height: 1500, tops: [0] },
    { height: 1501, tops: [0, 1300] },
    { height: 2800, tops: [0, 1300] },
    { height: 2801, tops: [0, 1300, 2600] },
    { height: 6993, tops: [0, 1300, 2600, 3900, 5200, 6500] },
  ])("splits $height rows into the expected windows", ({ height, tops }) => {
    expect(sliceTops(height)).toEqual(tops);
  });

  it("starts each consecutive slice 200 rows above the previous bottom", () => {
    const tops = sliceTops(6993);

    expect(SLICE_OVERLAP).toBe(200);
    for (let index = 1; index < tops.length; index += 1) {
      expect(SLICE_HEIGHT - (tops[index] - tops[index - 1])).toBe(
        SLICE_OVERLAP,
      );
    }
  });
});

describe("image loading", () => {
  it("caps an ultra-wide image at 1300 pixels without distorting it", async () => {
    const path = join(directory, "wide.png");
    await sharp({
      create: {
        width: 2600,
        height: 400,
        channels: 3,
        background: { r: 80, g: 120, b: 160 },
      },
    })
      .png()
      .toFile(path);

    const loaded = await loadImage(path);
    const metadata = await sharp(loaded).metadata();

    expect(metadata.width).toBe(1300);
    expect(metadata.height).toBe(200);
  });

  it("applies the EXIF orientation before capping the displayed width", async () => {
    const path = join(directory, "rotated.jpg");
    await sharp({
      create: {
        width: 3000,
        height: 2000,
        channels: 3,
        background: { r: 180, g: 100, b: 40 },
      },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(path);

    const loaded = await loadImage(path);
    const metadata = await sharp(loaded).metadata();

    expect(metadata.width).toBe(1300);
    expect(metadata.height).toBe(1950);
  });
});

describe("slice preparation", () => {
  it("prepares an ultra-tall image as ordered, overlapping JPEG windows", async () => {
    const path = join(directory, "tall.png");
    await sharp({
      create: {
        width: 600,
        height: 6993,
        channels: 3,
        background: { r: 20, g: 140, b: 80 },
      },
    })
      .png()
      .toFile(path);

    const images = await collectImages([
      { path, captureDate: "2026-10-18" },
    ]);
    const dimensions = await Promise.all(
      images.map(async ({ jpeg }) => {
        const metadata = await sharp(jpeg).metadata();
        return [metadata.width, metadata.height];
      }),
    );

    expect(images).toHaveLength(6);
    expect(images.map(({ imageIndex }) => imageIndex)).toEqual(
      Array(6).fill(0),
    );
    expect(images.map(({ sliceIndex }) => sliceIndex)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(images.map(({ sliceCount }) => sliceCount)).toEqual(
      Array(6).fill(6),
    );
    expect(images.map(({ captureDate }) => captureDate)).toEqual(
      Array(6).fill("2026-10-18"),
    );
    expect(dimensions).toEqual([
      [600, 1500],
      [600, 1500],
      [600, 1500],
      [600, 1500],
      [600, 1500],
      [600, 493],
    ]);
  });

  it("flattens transparent PNG pixels onto white before JPEG encoding", async () => {
    const path = join(directory, "transparent.png");
    await sharp({
      create: {
        width: 20,
        height: 20,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toFile(path);

    const [image] = await collectImages([{ path, captureDate: null }]);
    const metadata = await sharp(image.jpeg).metadata();
    const { data } = await sharp(image.jpeg)
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(20);
    expect(metadata.height).toBe(20);
    expect(data[0]).toBeGreaterThan(240);
    expect(data[1]).toBeGreaterThan(240);
    expect(data[2]).toBeGreaterThan(240);
  });
});

describe("batch planning", () => {
  it("splits at the forty-image limit", () => {
    expect(batchSizes(planBatches(fakeImages(Array(40).fill(1))))).toEqual([
      40,
    ]);
    expect(batchSizes(planBatches(fakeImages(Array(41).fill(1))))).toEqual([
      40, 1,
    ]);
    expect(batchSizes(planBatches(fakeImages(Array(85).fill(1))))).toEqual([
      40, 40, 5,
    ]);
  });

  it("keeps one image's slices together when the image fits", () => {
    const batches = planBatches(fakeImages([3, 3, 1]), { maxImages: 4 });

    expect(batchSizes(batches)).toEqual([3, 4]);
    expect(batches.map((batch) => batch.map(({ imageIndex }) => imageIndex))).toEqual([
      [0, 0, 0],
      [1, 1, 1, 2],
    ]);
  });

  it("splits an image whose slices alone exceed the limits", () => {
    expect(
      batchSizes(planBatches(fakeImages([1, 5]), { maxImages: 2 })),
    ).toEqual([1, 2, 2, 1]);
  });

  it("respects the encoded byte limit", () => {
    const sample = fakeSlice(0, 0, 1);
    const maxBytes = 3 * (encodedSize(sample) + 1);

    expect(
      batchSizes(planBatches(fakeImages(Array(7).fill(1)), { maxBytes })),
    ).toEqual([3, 3, 1]);
  });

  it("returns no work for empty input", async () => {
    expect(sliceTops(0)).toEqual([]);
    expect(planBatches([])).toEqual([]);
    expect(await collectImages([])).toEqual([]);
  });
});
