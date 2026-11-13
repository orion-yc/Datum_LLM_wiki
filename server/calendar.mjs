// Learning schedules are calendar dates, independent of the server OS timezone.
export function calendarDate(date = new Date(), timeZone = process.env.APP_TIMEZONE || 'Asia/Shanghai') {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
