// node detect.mjs pdfs... [--pages a-b] [--overlay dir]
// Runs small layout/formula detectors on rendered pages and compares their
// displayed-formula boxes with the plugin's own verdict, line by line.
import { openPdf, B } from "./harness.mjs";
import * as napi from "@napi-rs/canvas";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename } from "node:path";
const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");

const MODELS = [
	{ key: "ppdl-s", file: "models/ppdl-s.onnx", size: 480, kind: "paddle", formula: 7, threshold: 0.5 },
	{ key: "yolo11n", file: "models/hantian_yolo-doclaynet__yolov11n-doclaynet.onnx", size: 1024, kind: "yolo", classes: 11, formula: 2, threshold: 0.25 },
	{ key: "p2t-mfd", file: "models/breezedeus_pix2text-mfd__mfd-v20240618.onnx", size: 768, kind: "yolo", classes: 2, formula: 1, threshold: 0.25 },
];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const pagesSpec = opt("--pages");
const overlayDir = opt("--overlay");
const files = args;
if (overlayDir) { mkdirSync(overlayDir, { recursive: true }); for (const f of readdirSync(overlayDir)) if (f.endsWith(".png")) unlinkSync(`${overlayDir}/${f}`); }

for (const m of MODELS) m.session = await ort.InferenceSession.create(m.file, { intraOpNumThreads: 4 });

// One render per page, at the resolution the largest model wants.
async function render(doc, p) {
	const page = await doc.getPage(p);
	const base = page.getViewport({ scale: 1 });
	const scale = 1024 / Math.max(base.width, base.height);
	const viewport = page.getViewport({ scale });
	const canvas = napi.createCanvas(Math.round(viewport.width), Math.round(viewport.height));
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
	await page.render({ canvasContext: ctx, viewport, canvas, annotationMode: 0 }).promise;
	return { canvas, viewport };
}

function tensorFrom(canvas, w, h, { letterbox, mean, std }) {
	const c = napi.createCanvas(w, h);
	const x = c.getContext("2d");
	let sx = w / canvas.width, sy = h / canvas.height, ox = 0, oy = 0;
	if (letterbox) {
		const s = Math.min(sx, sy); sx = sy = s;
		ox = (w - canvas.width * s) / 2; oy = (h - canvas.height * s) / 2;
		x.fillStyle = "rgb(114,114,114)"; x.fillRect(0, 0, w, h);
	}
	x.drawImage(canvas, ox, oy, canvas.width * sx, canvas.height * sy);
	const px = x.getImageData(0, 0, w, h).data;
	const data = new Float32Array(3 * w * h);
	for (let i = 0, n = w * h; i < n; i++) {
		for (let k = 0; k < 3; k++) {
			const v = px[4 * i + k] / 255;
			data[k * n + i] = mean ? (v - mean[k]) / std[k] : v;
		}
	}
	return { data, sx, sy, ox, oy };
}

const iou = (a, b) => {
	const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
	if (w <= 0 || h <= 0) return 0;
	const i = w * h;
	return i / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i);
};

// Formula boxes in canvas pixels.
async function detect(m, canvas) {
	const t0 = performance.now();
	if (m.kind === "paddle") {
		const { data } = tensorFrom(canvas, m.size, m.size, { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] });
		const t1 = performance.now();
		const out = await m.session.run({
			image: new ort.Tensor("float32", data, [1, 3, m.size, m.size]),
			scale_factor: new ort.Tensor("float32", new Float32Array([m.size / canvas.height, m.size / canvas.width]), [1, 2]),
		});
		const t2 = performance.now();
		const rows = out[m.session.outputNames[0]].data;
		const boxes = [];
		for (let i = 0; i + 5 < rows.length; i += 6) {
			if (rows[i] === m.formula && rows[i + 1] >= m.threshold) boxes.push([rows[i + 2], rows[i + 3], rows[i + 4], rows[i + 5]]);
		}
		return { boxes, pre: t1 - t0, infer: t2 - t1 };
	}
	const lb = tensorFrom(canvas, m.size, m.size, { letterbox: true });
	const t1 = performance.now();
	const out = await m.session.run({ images: new ort.Tensor("float32", lb.data, [1, 3, m.size, m.size]) });
	const t2 = performance.now();
	const o = out.output0, [, ch, n] = o.dims, d = o.data;
	const cand = [];
	for (let j = 0; j < n; j++) {
		const score = d[(4 + m.formula) * n + j];
		if (score < m.threshold) continue;
		let best = 0;
		for (let c = 0; c < m.classes; c++) best = Math.max(best, d[(4 + c) * n + j]);
		if (best > score) continue;           // another class wins this anchor
		const cx = d[j], cy = d[n + j], w = d[2 * n + j], h = d[3 * n + j];
		cand.push({ score, box: [(cx - w / 2 - lb.ox) / lb.sx, (cy - h / 2 - lb.oy) / lb.sy, (cx + w / 2 - lb.ox) / lb.sx, (cy + h / 2 - lb.oy) / lb.sy] });
	}
	cand.sort((a, b) => b.score - a.score);
	const boxes = [];
	for (const c of cand) if (!boxes.some((b) => iou(b, c.box) > 0.45)) boxes.push(c.box);
	void ch;
	return { boxes, pre: t1 - t0, infer: t2 - t1 };
}

const stats = Object.fromEntries(MODELS.map((m) => [m.key, { both: 0, onlyRules: 0, onlyModel: 0, neither: 0, pre: 0, infer: 0, pages: 0 }]));
let renderMs = 0, pageCount = 0;
const disagreements = [];

for (const file of files) {
	const doc = await openPdf(file);
	let [a, b] = pagesSpec ? pagesSpec.split("-").map(Number) : [1, doc.numPages];
	b = Math.min(b || a, doc.numPages);
	for (let p = a; p <= b; p++) {
		const t = performance.now();
		const { canvas, viewport } = await render(doc, p);
		renderMs += performance.now() - t;
		pageCount++;
		const pd = await doc.getPageData({ pageIndex: p - 1 });
		const { lines, chars } = B.analysePage(pd.chars, pd.viewBox);
		// A line's own extent without its equation number: detectors differ on
		// whether the number is part of a formula's box.
		const bodyRect = (l) => {
			const from = l.eqNumTo >= 0 ? l.eqNumTo + 1 : l.from, to = l.eqNumFrom >= 0 ? l.eqNumFrom - 1 : l.to;
			let r = null;
			for (let i = from; i <= to; i++) {
				const q = chars[i].rect;
				if (!chars[i].c.trim()) continue;
				r = r ? [Math.min(r[0], q[0]), Math.min(r[1], q[1]), Math.max(r[2], q[2]), Math.max(r[3], q[3])] : q.slice();
			}
			return r || l.rect;
		};
		const judged = lines.filter((l) => !l.furniture && !l.tabular && l.tableRow === undefined && (l.textWords >= 1 || l.kind === "display"));
		const toCanvas = (r) => {
			const [x1, y1] = viewport.convertToViewportPoint(r[0], r[3]);
			const [x2, y2] = viewport.convertToViewportPoint(r[2], r[1]);
			return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
		};
		const perModel = {};
		for (const m of MODELS) {
			const r = await detect(m, canvas);
			const s = stats[m.key];
			s.pre += r.pre; s.infer += r.infer; s.pages++;
			perModel[m.key] = r.boxes;
			for (const line of judged) {
				const lb = toCanvas(bodyRect(line));
				const area = Math.max(1, (lb[2] - lb[0]) * (lb[3] - lb[1]));
				const covered = Math.max(0, ...r.boxes.map((bx) => {
					const w = Math.min(lb[2], bx[2]) - Math.max(lb[0], bx[0]), h = Math.min(lb[3], bx[3]) - Math.max(lb[1], bx[1]);
					return w > 0 && h > 0 ? (w * h) / area : 0;
				}));
				const model = covered >= 0.6, rules = line.kind === "display";
				if (model && rules) s.both++;
				else if (rules) s.onlyRules++;
				else if (model) s.onlyModel++;
				else s.neither++;
				if (model !== rules) disagreements.push({ model: m.key, page: `${basename(file)}#${p}`, rules: line.kind, text: line.text.slice(0, 60) });
			}
		}
		if (overlayDir) {
			const ctx = canvas.getContext("2d");
			const colours = { "ppdl-s": "rgba(220,0,0,0.9)", yolo11n: "rgba(0,140,0,0.9)", "p2t-mfd": "rgba(0,0,220,0.9)" };
			for (const line of judged.filter((l) => l.kind === "display")) {
				const r = toCanvas(line.rect); ctx.fillStyle = "rgba(255,200,0,0.25)"; ctx.fillRect(r[0], r[1], r[2] - r[0], r[3] - r[1]);
			}
			MODELS.forEach((m, k) => {
				ctx.strokeStyle = colours[m.key]; ctx.lineWidth = 1.5;
				for (const bx of perModel[m.key]) ctx.strokeRect(bx[0] - k, bx[1] - k, bx[2] - bx[0] + 2 * k, bx[3] - bx[1] + 2 * k);
			});
			writeFileSync(`${overlayDir}/${basename(file, ".pdf")}-p${String(p).padStart(2, "0")}.png`, canvas.toBuffer("image/png"));
		}
	}
}

console.log(`${pageCount} pages; render at ~1024px: ${(renderMs / pageCount).toFixed(0)} ms/page`);
for (const m of MODELS) {
	const s = stats[m.key], total = s.both + s.onlyRules + s.onlyModel + s.neither;
	console.log(`${m.key.padEnd(8)} input ${m.size}  prep ${(s.pre / s.pages).toFixed(0)} ms  infer ${(s.infer / s.pages).toFixed(0)} ms/page | lines ${total}: agree ${((s.both + s.neither) / total * 100).toFixed(1)}%  (display both ${s.both}, rules only ${s.onlyRules}, model only ${s.onlyModel})`);
}
writeFileSync("out-disagreements.json", JSON.stringify(disagreements, null, 1));
process.exit(0);
