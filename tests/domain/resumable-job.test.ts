import { describe, expect, it } from "vitest";

import {
  BatchState,
  JobState,
  ResumableJob,
  type ResumableBatch,
} from "../../server/domain/resumable-job.js";

describe("resumable jobs", () => {
  it("runs batches in order until done", () => {
    const job = new ResumableJob();

    expect(job.state).toBe(JobState.Pending);
    expect(job.plan(3)).toBe(false);
    expect(job.start()).toBe(true);
    expect(job.plan(3)).toBe(true);
    expect(job.nextBatch()).toBe(0);
    expect(job.completeBatch(1, "b")).toBe(false);
    expect(job.completeBatch(0, "a")).toBe(true);
    expect(job.completeBatch(1, "b")).toBe(true);
    expect(job.state).toBe(JobState.Running);
    expect(job.completeBatch(2, "c")).toBe(true);
    expect(job.state).toBe(JobState.Done);
    expect(job.results()).toEqual(["a", "b", "c"]);
    expect(job.start()).toBe(false);
  });

  it("resumes at the failed batch", () => {
    const job = new ResumableJob();

    expect(job.start()).toBe(true);
    expect(job.plan(3)).toBe(true);
    expect(job.completeBatch(0, "a")).toBe(true);
    expect(job.fail()).toBe(true);
    expect(job.state).toBe(JobState.Failed);
    expect(job.batches[1]?.state).toBe(BatchState.Failed);
    expect(job.nextBatch()).toBe(1);
    expect(job.start()).toBe(true);
    expect(job.plan(3)).toBe(true);
    expect(job.plan(4)).toBe(false);
    expect(job.completeBatch(1, "b")).toBe(true);
    expect(job.completeBatch(2, "c")).toBe(true);
    expect(job.state).toBe(JobState.Done);
  });

  it("restores persisted rows", () => {
    const rows: readonly ResumableBatch[] = [
      { state: BatchState.Done, result: "a" },
      { state: BatchState.Pending, result: "" },
      { state: BatchState.Pending, result: "" },
    ];

    const running = ResumableJob.restore(JobState.Running, rows);
    expect(running).not.toBeNull();
    expect(running?.state).toBe(JobState.Failed);
    expect(running?.nextBatch()).toBe(1);
    expect(running?.batches[1]?.state).toBe(BatchState.Failed);
    expect(running?.results()).toEqual(["a"]);

    const done = ResumableJob.restore(JobState.Done, [
      { state: BatchState.Done, result: "a" },
    ]);
    expect(done).not.toBeNull();
    expect(done?.state).toBe(JobState.Done);

    const pending = ResumableJob.restore(JobState.Pending, []);
    expect(pending).not.toBeNull();
    expect(pending?.nextBatch()).toBe(0);
  });

  it("rejects inconsistent rows", () => {
    expect(
      ResumableJob.restore(JobState.Done, [
        { state: BatchState.Done, result: "a" },
        { state: BatchState.Pending, result: "" },
      ]),
    ).toBeNull();
    expect(ResumableJob.restore(JobState.Done, [])).toBeNull();
    expect(
      ResumableJob.restore(JobState.Failed, [
        { state: BatchState.Failed, result: "" },
        { state: BatchState.Done, result: "b" },
      ]),
    ).toBeNull();
  });

  it("forgets batches on reset", () => {
    const job = new ResumableJob();

    expect(job.start()).toBe(true);
    expect(job.plan(2)).toBe(true);
    expect(job.completeBatch(0, "a")).toBe(true);
    job.reset();
    expect(job.state).toBe(JobState.Pending);
    expect(job.batchCount).toBe(0);
    expect(job.start()).toBe(true);
    expect(job.plan(4)).toBe(true);
  });

  it("round-trips state keys", () => {
    for (const state of Object.values(JobState)) {
      expect(ResumableJob.stateFromKey(ResumableJob.stateKey(state))).toBe(
        state,
      );
    }
    for (const state of Object.values(BatchState)) {
      expect(
        ResumableJob.batchStateFromKey(ResumableJob.batchStateKey(state)),
      ).toBe(state);
    }
    expect(ResumableJob.stateFromKey("paused")).toBeNull();
  });
});
