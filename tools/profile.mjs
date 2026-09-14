// node profile.mjs pdfs...  — analysis time per page (page data fetched first,
// so only the plugin's own work is timed), slowest pages, and a per-pass split.
import { openPdf, B } from "./harness.mjs";
const files = process.argv.slice(2);
const pages = [];
for (const f of files) {
	const doc = await openPdf(f);
	for (let p = 1; p <= doc.numPages; p++) pages.push({ f, p, pd: await doc.getPageData({ pageIndex: p - 1 }) });
}
// warm up the JIT
for (const { pd } of pages.slice(0, 20)) B.segmentPage(pd.chars, pd.viewBox);
const times = [];
for (const pg of pages) {
	const t = performance.now();
	for (let k = 0; k < 3; k++) B.segmentPage(pg.pd.chars, pg.pd.viewBox, { only: process.env.ONLY });
	times.push({ ...pg, ms: (performance.now() - t) / 3, chars: pg.pd.chars.length });
}
times.sort((a, b) => b.ms - a.ms);
const total = times.reduce((s, t) => s + t.ms, 0);
console.log(`pages ${times.length}  mean ${(total / times.length).toFixed(2)} ms  median ${times[times.length >> 1].ms.toFixed(2)} ms  max ${times[0].ms.toFixed(2)} ms`);
for (const t of times.slice(0, 6)) console.log(`  ${t.ms.toFixed(2)} ms  ${t.f}#${t.p}  (${t.chars} chars)`);
if (B.__timings) console.log(B.__timings());
process.exit(0);
