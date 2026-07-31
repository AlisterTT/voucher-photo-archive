export function recordsNeedRefresh(serverActivityAt, recordsSyncedAt) {
  return serverActivityAt !== recordsSyncedAt;
}

export function canApplyRecordResponse(requestedRecordId, selectedRecordId) {
  return Boolean(requestedRecordId) && requestedRecordId === selectedRecordId;
}
