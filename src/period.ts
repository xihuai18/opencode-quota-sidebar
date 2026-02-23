export function periodStart(period: 'day' | 'week' | 'month') {
  const now = new Date()
  if (period === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
  }
  if (period === 'week') {
    const day = now.getDay()
    const shift = day === 0 ? 6 : day - 1
    const start = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - shift,
    )
    start.setHours(0, 0, 0, 0)
    return start.getTime()
  }
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}
