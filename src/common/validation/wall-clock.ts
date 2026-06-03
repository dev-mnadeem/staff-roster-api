/**
 * "HH:MM" on a 24-hour clock, 00:00 to 23:59, plus 24:00 so a window can run
 * to the end of the day — overnight availability is entered as two windows,
 * e.g. Fri 18:00–24:00 and Sat 00:00–02:00.
 */
export const WALL_CLOCK_TIME = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
