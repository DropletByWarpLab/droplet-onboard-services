-- WARP-225: mime_to_category() — maps a MIME-type string to one of 8
-- categories used by the dashboard's `/context` page (donut, bytes-bar,
-- pipeline-health). Categories cover the full WARP-201..208 extractor
-- spectrum: audio, video, pdf, image, email, archive, text, other.
--
-- Why a SQL function: the dashboard's coverage donut and bytes-by-source
-- chart group every BrainMemoryItem row by category. A function lets the
-- aggregate stay a single GROUP BY (cheap, indexable on the contained
-- WHERE clauses) instead of a sprawling CASE block we'd duplicate in
-- multiple readers. IMMUTABLE so the planner can fold it into queries.
--
-- Unknown / NULL MIMEs collapse to 'other' so callers never have to
-- coalesce on the read side. The chunked text-document set (text/*,
-- application/json, application/xml) maps to 'text' rather than 'other'
-- so the dashboard's "documents" lens has a single bucket.

CREATE OR REPLACE FUNCTION mime_to_category(mime text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    -- audio (WARP-197)
    WHEN mime LIKE 'audio/%' THEN 'audio'
    -- video (WARP-198 / WARP-208 frame OCR)
    WHEN mime LIKE 'video/%' THEN 'video'
    -- email (WARP-199): includes RFC 822 + Outlook .msg + x-msmail
    WHEN mime = 'message/rfc822' THEN 'email'
    WHEN mime = 'application/vnd.ms-outlook' THEN 'email'
    WHEN mime = 'application/x-msmail' THEN 'email'
    -- archive (WARP-200): zip/tar/gzip/bzip2 family
    WHEN mime IN (
      'application/zip',
      'application/x-zip-compressed',
      'application/x-tar',
      'application/gzip',
      'application/x-gzip',
      'application/x-bzip2'
    ) THEN 'archive'
    -- pdf (WARP-201) — kept as its own bucket because PDFs dominate
    -- knowledge-worker corpora and the dashboard surfaces a per-extractor
    -- avg-time-to-ready that's distinctly different from docx/text.
    WHEN mime = 'application/pdf' THEN 'pdf'
    -- image (WARP-201 OCR via Tesseract)
    WHEN mime LIKE 'image/%' THEN 'image'
    -- text-like documents (WARP-201): docx, plain text, markdown, csv, html, json, xml
    WHEN mime IN (
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/json',
      'application/xml'
    ) THEN 'text'
    WHEN mime LIKE 'text/%' THEN 'text'
    -- everything else (incl. application/octet-stream, NULL)
    ELSE 'other'
  END;
$$;

COMMENT ON FUNCTION mime_to_category(text) IS
  'WARP-225: classifies a MIME type into one of {audio,video,pdf,image,email,archive,text,other} for the dashboard context-meter aggregations.';
