-- Model selection per session and per message.

-- The model chosen in the session's picker. NULL: use the default setting.
ALTER TABLE sessions ADD COLUMN model TEXT;

-- For assistant messages: the model of the run that last wrote the message.
ALTER TABLE messages ADD COLUMN model TEXT;

-- The model each run used. NULL: none was sent.
ALTER TABLE runs ADD COLUMN model TEXT;
