import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";

import {
  RecipeErrorKind,
  type RecipeError,
  type RecipeSearchResult,
  type RecipeSource,
  type WebRecipe,
} from "../../server/recipes/types.js";
import {
  parseContract,
  type RecipeParseOutcome,
} from "../../server/recipes/xiachufang-parser.js";

type JsonObject = Record<string, unknown>;

interface ParsedRecording {
  outcome: RecipeParseOutcome;
  operation: "search" | "detail" | null;
  keyword: string;
  id: string;
  page: number;
}

export const NOT_FOUND_RECORDING_DETAIL = "no recording for this request";

class RecordedRecipeError extends Error implements RecipeError {
  readonly kind: RecipeErrorKind;
  readonly detail: string;

  constructor(error: RecipeError) {
    super(error.detail);
    this.name = "RecordedRecipeError";
    this.kind = error.kind;
    this.detail = error.detail;
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failed(detail: string): RecipeParseOutcome {
  return {
    result: null,
    error: { kind: RecipeErrorKind.BadResponse, detail },
  };
}

function parseRecording(source: string): ParsedRecording {
  let value: unknown;
  try {
    value = YAML.parse(source);
  } catch (error) {
    return {
      outcome: failed(
        error instanceof Error ? error.message : "malformed YAML",
      ),
      operation: null,
      keyword: "",
      id: "",
      page: 1,
    };
  }

  const outcome = parseContract(value);
  if (!isObject(value)) {
    return { outcome, operation: null, keyword: "", id: "", page: 1 };
  }

  const version =
    typeof value.schema_version === "string"
      ? value.schema_version
      : "";
  const major = version.split(".")[0] ?? "";
  const operation =
    /^-?\d+$/.test(major) &&
    Number(major) === 1 &&
    (value.operation === "search" || value.operation === "detail")
      ? value.operation
      : null;
  const query = isObject(value.query) ? value.query : {};
  const keyword =
    typeof query.keyword === "string" ? query.keyword : "";
  const id = typeof query.id === "string" ? query.id : "";
  const rawPage = query.page;
  const page =
    typeof rawPage === "number" && Number.isFinite(rawPage)
      ? Math.trunc(rawPage)
      : typeof rawPage === "string" &&
          rawPage.trim() &&
          Number.isFinite(Number(rawPage))
        ? Math.trunc(Number(rawPage))
        : 1;

  return { outcome, operation, keyword, id, page };
}

function searchKey(keyword: string, page: number): string {
  return `search\n${keyword}\n${page}`;
}

function detailKey(id: string): string {
  return `detail\n${id}`;
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("request cancelled");
  error.name = "AbortError";
  return error;
}

export class RecordedRecipeSource implements RecipeSource {
  private readonly documents = new Map<string, RecipeParseOutcome>();

  addFile(path: string): boolean {
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      return false;
    }

    const recording = parseRecording(source);
    if (recording.operation === null) {
      return false;
    }
    const key =
      recording.operation === "search"
        ? searchKey(recording.keyword, recording.page)
        : detailKey(recording.id);
    this.documents.set(key, recording.outcome);
    return true;
  }

  addDirectory(directory: string): number {
    let names: string[];
    try {
      names = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return 0;
    }

    let added = 0;
    for (const name of names) {
      if (this.addFile(join(directory, name))) {
        added += 1;
      }
    }
    return added;
  }

  isConfigured(): boolean {
    return true;
  }

  search(
    keyword: string,
    page: number,
    signal: AbortSignal,
  ): Promise<RecipeSearchResult> {
    return this.answer(searchKey(keyword, page), signal, (result) => {
      if (!("items" in result)) {
        throw new RecordedRecipeError({
          kind: RecipeErrorKind.BadResponse,
          detail: "recorded query is not a search",
        });
      }
      return result;
    });
  }

  detail(id: string, signal: AbortSignal): Promise<WebRecipe> {
    return this.answer(detailKey(id), signal, (result) => {
      if ("items" in result) {
        throw new RecordedRecipeError({
          kind: RecipeErrorKind.BadResponse,
          detail: "recorded query is not a detail",
        });
      }
      return result;
    });
  }

  private answer<T>(
    key: string,
    signal: AbortSignal,
    select: (result: RecipeSearchResult | WebRecipe) => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener("abort", onAbort);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      queueMicrotask(() => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(abortReason(signal));
          return;
        }

        const outcome = this.documents.get(key);
        if (!outcome) {
          reject(
            new RecordedRecipeError({
              kind: RecipeErrorKind.NotFound,
              detail: NOT_FOUND_RECORDING_DETAIL,
            }),
          );
          return;
        }
        if (!outcome.result) {
          reject(new RecordedRecipeError(outcome.error));
          return;
        }

        try {
          resolve(select(outcome.result));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
