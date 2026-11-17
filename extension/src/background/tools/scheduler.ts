// Runs tasks so that tasks on different lanes overlap while tasks on one lane
// run strictly one after another in arrival order. A global cap keeps the
// browser from being flooded. Pure logic, no browser APIs.
//
// A task can be given an AbortSignal (a deadline, a cancel from the relay). When it fires the task
// is given up on: it is rejected with the signal's reason and its lane and slot are freed at once,
// so a Chrome call that never settles cannot block its lane or a slot forever.

interface Job {
  lane: string;
  /** Who queued the task, so one caller's queue can be dropped alone. */
  owner?: string;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** Set once the job settled or was given up on; later outcomes of its task are ignored. */
  done?: boolean | 'released';
}

export class Scheduler {
  private pending: Job[] = [];
  private busy = new Set<string>();
  private running = 0;

  constructor(readonly maxConcurrent = 6) {}

  run<T>(lane: string, task: () => Promise<T>, owner?: string, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const job: Job = { lane, owner, task, resolve: resolve as (v: unknown) => void, reject, signal };
      if (signal) {
        job.onAbort = () => this.giveUp(job, signal.reason);
        signal.addEventListener('abort', job.onAbort, { once: true });
      }
      this.pending.push(job);
      this.pump();
    });
  }

  /** Rejects every task that has not started yet (only `owner`'s when given); running tasks are left to finish. */
  cancelPending(reason: unknown, owner?: string): number {
    const dropped = owner === undefined ? this.pending.splice(0) : this.pending.filter((job) => job.owner === owner);
    if (owner !== undefined) this.pending = this.pending.filter((job) => job.owner !== owner);
    for (const job of dropped) this.settle(job, () => job.reject(reason));
    return dropped.length;
  }

  get stats() {
    return { running: this.running, queued: this.pending.length };
  }

  private pump(): void {
    let i = 0;
    while (i < this.pending.length && this.running < this.maxConcurrent) {
      const job = this.pending[i];
      if (this.busy.has(job.lane)) {
        i++;
        continue;
      }
      this.pending.splice(i, 1);
      this.busy.add(job.lane);
      this.running++;
      Promise.resolve()
        .then(job.task)
        .then(
          (value) => this.settle(job, () => job.resolve(value)),
          (reason) => this.settle(job, () => job.reject(reason)),
        )
        .finally(() => {
          // A job given up on already freed its lane and slot.
          if (job.done === 'released') return;
          this.release(job);
        });
    }
  }

  /** The signal fired: drop the job if it is still queued, or free its lane and slot if it is running. */
  private giveUp(job: Job, reason: unknown): void {
    if (job.done) return;
    const queued = this.pending.indexOf(job);
    if (queued !== -1) this.pending.splice(queued, 1);
    this.settle(job, () => job.reject(reason));
    if (queued === -1) {
      job.done = 'released';
      this.release(job);
    }
  }

  private settle(job: Job, outcome: () => void): void {
    if (job.done) return;
    job.done = true;
    if (job.onAbort) job.signal?.removeEventListener('abort', job.onAbort);
    outcome();
  }

  private release(job: Job): void {
    this.busy.delete(job.lane);
    this.running--;
    this.pump();
  }
}
