import { describe, expect, it, vi } from "vitest";
import type { BookProgressState } from "../db/book-queries";
import { ReaderPositionSync } from "./position-sync";

const remoteState = (overrides: Partial<BookProgressState> = {}): BookProgressState => ({
  progress: 0.255,
  currentCfi: "cfi-phone",
  updatedAt: 2000,
  fromOtherDevice: true,
  ...overrides,
});

function createTracker(options: { remote?: BookProgressState | null } = {}) {
  const save = vi.fn().mockResolvedValue({ saved: true, updatedAt: 3000 });
  const load = vi.fn().mockResolvedValue(options.remote ?? null);
  const tracker = new ReaderPositionSync(
    { updatedAt: 1000, cfi: "cfi-open", progress: 0.2 },
    { save, load },
  );
  return { tracker, save, load };
}

describe("ReaderPositionSync", () => {
  describe("saving", () => {
    it("does not save the position restored on open", async () => {
      const { tracker, save } = createTracker();
      tracker.noteRelocate({ progress: 0.19, cfi: "cfi-rederived" }, { restoring: true });

      expect(await tracker.flush()).toEqual({ type: "none" });
      expect(save).not.toHaveBeenCalled();
    });

    it("does not save when the reader never left the saved position", async () => {
      const { tracker, save } = createTracker();
      tracker.noteRelocate({ progress: 0.2, cfi: "cfi-open" });

      expect(await tracker.flush()).toEqual({ type: "none" });
      expect(save).not.toHaveBeenCalled();
    });

    it("saves a position the user moved to and advances the baseline", async () => {
      const { tracker, save } = createTracker();
      tracker.noteRelocate({ progress: 0.21, cfi: "cfi-next" });

      expect(await tracker.flush()).toEqual({ type: "saved", updatedAt: 3000 });
      expect(save).toHaveBeenCalledWith({ progress: 0.21, currentCfi: "cfi-next" }, 1000);
      expect(tracker.getBaseline()).toEqual({ updatedAt: 3000, cfi: "cfi-next", progress: 0.21 });

      // Flushing again without moving is a no-op (pagehide + unmount both flush).
      expect(await tracker.flush()).toEqual({ type: "none" });
      expect(save).toHaveBeenCalledTimes(1);
    });

    it("reports a conflict instead of overwriting a newer remote position", async () => {
      const remote = remoteState();
      const { tracker, save } = createTracker();
      save.mockResolvedValue({ saved: false, remote });
      tracker.noteRelocate({ progress: 0.21, cfi: "cfi-next" });

      expect(await tracker.flush()).toEqual({ type: "conflict", remote });
      expect(tracker.hasPendingConflict()).toBe(true);

      // No further writes while the user has not decided.
      expect(await tracker.flush()).toEqual({ type: "none" });
      expect(save).toHaveBeenCalledTimes(1);
    });

    it("saves the local position after the user chose to keep it", async () => {
      const remote = remoteState();
      const { tracker, save } = createTracker();
      save.mockResolvedValueOnce({ saved: false, remote });
      tracker.noteRelocate({ progress: 0.21, cfi: "cfi-next" });
      await tracker.flush();

      tracker.keepLocal(remote);
      expect(await tracker.flush()).toEqual({ type: "saved", updatedAt: 3000 });
      expect(save).toHaveBeenLastCalledWith({ progress: 0.21, currentCfi: "cfi-next" }, 2000);
    });
  });

  describe("remote position after sync", () => {
    it("ignores a database row that this device wrote itself", async () => {
      const { tracker } = createTracker({ remote: remoteState({ fromOtherDevice: false }) });
      expect(await tracker.checkRemote()).toEqual({ type: "none" });
    });

    it("ignores a row that is not newer than the baseline", async () => {
      const { tracker } = createTracker({ remote: remoteState({ updatedAt: 1000 }) });
      expect(await tracker.checkRemote()).toEqual({ type: "none" });
    });

    it("adopts a newer remote position that is ahead when the reader is idle", async () => {
      const remote = remoteState();
      const { tracker } = createTracker({ remote });
      expect(await tracker.checkRemote()).toEqual({ type: "adopt", remote });

      tracker.adopt(remote);
      expect(tracker.getBaseline()).toEqual({ updatedAt: 2000, cfi: "cfi-phone", progress: 0.255 });
    });

    it("does not write the stale position after adopting the remote one", async () => {
      const remote = remoteState();
      const { tracker, save } = createTracker({ remote });
      await tracker.checkRemote();
      tracker.adopt(remote);

      // The reader re-derives its own CFI for the adopted spot; the caller marks
      // those relocations as restoring.
      tracker.noteRelocate({ progress: 0.25, cfi: "cfi-rederived" }, { restoring: true });
      expect(await tracker.flush()).toEqual({ type: "none" });
      expect(save).not.toHaveBeenCalled();
    });

    it("asks the user when they already moved and the remote is newer", async () => {
      const remote = remoteState();
      const { tracker } = createTracker({ remote });
      tracker.noteRelocate({ progress: 0.21, cfi: "cfi-next" });

      expect(await tracker.checkRemote()).toEqual({ type: "conflict", remote });
    });

    it("asks the user instead of jumping back to a remote position that is behind", async () => {
      const remote = remoteState({ progress: 0.1, currentCfi: "cfi-old" });
      const { tracker } = createTracker({ remote });

      expect(await tracker.checkRemote()).toEqual({ type: "conflict", remote });
    });

    it("moves the baseline without prompting when the remote is at the same place", async () => {
      const remote = remoteState({ currentCfi: "cfi-open", progress: 0.2 });
      const { tracker } = createTracker({ remote });

      expect(await tracker.checkRemote()).toEqual({ type: "none" });
      expect(tracker.getBaseline().updatedAt).toBe(2000);
    });
  });
});
