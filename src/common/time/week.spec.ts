import { hoursInWeek, weekKeyInTimezone } from './week';

describe('location calendar weeks', () => {
  it('keeps Saturday evening out of the new UTC week', () => {
    expect(
      weekKeyInTimezone(
        new Date('2026-05-10T00:30:00Z'),
        'America/Los_Angeles',
      ),
    ).toBe('2026-05-03');
  });
  it('assigns the same instant to the correct week at each site', () => {
    const instant = new Date('2026-05-10T04:30:00Z');
    expect(weekKeyInTimezone(instant, 'America/New_York')).toBe('2026-05-10');
    expect(weekKeyInTimezone(instant, 'America/Los_Angeles')).toBe(
      '2026-05-03',
    );
  });
  it('does not shift the week when daylight saving time changes', () => {
    for (const instant of [
      '2026-03-08T06:30:00Z',
      '2026-03-08T07:30:00Z',
      '2026-11-01T05:30:00Z',
      '2026-11-01T06:30:00Z',
    ]) {
      const expected = instant.startsWith('2026-03')
        ? '2026-03-08'
        : '2026-11-01';
      expect(weekKeyInTimezone(new Date(instant), 'America/New_York')).toBe(
        expected,
      );
    }
  });
});

it('ranks hours by the same local weeks used by the constraint engine', () => {
  const startAt = new Date('2026-05-10T04:30:00Z');
  const endAt = new Date('2026-05-10T08:30:00Z');
  expect(
    hoursInWeek(startAt, 'America/New_York', [
      { startAt, endAt, timezone: 'America/New_York' },
      { startAt, endAt, timezone: 'America/Los_Angeles' },
    ]),
  ).toBe(4);
});
