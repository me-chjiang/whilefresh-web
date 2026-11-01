import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { Catalog } from "../../server/domain/catalog.js";
import {
  readRecording,
  writeRecording,
} from "../../server/recognition/recording.js";
import {
  DemoRecognizer,
  ReplayRecognizer,
} from "../../server/recognition/replay.js";
import {
  ErrorKind,
  InputKind,
  type RecognitionRequest,
} from "../../server/recognition/types.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const vocabulary = Catalog.fromJson(
  readFileSync(
    join(repository, "test-data/vocabulary/synthetic-vocabulary.json"),
    "utf8",
  ),
);

interface StandardAnswer {
  items: Array<{ canonical_name: string }>;
}

function requestFor(kind: InputKind): RecognitionRequest {
  return {
    kind,
    images: [],
    text: "",
    vocabulary,
  };
}

function canonicalNames(items: Array<{ canonicalName: string }>): string[] {
  return [...new Set(items.map((item) => item.canonicalName))].sort();
}

const answerDirectories: Record<InputKind, string> = {
  [InputKind.Screenshot]: "screenshots",
  [InputKind.Receipt]: "receipts",
  [InputKind.OrderText]: "texts",
};

describe("replay and demo", () => {
  it.each([
    ["order-delivery-01", InputKind.Screenshot],
    ["receipt-01-flat", InputKind.Receipt],
    ["text-mall-03", InputKind.OrderText],
  ] as const)(
    "replays %s and matches the standard canonical-name set",
    async (id, kind) => {
      const recognizer = new ReplayRecognizer(
        join(repository, `test-data/recordings/synthetic/${id}.json`),
      );
      const result = await recognizer.recognize(
        requestFor(kind),
        AbortSignal.timeout(2_000),
      );

      const answer = JSON.parse(
        readFileSync(
          join(
            repository,
            `test-data/synthetic/${answerDirectories[kind]}/${id}.json`,
          ),
          "utf8",
        ),
      ) as StandardAnswer;
      const expected = [
        ...new Set(
          answer.items.map(
            (item) =>
              vocabulary.resolve(item.canonical_name) ||
              item.canonical_name,
          ),
        ),
      ].sort();

      expect(canonicalNames(result.items)).toEqual(expected);
      expect(result.isDemo).toBe(false);
    },
  );

  it("has a demo preset for every input kind", async () => {
    const recognizer = new DemoRecognizer();
    for (const kind of Object.values(InputKind)) {
      const result = await recognizer.recognize(
        requestFor(kind),
        AbortSignal.timeout(2_000),
      );
      expect(result.isDemo).toBe(true);
      expect(result.items.length).toBeGreaterThan(0);
    }
  });

  it("reports a missing replay file as a bad response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "whilefresh-missing-"));
    try {
      const replay = new ReplayRecognizer(join(directory, "missing.json"));
      const demo = new DemoRecognizer(directory);

      for (const recognizer of [replay, demo]) {
        await expect(
          recognizer.recognize(
            requestFor(InputKind.Screenshot),
            AbortSignal.timeout(2_000),
          ),
        ).rejects.toMatchObject({
          kind: ErrorKind.BadResponse,
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("round-trips a recording without changing its data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "whilefresh-recording-"));
    try {
      const original = await readRecording(
        join(
          repository,
          "test-data/recordings/synthetic/order-delivery-01.json",
        ),
      );
      const copyPath = join(directory, "copy.json");

      await writeRecording(copyPath, original);
      await expect(readRecording(copyPath)).resolves.toEqual(original);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes recordings readable and writable by the owner only", async () => {
    const directory = mkdtempSync(join(tmpdir(), "whilefresh-permissions-"));
    try {
      const file = join(directory, "recording.json");
      writeFileSync(file, "{}", { mode: 0o644 });
      chmodSync(file, 0o644);

      const recording = await readRecording(
        join(
          repository,
          "test-data/recordings/synthetic/text-mall-03.json",
        ),
      );
      await writeRecording(file, recording);

      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
