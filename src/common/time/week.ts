import { formatInTimeZone } from 'date-fns-tz';

/** Sunday date identifying the week in a location's wall-clock calendar. */
export function weekKeyInTimezone(date: Date, timezone: string): string {
  const localDate = formatInTimeZone(date, timezone, 'yyyy-MM-dd');
  const sunday = new Date(`${localDate}T00:00:00.000Z`);
  sunday.setUTCDate(sunday.getUTCDate() - sunday.getUTCDay());
  return sunday.toISOString().slice(0, 10);
}

export function hoursInWeek(
  weekOf: Date,
  timezone: string,
  assignments: Array<{ startAt: Date; endAt: Date; timezone: string }>,
): number {
  const week = weekKeyInTimezone(weekOf, timezone);
  return assignments.reduce((hours, assignment) => {
    if (weekKeyInTimezone(assignment.startAt, assignment.timezone) !== week)
      return hours;
    return (
      hours +
      (assignment.endAt.getTime() - assignment.startAt.getTime()) / 3_600_000
    );
  }, 0);
}
