import { describe, expect, it } from "vitest";
import {
    formatLastTurnDelta,
    formatMessageModelLabel,
    formatMessageUsageLine,
    formatModelLabel,
    isAutoModelId,
    resolveChatUsageDisplay,
} from "@/lib/chat/usage-display";

describe("usage-display", () => {
    it("detects auto models", () => {
        expect(isAutoModelId("auto")).toBe(true);
        expect(isAutoModelId("openrouter/auto")).toBe(true);
        expect(isAutoModelId("anthropic/claude-sonnet-4")).toBe(false);
    });

    it("formats model labels", () => {
        expect(formatModelLabel("auto")).toBe("Auto");
        expect(formatModelLabel("openrouter/auto")).toBe("Auto");
        expect(formatModelLabel("anthropic/claude-sonnet-4")).toBe("Claude Sonnet 4");
        expect(formatModelLabel("")).toBe("");
        expect(formatModelLabel(null)).toBe("");
    });

    it("shows Auto when Auto was selected, otherwise the concrete model name", () => {
        expect(
            formatMessageModelLabel("google/gemini-2.5-flash", { usedAuto: true }),
        ).toBe("Auto");
        expect(formatMessageModelLabel("auto", { usedAuto: true })).toBe("Auto");
        expect(formatMessageModelLabel("anthropic/claude-sonnet-4", { usedAuto: false })).toBe(
            "Claude Sonnet 4",
        );
        expect(formatMessageModelLabel("deepseek/deepseek-v4-flash", { usedAuto: false })).toBe(
            "Deepseek V4 Flash",
        );
    });

    it("formats auto usage lines as token counts, not a client-side pool percent", () => {
        expect(
            formatMessageUsageLine(
                { usedAuto: true, autoPercent: 42, tokens: 1200 },
                "openrouter/auto",
            ),
        ).toBe("1,200");
        expect(
            formatMessageUsageLine({ usedAuto: true, tokens: 100_000 }, "auto"),
        ).toBe("100,000");
        expect(formatMessageUsageLine({ usedAuto: true }, "auto")).toBe("");
    });

    it("formats credit usage lines without tokens", () => {
        expect(
            formatMessageUsageLine({ creditsCharged: 1.25 }, "anthropic/claude-sonnet-4"),
        ).toBe("1.25");
        expect(
            formatMessageUsageLine(
                { creditsCharged: 1.25, tokens: 3400 },
                "anthropic/claude-sonnet-4",
            ),
        ).toBe("1.25");
    });

    it("splits usage into separate rows and omits empty fields", async () => {
        const { formatMessageUsageRows } = await import("@/lib/chat/usage-display");
        expect(
            formatMessageUsageRows(
                { usedAuto: true, tokens: 100_000, inputTokens: 80_000, outputTokens: 20_000 },
                "auto",
            ),
        ).toEqual([
            { label: "Tokens", value: "100,000" },
            { label: "Input", value: "80,000" },
            { label: "Output", value: "20,000" },
        ]);
        expect(formatMessageUsageRows({ usedAuto: true }, "auto")).toEqual([]);
        expect(formatMessageUsageRows(undefined, "auto")).toEqual([]);
    });

    it("appends what the last turn cost while it is still recent", () => {
        const now = 1_700_000_000_000;
        const auth = {
            loggedIn: true,
            tier: "pro" as const,
            freeAutoPercent: 18,
            creditsIncluded: 1500,
            creditsRemaining: 1200,
        };

        expect(
            resolveChatUsageDisplay(
                "auto",
                auth,
                { tokens: 12_400, inputTokens: 10_000, creditsCharged: 0, usedAuto: true, at: now - 1_000 },
                now,
            ).tooltip,
        ).toBe("18% used this month (Auto) · +12,400 tokens last turn");

        expect(
            resolveChatUsageDisplay(
                "anthropic/claude-sonnet-4",
                auth,
                { tokens: 0, inputTokens: 0, creditsCharged: 1.25, usedAuto: false, at: now - 1_000 },
                now,
            ).tooltip,
        ).toBe("300.00 out of 1,500.00 this month · +1.25 credits last turn");
    });

    it("drops the last-turn figure once it is history or empty", () => {
        const now = 1_700_000_000_000;
        const auth = {
            loggedIn: true,
            tier: "pro" as const,
            freeAutoPercent: 18,
            creditsIncluded: 1500,
            creditsRemaining: 1200,
        };

        // Older than the 15 minute window.
        expect(
            resolveChatUsageDisplay(
                "auto",
                auth,
                { tokens: 12_400, inputTokens: 0, creditsCharged: 0, usedAuto: true, at: now - 16 * 60_000 },
                now,
            ).tooltip,
        ).toBe("18% used this month (Auto)");

        // A turn that charged nothing says nothing.
        expect(
            resolveChatUsageDisplay(
                "anthropic/claude-sonnet-4",
                auth,
                { tokens: 0, inputTokens: 0, creditsCharged: 0, usedAuto: false, at: now },
                now,
            ).tooltip,
        ).toBe("300.00 out of 1,500.00 this month");

        expect(resolveChatUsageDisplay("auto", auth, null, now).tooltip).toBe(
            "18% used this month (Auto)",
        );
    });

    it("formats the last-turn delta on its own", () => {
        const now = 1_700_000_000_000;
        expect(
            formatLastTurnDelta(
                { tokens: 5_000, inputTokens: 0, creditsCharged: 0, usedAuto: true, at: now },
                now,
            ),
        ).toBe("+5,000 tokens last turn");
        expect(
            formatLastTurnDelta(
                { tokens: 0, inputTokens: 0, creditsCharged: 2, usedAuto: false, at: now },
                now,
            ),
        ).toBe("+2.00 credits last turn");
        expect(formatLastTurnDelta(null, now)).toBeNull();
        expect(formatLastTurnDelta(undefined, now)).toBeNull();
    });

    it("resolves chat ring from monthly Auto or credits usage", () => {
        expect(
            resolveChatUsageDisplay(
                "auto",
                {
                    loggedIn: true,
                    tier: "pro",
                    freeAutoPercent: 18,
                    creditsIncluded: 1500,
                    creditsRemaining: 1200,
                },
                null,
            ),
        ).toMatchObject({
            mode: "auto",
            percent: 18,
            title: "18% used",
            tooltip: "18% used this month (Auto)",
        });

        expect(
            resolveChatUsageDisplay(
                "auto",
                {
                    loggedIn: true,
                    tier: "pro",
                    freeAutoPercent: 18,
                    creditsIncluded: 1500,
                    creditsRemaining: 1200,
                },
                { tokens: 100_000, creditsCharged: 0, usedAuto: true, at: 1 },
            ),
        ).toMatchObject({
            mode: "auto",
            percent: 18,
            title: "18% used",
            tooltip: "18% used this month (Auto)",
        });

        expect(
            resolveChatUsageDisplay(
                "anthropic/claude-sonnet-4",
                {
                    loggedIn: true,
                    tier: "pro",
                    freeAutoPercent: 18,
                    creditsIncluded: 1500,
                    creditsRemaining: 1200,
                },
                { tokens: 0, creditsCharged: 75, usedAuto: false, at: 1 },
            ),
        ).toMatchObject({
            mode: "credits",
            percent: 20,
            title: "300.00 out of 1,500.00",
            tooltip: "300.00 out of 1,500.00 this month",
        });
    });
});
