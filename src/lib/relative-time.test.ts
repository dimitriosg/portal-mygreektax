import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

// `now` is pinned in every case so these assert the arithmetic, not the clock.
const NOW = new Date("2026-09-07T12:00:00Z");

function agoByDays(days: number): string {
  return relativeTime(new Date(NOW.getTime() - days * 86_400_000).toISOString(), NOW);
}

function agoByMinutes(mins: number): string {
  return relativeTime(new Date(NOW.getTime() - mins * 60_000).toISOString(), NOW);
}

describe("relativeTime", () => {
  it("handles the absent and unparseable cases", () => {
    expect(relativeTime(null, NOW)).toBe("Never");
    expect(relativeTime(undefined, NOW)).toBe("Never");
    expect(relativeTime("", NOW)).toBe("Never");
    expect(relativeTime("not a date", NOW)).toBe("Never");
  });

  it("does not go negative for a future timestamp", () => {
    expect(relativeTime(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe("just now");
  });

  it("counts minutes, then hours", () => {
    expect(agoByMinutes(0)).toBe("just now");
    expect(agoByMinutes(1)).toBe("1 min ago");
    expect(agoByMinutes(59)).toBe("59 min ago");
    expect(agoByMinutes(60)).toBe("1 hour ago");
    expect(agoByMinutes(120)).toBe("2 hours ago");
  });

  it("counts days up to 30", () => {
    expect(agoByDays(1)).toBe("1 day ago");
    expect(agoByDays(29)).toBe("29 days ago");
  });

  // The regression this file was added for. Deciding the year boundary on
  // `months < 12` left 360-364 days falling through to floor(days/365), which
  // printed "0 years ago" — live in admin-partners' "Last seen" column.
  it("never prints '0 years ago' in the 360-364 day gap", () => {
    expect(agoByDays(359)).toBe("11 months ago");
    for (const days of [360, 361, 362, 363, 364]) {
      expect(agoByDays(days)).toBe("12 months ago");
    }
  });

  it("crosses into years at 365 days, with the singular", () => {
    expect(agoByDays(365)).toBe("1 year ago");
    expect(agoByDays(730)).toBe("2 years ago");
  });

  it("never prints '0' of any unit", () => {
    for (let days = 30; days <= 800; days += 1) {
      expect(agoByDays(days)).not.toMatch(/^0 /);
    }
  });
});
