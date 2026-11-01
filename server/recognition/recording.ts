import { ErrorKind, InputKind, makeRecognitionError } from "./types.js";
import { PROMPT_VERSION } from "./prompt.js";
import {
  mergeResults,
  parseChatCompletion,
} from "./response-parser.js";
import { open, readFile } from "node:fs/promises";
import type {
  BatchSpan,
  RecognitionRequest,
  RecognitionResult,
} from "./types.js";

export const RECORDING_FORMAT = 1;

export interface Recording {
  inputKind: InputKind;
  imageCount: number;
  textLength: number;
  promptVersion: string;
  responses: unknown[];
  batches?: BatchSpan[];
}

interface RecordingFile {
  format: typeof RECORDING_FORMAT;
  request: {
    inputKind: InputKind;
    imageCount: number;
    textLength: number;
    promptVersion: string;
  };
  batches?: BatchSpan[];
  responses: unknown[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInputKind(value: unknown): value is InputKind {
  return Object.values(InputKind).includes(value as InputKind);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isBatchSpan(value: unknown): value is BatchSpan {
  return (
    isObject(value) &&
    Number.isInteger(value.firstImage) &&
    Number.isInteger(value.lastImage)
  );
}

function parseRecording(value: unknown): Recording {
  if (!isObject(value) || value.format !== RECORDING_FORMAT) {
    throw new Error(`recording is not format ${RECORDING_FORMAT}`);
  }
  const request = value.request;
  if (
    !isObject(request) ||
    !isInputKind(request.inputKind) ||
    !nonNegativeInteger(request.imageCount) ||
    !nonNegativeInteger(request.textLength) ||
    typeof request.promptVersion !== "string"
  ) {
    throw new Error("recording request summary is invalid");
  }
  if (!Array.isArray(value.responses) || value.responses.length === 0) {
    throw new Error("recording has no responses");
  }

  let batches: BatchSpan[] | undefined;
  if (value.batches !== undefined) {
    if (!Array.isArray(value.batches) || !value.batches.every(isBatchSpan)) {
      throw new Error("recording batches are invalid");
    }
    batches = value.batches.map((span) => ({
      firstImage: span.firstImage,
      lastImage: span.lastImage,
    }));
  }

  return {
    inputKind: request.inputKind,
    imageCount: request.imageCount,
    textLength: request.textLength,
    promptVersion: request.promptVersion,
    responses: [...value.responses],
    ...(batches === undefined ? {} : { batches }),
  };
}

export function makeRecording(
  request: RecognitionRequest,
  result: RecognitionResult,
): Recording {
  return {
    inputKind: request.kind,
    imageCount: request.images.length,
    textLength: request.text.length,
    promptVersion: PROMPT_VERSION,
    responses: [...result.rawResponses],
    ...(result.batchSpans.length === result.rawResponses.length &&
    result.batchSpans.length > 0
      ? {
          batches: result.batchSpans.map((span) => ({
            firstImage: span.firstImage,
            lastImage: span.lastImage,
          })),
        }
      : {}),
  };
}

export async function readRecording(file: string): Promise<Recording> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot read recording ${file}: ${message}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`recording ${file} is not valid JSON: ${message}`);
  }
  return parseRecording(value);
}

function fileResponse(response: unknown): unknown {
  if (typeof response !== "string") {
    return response;
  }
  try {
    return JSON.parse(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`recording response is not valid JSON: ${message}`);
  }
}

export async function writeRecording(
  file: string,
  recording: Recording,
): Promise<void> {
  const body: RecordingFile = {
    format: RECORDING_FORMAT,
    request: {
      inputKind: recording.inputKind,
      imageCount: recording.imageCount,
      textLength: recording.textLength,
      promptVersion: recording.promptVersion,
    },
    responses: recording.responses.map(fileResponse),
    ...(recording.batches !== undefined
      ? { batches: recording.batches }
      : {}),
  };

  const handle = await open(file, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.truncate(0);
    await handle.writeFile(`${JSON.stringify(body, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

function responseBody(response: unknown): string {
  return typeof response === "string" ? response : JSON.stringify(response);
}

export function resultFromRecording(
  recording: Recording,
  request: RecognitionRequest,
): RecognitionResult {
  if (recording.responses.length === 0) {
    throw makeRecognitionError(
      ErrorKind.BadResponse,
      "recording has no responses",
    );
  }

  const hasBatchSpans =
    recording.batches !== undefined &&
    recording.batches.length === recording.responses.length;
  const parts: RecognitionResult[] = [];
  recording.responses.forEach((response, index) => {
    const outcome = parseChatCompletion(
      responseBody(response),
      request.vocabulary,
      recording.inputKind,
    );
    if (!outcome.result) {
      throw outcome.error;
    }
    if (hasBatchSpans) {
      outcome.result.batchSpans = [recording.batches![index]];
    }
    parts.push(outcome.result);
  });
  return mergeResults(parts);
}
