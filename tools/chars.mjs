import { pageData } from "./harness.mjs";
const [path, page, needle, n = 12] = process.argv.slice(2);
const pd = await pageData(path, Number(page) - 1);
const cs = pd.chars;
let at = -1;
for (let i = 0; i < cs.length && at < 0; i++) {
	let s = "";
	for (let j = i; j < cs.length && s.length < needle.length; j++) s += cs[j].c;
	if (s.startsWith(needle)) at = i;
}
for (const c of cs.slice(at, at + Number(n))) console.log(JSON.stringify(c.c), c.rect.map((v) => v.toFixed(1)).join(","), c.fontName, c.fontSize.toFixed(1), "base", c.baseline.toFixed(1), c.spaceAfter ? "sp" : "");
process.exit(0);
