import { defaultSchema as d, type Options } from "rehype-sanitize";
const c = [...(d.attributes?.code ?? []), ["className", /^language-./] as [string, RegExp]];
export const EDITOR_SANITIZE_SCHEMA: Options = { ...d, attributes: { ...d.attributes, "*": [...(d.attributes?.["*"] ?? []), "dataSourceStart", "dataSourceEnd"], code: c } };
export const GIT_SANITIZE_SCHEMA: Options = { ...d, tagNames: [...(d.tagNames ?? []), "button"], attributes: { ...d.attributes, code: c } };
