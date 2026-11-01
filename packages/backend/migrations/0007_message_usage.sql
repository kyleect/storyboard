-- Token usage per assistant message (context usage design).

-- For assistant messages: the usage of the model call that last wrote the
-- message, as its `message.finished` event carries it (JSON
-- {promptTokens, completionTokens}). NULL: none reported, or not an
-- assistant message.
ALTER TABLE messages ADD COLUMN usage TEXT;

-- Existing messages: the usage of each message's latest `message.finished`
-- event (a continued message has one per call). NULL when that event has
-- none.
UPDATE messages
SET usage = json_extract(e.data, '$.usage')
FROM (
  SELECT json_extract(data, '$.messageId') AS message_id, max(id) AS id
  FROM events
  WHERE type = 'message.finished'
  GROUP BY message_id
) AS latest
JOIN events AS e ON e.id = latest.id
WHERE messages.id = latest.message_id;
