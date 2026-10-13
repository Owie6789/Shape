import { beforeEach, describe, expect, it } from "vitest";
import {
    getPlanOrigin,
    planOriginKey,
    recordPlanOrigin,
    resolveProjectPlanPath,
} from "@/features/chat/lib/plan-origin";

beforeEach(() => {
    localStorage.clear();
});

describe("plan origin registry", () => {
    it("remembers the chat a plan was created in", () => {
        recordPlanOrigin("/proj/plans/a.md", "chat-1");
        expect(getPlanOrigin("/proj/plans/a.md")).toBe("chat-1");
    });

    it("keeps the first chat that showed the plan", () => {
        recordPlanOrigin("/proj/plans/a.md", "chat-1");
        recordPlanOrigin("/proj/plans/a.md", "chat-2");
        expect(getPlanOrigin("/proj/plans/a.md")).toBe("chat-1");
    });

    it("ignores the unsaved draft, so a later real chat can claim the plan", () => {
        recordPlanOrigin("/proj/plans/a.md", null);
        expect(getPlanOrigin("/proj/plans/a.md")).toBeNull();
        recordPlanOrigin("/proj/plans/a.md", "chat-9");
        expect(getPlanOrigin("/proj/plans/a.md")).toBe("chat-9");
    });

    it("matches the same file however its separators are written", () => {
        recordPlanOrigin("C:\\proj\\plans\\a.md", "chat-3");
        expect(getPlanOrigin("C:/proj//plans/a.md")).toBe("chat-3");
        expect(planOriginKey(" C:\\proj\\plans\\a.md ")).toBe("C:/proj/plans/a.md");
    });

    it("returns null for a plan with no recorded origin", () => {
        expect(getPlanOrigin("/proj/plans/unknown.md")).toBeNull();
    });

    it("resolves a project-relative plan path against the project root", () => {
        expect(resolveProjectPlanPath("plans/a.md", "/proj")).toBe("/proj/plans/a.md");
        expect(resolveProjectPlanPath("/abs/a.md", "/proj")).toBe("/abs/a.md");
        expect(resolveProjectPlanPath("plans/a.md", null)).toBe("plans/a.md");
    });

    it("survives corrupt storage without throwing", () => {
        localStorage.setItem("shape-plan-origins", "{not json");
        expect(getPlanOrigin("/proj/plans/a.md")).toBeNull();
        recordPlanOrigin("/proj/plans/a.md", "chat-4");
        expect(getPlanOrigin("/proj/plans/a.md")).toBe("chat-4");
    });
});
