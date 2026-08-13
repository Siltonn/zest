"use client";

import { Calendar, DateField, DatePicker, Label, TimeField } from "@heroui/react";
import {
  CalendarDate,
  Time,
  getLocalTimeZone,
  today,
  toCalendarDate,
  type CalendarDate as CalendarDateType,
  type Time as TimeType,
} from "@internationalized/date";

/**
 * Picking when a post goes out.
 *
 * Date and time are separate controls on purpose: a calendar popover is the
 * right way to choose a day, and a segmented time field is the right way to
 * choose an hour — cramming both into one input gives you neither. Both are
 * HeroUI, so keyboard behaviour and locale formatting come for free instead of
 * inheriting whatever the browser's native datetime widget happens to do.
 *
 * The value crossing this boundary is an ISO string, because that is what the
 * API takes; the calendar library's types stay inside.
 */
export function DateTimePicker({
  value,
  onChange,
  label,
}: {
  /** ISO 8601, or empty for "no time chosen". */
  value: string;
  onChange: (iso: string) => void;
  label?: string;
}) {
  const zone = getLocalTimeZone();
  const parsed = value ? new Date(value) : null;
  const valid = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  const date = valid
    ? new CalendarDate(valid.getFullYear(), valid.getMonth() + 1, valid.getDate())
    : null;
  const time = valid ? new Time(valid.getHours(), valid.getMinutes()) : null;

  const emit = (nextDate: CalendarDateType | null, nextTime: TimeType | null) => {
    if (!nextDate) {
      onChange("");
      return;
    }
    // Default to a reasonable hour rather than midnight, which nobody means.
    const hour = nextTime?.hour ?? 9;
    const minute = nextTime?.minute ?? 0;
    const local = new Date(
      nextDate.year,
      nextDate.month - 1,
      nextDate.day,
      hour,
      minute,
    );
    onChange(local.toISOString());
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <DatePicker
        value={date}
        onChange={(next) => emit(next, time)}
        // Nothing is scheduled into the past; the queue would publish it at once.
        minValue={today(zone)}
      >
        {label && <Label>{label}</Label>}
        <DatePicker.Trigger>
          <DateField.Root>
            <DateField.Group>
              <DateField.Input>
                {(segment) => <DateField.Segment segment={segment} />}
              </DateField.Input>
            </DateField.Group>
          </DateField.Root>
          <DatePicker.TriggerIndicator />
        </DatePicker.Trigger>
        <DatePicker.Popover>
          <Calendar>
            <Calendar.Header>
              <Calendar.NavButton slot="previous">‹</Calendar.NavButton>
              <Calendar.Heading />
              <Calendar.NavButton slot="next">›</Calendar.NavButton>
            </Calendar.Header>
            <Calendar.Grid>
              <Calendar.GridHeader>
                {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
              </Calendar.GridHeader>
              <Calendar.GridBody>
                {(day) => <Calendar.Cell date={day} />}
              </Calendar.GridBody>
            </Calendar.Grid>
          </Calendar>
        </DatePicker.Popover>
      </DatePicker>

      <TimeField value={time} onChange={(next) => emit(date, next)}>
        <TimeField.Group>
          <TimeField.Input>
            {(segment) => <TimeField.Segment segment={segment} />}
          </TimeField.Input>
        </TimeField.Group>
      </TimeField>
    </div>
  );
}

export { toCalendarDate };
