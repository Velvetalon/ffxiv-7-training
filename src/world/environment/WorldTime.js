const HOURS_PER_DAY = 24;
const SECONDS_PER_EORZEA_HOUR = 175;

function wrapHour(value) {
  const hour = Number(value);
  if (!Number.isFinite(hour)) return 0;
  return ((hour % HOURS_PER_DAY) + HOURS_PER_DAY) % HOURS_PER_DAY;
}

/**
 * Independent world-clock state. A host may advance it locally or replace its
 * time with an authoritative state source without involving the renderer.
 */
export class WorldTime {
  constructor({ hour = 8, day = 0, secondsPerHour = SECONDS_PER_EORZEA_HOUR, paused = false } = {}) {
    this.hour = wrapHour(hour);
    this.day = Math.max(0, Math.floor(Number(day) || 0));
    this.secondsPerHour = Math.max(1, Number(secondsPerHour) || SECONDS_PER_EORZEA_HOUR);
    this.paused = Boolean(paused);
  }

  setHour(hour, day = this.day) {
    this.hour = wrapHour(hour);
    this.day = Math.max(0, Math.floor(Number(day) || 0));
    return this.snapshot();
  }

  setState({ hour, day, paused } = {}) {
    if (hour !== undefined) this.hour = wrapHour(hour);
    if (day !== undefined) this.day = Math.max(0, Math.floor(Number(day) || 0));
    if (paused !== undefined) this.paused = Boolean(paused);
    return this.snapshot();
  }

  advance(realSeconds) {
    if (this.paused) return this.snapshot();
    const deltaHours = (Math.max(0, Number(realSeconds) || 0) / this.secondsPerHour);
    const accumulated = this.hour + deltaHours;
    this.day += Math.floor(accumulated / HOURS_PER_DAY);
    this.hour = wrapHour(accumulated);
    return this.snapshot();
  }

  snapshot() {
    return Object.freeze({
      day: this.day,
      hour: this.hour,
      normalized: this.hour / HOURS_PER_DAY,
      paused: this.paused,
      secondsPerHour: this.secondsPerHour,
    });
  }
}

export const EORZEA_TIME = Object.freeze({ HOURS_PER_DAY, SECONDS_PER_EORZEA_HOUR });
