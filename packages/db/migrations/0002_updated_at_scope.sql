-- updated_at should mean "the author changed this prompt". The original trigger
-- fired on every UPDATE, so an upvote, a trending recompute, a search-vector
-- refresh, or pinning all bumped it and reshuffled the owner's shelf, which
-- sorts by updated_at. Restricting the trigger to authored columns fixes that.
DROP TRIGGER IF EXISTS prompts_touch_updated_at ON prompts;--> statement-breakpoint

CREATE TRIGGER prompts_touch_updated_at
BEFORE UPDATE OF title, description, category, model_hint, visibility, current_version_id ON prompts
FOR EACH ROW EXECUTE FUNCTION shelf_touch_updated_at();--> statement-breakpoint

-- Tag changes are authored changes too, but they live in a join table.
CREATE OR REPLACE FUNCTION shelf_prompt_tags_touch_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE prompts SET updated_at = now() WHERE id = COALESCE(NEW.prompt_id, OLD.prompt_id);
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER prompt_tags_touch_updated_at
AFTER INSERT OR DELETE ON prompt_tags
FOR EACH ROW EXECUTE FUNCTION shelf_prompt_tags_touch_trigger();
