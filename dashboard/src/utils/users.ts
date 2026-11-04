// Pure helpers of the Users page: the bounds the gateway publishes for a dashboard user, and the
// shape of an edit. Kept apart from the page so the test runner (and anything else) can import them
// without the component.
import type { User } from '../services/api';

// The bounds the gateway's CreateUserDto and UpdateUserDto publish, counted the way its validators
// count (one per code point, so an emoji is one).
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
/** The longest address RFC 5321 allows, which is also the gateway's column width. */
export const EMAIL_MAX_LENGTH = 254;

/** The edit form: a blank password leaves the stored one alone. */
export interface UserDraft {
  email: string;
  role: string;
  isActive: boolean;
  password: string;
}

export type UserPatch = { email?: string; password?: string; role?: string; isActive?: boolean };

/** The gateway stores an address trimmed and lower-cased, so the form compares the same way. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// The gateway's IsEmail wants a local part, a domain and a top-level label; a looser check here would
// send an address it refuses with a bare "Bad Request" in production.
export function isValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  return normalized.length <= EMAIL_MAX_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

export function passwordLength(password: string): number {
  return [...password].length;
}

export function isValidPassword(password: string): boolean {
  const length = passwordLength(password);
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

export function userDraft(user: User): UserDraft {
  return { email: user.email, role: user.role, isActive: user.isActive, password: '' };
}

/**
 * Only what the edit changed: a password, role or deactivation deletes every login key the user
 * holds, so a field left as stored must not be resent and sign them out for nothing.
 */
export function userPatch(user: User, draft: UserDraft): UserPatch {
  const patch: UserPatch = {};
  const email = normalizeEmail(draft.email);
  if (email !== user.email) patch.email = email;
  if (draft.role !== user.role) patch.role = draft.role;
  if (draft.isActive !== user.isActive) patch.isActive = draft.isActive;
  if (draft.password) patch.password = draft.password;
  return patch;
}
