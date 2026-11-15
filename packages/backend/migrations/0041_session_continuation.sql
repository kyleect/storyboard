-- A session that continues an earlier one (session rollover design, D8).
--
-- `continued_from_id` is the session it continues, and `continued_from_title`
-- that session's title then, so a purged predecessor can still be named, as
-- with `forked_from_title`. `continued_carried` is how many messages were
-- copied into this session, for the divider. There is no foreign key, as with
-- `forked_from_id`, so purging the earlier session is never blocked by this one.
ALTER TABLE sessions ADD COLUMN continued_from_id TEXT;
ALTER TABLE sessions ADD COLUMN continued_from_title TEXT;
ALTER TABLE sessions ADD COLUMN continued_carried INTEGER;

CREATE INDEX sessions_continued_from ON sessions(continued_from_id)
  WHERE continued_from_id IS NOT NULL;
