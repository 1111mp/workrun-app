ALTER TABLE schedules ADD COLUMN schedule_kind TEXT NOT NULL DEFAULT 'recurring' CHECK (schedule_kind IN ('recurring','once'));
ALTER TABLE schedules ADD COLUMN run_at TEXT;
ALTER TABLE schedules ADD COLUMN finished_at TEXT;
ALTER TABLE schedules ADD COLUMN finish_reason TEXT CHECK (finish_reason IN ('triggered','missed','skipped','failed'));
