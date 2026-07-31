import test from "node:test";
import assert from "node:assert/strict";

import { canApplyRecordResponse, recordsNeedRefresh } from "../public/sync-state.js";

test("task stats cannot hide an unsynchronized records change", () => {
  const recordsSyncedAt = "2026-07-31T16:00:00+08:00";
  const taskLastActivityAt = "2026-07-31T16:00:01+08:00";
  const serverLastActivityAt = taskLastActivityAt;

  assert.equal(recordsNeedRefresh(serverLastActivityAt, recordsSyncedAt), true);
});

test("a marker captured before refresh keeps a concurrent change pending", () => {
  const refreshMarker = "2026-07-31T16:00:01+08:00";
  const serverLastActivityAt = "2026-07-31T16:00:02+08:00";

  assert.equal(recordsNeedRefresh(serverLastActivityAt, refreshMarker), true);
});

test("an image response is discarded after switching vouchers", () => {
  assert.equal(canApplyRecordResponse("voucher-a", "voucher-b"), false);
  assert.equal(canApplyRecordResponse("voucher-a", "voucher-a"), true);
});
