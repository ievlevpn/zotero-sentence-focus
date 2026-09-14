// node --expose-gc leakcheck.mjs pdfs... — analyse every page repeatedly; the
// heap after a forced collection should not climb from round to round.
import { openPdf, B } from "./harness.mjs";
const pages = [];
for (const f of process.argv.slice(2)) {
	const doc = await openPdf(f);
	for (let p = 1; p <= doc.numPages; p++) pages.push(await doc.getPageData({ pageIndex: p - 1 }));
}
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed / 1e6; };
const rounds = [];
for (let r = 0; r < 10; r++) {
	for (const pd of pages) B.segmentPage(pd.chars, pd.viewBox, { only: "sentence" });
	rounds.push(heap());
}
console.log("heap MB after each round:", rounds.map((m) => m.toFixed(1)).join(" "));
const growth = rounds[rounds.length - 1] - rounds[1];
console.log(growth > 2 ? `GROWS by ${growth.toFixed(1)} MB` : `stable (${growth.toFixed(2)} MB drift over 8 rounds)`);
process.exit(0);
