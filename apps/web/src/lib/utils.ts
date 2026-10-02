import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// A fixed locale and time zone, so the server and the browser print the same
// string and hydration never disagrees about a date.
const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

export const formatDate = (iso: string): string => DATE.format(new Date(iso));
export const formatDateTime = (iso: string): string => `${DATE_TIME.format(new Date(iso))} UTC`;

const COMPACT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const formatCount = (value: number): string => COMPACT.format(value);

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${formatCount(count)} ${count === 1 ? one : many}`;
