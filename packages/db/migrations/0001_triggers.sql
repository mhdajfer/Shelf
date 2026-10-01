-- Invariants Drizzle cannot express: the search vector, version immutability,
-- the append-only ledger, and updated_at maintenance.
--
-- The weighting the brief specifies: title A, tags B, description C, body D.
-- Title and description live on the row, tags in a join table, and the body in
-- the current version, so this cannot be a generated column. Keeping the whole
-- expression in one function means the three triggers below cannot disagree
-- about the weights.
CREATE OR REPLACE FUNCTION shelf_prompt_search_vector(p_prompt_id uuid)
RETURNS tsvector
LANGUAGE sql
STABLE
AS $$
  SELECT
    setweight(to_tsvector('english', coalesce(p.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce((
      SELECT string_agg(t.name, ' ')
      FROM prompt_tags pt
      JOIN tags t ON t.id = pt.tag_id
      WHERE pt.prompt_id = p.id
    ), '')), 'B') ||
    setweight(to_tsvector('english', coalesce(p.description, '')), 'C') ||
    setweight(to_tsvector('english', coalesce((
      SELECT v.body
      FROM prompt_versions v
      WHERE v.id = p.current_version_id
    ), '')), 'D')
  FROM prompts p
  WHERE p.id = p_prompt_id;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION shelf_refresh_prompt_search_vector(p_prompt_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE prompts
  SET search_vector = shelf_prompt_search_vector(p_prompt_id)
  WHERE id = p_prompt_id;
$$;--> statement-breakpoint

-- AFTER rather than BEFORE: the function reads the committed row, and the
-- inner UPDATE touches only search_vector, which is not in this trigger's
-- column list, so it cannot recurse.
CREATE OR REPLACE FUNCTION shelf_prompts_search_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM shelf_refresh_prompt_search_vector(NEW.id);
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER prompts_search_vector_sync
AFTER INSERT OR UPDATE OF title, description, current_version_id ON prompts
FOR EACH ROW EXECUTE FUNCTION shelf_prompts_search_trigger();--> statement-breakpoint

CREATE OR REPLACE FUNCTION shelf_prompt_tags_search_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM shelf_refresh_prompt_search_vector(COALESCE(NEW.prompt_id, OLD.prompt_id));
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE TRIGGER prompt_tags_search_vector_sync
AFTER INSERT OR DELETE ON prompt_tags
FOR EACH ROW EXECUTE FUNCTION shelf_prompt_tags_search_trigger();--> statement-breakpoint

-- Versions are the history; rewriting one would make a diff lie. DELETE stays
-- permitted so cascading a prompt delete still works.
CREATE OR REPLACE FUNCTION shelf_reject_version_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'prompt_versions is immutable; save a new version instead'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER prompt_versions_immutable
BEFORE UPDATE ON prompt_versions
FOR EACH ROW EXECUTE FUNCTION shelf_reject_version_update();--> statement-breakpoint

-- A failed model call is corrected with a compensating refund row, never by
-- editing or removing the debit.
CREATE OR REPLACE FUNCTION shelf_reject_ledger_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only; insert a compensating entry instead'
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER credit_ledger_append_only
BEFORE UPDATE OR DELETE ON credit_ledger
FOR EACH ROW EXECUTE FUNCTION shelf_reject_ledger_change();--> statement-breakpoint

CREATE OR REPLACE FUNCTION shelf_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER users_touch_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION shelf_touch_updated_at();--> statement-breakpoint

CREATE TRIGGER prompts_touch_updated_at
BEFORE UPDATE ON prompts
FOR EACH ROW EXECUTE FUNCTION shelf_touch_updated_at();--> statement-breakpoint

CREATE TRIGGER collections_touch_updated_at
BEFORE UPDATE ON collections
FOR EACH ROW EXECUTE FUNCTION shelf_touch_updated_at();
