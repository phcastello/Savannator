const HOUR = 3_600_000;
export const DEFAULT_COMPETITION_END_AT = "2026-09-25T23:59:00-03:00";

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function theilSen(points, value) {
  const slopes = [];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      const hours = (Date.parse(points[j].checked_at) - Date.parse(points[i].checked_at)) / HOUR;
      if (hours > 0) slopes.push((value(points[j]) - value(points[i])) / hours);
    }
  }
  return median(slopes);
}

export function seriesStats(series) {
  const latest = series.at(-1) ?? null;
  const previous = series.at(-2);
  if (!latest) return { latest: null, delta: null, rate: null };
  const latestAt = Date.parse(latest.checked_at);
  const hours = previous ? (latestAt - Date.parse(previous.checked_at)) / HOUR : null;
  const short = series.filter((item) => Date.parse(item.checked_at) >= latestAt - 12 * HOUR);
  return {
    latest,
    delta: previous && hours > 0 ? { count: latest.count - previous.count, hours } : null,
    rate: theilSen(short, (item) => item.count),
  };
}

function recent(checks, hours, now) {
  const start = now - hours * HOUR;
  return checks.filter((check) => Date.parse(check.checked_at) >= start);
}

export function calculateAnalytics(checks, { endAt = DEFAULT_COMPETITION_END_AT, asOf } = {}) {
  const deadline = Date.parse(endAt);
  const latest = checks.at(-1);
  if (!latest) return {
    latest: null, delta: null, rates: null, gap: null, gapSlope: null,
    gapDirection: null, forecast: { status: asOf >= deadline ? "ended" : "insufficient_data" },
  };

  const previous = checks.at(-2);
  const now = Date.parse(latest.checked_at);
  const short = recent(checks, 12, now);
  const long = recent(checks, 24, now);
  const gapOf = (check) => check.target_count - check.rival_count;
  const gap = gapOf(latest);
  const targetRate = theilSen(short, (check) => check.target_count);
  const rivalRate = theilSen(short, (check) => check.rival_count);
  const gapSlope = theilSen(short, gapOf);
  const delta = previous ? {
    target: latest.target_count - previous.target_count,
    rival: latest.rival_count - previous.rival_count,
    hours: (now - Date.parse(previous.checked_at)) / HOUR,
  } : null;
  const gapDirection = gapSlope === null || gap === 0 ? null
    : gap * gapSlope < 0 ? "closing" : "opening";

  let forecast = { status: "insufficient_data" };
  if ((asOf ?? now) >= deadline) {
    forecast = { status: "ended" };
  } else if (long.length >= 4 && short.length >= 4) {
    const longSlope = theilSen(long, gapOf);
    const lastThreeSlope = theilSen(short.slice(-3), gapOf);
    const crossing = gap !== 0 && gapSlope !== null && gap * gapSlope < 0;
    if (!crossing || Math.abs(gapSlope) < 1) {
      forecast = { status: "no_crossing" };
    } else {
      const sameDirection = gap * longSlope < 0 && gap * lastThreeSlope < 0;
      const ratio = Math.abs(lastThreeSlope / longSlope);
      const hours = -gap / gapSlope;
      const crossingAt = now + hours * HOUR;
      const stepRates = [];
      for (let i = 1; i < short.length; i += 1) {
        const elapsed = (Date.parse(short[i].checked_at) - Date.parse(short[i - 1].checked_at)) / HOUR;
        if (elapsed > 0) stepRates.push((gapOf(short[i]) - gapOf(short[i - 1])) / elapsed);
      }
      const volatility = median(stepRates.map((rate) => Math.abs(rate - gapSlope))) ?? 0;
      // Extrapolações distantes e taxas muito diferentes entre janelas são frágeis.
      if (!sameDirection || ratio < 0.5 || ratio > 2 || volatility > 2 * Math.abs(gapSlope) || hours > 48 || hours <= 0 || crossingAt <= (asOf ?? now)) {
        forecast = { status: "unstable" };
      } else if (crossingAt > deadline) {
        forecast = { status: "after_deadline" };
      } else {
        forecast = {
          status: "estimated",
          hours,
          at: new Date(crossingAt).toISOString(),
          projection: {
            at: new Date(now + Math.min(hours, 48) * HOUR).toISOString(),
            target: latest.target_count + targetRate * Math.min(hours, 48),
            rival: latest.rival_count + (targetRate - gapSlope) * Math.min(hours, 48),
          },
        };
      }
    }
  }

  return {
    latest,
    delta,
    rates: { target: targetRate, rival: rivalRate },
    gap,
    gapSlope,
    gapDirection,
    forecast,
  };
}
