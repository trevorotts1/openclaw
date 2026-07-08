export function missingTargetMessage(provider: string, hint?: string): string {
  return `Delivering to ${provider} requires target${formatTargetHint(hint)}`;
}

export function missingTargetError(provider: string, hint?: string): Error {
  return new Error(missingTargetMessage(provider, hint));
}

export function ambiguousTargetMessage(provider: string, raw: string, hint?: string): string {
  return `Ambiguous target "${raw}" for ${provider}. Provide a unique name or an explicit id.${formatTargetHint(hint, true)}`;
}

export function ambiguousTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(ambiguousTargetMessage(provider, raw, hint));
}

export function unknownTargetMessage(provider: string, raw: string, hint?: string): string {
  return `Unknown target "${raw}" for ${provider}.${formatTargetHint(hint, true)}`;
}

export function unknownTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(unknownTargetMessage(provider, raw, hint));
}

/**
 * Formats the user-facing error shown when an outbound target is a phone number
 * but the channel can only deliver to a numeric id (e.g. a Telegram chat_id).
 *
 * A phone number is the wrong *type* of target: Telegram bots cannot resolve or
 * message a phone number (the Bot API exposes no phone lookup — a chat_id is
 * only known after the user first contacts the bot). Surfacing this distinctly
 * from the generic "unknown target" error tells callers to resolve the contact's
 * numeric id instead of blindly retrying the same phone number.
 */
export function phoneNumberTargetMessage(provider: string, raw: string, hint?: string): string {
  return `${provider} cannot send to a phone number ("${raw}"); a numeric chat_id is required. Resolve this contact's numeric chat_id first — a phone number is not a valid ${provider} target.${formatTargetHint(hint, true)}`;
}

/**
 * Builds an Error for phone-number-as-target failures (wrong target type).
 */
export function phoneNumberTargetError(provider: string, raw: string, hint?: string): Error {
  return new Error(phoneNumberTargetMessage(provider, raw, hint));
}

function formatTargetHint(hint?: string, withLabel = false): string {
  const normalized = hint?.trim();
  if (!normalized) {
    return "";
  }
  return withLabel ? ` Hint: ${normalized}` : ` ${normalized}`;
}
