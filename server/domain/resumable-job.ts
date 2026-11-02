export const JobState = {
  Pending: "pending",
  Running: "running",
  Done: "done",
  Failed: "failed",
} as const;

export type JobState = (typeof JobState)[keyof typeof JobState];

export const BatchState = {
  Pending: "pending",
  Done: "done",
  Failed: "failed",
} as const;

export type BatchState = (typeof BatchState)[keyof typeof BatchState];

export const ResumableJobState = JobState;
export type ResumableJobState = JobState;
export const ResumableBatchState = BatchState;
export type ResumableBatchState = BatchState;

export interface ResumableBatch {
  state: BatchState;
  result: string;
}

export function stateKey(state: JobState): string {
  return state;
}

export function stateFromKey(key: string): JobState | null {
  return Object.values(JobState).find((state) => state === key) ?? null;
}

export function batchStateKey(state: BatchState): string {
  return state;
}

export function batchStateFromKey(key: string): BatchState | null {
  return Object.values(BatchState).find((state) => state === key) ?? null;
}

export class ResumableJob {
  static stateKey(state: JobState): string {
    return stateKey(state);
  }

  static stateFromKey(key: string): JobState | null {
    return stateFromKey(key);
  }

  static batchStateKey(state: BatchState): string {
    return batchStateKey(state);
  }

  static batchStateFromKey(key: string): BatchState | null {
    return batchStateFromKey(key);
  }

  static restore(
    jobState: JobState,
    batches: readonly ResumableBatch[],
  ): ResumableJob | null {
    let unfinishedSeen = false;
    for (const batch of batches) {
      if (batch.state === BatchState.Done && unfinishedSeen) {
        return null;
      }
      unfinishedSeen ||= batch.state !== BatchState.Done;
    }
    if (
      jobState === JobState.Done &&
      (batches.length === 0 || unfinishedSeen)
    ) {
      return null;
    }

    const job = new ResumableJob();
    job.currentState = jobState;
    job.currentBatches = batches.map((batch) => ({ ...batch }));
    if (jobState === JobState.Running) {
      job.currentState = JobState.Failed;
      const next = job.nextBatch();
      if (next < job.currentBatches.length) {
        job.currentBatches[next]!.state = BatchState.Failed;
      }
    }
    return job;
  }

  private currentState: JobState = JobState.Pending;
  private currentBatches: ResumableBatch[] = [];

  get state(): JobState {
    return this.currentState;
  }

  get batches(): readonly ResumableBatch[] {
    return this.currentBatches;
  }

  get batchCount(): number {
    return this.currentBatches.length;
  }

  start(): boolean {
    if (
      this.currentState !== JobState.Pending &&
      this.currentState !== JobState.Failed
    ) {
      return false;
    }
    this.currentState = JobState.Running;
    return true;
  }

  plan(count: number): boolean {
    if (this.currentState !== JobState.Running || count <= 0) {
      return false;
    }
    if (this.currentBatches.length === 0) {
      this.currentBatches = Array.from({ length: count }, () => ({
        state: BatchState.Pending,
        result: "",
      }));
      return true;
    }
    return this.currentBatches.length === count;
  }

  completeBatch(index: number, result: string): boolean {
    if (
      this.currentState !== JobState.Running ||
      index !== this.nextBatch() ||
      index >= this.currentBatches.length
    ) {
      return false;
    }
    this.currentBatches[index] = { state: BatchState.Done, result };
    if (this.nextBatch() === this.currentBatches.length) {
      this.currentState = JobState.Done;
    }
    return true;
  }

  fail(): boolean {
    if (this.currentState !== JobState.Running) {
      return false;
    }
    this.currentState = JobState.Failed;
    const next = this.nextBatch();
    if (next < this.currentBatches.length) {
      this.currentBatches[next]!.state = BatchState.Failed;
    }
    return true;
  }

  reset(): void {
    this.currentState = JobState.Pending;
    this.currentBatches = [];
  }

  nextBatch(): number {
    const index = this.currentBatches.findIndex(
      (batch) => batch.state !== BatchState.Done,
    );
    return index === -1 ? this.currentBatches.length : index;
  }

  results(): string[] {
    return this.currentBatches
      .filter((batch) => batch.state === BatchState.Done)
      .map((batch) => batch.result);
  }
}
