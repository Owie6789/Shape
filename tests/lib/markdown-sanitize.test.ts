import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { describe, expect, it } from "vitest";
import { EDITOR_SANITIZE_SCHEMA, GIT_SANITIZE_SCHEMA } from "@/lib/ui/markdown-sanitize";
import { remarkSourcePositions } from "@/features/editor/ui/markdown/lib/remark-source-positions";
describe("markdown", () => {
    it("sanitizes", () => {
        const r = (s: object, m: string, rp = [remarkGfm]) => renderToStaticMarkup(React.createElement(ReactMarkdown, { remarkPlugins: rp, rehypePlugins: [rehypeRaw, [rehypeSanitize, s]] }, m));
        const [h, gh] = [r(EDITOR_SANITIZE_SCHEMA, '# T\n\n<script>x()</script><img src=x onerror=alert(1) /><a href="javascript:alert(2)">x</a>\n\n```ts\nconst x = 1;\n```\n', [remarkGfm, remarkSourcePositions]), r(GIT_SANITIZE_SCHEMA, '<button onclick="alert(1)">Deploy</button><script>x()</script>')];
        for (const b of ["<script", "onerror", "javascript:"]) expect(h).not.toContain(b);
        for (const g of ["data-source-start=", "language-ts"]) expect(h).toContain(g);
        expect(gh).toContain("<button>Deploy</button>");
        for (const b of ["onclick", "<script"]) expect(gh).not.toContain(b);
        const u = ["java&#9;script:alert(1)", "&#106;avascript:alert(1)", "data:text/html,alert(1)"].map((x) => `<a href="${x}">x</a>`).join("");
        expect([r(EDITOR_SANITIZE_SCHEMA, u, [remarkGfm, remarkSourcePositions]), r(GIT_SANITIZE_SCHEMA, u)].join("")).not.toContain("href=");
    });
});
