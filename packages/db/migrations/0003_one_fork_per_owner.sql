-- One live fork of a prompt per user. Forking the same prompt twice only made
-- duplicate copies, and the application check alone could be beaten by two
-- requests racing, so the rule lives here as well.

-- Shelves that already hold duplicates keep the most recently edited copy.
UPDATE prompts SET status = 'deleted'
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY owner_id, forked_from_id ORDER BY updated_at DESC, id
    ) AS position
    FROM prompts
    WHERE owner_id IS NOT NULL AND forked_from_id IS NOT NULL AND status <> 'deleted'
  ) ranked
  WHERE position > 1
);--> statement-breakpoint

-- fork_count now means live forks, so it has to agree with the rows.
UPDATE prompts p SET fork_count = (
  SELECT count(*) FROM prompts f WHERE f.forked_from_id = p.id AND f.status <> 'deleted'
)
WHERE p.fork_count <> (
  SELECT count(*) FROM prompts f WHERE f.forked_from_id = p.id AND f.status <> 'deleted'
) AND EXISTS (SELECT 1 FROM prompts f WHERE f.forked_from_id = p.id);--> statement-breakpoint

CREATE UNIQUE INDEX "prompts_one_fork_per_owner_key" ON "prompts" USING btree ("owner_id","forked_from_id") WHERE forked_from_id IS NOT NULL AND status <> 'deleted';
