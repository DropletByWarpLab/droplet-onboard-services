-- WARP-1394: path_ext_to_category() — maps a file path's extension to the
-- same 8 categories as mime_to_category() (WARP-225): audio, video, pdf,
-- image, email, archive, text, other.
--
-- Why: Nextcloud-synced files (FileIndexStatus / watcher-written
-- FileContentChunk rows) carry no MIME type, so the /context aggregates
-- bucket them by extension instead. Same single-GROUP-BY rationale as
-- mime_to_category; IMMUTABLE so the planner folds it inline.
--
-- Classification rules (byte-identical TS twin: src/lib/path-category.ts):
--   - only the basename is considered (directory dots never classify);
--   - the extension is everything after the LAST dot, lowercased;
--   - dotfiles ('.env'), extensionless names, and trailing-dot names are
--     'other' (the extension regex requires a character before the dot
--     and at least one non-dot character after it).

CREATE OR REPLACE FUNCTION path_ext_to_category(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN ext IN ('mp3', 'wav', 'm4a', 'flac', 'ogg', 'opus', 'aac')
      THEN 'audio'
    WHEN ext IN ('mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v')
      THEN 'video'
    WHEN ext = 'pdf'
      THEN 'pdf'
    WHEN ext IN ('jpg', 'jpeg', 'png', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'heic')
      THEN 'image'
    WHEN ext IN ('eml', 'msg')
      THEN 'email'
    WHEN ext IN ('zip', 'tar', 'gz', 'tgz', 'bz2')
      THEN 'archive'
    WHEN ext IN ('txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml',
                 'html', 'htm', 'docx', 'doc', 'rtf', 'log', 'yaml', 'yml')
      THEN 'text'
    ELSE 'other'
  END
  FROM (
    SELECT lower(
      substring(regexp_replace(p, '^.*/', '') from '.\.([^.]+)$')
    ) AS ext
  ) AS extracted;
$$;

COMMENT ON FUNCTION path_ext_to_category(text) IS
  'WARP-1394: classifies a file path by extension into one of {audio,video,pdf,image,email,archive,text,other} for the dashboard context-meter aggregations over Nextcloud-synced files.';
