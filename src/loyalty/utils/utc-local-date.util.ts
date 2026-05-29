const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toUtcLocalDate(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

export function parseUtcLocalDate(value: string): Date | null {
  const trimmed = value.trim();
  const dateOnlyMatch = DATE_ONLY_PATTERN.exec(trimmed);

  if (dateOnlyMatch) {
    const [, rawYear, rawMonth, rawDay] = dateOnlyMatch;
    const year = Number(rawYear);
    const month = Number(rawMonth);
    const day = Number(rawDay);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }

    return date;
  }

  const parsed = new Date(trimmed);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return toUtcLocalDate(parsed);
}

export function isFutureUtcLocalDate(date: Date, reference: Date): boolean {
  return date.getTime() > toUtcLocalDate(reference).getTime();
}

export function isSameUtcMonthDay(date: Date, reference: Date): boolean {
  return (
    date.getUTCMonth() === reference.getUTCMonth() &&
    date.getUTCDate() === reference.getUTCDate()
  );
}

export function getUtcLocalYear(date: Date): number {
  return date.getUTCFullYear();
}
