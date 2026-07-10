export function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseDate(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function daysBetween(left, right) {
  const a = new Date(left.getFullYear(), left.getMonth(), left.getDate()).getTime();
  const b = new Date(right.getFullYear(), right.getMonth(), right.getDate()).getTime();
  return Math.round((a - b) / 86400000);
}
