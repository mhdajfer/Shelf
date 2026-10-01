/**
 * Every user-visible reference to the product name lives here. Renaming the
 * product should require editing this file and nothing else.
 */
export const brand = {
  name: 'Shelf',
  /** Used in <title> suffixes and the OG image footer. */
  shortName: 'Shelf',
  tagline: 'Write a prompt once. Find it again.',
  description:
    'A library for prompts you reuse. Write them, version them, test them, and keep the ones that work.',
  /** No scheme, no trailing slash. Overridden per environment by PUBLIC_WEB_URL. */
  domain: 'shelf.example',
  /** Shown on the public shelf next to guest-authored prompts. */
  guestDisplayName: 'Guest',
  supportEmail: 'hello@shelf.example',
} as const;

export type Brand = typeof brand;
