// Draw what the plugin makes of a page on top of the page itself.
// node overlay.mjs file.pdf pages... [--out dir]
// Sentence units alternate between two warm tints; displays are blue.
// The output directory holds one run: its earlier PNGs are removed first, so
// looking at pages again and again never piles images up.
import { openPdf, B } from "./harness.mjs";
import * as napi from "@napi-rs/canvas";
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args.splice(outIdx, 2)[1] : new URL("./out", import.meta.url).pathname;
const [path, ...pageSpecs] = args;
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith(".png")) unlinkSync(`${out}/${f}`);
const doc = await openPdf(path);
const pages = [];
for (const spec of pageSpecs.length ? pageSpecs : ["1-" + doc.numPages]) {
	const [a, b] = spec.split("-").map(Number);
	for (let p = a; p <= (b || a); p++) pages.push(p);
}

export async function renderPage(doc, pageNumber, scale) {
	const page = await doc.getPage(pageNumber);
	const viewport = page.getViewport({ scale });
	const canvas = napi.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	await page.render({ canvasContext: ctx, viewport, canvas, annotationMode: 0 }).promise;
	return { canvas, ctx, viewport };
}

for (const p of pages) {
	const scale = 2;
	const { canvas, ctx, viewport } = await renderPage(doc, p, scale);
	const pd = await doc.getPageData({ pageIndex: p - 1 });
	const units = B.segmentPage(pd.chars, pd.viewBox).sentence;
	ctx.globalCompositeOperation = "multiply";
	units.forEach((u, i) => {
		ctx.fillStyle = u.kind === "display" ? "rgba(120,170,255,0.45)" : i % 2 ? "rgba(255,210,60,0.5)" : "rgba(255,150,120,0.45)";
		for (const r of u.rects) {
			const [x1, y1] = viewport.convertToViewportPoint(r[0], r[3]);
			const [x2, y2] = viewport.convertToViewportPoint(r[2], r[1]);
			ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
		}
	});
	const file = `${out}/${basename(path, ".pdf")}-p${String(p).padStart(2, "0")}.png`;
	writeFileSync(file, canvas.toBuffer("image/png"));
	console.log(file, units.length);
}
process.exit(0);
