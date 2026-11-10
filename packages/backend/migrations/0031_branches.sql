-- Message branches (message editing and forking plan, part A).
--
-- A session's transcript becomes a tree: each top-level message points at the
-- message before it on its line, and the session points at the last message
-- of the line it shows (its tip). `seq` stays the order messages were
-- inserted in, which along any one line is the conversation order.
--
-- Existing messages are chained into one line each by the data step
-- `branches-backfill`; the columns are only added here.

-- The message before this one on its line. NULL for the first message of a
-- session (a session whose first message was edited has several), and for the
-- messages of subagent runs.
ALTER TABLE messages ADD COLUMN parent_id TEXT REFERENCES messages(id);

-- For the messages of a subagent run only: the top-level assistant message
-- that holds the root `start_subagent` call. A subagent message is shown with
-- the line that passes through its anchor. NULL for top-level messages.
ALTER TABLE messages ADD COLUMN anchor_id TEXT REFERENCES messages(id);

-- The child that was last on the active path through this message, so that
-- switching to a branch lands on the continuation last viewed. A hint with no
-- foreign key: it is checked against the live children when it is read.
ALTER TABLE messages ADD COLUMN last_child_id TEXT;

-- Set on the first message of a deleted branch; everything under it goes
-- with it. NULL: not deleted.
ALTER TABLE messages ADD COLUMN trashed_at TEXT;

-- The last message of the line the session shows. NULL for a session with no
-- messages.
ALTER TABLE sessions ADD COLUMN tip_id TEXT REFERENCES messages(id);

-- For a session made by forking: the session it was copied from and the title
-- that session had then. No foreign key: the source may be purged.
ALTER TABLE sessions ADD COLUMN forked_from_id TEXT;
ALTER TABLE sessions ADD COLUMN forked_from_title TEXT;

CREATE INDEX messages_parent ON messages(parent_id);
CREATE INDEX messages_anchor ON messages(anchor_id) WHERE anchor_id IS NOT NULL;
