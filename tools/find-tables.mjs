// node find-tables.mjs pdfs... — pages with a "Table N" caption, for review.
import { openPdf } from "./harness.mjs";
for (const f of process.argv.slice(2)) {
	const doc = await openPdf(f);
	const hits = [];
	for (let p = 1; p <= doc.numPages; p++) {
		const pd = await doc.getPageData({ pageIndex: p - 1 });
		const text = pd.chars.map((c) => c.c + (c.spaceAfter ? " " : "") + (c.lineBreakAfter ? "\n" : "")).join("");
		const n = (text.match(/^\s*(?:Table|TABLE)\s+\d+[.:]/gm) || []).length;
		if (n) hits.push(`${p}(${n})`);
	}
	console.log(f, hits.join(" "));
}
process.exit(0);
