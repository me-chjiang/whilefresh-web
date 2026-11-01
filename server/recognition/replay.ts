import { join } from "node:path";

import { config } from "../config.js";
import { readRecording, resultFromRecording } from "./recording.js";
import {
  ErrorKind,
  makeRecognitionError,
  type RecognitionError,
  type RecognitionRequest,
  type RecognitionResult,
  type Recognizer,
} from "./types.js";

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function isRecognitionError(value: unknown): value is RecognitionError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function replayFile(
  file: string,
  request: RecognitionRequest,
  signal: AbortSignal,
  isDemo: boolean,
): Promise<RecognitionResult> {
  throwIfAborted(signal);
  try {
    const recording = await readRecording(file);
    throwIfAborted(signal);
    const result = resultFromRecording(recording, request);
    result.isDemo = isDemo;
    return result;
  } catch (error) {
    if (isRecognitionError(error)) {
      throw error;
    }
    throw makeRecognitionError(ErrorKind.BadResponse, errorDetail(error));
  }
}

export class ReplayRecognizer implements Recognizer {
  constructor(private readonly file: string) {}

  async recognize(
    request: RecognitionRequest,
    signal: AbortSignal,
  ): Promise<RecognitionResult> {
    return replayFile(this.file, request, signal, false);
  }
}

export class DemoRecognizer implements Recognizer {
  private readonly directory: string;

  constructor(directory = join(config.assetsDir, "demo")) {
    this.directory = directory;
  }

  async recognize(
    request: RecognitionRequest,
    signal: AbortSignal,
  ): Promise<RecognitionResult> {
    return replayFile(
      join(this.directory, `${request.kind}.json`),
      request,
      signal,
      true,
    );
  }
}
