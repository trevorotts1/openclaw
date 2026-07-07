// Covers user-facing target error messages and hint formatting.
import { describe, expect, it } from "vitest";
import {
  ambiguousTargetError,
  ambiguousTargetMessage,
  missingTargetError,
  missingTargetMessage,
  phoneNumberTargetError,
  phoneNumberTargetMessage,
  unknownTargetError,
  unknownTargetMessage,
} from "./target-errors.js";

describe("target error helpers", () => {
  it.each([
    {
      actual: missingTargetMessage("Slack"),
      expected: "Delivering to Slack requires target",
    },
    {
      actual: missingTargetMessage("Slack", "Use channel:C123"),
      expected: "Delivering to Slack requires target Use channel:C123",
    },
    {
      actual: missingTargetError("Slack", "Use channel:C123").message,
      expected: "Delivering to Slack requires target Use channel:C123",
    },
    {
      actual: missingTargetMessage("Slack", "   "),
      expected: "Delivering to Slack requires target",
    },
    {
      actual: ambiguousTargetMessage("Discord", "general", "   "),
      expected: 'Ambiguous target "general" for Discord. Provide a unique name or an explicit id.',
    },
    {
      actual: unknownTargetMessage("Discord", "general", "   "),
      expected: 'Unknown target "general" for Discord.',
    },
    {
      actual: ambiguousTargetMessage("Discord", "general"),
      expected: 'Ambiguous target "general" for Discord. Provide a unique name or an explicit id.',
    },
    {
      actual: ambiguousTargetMessage("Discord", "general", "Use channel:123"),
      expected:
        'Ambiguous target "general" for Discord. Provide a unique name or an explicit id. Hint: Use channel:123',
    },
    {
      actual: unknownTargetMessage("Discord", "general", "Use channel:123"),
      expected: 'Unknown target "general" for Discord. Hint: Use channel:123',
    },
    {
      actual: unknownTargetError("Discord", "general").message,
      expected: 'Unknown target "general" for Discord.',
    },
    {
      actual: missingTargetMessage("Slack", "  Use channel:C123  "),
      expected: "Delivering to Slack requires target Use channel:C123",
    },
    {
      actual: unknownTargetMessage("Discord", "general", "  Use channel:123  "),
      expected: 'Unknown target "general" for Discord. Hint: Use channel:123',
    },
    {
      actual: phoneNumberTargetMessage("Telegram", "+15550001234"),
      expected:
        'Telegram cannot send to a phone number ("+15550001234"); a numeric chat_id is required. Resolve this contact\'s numeric chat_id first — a phone number is not a valid Telegram target.',
    },
    {
      actual: phoneNumberTargetMessage("Telegram", "+15550001234", "Use <chatId>"),
      expected:
        'Telegram cannot send to a phone number ("+15550001234"); a numeric chat_id is required. Resolve this contact\'s numeric chat_id first — a phone number is not a valid Telegram target. Hint: Use <chatId>',
    },
    {
      actual: phoneNumberTargetError("Telegram", "+15550001234").message,
      expected:
        'Telegram cannot send to a phone number ("+15550001234"); a numeric chat_id is required. Resolve this contact\'s numeric chat_id first — a phone number is not a valid Telegram target.',
    },
  ])("formats target error helper output for %j", ({ actual, expected }) => {
    expect(actual).toBe(expected);
  });

  it("includes the hint in ambiguous target errors", () => {
    expect(ambiguousTargetError("Discord", "general", "Use channel:123").message).toContain(
      "Hint: Use channel:123",
    );
  });

  it("distinguishes phone-number target errors from unknown-target errors", () => {
    const message = phoneNumberTargetError("Telegram", "+15550001234").message;
    expect(message).toContain("phone number");
    expect(message).toContain("chat_id");
    expect(message).not.toContain("Unknown target");
  });
});
