const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCHEDULE_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function getShanghaiDateKey(date = new Date()) {
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function getShanghaiMinuteOfDay(date = new Date()) {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function parseScheduleTime(value) {
  if (!SCHEDULE_TIME_PATTERN.test(value || "")) {
    throw new Error("invalid_schedule_time");
  }
  const [hour, minute] = value.split(":").map(Number);
  return { hour, minute, minuteOfDay: hour * 60 + minute };
}

function getNextRunAt(date = new Date(), scheduleTime = "09:00") {
  const { hour, minute } = parseScheduleTime(scheduleTime);
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  const target = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    hour - 8,
    minute,
    0,
    0
  );
  return new Date(target <= date.getTime() ? target + DAY_MS : target);
}

class DailyScheduler {
  constructor(options) {
    this.scheduleTime = options.scheduleTime;
    parseScheduleTime(this.scheduleTime);
    this.onDue = options.onDue;
    this.now = options.now || (() => new Date());
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.timer = null;
    this.nextRunAt = null;
  }

  async start() {
    const current = this.now();
    const { minuteOfDay } = parseScheduleTime(this.scheduleTime);
    if (getShanghaiMinuteOfDay(current) >= minuteOfDay) {
      await this.onDue(getShanghaiDateKey(current), "startup_catch_up");
    }
    this.scheduleNext();
  }

  reschedule(scheduleTime) {
    parseScheduleTime(scheduleTime);
    this.scheduleTime = scheduleTime;
    this.scheduleNext();
    return this.getState();
  }

  scheduleNext() {
    if (this.timer) {
      this.clearTimer(this.timer);
    }
    const current = this.now();
    this.nextRunAt = getNextRunAt(current, this.scheduleTime);
    const delay = Math.max(0, this.nextRunAt.getTime() - current.getTime());
    this.timer = this.setTimer(async () => {
      const dueAt = this.now();
      try {
        await this.onDue(getShanghaiDateKey(dueAt), "scheduled");
      } finally {
        this.scheduleNext();
      }
    }, delay);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  getState() {
    return {
      scheduleTime: this.scheduleTime,
      timeZone: "Asia/Shanghai",
      nextRunAt: this.nextRunAt ? this.nextRunAt.toISOString() : null
    };
  }
}

module.exports = {
  DailyScheduler,
  getNextRunAt,
  getShanghaiDateKey,
  getShanghaiMinuteOfDay,
  parseScheduleTime
};
