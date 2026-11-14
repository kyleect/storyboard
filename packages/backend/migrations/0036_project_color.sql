-- A project's color, picked from a fixed palette (`PROJECT_COLORS` in core).
-- The name of a color, such as 'teal'; NULL: no color. The API validates the
-- name, so the palette can change without a migration. Existing projects have
-- none.

ALTER TABLE projects ADD COLUMN color TEXT;
