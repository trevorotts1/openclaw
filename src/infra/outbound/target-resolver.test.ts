import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelDirectoryEntry } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetDirectoryCache, resolveMessagingTarget } from "./target-resolver.js";

const mocks = vi.hoisted(() => ({
  listGroups: vi.fn(),
  listGroupsLive: vi.fn(),
  resolveTarget: vi.fn(),
  getChannelPlugin: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: unknown[]) => mocks.getChannelPlugin(...args),
  normalizeChannelId: (value: string) => value,
}));

describe("resolveMessagingTarget (directory fallback)", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    mocks.listGroups.mockClear();
    mocks.listGroupsLive.mockClear();
    mocks.resolveTarget.mockClear();
    mocks.getChannelPlugin.mockClear();
    resetDirectoryCache();
    mocks.getChannelPlugin.mockReturnValue({
      directory: {
        listGroups: mocks.listGroups,
        listGroupsLive: mocks.listGroupsLive,
      },
      messaging: {
        targetResolver: {
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
  });

  it("uses live directory fallback and caches the result", async () => {
    const entry: ChannelDirectoryEntry = { kind: "group", id: "123456789", name: "support" };
    mocks.listGroups.mockResolvedValue([]);
    mocks.listGroupsLive.mockResolvedValue([entry]);

    const first = await resolveMessagingTarget({
      cfg,
      channel: "discord",
      input: "support",
    });

    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.target.source).toBe("directory");
      expect(first.target.to).toBe("123456789");
    }
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);

    const second = await resolveMessagingTarget({
      cfg,
      channel: "discord",
      input: "support",
    });

    expect(second.ok).toBe(true);
    expect(mocks.listGroups).toHaveBeenCalledTimes(1);
    expect(mocks.listGroupsLive).toHaveBeenCalledTimes(1);
  });

  it("skips directory lookup for direct ids", async () => {
    const result = await resolveMessagingTarget({
      cfg,
      channel: "discord",
      input: "123456789",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.source).toBe("normalized");
      expect(result.target.to).toBe("123456789");
    }
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("lets plugins override id-like target resolution before falling back to raw ids", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        targetResolver: {
          looksLikeId: () => true,
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.resolveTarget.mockResolvedValue({
      to: "user:dm-user-id",
      kind: "user",
      source: "directory",
    });

    const result = await resolveMessagingTarget({
      cfg,
      channel: "mattermost",
      input: "dthcxgoxhifn3pwh65cut3ud3w",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({
        to: "user:dm-user-id",
        kind: "user",
        source: "directory",
        display: undefined,
      });
    }
    expect(mocks.resolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        input: "dthcxgoxhifn3pwh65cut3ud3w",
      }),
    );
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("returns an actionable phone-number error for a phone-shaped telegram target", async () => {
    // Mirror the real telegram plugin: only bare numeric chat_ids are id-like,
    // and there is no plugin resolveTarget, so a phone number falls through to
    // the phone-number branch instead of the generic unknown-target error.
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        targetResolver: {
          looksLikeId: (raw: string) => /^-?\d+$/.test(raw.trim()),
        },
      },
    });

    const result = await resolveMessagingTarget({
      cfg,
      channel: "telegram",
      input: "+15550001234",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected phone-number target to fail resolution");
    }
    expect(result.error.message).toContain("phone number");
    expect(result.error.message).toContain("chat_id");
    expect(result.error.message).not.toContain("Unknown target");
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("still resolves a bare numeric telegram chat_id without hitting the phone-number path", async () => {
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        targetResolver: {
          looksLikeId: (raw: string) => /^-?\d+$/.test(raw.trim()),
        },
      },
    });

    const result = await resolveMessagingTarget({
      cfg,
      channel: "telegram",
      input: "123456789",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.to).toBe("123456789");
      expect(result.target.source).toBe("normalized");
    }
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });

  it("does not apply the phone-number error to non-telegram phone-shaped targets", async () => {
    // The phone-number branch is telegram-gated; other channels still resolve
    // phone-shaped inputs through their own plugin resolver exactly as before.
    mocks.getChannelPlugin.mockReturnValue({
      messaging: {
        targetResolver: {
          looksLikeId: () => true,
          resolveTarget: mocks.resolveTarget,
        },
      },
    });
    mocks.resolveTarget.mockResolvedValue({
      to: "+15550009876",
      kind: "user",
      source: "normalized",
    });

    const result = await resolveMessagingTarget({
      cfg,
      channel: "mattermost",
      input: "+15550009876",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target.to).toBe("+15550009876");
    }
    expect(mocks.listGroups).not.toHaveBeenCalled();
    expect(mocks.listGroupsLive).not.toHaveBeenCalled();
  });
});
