// node snapshot.mjs out.json file.pdf...  — every page's sentence units, for diffing.
import { openPdf, B } from "./harness.mjs";
import { writeFileSync } from "node:fs";
const [out, ...files] = process.argv.slice(2);
const snap = {};
for (const f of files) {
	const doc = await openPdf(f);
	for (let p = 1; p <= doc.numPages; p++) {
		const pd = await doc.getPageData({ pageIndex: p - 1 });
		snap[`${f}#${p}`] = B.segmentPage(pd.chars, pd.viewBox).sentence.map((u) => [u.kind, u.text, u.rects.map((r) => r.map(Math.round))]);
	}
}
writeFileSync(out, JSON.stringify(snap));
console.log(Object.keys(snap).length, "pages");
process.exit(0);
