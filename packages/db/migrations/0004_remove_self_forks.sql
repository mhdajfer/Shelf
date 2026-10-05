-- Forking a prompt you already own only duplicates it. The API now refuses
-- that; this removes the copies made before it did.
--
-- Only unedited copies go: a fork of the owner's own prompt that still has its
-- single original version and the same title and body as its source. A copy the owner
-- went on to change is their work and is left alone.
UPDATE prompts f SET status = 'deleted'
FROM prompts s
WHERE f.forked_from_id = s.id
  AND f.owner_id IS NOT NULL
  AND f.owner_id = s.owner_id
  AND f.status <> 'deleted'
  AND f.title = s.title
  AND (SELECT count(*) FROM prompt_versions v WHERE v.prompt_id = f.id) = 1
  AND (SELECT v.body FROM prompt_versions v WHERE v.id = f.current_version_id)
      IS NOT DISTINCT FROM
      (SELECT v.body FROM prompt_versions v WHERE v.id = s.current_version_id);--> statement-breakpoint

-- Bring every fork count back in line with the forks that still exist.
UPDATE prompts p SET fork_count = live.count
FROM (
  SELECT s.id, count(f.id) FILTER (WHERE f.status <> 'deleted') AS count
  FROM prompts s
  JOIN prompts f ON f.forked_from_id = s.id
  GROUP BY s.id
) live
WHERE p.id = live.id AND p.fork_count <> live.count;
