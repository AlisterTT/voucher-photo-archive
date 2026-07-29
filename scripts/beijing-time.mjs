const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function asDate(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("时间值无效");
  return date;
}

export function beijingParts(value = Date.now()) {
  const shifted = new Date(asDate(value).getTime() + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

function pad(value, length = 2) {
  return String(value).padStart(length, "0");
}

export function beijingIsoString(value = Date.now()) {
  const parts = beijingParts(value);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}.${pad(parts.millisecond, 3)}+08:00`;
}

export function beijingCompactDateTime(value = Date.now()) {
  const parts = beijingParts(value);
  return `${pad(parts.year, 4)}${pad(parts.month)}${pad(parts.day)}${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`;
}

export function formatBeijingDateTime(value = Date.now()) {
  const parts = beijingParts(value);
  return `${pad(parts.year, 4)}/${pad(parts.month)}/${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}
