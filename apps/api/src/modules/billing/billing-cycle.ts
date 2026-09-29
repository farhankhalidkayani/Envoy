/** UTC throughout — a billing cycle boundary shouldn't shift with the server's local timezone. */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** `day` clamped to the month's actual length — a billingCycleDay of 31 resets on Feb 28/29, not Mar 3. */
function cycleBoundary(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, Math.min(day, daysInMonth(year, monthIndex))));
}

/** The [start, end) window `now` currently falls in, given a monthly reset day. */
export function billingCycleWindow(billingCycleDay: number, now: Date): { start: Date; end: Date } {
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let start = cycleBoundary(year, month, billingCycleDay);

  if (start > now) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    start = cycleBoundary(year, month, billingCycleDay);
  }

  let endYear = year;
  let endMonth = month + 1;
  if (endMonth > 11) {
    endMonth = 0;
    endYear += 1;
  }
  return { start, end: cycleBoundary(endYear, endMonth, billingCycleDay) };
}
