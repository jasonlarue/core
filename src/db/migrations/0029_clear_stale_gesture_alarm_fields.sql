-- Temperature taps never used the alarm fields, but switching a tap from an
-- alarm action to a temperature one left them in the row. Ringing actions now
-- apply to temperature taps too, so leftovers would silently snooze or stop
-- alarms; clear them. New saves write every field.
UPDATE `tap_gestures` SET `alarm_behavior` = NULL, `alarm_snooze_duration` = NULL, `alarm_inactive_behavior` = NULL WHERE `action_type` = 'temperature';
