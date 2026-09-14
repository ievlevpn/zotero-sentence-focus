// Offline harness: Zotero's own pdf.js (extracted from omni.ja into vendor/)
// on real PDFs, in Node. `node harness.mjs file.pdf page [--describe]`
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as napi from "@napi-rs/canvas";

globalThis.DOMMatrix ??= napi.DOMMatrix;
globalThis.ImageData ??= napi.ImageData;
globalThis.Path2D ??= napi.Path2D;
Math.sumPrecise ??= (xs) => { let s = 0; for (const x of xs) s += x; return s; };

const require = createRequire(import.meta.url);
export const B = require(process.env.SFZ_BOOTSTRAP || "../bootstrap.js");

let pdfjs = null;
async function lib() {
	if (!pdfjs) {
		const warn = console.log;
		pdfjs = await import("./vendor/pdf.mjs");
		pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.mjs", import.meta.url).href;
		pdfjs.GlobalWorkerOptions.verbosity = 0;
		void warn;
	}
	return pdfjs;
}

const docs = new Map();
export async function openPdf(path) {
	if (!docs.has(path)) {
		const p = await lib();
		const data = new Uint8Array(readFileSync(path));
		docs.set(path, await p.getDocument({ data, isEvalSupported: false, verbosity: 0 }).promise);
	}
	return docs.get(path);
}

export async function pageData(path, pageIndex) {
	const doc = await openPdf(path);
	return doc.getPageData({ pageIndex });
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [path, page] = process.argv.slice(2);
	const pd = await pageData(path, Number(page) - 1);
	console.log(B.describePage(pd.chars, pd.viewBox));
	process.exit(0);
}
