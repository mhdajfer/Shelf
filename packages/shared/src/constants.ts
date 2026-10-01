/** Hard limits enforced on input at the API boundary and mirrored in the UI. */
export const LIMITS = {
  titleMax: 120,
  descriptionMax: 500,
  bodyMax: 20_000,
  tagsMax: 5,
  tagMax: 32,
  versionNoteMax: 200,
  handleMax: 24,
  modelHintMax: 40,
  collectionNameMax: 60,
  reportReasonMax: 500,
  maxVariablesPerPrompt: 50,
  maxVariableNameLength: 64,
  /** Soft cap. Creation past this returns a clear error rather than failing silently. */
  maxPromptsPerUser: 1000,
} as const;

export const CATEGORIES = [
  'writing',
  'coding',
  'research',
  'marketing',
  'data',
  'learning',
  'productivity',
  'other',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<Category, string> = {
  writing: 'Writing',
  coding: 'Coding',
  research: 'Research',
  marketing: 'Marketing',
  data: 'Data',
  learning: 'Learning',
  productivity: 'Productivity',
  other: 'Other',
};

export const VISIBILITIES = ['public', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const PROMPT_STATUSES = ['active', 'hidden', 'deleted'] as const;
export type PromptStatus = (typeof PROMPT_STATUSES)[number];

export const ACTOR_TYPES = ['user', 'guest'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const USER_ROLES = ['user', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Ledger entry kinds. Debits are negative, grants and refunds positive; a
 * balance is the sum over the actor's current UTC day.
 */
export const CREDIT_KINDS = ['create', 'run', 'tool', 'refund'] as const;
export type CreditKind = (typeof CREDIT_KINDS)[number];

export const PUBLIC_SORTS = ['trending', 'new', 'top_week', 'top_all'] as const;
export type PublicSort = (typeof PUBLIC_SORTS)[number];

/** Fallbacks when the matching env var is unset. Env always wins. */
export const DEFAULT_CREDITS = {
  guestDailyCreate: 3,
  guestDailyRun: 5,
  userDailyRun: 50,
} as const;

/** Window after which a guest's own prompt becomes read-only to them. */
export const GUEST_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Reports needed before a public prompt auto-hides pending review. */
export const REPORTS_TO_AUTOHIDE = 3;
