// node tools/stress.cjs — analysis time as pathological pages grow: a grid of
// formula pieces (a big matrix), a long table of numbers, a page of prose.
const B = require("../bootstrap.js");
const glyph = (c, x, y, size = 10, font = "CMMI10") => ({
	c, rect: [x, y - 2.5, x + 5, y + 7.5], inlineRect: [x, y - 2.5, x + 5, y + 7.5], fontSize: size, fontName: font,
	bold: false, italic: false, baseline: y, rotation: 0, spaceAfter: false, lineBreakAfter: false, paragraphBreakAfter: false, ignorable: false,
});
function grid(rows, cols, word) {
	const chars = [];
	for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
		// staggered like numerators and denominators, so no two pieces stitch
		const x = 60 + k * (480 / cols), y = 760 - r * (700 / rows) + (k % 2 ? 6 : 0);
		const s = word(r, k);
		for (let j = 0; j < s.length; j++) chars.push(glyph(s[j], x + j * 5, y, 10, /\d/.test(s) ? "CMR10" : "CMMI10"));
		chars[chars.length - 1].lineBreakAfter = true;
	}
	return chars;
}
function prose(lines) {
	const chars = [];
	for (let r = 0; r < lines; r++) {
		const text = "the quick brown fox jumps over the lazy dog and then over it again";
		let x = 72;
		for (const c of text) {
			if (c === " ") { chars[chars.length - 1].spaceAfter = true; x += 3; continue; }
			chars.push(glyph(c, x, 760 - r * (700 / lines) , 10, "CMR10")); x += 5.5;
		}
		chars[chars.length - 1].lineBreakAfter = true;
	}
	return chars;
}
const time = (chars) => {
	B.segmentPage(chars, [0, 0, 612, 792]);
	const t = performance.now();
	B.segmentPage(chars, [0, 0, 612, 792]);
	return (performance.now() - t).toFixed(1);
};
for (const n of [10, 20, 40, 80]) {
	console.log(`n=${n}: matrix ${n}x8 ${time(grid(n, 8, (r, k) => "x" + k))} ms | table ${n}x6 ${time(grid(n, 6, (r, k) => String(r * 37 + k)))} ms | prose ${n * 4} lines ${time(prose(n * 4))} ms`);
}
if (process.argv[2] === "--lines") {
	for (const [name, chars] of [["matrix", grid(80, 8, (r, k) => "x" + k)], ["table", grid(80, 6, (r, k) => String(r * 37 + k))], ["prose", prose(320)]]) {
		const r = B.describePage(chars, [0, 0, 612, 792]);
		const kinds = {};
		for (const l of r.split("\n")) { const m = /^(text|display|dropped)\s+x/.exec(l); if (m) kinds[m[1]] = (kinds[m[1]] || 0) + 1; }
		console.log(name, r.split("\n")[1], JSON.stringify(kinds));
	}
}
