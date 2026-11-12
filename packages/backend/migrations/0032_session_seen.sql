-- Session seen status
-- 
-- Record if a user has seen an assistant's response on a chat session.
--
-- Existing sessions will default to being seen.

ALTER TABLE sessions ADD COLUMN seen_tip_id TEXT;

-- Mark all existing sessions as seen
UPDATE sessions SET seen_tip_id = tip_id;
