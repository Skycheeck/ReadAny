/**
 * Keeps a reader's saved position consistent with sync.
 *
 * A book is synced as one row, last-write-wins by `updated_at`. A reader that
 * stays open while sync applies a newer position from another device would
 * otherwise write its stale in-memory position back with a fresh timestamp and
 * discard the newer one. The tracker therefore:
 *  - persists only positions the user actually moved to (not the restore on open),
 *  - never overwrites a position another device wrote after the reader last looked,
 *  - tells the reader when to adopt a newer remote position or ask the user.
 */
import type { BookProgressState, SaveBookProgressResult } from "../db/book-queries";

export interface PositionBaseline {
  /** `updated_at` of the book row the reader last saw, saved or adopted. */
  updatedAt: number;
  cfi: string | null;
  progress: number;
}

export interface ReaderPosition {
  progress: number;
  cfi: string;
}

export type PositionSyncOutcome =
  /** Nothing to do. */
  | { type: "none" }
  /** The position was written to the database. */
  | { type: "saved"; updatedAt: number }
  /** The reader is idle and the remote position is ahead: jump there. */
  | { type: "adopt"; remote: BookProgressState }
  /** Both sides moved (or the remote is behind): let the user choose. */
  | { type: "conflict"; remote: BookProgressState };

export interface PositionSyncDeps {
  save: (
    position: { progress: number; currentCfi: string },
    baselineUpdatedAt: number,
  ) => Promise<SaveBookProgressResult>;
  load: () => Promise<BookProgressState | null>;
}

export class ReaderPositionSync {
  private baseline: PositionBaseline;
  private latest: ReaderPosition | null = null;
  private userMoved = false;
  private conflict: BookProgressState | null = null;

  constructor(
    baseline: PositionBaseline,
    private readonly deps: PositionSyncDeps,
  ) {
    this.baseline = { ...baseline };
  }

  getBaseline(): PositionBaseline {
    return { ...this.baseline };
  }

  /** True while a conflict is waiting for the user's decision. */
  hasPendingConflict(): boolean {
    return this.conflict !== null;
  }

  /**
   * Records the position the reader is showing. `restoring` marks relocations
   * caused by opening the book at its saved position, which are not user moves.
   */
  noteRelocate(position: ReaderPosition, options: { restoring?: boolean } = {}): void {
    if (options.restoring) return;
    this.latest = position;
    if (position.cfi !== this.baseline.cfi) this.userMoved = true;
  }

  /** True when there is a user-made position that is not in the database yet. */
  isDirty(): boolean {
    return this.userMoved && this.latest !== null && this.latest.cfi !== this.baseline.cfi;
  }

  /** Writes the latest user position, unless another device wrote a newer one. */
  async flush(): Promise<PositionSyncOutcome> {
    if (!this.isDirty() || this.conflict) return { type: "none" };
    const latest = this.latest as ReaderPosition;

    const result = await this.deps.save(
      { progress: latest.progress, currentCfi: latest.cfi },
      this.baseline.updatedAt,
    );
    if (result.saved) {
      this.baseline = { updatedAt: result.updatedAt, cfi: latest.cfi, progress: latest.progress };
      return { type: "saved", updatedAt: result.updatedAt };
    }
    this.conflict = result.remote;
    return { type: "conflict", remote: result.remote };
  }

  /** Call after sync finished: looks for a position another device wrote. */
  async checkRemote(): Promise<PositionSyncOutcome> {
    if (this.conflict) return { type: "none" };
    const remote = await this.deps.load();
    if (!remote || !remote.fromOtherDevice) return { type: "none" };
    if (remote.updatedAt <= this.baseline.updatedAt) return { type: "none" };

    if (!remote.currentCfi || remote.currentCfi === this.baseline.cfi) {
      // Same place (or nothing usable): just move the baseline forward.
      this.baseline = {
        updatedAt: remote.updatedAt,
        cfi: remote.currentCfi ?? this.baseline.cfi,
        progress: remote.progress,
      };
      return { type: "none" };
    }

    if (this.isDirty()) {
      this.conflict = remote;
      return { type: "conflict", remote };
    }
    if (remote.progress > this.baseline.progress) {
      return { type: "adopt", remote };
    }
    // The remote row is newer but behind us: do not move the reader silently.
    this.conflict = remote;
    return { type: "conflict", remote };
  }

  /** The reader jumped to the remote position. */
  adopt(remote: BookProgressState): void {
    this.baseline = {
      updatedAt: remote.updatedAt,
      cfi: remote.currentCfi,
      progress: remote.progress,
    };
    this.latest = null;
    this.userMoved = false;
    this.conflict = null;
  }

  /** The user chose to keep the local position; the next save overwrites the remote one. */
  keepLocal(remote: BookProgressState): void {
    this.baseline = {
      updatedAt: remote.updatedAt,
      cfi: remote.currentCfi,
      progress: remote.progress,
    };
    this.conflict = null;
  }
}
