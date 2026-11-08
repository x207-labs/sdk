/**
 * A-SD-03/A-SD-04: runs async jobs of the same key one after the other (jobs of other keys are not delayed).
 * `settlePayment` reads the stored base, verifies and then saves; without this two concurrent settles of one payer both pass the check against the same base.
 * In process only, which is how the facilitator runs (one SQLite file, one process). A second facilitator process on the same file needs a database-level check.
 */
export class KeyedLock {
  readonly #tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(job, job);
    const tail = result.catch(() => undefined);
    this.#tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    }
  }
}
