-- Reasoning effort per session and per message, like the model.

-- The effort chosen in the session's picker. NULL: use the default setting.
ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT;

-- For assistant messages: the effort of the run that last wrote the message.
ALTER TABLE messages ADD COLUMN reasoning_effort TEXT;

-- The effort each run sent. NULL: none was sent.
ALTER TABLE runs ADD COLUMN reasoning_effort TEXT;
