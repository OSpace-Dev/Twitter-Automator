const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DailyScheduler,
  getNextRunAt,
  getShanghaiDateKey,
  parseScheduleTime
} = require("../support/api/twitter-timeline/scheduler");

test("calculates the next Asia/Shanghai HH:mm run", () => {
  const now = new Date("2026-07-19T00:30:00.000Z");
  assert.equal(getShanghaiDateKey(now), "2026-07-19");
  assert.deepEqual(parseScheduleTime("09:15"), { hour: 9, minute: 15, minuteOfDay: 555 });
  assert.equal(getNextRunAt(now, "09:15").toISOString(), "2026-07-19T01:15:00.000Z");
  assert.equal(
    getNextRunAt(new Date("2026-07-19T02:00:00.000Z"), "09:15").toISOString(),
    "2026-07-20T01:15:00.000Z"
  );
});

test("catches up after startup and reschedules immediately", async () => {
  const dueCalls = [];
  const timers = [];
  const scheduler = new DailyScheduler({
    scheduleTime: "09:00",
    now: () => new Date("2026-07-19T02:30:00.000Z"),
    onDue: async (...args) => dueCalls.push(args),
    setTimer(callback, delay) {
      timers.push({ callback, delay });
      return { unref() {} };
    },
    clearTimer() {}
  });

  await scheduler.start();
  assert.deepEqual(dueCalls, [["2026-07-19", "startup_catch_up"]]);
  assert.equal(scheduler.getState().nextRunAt, "2026-07-20T01:00:00.000Z");
  const state = scheduler.reschedule("11:30");
  assert.equal(state.scheduleTime, "11:30");
  assert.equal(state.nextRunAt, "2026-07-19T03:30:00.000Z");
  assert.equal(timers.length, 2);
  scheduler.stop();
});
