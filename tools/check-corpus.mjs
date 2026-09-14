// node check-corpus.mjs — the reported cases, on the real PDFs.
import { openPdf, B } from "./harness.mjs";
import { readFileSync, existsSync } from "node:fs";
const spec = JSON.parse(readFileSync(new URL("./expectations.json", import.meta.url)));
let failures = 0, checked = 0, skipped = 0;
for (const [file, pages] of Object.entries(spec)) {
	if (file.startsWith("_")) continue;
	const path = new URL(`./pdfs/${file}`, import.meta.url).pathname;
	if (!existsSync(path)) { skipped++; continue; }
	const doc = await openPdf(path);
	for (const [page, cases] of Object.entries(pages)) {
		const pd = await doc.getPageData({ pageIndex: Number(page) - 1 });
		const units = B.segmentPage(pd.chars, pd.viewBox).sentence;
		for (const c of cases) {
			checked++;
			const unit = units.find((u) => u.text.includes(c.has));
			const bad = !unit ? "not found"
				: unit.kind !== c.kind ? `is ${unit.kind}`
				: c.lacks && unit.text.includes(c.lacks) ? `contains ${JSON.stringify(c.lacks)}`
				: null;
			if (bad) {
				failures++;
				console.log(`FAIL ${file} p${page}: ${JSON.stringify(c.has)} ${bad}` + (unit ? `\n     ${JSON.stringify(unit.text.slice(0, 110))}` : ""));
			}
		}
	}
}
console.log(`${checked - failures}/${checked} corpus expectations hold${skipped ? `, ${skipped} file(s) missing` : ""}`);
process.exit(failures ? 1 : 0);
