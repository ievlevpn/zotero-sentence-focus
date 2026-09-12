// Self-check: node test.js  (exits non-zero on failure)
//
// The analysis in bootstrap.js never touches Zotero, so it can be driven here
// with a synthetic page. `layout()` below builds the same per-character stream
// Zotero's pdf.js fork produces, from a compact description of a page:
//
//   «...»  glyphs from a formula font        ^...^  a raised footnote marker
//   { x }  left edge in points               { size }  font size
//   { para: true }  Zotero's paragraph break after this line
//   { hyphen: true } line ends on a soft hyphen (Zotero flags it ignorable)
//   ‖      Zotero cuts the visual line here and calls it a paragraph break —
//          what its overlaps() test does when a superscript meets an "="
//   ¹      the glyph before it is raised and small (a superscript)
//   {ffi}  one glyph carrying several characters, as Zotero returns a ligature
//   { mathFont }  the font the «...» glyphs claim to be in, for papers whose
//          maths is not set in Computer Modern
//   ~n~    a subscript: smaller and lowered, as a real index is

const assert = require("assert");
const {
	segmentPage, splitSentences, prevToken, mergeTiny, solidColor, charsToLines, mergeBoxes,
	materialize, toPercent, toUserBox, pageAspect, wordRanges, lineRanges,
	GRANULARITIES, STYLES, CSS, describePage, padBoxes, LIST_LABEL_RE,
} = require("./bootstrap.js");

const TEXT_FONT = "NimbusRomNo9L-Regu";
const MATH_FONT = "KHFWDQ+CMMI10";
const VIEW = [0, 0, 612, 792];

function layout(lines, viewBox = VIEW) {
	const chars = [];
	let baseY = viewBox[3] - 80;
	for (let li = 0; li < lines.length; li++) {
		const ln = typeof lines[li] === "string" ? { text: lines[li] } : lines[li];
		const size = ln.size || 10;
		const y = ln.y != null ? ln.y : baseY;
		let x = ln.x != null ? ln.x : 72;
		const start = chars.length;
		let fragStart = chars.length;
		const frags = [];
		let math = !!ln.math, sup = false, sub = false, group = null, dy = 0;

		// Zotero hands back a ligature as ONE glyph whose `c` is several
		// characters ("ffi"), covered by a single rect.
		const emit = (text) => {
			const sz = (sup || sub) ? size * 0.6 : size;
			const w = sz * 0.5 * (text.length > 1 ? text.length * 0.7 : 1);
			const off = (sup ? 0.35 * size : sub ? -0.2 * size : 0) + dy;
			chars.push({
				c: text,
				rect: [x, y - 0.2 * sz + off, x + w, y + 0.7 * sz + off],
				fontSize: sz,
				fontName: math ? (ln.mathFont || MATH_FONT) : TEXT_FONT,
				bold: !!ln.bold,
				italic: math,
				baseline: y + off,
				rotation: 0,
				spaceAfter: false,
				lineBreakAfter: false,
				paragraphBreakAfter: false,
				ignorable: false,
			});
			x += w;
		};

		// `pieces` places runs at explicit coordinates, which is how real maths
		// is set: a fraction draws the numerator, then moves BACK to the left
		// and down for the denominator, so glyph order is not left-to-right.
		const pieces = ln.pieces || [{ text: ln.text }];
		for (const piece of pieces) {
		if (piece.x != null) x = piece.x;
		dy = piece.dy || 0;
		for (const c of piece.text) {
			if (c === "«") { math = true; continue; }
			if (c === "»") { math = false; continue; }
			if (c === "^") { sup = !sup; sub = false; continue; }
			if (c === "~") { sub = !sub; sup = false; continue; }
			if (c === "{") { group = ""; continue; }
			if (c === "}") { emit(group); group = null; continue; }
			if (group !== null) { group += c; continue; }
			if (c === "‖") {
				// Zotero ends a fragment here and calls it a paragraph break.
				const last = chars[chars.length - 1];
				last.lineBreakAfter = true;
				last.paragraphBreakAfter = true;
				frags.push([fragStart, chars.length - 1]);
				fragStart = chars.length;
				continue;
			}
			if (c === " ") {
				if (chars.length > start) chars[chars.length - 1].spaceAfter = true;
				x += size * 0.35;
				continue;
			}
			emit(c);
		}
		}

		if (chars.length === start) continue;
		const last = chars[chars.length - 1];
		last.lineBreakAfter = true;
		last.paragraphBreakAfter = !!ln.para;
		if (ln.hyphen) last.ignorable = true;
		frags.push([fragStart, chars.length - 1]);
		// Zotero gives every glyph the vertical extent of its own fragment —
		// which is why a fragmented line comes back with mismatched bands.
		for (const [a, b] of frags) {
			const own = chars.slice(a, b + 1);
			if (!own.length) continue;
			const lo = Math.min(...own.map((c) => c.rect[1]));
			const hi = Math.max(...own.map((c) => c.rect[3]));
			for (const c of own) c.inlineRect = [c.rect[0], lo, c.rect[2], hi];
		}
		baseY = y - size * 1.7;
	}
	return chars;
}

const texts = (lines, opts) => segmentPage(layout(lines), VIEW, opts).sentence.map((u) => u.text);
const kinds = (lines, opts) => segmentPage(layout(lines), VIEW, opts).sentence.map((u) => u.kind);

// --- prose, wrapped over several lines -------------------------------------

assert.deepStrictEqual(texts([
	"The measure is finite. We now turn to the",
	"second case, which is harder. A third one",
	{ text: "follows.", para: true },
]), [
	"The measure is finite.",
	"We now turn to the second case, which is harder.",
	"A third one follows.",
]);

// --- abbreviations ---------------------------------------------------------

assert.deepStrictEqual(texts([{ text: "See Fig. 3 for the bound. It is sharp.", para: true }]),
	["See Fig. 3 for the bound.", "It is sharp."]);
assert.deepStrictEqual(texts([{ text: "This holds, i.e. the map is onto. Hence we win.", para: true }]),
	["This holds, i.e. the map is onto.", "Hence we win."]);
assert.deepStrictEqual(texts([{ text: "By Thm. 2.1 and Sec. 4 we conclude. Done.", para: true }]),
	["By Thm. 2.1 and Sec. 4 we conclude.", "Done."]);
assert.deepStrictEqual(texts([{ text: "Smith et al. showed this. We extend it.", para: true }]),
	["Smith et al. showed this.", "We extend it."]);

// --- numbers ---------------------------------------------------------------

assert.deepStrictEqual(texts([{ text: "We take 3.14 as the value. Version 2.0 is out.", para: true }]),
	["We take 3.14 as the value.", "Version 2.0 is out."]);
// A numbered theorem header still ends: "3.1." is followed by a capital.
assert.deepStrictEqual(texts([{ text: "Theorem 3.1. Let X be compact. Then X is closed.", para: true }]),
	["Theorem 3.1.", "Let X be compact.", "Then X is closed."]);

// --- initials --------------------------------------------------------------

assert.deepStrictEqual(texts([{ text: "This is due to J. R. R. Tolkien. We follow him.", para: true }]),
	["This is due to J. R. R. Tolkien.", "We follow him."]);
// ...but a lone capital that is not part of a run of initials does end one.
assert.deepStrictEqual(texts([{ text: "The proof is in Appendix A. We now conclude.", para: true }]),
	["The proof is in Appendix A.", "We now conclude."]);

// --- mathematics -----------------------------------------------------------

// A period inside a formula is not a full stop.
assert.deepStrictEqual(texts([{ text: "Write «f.g» for the composite. It is smooth.", para: true }]),
	["Write f.g for the composite.", "It is smooth."]);
// A sentence may open with a lower-case formula variable.
assert.deepStrictEqual(texts([{ text: "The map is proper. «f» denotes its inverse.", para: true }]),
	["The map is proper.", "f denotes its inverse."]);
// Inline maths mid-sentence does not break it.
assert.deepStrictEqual(texts([{ text: "Suppose «x ∈ X» and «y ≤ 1». Then the claim holds.", para: true }]),
	["Suppose x ∈ X and y ≤ 1.", "Then the claim holds."]);

// --- display equations -----------------------------------------------------

{
	const page = [
		{ text: "Let X be a random variable such that" },
		{ text: "«E[X] = 0,»", x: 240, para: true },
		{ text: "where the expectation is taken over all paths. The proof is complete.", para: true },
	];
	assert.deepStrictEqual(kinds(page), ["text", "display", "text", "text"]);
	assert.deepStrictEqual(texts(page), [
		"Let X be a random variable such that",
		"E[X] = 0,",
		"where the expectation is taken over all paths.",
		"The proof is complete.",
	]);
	// With mergeDisplay on, the equation folds back into its sentence.
	assert.deepStrictEqual(texts(page, { mergeDisplay: true })[0],
		"Let X be a random variable such that E[X] = 0, where the expectation is taken over all paths.");
}

// An equation number at the right margin is neither highlighted nor read.
{
	const units = segmentPage(layout([
		{ text: "We therefore obtain" },
		{ text: "«E[X] = 0,»                                        (2.1)", x: 200, para: true },
		{ text: "which finishes the argument.", para: true },
	]), VIEW).sentence;
	const eq = units.find((u) => u.kind === "display");
	assert.strictEqual(eq.text, "E[X] = 0,");
	assert.ok(!units.some((u) => u.text.includes("2.1")), "equation number must not join a unit");
}

// --- hyphenation across a line break ---------------------------------------

assert.deepStrictEqual(texts([
	{ text: "The construction is straight-", hyphen: true },
	{ text: "forward. Nothing else is needed.", para: true },
]), ["The construction is straightforward.", "Nothing else is needed."]);

// --- footnote markers ------------------------------------------------------

// "holds.12 The" would read as a decimal without masking the raised marker.
assert.deepStrictEqual(texts([{ text: "The bound holds.^12^ The rest is routine.", para: true }]),
	["The bound holds.", "The rest is routine."]);

// --- list labels and references --------------------------------------------

assert.deepStrictEqual(texts([{ text: "1. the first case is trivial. The second is not.", para: true }]),
	["1. the first case is trivial.", "The second is not."]);
assert.deepStrictEqual(texts([{ text: "[12] Smith, J. A. Some paper. J. Algebra 4 (1999), 1-20.", para: true }]),
	["[12] Smith, J. A. Some paper. J. Algebra 4 (1999), 1-20."]);

// --- a sentence broken across columns --------------------------------------

{
	// Zotero's layout analysis ends a paragraph at the foot of a column; the
	// sentence plainly carries on at the top of the next one.
	const units = texts([
		{ text: "The first column ends with a clause that", x: 60, y: 700, para: true },
		{ text: "continues here at the top of the next", x: 330, y: 700, para: true },
		{ text: "column and stops. A new one starts.", x: 330, y: 683, para: true },
	]);
	assert.deepStrictEqual(units, [
		"The first column ends with a clause that continues here at the top of the next column and stops.",
		"A new one starts.",
	]);
}

// --- running heads and page numbers ----------------------------------------

{
	const units = texts([
		{ text: "24", y: 40, x: 300 },
		{ text: "A body sentence sits here. Another follows it.", y: 700, para: true },
		{ text: "It carries on for a while longer here.", y: 683, para: true },
		{ text: "And a third line of body text.", y: 666, para: true },
		{ text: "CHAPTER 2. MEASURES", y: 755, x: 200 },
	]);
	assert.ok(!units.some((u) => u === "24"), "page number should be dropped");
	assert.ok(!units.some((u) => u.includes("CHAPTER 2")), "running head should be dropped");
	assert.strictEqual(units[0], "A body sentence sits here.");
}

// --- ellipsis --------------------------------------------------------------

assert.deepStrictEqual(texts([{ text: "We take the limit ... and then stop. Next.", para: true }]),
	["We take the limit ... and then stop.", "Next."]);

// --- rectangles ------------------------------------------------------------

{
	const units = segmentPage(layout([
		"The measure is finite. We now turn to the",
		{ text: "second case.", para: true },
	]), VIEW).sentence;
	// The second sentence starts mid-line and wraps, so it needs two boxes.
	assert.strictEqual(units.length, 2);
	assert.strictEqual(units[1].rects.length, 2);
	const [a, b] = units[1].rects;
	assert.ok(a[3] > b[3], "first box is the higher line");
	assert.ok(a[0] > units[0].rects[0][0], "second sentence starts to the right of the first");
}

// --- pure helpers ----------------------------------------------------------

assert.strictEqual(prevToken("see w.r.t.", 9), "w.r.t");
assert.strictEqual(prevToken("in Fig.", 6), "Fig");
assert.strictEqual(prevToken("x = 1.", 5), "");
assert.deepStrictEqual(splitSentences("A b. C d.", [], []), [[0, 4], [5, 9]]);
assert.deepStrictEqual(mergeTiny("). Real text here.", [[0, 2], [3, 18]]), [[0, 18]]);
assert.strictEqual(solidColor("#ffd23f"), "#ffd23f");
assert.strictEqual(solidColor("ffd23f"), "#ffd23f");
assert.strictEqual(solidColor("nonsense"), "#ffd23f");
assert.strictEqual(charsToLines(materialize(layout(["one", "two", "three"]))).length, 3);

// toPercent must survive rotation: pdf.js hands over the page's own matrix.
{
	const upright = { transform: [1, 0, 0, -1, 0, 200], width: 100, height: 200 };
	const p = toPercent([10, 20, 30, 40], upright);
	assert.strictEqual(p.left, 10);
	assert.strictEqual(p.width, 20);
	assert.strictEqual(p.top, 80);   // PDF y is measured up, CSS down
	assert.strictEqual(p.height, 10);
}



// A block that stops on a colon is still mid-sentence: layout analysis breaks
// paragraphs there, but the clause after it belongs to the same sentence.
assert.deepStrictEqual(texts([
	{ text: "In the first case:", para: true },
	{ text: "nothing happens at all. In the second, everything does.", para: true },
]), ["In the first case: nothing happens at all.", "In the second, everything does."]);



// --- a visual line that Zotero hands back in fragments ----------------------

// Zotero's overlaps() test cuts a line wherever a superscript is followed by a
// glyph on the maths axis, and then calls the cut a paragraph break because
// the two pieces sit side by side rather than stacked. Both halves are one
// visual line and one sentence, and must be treated as such.
assert.deepStrictEqual(texts([
	{ text: "whose potential is the Newton polynomial «p_k(X)‖ = tr(A_X^k^)» of degree k of the" },
	{ text: "adjacency spectrum. Three families of chains are treated.", para: true },
]), [
	"whose potential is the Newton polynomial p_k(X) = tr(A_Xk) of degree k of the adjacency spectrum.",
	"Three families of chains are treated.",
]);

// The same cut must not fuse two columns that happen to share a baseline.
{
	// Capitalised so the continuation join stays out of it: this is about the
	// fragment stitch alone.
	const units = texts([
		{ text: "left column text here‖ and more", x: 60, y: 700, para: true },
		{ text: "Right column text here.", x: 400, y: 700, para: true },
	]);
	assert.ok(units.some((u) => u === "Right column text here."),
		"a line in the next column must stay its own unit");
	assert.ok(units.some((u) => u === "left column text here and more"),
		"the cut line must be stitched back into one");
}



// --- granularities ---------------------------------------------------------

// Word, line, sentence and paragraph all come off the same block text, so they
// agree about what counts as text: the equation number dropped from one is
// dropped from all of them.
{
	const page = layout([
		{ text: "The measure is finite. We now" },
		{ text: "turn to the second case.", para: true },
	]);
	const all = segmentPage(page, VIEW);

	assert.deepStrictEqual(all.paragraph.map((u) => u.text),
		["The measure is finite. We now turn to the second case."]);
	assert.deepStrictEqual(all.line.map((u) => u.text),
		["The measure is finite. We now", "turn to the second case."]);
	assert.deepStrictEqual(all.sentence.map((u) => u.text),
		["The measure is finite.", "We now turn to the second case."]);
	assert.deepStrictEqual(all.word.map((u) => u.text).slice(0, 6),
		["The", "measure", "is", "finite.", "We", "now"]);
	assert.strictEqual(all.word.length, 11);
	// Every word sits on exactly one line, so it needs exactly one box.
	assert.ok(all.word.every((u) => u.rects.length === 1), "a word is one box");
	// A line unit spans its whole line and no more.
	assert.strictEqual(all.line[0].rects.length, 1);
}

// An equation number is excluded at every granularity, not just the sentence.
{
	const all = segmentPage(layout([
		{ text: "We therefore obtain" },
		{ text: "«E[X] = 0,»                                        (2.1)", x: 200, para: true },
	]), VIEW);
	for (const g of GRANULARITIES) {
		assert.ok(!all[g].some((u) => u.text.includes("2.1")), `${g}: equation number must be dropped`);
	}
}

// Furniture stays out of every granularity too — stepping by line should not
// walk onto the running head.
{
	const all = segmentPage(layout([
		{ text: "24", y: 40, x: 300 },
		{ text: "A body sentence sits here. Another follows it.", y: 700, para: true },
		{ text: "It carries on for a while longer here.", y: 683, para: true },
		{ text: "And a third line of body text.", y: 666, para: true },
	]), VIEW);
	for (const g of GRANULARITIES) {
		assert.ok(!all[g].some((u) => u.text === "24"), `${g}: page number must be dropped`);
	}
}

assert.deepStrictEqual(wordRanges("  ab  cd "), [[2, 4], [6, 8]]);
assert.deepStrictEqual(lineRanges("abc def", [0, 4]), [[0, 4], [4, 7]]);



// --- a run-in section heading ----------------------------------------------

// Zotero drops the paragraph break before a one-line heading whenever the
// heading's first glyph shares a font with the paragraph's first glyph — and a
// section number set in roman does exactly that. The heading arrives glued to
// the end of the previous paragraph, with only the vertical gap to give it
// away.
{
	const page = [
		{ text: "The natural device for such a task is a chain", y: 700 },
		{ text: "with the uniform stationary distribution.", y: 683 },
		{ text: "The present paper is devoted to this.", y: 666 },
		{ text: "1.2. State of the art.", y: 630, bold: true },
	];
	assert.deepStrictEqual(texts(page), [
		"The natural device for such a task is a chain with the uniform stationary distribution.",
		"The present paper is devoted to this.",
		"1.2. State of the art.",
	]);
	// The heading is one paragraph of its own, not the tail of the one above.
	assert.deepStrictEqual(segmentPage(layout(page), VIEW).paragraph.map((u) => u.text).slice(-1),
		["1.2. State of the art."]);
}

// A dotted section number is a label, not the end of a sentence.
assert.deepStrictEqual(texts([{ text: "2.3.1. Growth operations. These are defined below.", para: true }]),
	["2.3.1. Growth operations.", "These are defined below."]);

// A unit made only of digits is still a unit: "1.2." must not be swallowed by
// the sentence before it just because it holds no letters.
assert.deepStrictEqual(mergeTiny("Ends here. 1.2. Next", [[0, 10], [11, 15], [16, 20]]),
	[[0, 10], [11, 15], [16, 20]]);
assert.deepStrictEqual(mergeTiny("Ends here. ). Next", [[0, 10], [11, 13], [14, 18]]),
	[[0, 13], [14, 18]]);



// Appendices number their sections with a letter, so a label segment is a
// letter or a small number either way.
assert.deepStrictEqual(texts([{ text: "A.1. Auxiliary lemmas. These are standard.", para: true }]),
	["A.1. Auxiliary lemmas.", "These are standard."]);
assert.deepStrictEqual(texts([{ text: "2. Preliminaries. We fix notation.", para: true }]),
	["2. Preliminaries.", "We fix notation."]);
// An abbreviation with internal periods at a line start is not a stop either.
assert.deepStrictEqual(texts([{ text: "U.S. policy changed in 1998. Then it did not.", para: true }]),
	["U.S. policy changed in 1998.", "Then it did not."]);



// --- the highlight has to blend with the page canvas ------------------------

// A positioned wrapper forms a stacking context, which isolates the blend mode
// from the canvas below; the blend then degrades to plain alpha and washes the
// glyphs out. Zotero's own overlay carries a comment about this. None of it is
// visible from node, so pin the shape of the stylesheet instead.
assert.match(CSS, /\.sfz-layer\{display:contents\}/,
	"the highlight wrapper must not have a box of its own");
assert.match(CSS, /\.sfz-veil\.sfz-blend\{mix-blend-mode:var\(--sfz-blend\)\}/,
	"the blend belongs on the group that holds the boxes, not the wrapper");
assert.ok(!/\.sfz-layer\{[^}]*position:/.test(CSS),
	"positioning the wrapper would isolate the blend again");



// --- ligatures --------------------------------------------------------------

// Zotero normalises the "ffi" ligature to a three-character string but leaves
// it as ONE glyph with ONE rect, so three text positions map to the same char.
// Emitting a box per position stacks three of them on the same glyph, and with
// a multiply blend that paints the ligature darker than the rest of the line.
{
	const units = segmentPage(layout([{ text: "The e{ffi}cient map is here.", para: true }]), VIEW).sentence;
	assert.strictEqual(units.length, 1);
	assert.strictEqual(units[0].text, "The efficient map is here.");
	assert.strictEqual(units[0].rects.length, 1, "one line of text is one box, ligature or not");
}

// The same holds at word granularity, where the ligature is inside the word.
{
	const words = segmentPage(layout([{ text: "an e{ffi}cient map", para: true }]), VIEW).word;
	assert.deepStrictEqual(words.map((u) => u.text), ["an", "efficient", "map"]);
	assert.ok(words.every((u) => u.rects.length === 1), "each word is a single box");
}



// --- displayed formulas are an area ----------------------------------------

// Maths is set in two dimensions: a fraction draws its numerator, then moves
// back to the left and down for the denominator. Following the glyphs gives
// ragged boxes that sit on top of one another; the formula wants its area.
{
	const page = [
		{ text: "We therefore obtain" },
		{ math: true, para: true, pieces: [
			{ text: "E = ", x: 200 },
			{ text: "a+b", x: 230, dy: 5 },     // numerator
			{ text: "c+d", x: 230, dy: -7 },    // denominator, back to the left
			{ text: " ,", x: 262 },
		] },
		{ text: "which finishes it.", para: true },
	];
	const all = segmentPage(layout(page), VIEW);
	const eq = all.sentence.find((u) => u.kind === "display");
	assert.ok(eq, "the formula is a display unit");
	assert.strictEqual(eq.rects.length, 1, "a one-line formula is one area, not four boxes");
	const [x1, , x2] = eq.rects[0];
	assert.ok(x1 <= 200 && x2 >= 262, "the area spans the whole formula");

	// Stepping word by word through a formula still boxes the tokens, so the
	// area treatment must not leak down to that granularity.
	const tokens = all.word.filter((u) => u.kind === "display");
	const areaWidth = eq.rects[0][2] - eq.rects[0][0];
	assert.ok(tokens.length > 1, "a formula still has separate words");
	assert.ok(tokens.every((u) => u.rects[0][2] - u.rects[0][0] < areaWidth),
		"a word inside a formula is boxed to the word, not the whole area");
}

// A two-line align block is one unit covering the area of both lines. Maths
// hangs limits above and below its own baseline, so a box per line would leave
// holes; the area is the only shape that cannot come out ragged.
{
	const all = segmentPage(layout([
		{ text: "Expanding the sum we find" },
		{ text: "«S_n = Σ a_k x_k»", x: 200 },
		{ text: "«    = Σ b_k y_k,»", x: 200, para: true },
		{ text: "where the coefficients are given below.", para: true },
	]), VIEW);
	const eq = all.sentence.find((u) => u.kind === "display");
	assert.strictEqual(eq.rects.length, 1, "the whole align block is one area");
	assert.ok(eq.rects[0][3] - eq.rects[0][1] > 15, "the area spans both lines");
}

// No box of a unit may sit on top of another: overlapping boxes composited
// separately would darken, which is what a fraction used to do.
{
	const all = segmentPage(layout([
		{ pieces: [
			{ text: "The ratio " },
			{ text: "a+b", x: 200, dy: 5 },
			{ text: "c+d", x: 200, dy: -7 },
			{ text: " is finite.", x: 232 },
		], para: true },
	]), VIEW);
	for (const u of all.sentence) {
		for (let i = 0; i < u.rects.length; i++) {
			for (let j = i + 1; j < u.rects.length; j++) {
				const a = u.rects[i], b = u.rects[j];
				const overlap = Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > 0.5
					&& Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > 0.5;
				assert.ok(!overlap, `boxes ${i} and ${j} overlap: ${a} vs ${b}`);
			}
		}
	}
}



// A wide channel — the run up to an equation number — must survive merging.
assert.deepStrictEqual(mergeBoxes([[10, 0, 50, 10], [200, 0, 230, 10]]),
	[[10, 0, 50, 10], [200, 0, 230, 10]]);
// Identical and overlapping boxes on one band collapse to one.
assert.deepStrictEqual(mergeBoxes([[10, 0, 50, 10], [10, 0, 50, 10]]), [[10, 0, 50, 10]]);
assert.deepStrictEqual(mergeBoxes([[10, 0, 50, 10], [40, 0, 70, 10]]), [[10, 0, 70, 10]]);
// Different bands are different lines and never merge.
assert.deepStrictEqual(mergeBoxes([[10, 0, 50, 10], [10, 20, 50, 30]]),
	[[10, 0, 50, 10], [10, 20, 50, 30]]);



// --- the parts node cannot run ---------------------------------------------

// Most of bootstrap.js talks to a live reader and cannot be exercised here, so
// a call to a function that was deleted or renamed would sail past both these
// tests and `node --check`, and only fail when a key is pressed in Zotero.
{
	const { check, FILES } = require("./lint.js");
	for (const file of FILES) {
		assert.deepStrictEqual([...check(file).keys()], [], `${file} calls undefined functions`);
	}
}



// --- highlight styles -------------------------------------------------------

const STYLE_VALUES = new Set(STYLES.map(([value]) => value));

// The reader menu builds its chips from STYLES; the preferences pane lists the
// same set by hand. They have to agree, or a style is reachable from one place
// and not the other.
{
	const pane = require("fs").readFileSync("prefs.xhtml", "utf8");
	for (const [value, label] of STYLES) {
		assert.ok(pane.includes(`value="${value}"`), `Settings is missing the ${value} style`);
		assert.ok(pane.includes(`>${label}<`), `Settings is missing the label for ${value}`);
	}
	// And nothing the pane offers may be a style bootstrap.js cannot draw.
	const styleOptions = /id="sf-style">([\s\S]*?)<\/html:select>/.exec(pane);
	assert.ok(styleOptions, "the style menu is in the pane");
	for (const m of styleOptions[1].matchAll(/value="([a-z]+)"/g)) {
		assert.ok(STYLE_VALUES.has(m[1]), `Settings offers an unknown style: ${m[1]}`);
	}
}

// Drawing units are square, so a radius or a slant is not squashed on a page
// that is taller than it is wide.
{
	const pv = { viewport: { width: 612, height: 792 } };
	const aspect = pageAspect(pv);
	assert.ok(Math.abs(aspect - 792 / 612) < 1e-9);
	assert.strictEqual(pageAspect({ viewport: { width: 0, height: 0 } }), 1.294);

	// A square region of the page must come out square in user units.
	const upright = { transform: [1, 0, 0, -1, 0, 792], width: 612, height: 792 };
	const box = toUserBox([100, 400, 200, 500], upright, pageAspect({ viewport: upright }));
	const pxPerUserX = 612 / 100;
	const pxPerUserY = 792 / (100 * pageAspect({ viewport: upright }));
	assert.ok(Math.abs(pxPerUserX - pxPerUserY) < 1e-9, "user units must be square");
	assert.ok(Math.abs(box.w - box.h) < 1e-9, "a 100x100pt region is square in user units");
}



// --- a display row that arrives in pieces -----------------------------------

// Two equations side by side, a limit under the summation sign, and "(3)" out
// at the right margin — and the layout hands the row over in five pieces. Each
// piece judged on its own goes wrong: "P(X,Z)," has no words and no relation
// sign, scores as prose, and takes the paragraph below it into the highlight.
{
	const page = [
		{ text: "respect to the uniform distribution, its transition matrix is", y: 700, para: true },
		{ text: "«P»(«X»,«Y») «=» min{«q»(«X»,«Y»),«q»(«Y»,«X»)}", x: 90, y: 665 },
		{ text: "(«X» «≠» «Y»),", x: 250, y: 665 },
		{ text: "«P»(«X»,«X») «=» 1 «−» «Σ»", x: 330, y: 665 },
		{ text: "«Z»«≠»«X»", x: 400, y: 652, size: 7 },     // the limit, below the line
		{ text: "«P»(«X»,«Z»),", x: 430, y: 665 },
		{ text: "(3)", x: 540, y: 665, para: true },
		{ text: "its lazy version is aperiodic and it converges. Moreover the rest must be", y: 620, para: true },
	];
	const units = segmentPage(layout(page), VIEW).sentence;
	const displays = units.filter((u) => u.kind === "display");

	assert.strictEqual(displays.length, 1, "the row is one formula, not several");
	assert.strictEqual(displays[0].rects.length, 1, "and it is highlighted as one area");
	// The area covers both equations and reaches down over the limit...
	const [x1, y1, x2, y2] = displays[0].rects[0];
	assert.ok(x1 <= 90 && x2 >= 460, "the area spans both equations");
	assert.ok(y2 - y1 > 15, "the area reaches down over the limit under the sum");
	// ...and stops short of the equation number.
	assert.ok(x2 < 540, "the area stops before the equation number");
	assert.ok(!units.some((u) => u.text.includes("(3)")), "the equation number is dropped");

	// The paragraph below keeps to itself.
	assert.deepStrictEqual(units.filter((u) => u.kind === "text").map((u) => u.text), [
		"respect to the uniform distribution, its transition matrix is",
		"its lazy version is aperiodic and it converges.",
		"Moreover the rest must be",
	]);
}

// A parenthesised label is only an equation number when something shares its
// row; a short line that happens to look like one is left alone.
{
	const units = texts([
		{ text: "The three cases are these.", y: 700, para: true },
		{ text: "(a) the first one holds here.", y: 683, para: true },
	]);
	assert.ok(units.some((u) => u.includes("(a)")), "a list label is not an equation number");
}



// An equation number is a label whatever the display setting says, so folding
// equations into their sentence must not drag "(3)" in with them.
{
	const page = [
		{ text: "We therefore obtain", y: 700 },
		{ text: "«E»[«X»] «=» 0,", x: 200, y: 683 },
		{ text: "(3)", x: 540, y: 683, para: true },
		{ text: "which finishes the argument.", y: 660, para: true },
		{ text: "A further remark closes the section.", y: 643, para: true },
		{ text: "And one more line of prose here.", y: 626, para: true },
	];
	for (const mergeDisplay of [false, true]) {
		const units = segmentPage(layout(page), VIEW, { mergeDisplay }).sentence;
		assert.ok(!units.some((u) => u.text.includes("(3)")),
			`mergeDisplay:${mergeDisplay} must still drop the equation number`);
	}
}



// --- maths that is not Computer Modern --------------------------------------

// Plenty of journals set their maths in a Times or Palatino family, where the
// italic letters of a formula come back in a font whose name says nothing
// about maths at all. Detection cannot rest on the font name: a variable is a
// single letter standing between non-letters, and prose italicises whole
// words, which is true whatever the glyphs claim to be.
{
	const TIMES_MATH = "ABCDEF+NimbusRomNo9L-ReguItal";
	const page = [
		{ text: "respect to the uniform distribution, its transition matrix is", y: 700, para: true },
		{ text: "«P»(«X»,«Y») «=» min{«q»(«X»,«Y»),«q»(«Y»,«X»)}", x: 90, y: 665, mathFont: TIMES_MATH },
		{ text: "(«X» «≠» «Y»),", x: 250, y: 665, mathFont: TIMES_MATH },
		{ text: "«P»(«X»,«X») «=» 1 «−» «Σ»", x: 330, y: 665, mathFont: TIMES_MATH },
		{ text: "«Z»«≠»«X»", x: 400, y: 652, size: 7, mathFont: TIMES_MATH },
		{ text: "«P»(«X»,«Z»),", x: 430, y: 665, mathFont: TIMES_MATH },
		{ text: "(3)", x: 540, y: 665, para: true },
		{ text: "its lazy version is aperiodic and it converges. Moreover the rest must be", y: 620, para: true },
	];
	const units = segmentPage(layout(page), VIEW).sentence;
	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1, "the row is one formula even in a Times maths font");
	assert.strictEqual(displays[0].rects.length, 1, "and one area");
	assert.ok(!units.some((u) => u.text.includes("(3)")), "the equation number is dropped");
	assert.deepStrictEqual(units.filter((u) => u.kind === "text").map((u) => u.text), [
		"respect to the uniform distribution, its transition matrix is",
		"its lazy version is aperiodic and it converges.",
		"Moreover the rest must be",
	]);
}



// The diagnostics dump has to carry the things every wrong call so far turned
// on: what a line was taken for, the numbers behind that, and the font names.
{
	const report = describePage(layout([
		{ text: "respect to the uniform distribution, its matrix is", y: 700, para: true },
		{ text: "«P»(«X»,«Y») «=» min{«q»(«X»,«Y»)}", x: 220, y: 665, mathFont: "ABC+NimbusRomNo9L-ReguItal" },
	]), VIEW);
	assert.match(report, /columns /);
	assert.match(report, /display\s+x \d+\.\.\d+/, "the report says what each line was taken for");
	assert.match(report, /NimbusRomNo9L-ReguItal\(\d+\)/, "and which fonts it saw");
	assert.match(report, /math 0\.\d\d var 0\.\d\d/, "and the numbers behind the call");
}



// --- folding equations into their sentence ----------------------------------

// Rebuilt from a real page's diagnostics, paragraph breaks included: the
// layout puts one after the prose that introduces the formula, one after the
// formula, one after the limit beneath it and one after the tail. With
// equations folded in, none of those may cut the sentence running through it —
// suspending only the paragraph break was not enough, because a formula is
// also set off with enough blank space to trigger the gap break.
{
	const CM = "UVFEFX+CMMI10";
	const page = [
		{ text: "respect to the uniform distribution on «Ω»n, its transition matrix is", x: 82, y: 194, para: true },
		{ text: "«P» («X», «Y» ) «=» min{«q»(«X», «Y» )} («X» «6=» «Y» ), «P» («X», «X») «=» 1 «−» «Σ»", x: 116, y: 176, mathFont: CM, para: true },
		{ text: "«Z» «6=»«X»", x: 432, y: 160, size: 8, mathFont: CM, para: true },
		{ text: "«P» («X», «Z»),         (3)", x: 454, y: 174, mathFont: CM, para: true },
		{ text: "its lazy version is aperiodic and it converges to Unif here.", x: 82, y: 144, para: true },
		{ text: "Moreover the proposal probabilities must be computed as sums over local occurrences.", x: 82, y: 117, para: true },
	];

	// Off: the formula is its own stop, highlighted as one area.
	const apart = segmentPage(layout(page), VIEW, { mergeDisplay: false }).sentence;
	const formula = apart.filter((u) => u.kind === "display");
	assert.strictEqual(formula.length, 1, "the row is one formula");
	assert.strictEqual(formula[0].rects.length, 1, "highlighted as one area");
	assert.strictEqual(apart.length, 4, "prose before, formula, prose after, last line");

	// On: one sentence, running straight through the formula.
	const merged = segmentPage(layout(page), VIEW, { mergeDisplay: true }).sentence;
	assert.ok(!merged.some((u) => u.kind === "display"), "nothing is set apart when folding in");
	assert.strictEqual(merged.length, 2, "the sentence through the formula, then the next one");
	assert.match(merged[0].text, /^respect to the uniform distribution/);
	assert.match(merged[0].text, /P \(X, X\) = 1 − Σ/, "the formula is inside the sentence");
	assert.match(merged[0].text, /its lazy version is aperiodic and it converges to Unif here\.$/,
		"and the sentence carries on past it to its full stop");

	// Either way the equation number is a label, not text.
	for (const units of [apart, merged]) {
		assert.ok(!units.some((u) => u.text.includes("(3)")), "the equation number is dropped");
	}
}

// A gap only a few points wide is still an equation number when it sits at the
// column's right margin — which is the only thing separating "(3)" from an
// ordinary parenthesis, since the gap alone can be as small as a word space.
{
	const units = texts([
		{ text: "The bound follows from this (see below) and nothing else.", y: 700, para: true },
		{ text: "The next line of prose continues here for a while longer.", y: 683, para: true },
		{ text: "And a third line of prose to establish the margin.", y: 666, para: true },
	]);
	assert.ok(units.some((u) => u.includes("(see below)")),
		"a parenthesis inside a line is not an equation number");
}



// --- breathing room ---------------------------------------------------------

// Padding is measured in line heights, so it grows with the type rather than
// the page, and a displayed formula gets more of it sideways than prose does.
{
	const box = [{ x: 10, y: 10, w: 20, h: 2 }];
	assert.deepStrictEqual(padBoxes(box, 2, false, 0), box, "no padding leaves the box alone");

	const prose = padBoxes(box, 2, false, 1)[0];
	const formula = padBoxes(box, 2, true, 1)[0];
	assert.ok(formula.x < prose.x && formula.w > prose.w, "a formula gets more room sideways");
	assert.ok(prose.w > box[0].w && prose.h > box[0].h, "prose gets some room in both directions");
	// Symmetric, and proportional to the line height it was given.
	assert.ok(Math.abs((prose.x + prose.w / 2) - (box[0].x + box[0].w / 2)) < 1e-9, "padding is symmetric");
	const bigger = padBoxes(box, 4, false, 1)[0];
	assert.ok(Math.abs((box[0].x - bigger.x) - 2 * (box[0].x - prose.x)) < 1e-9,
		"twice the line height is twice the room");
	// And the slider scales it.
	const doubled = padBoxes(box, 2, false, 2)[0];
	assert.ok(Math.abs((box[0].x - doubled.x) - 2 * (box[0].x - prose.x)) < 1e-9, "the setting scales it");
}

// A unit carries the line height padding is measured against — for a formula
// that is one row, not the height of the whole area it spans.
{
	const all = segmentPage(layout([
		{ text: "Expanding the sum we find" },
		{ text: "«S_n = Σ a_k x_k»", x: 200 },
		{ text: "«    = Σ b_k y_k,»", x: 200, para: true },
		{ text: "where the coefficients are given below.", para: true },
	]), VIEW);
	const eq = all.sentence.find((u) => u.kind === "display");
	const areaHeight = eq.rects[0][3] - eq.rects[0][1];
	assert.ok(eq.em > 0 && eq.em < areaHeight * 0.75,
		"the line height is one row, well under the height of the two-row area");
}



// --- a summation with limits above and below --------------------------------

// The pieces of a display row do not arrive in reading order: a summation sign
// is followed by its upper limit, set high above the line, and then its lower
// limit, set well below it. Judging each piece against the one before it puts a
// gulf between the upper limit and the lower one and cuts the formula in two.
{
	const CM = "UVFEFX+CMMI10";
	const units = segmentPage(layout([
		{ text: "by", x: 82, y: 700, para: true },
		{ text: "«π»(«X») «:=» exp(«−β» «p»(«X»)),    «p»(«X») «:=» «Σ»", x: 150, y: 665, mathFont: CM },
		{ text: "«n»", x: 300, y: 680, size: 7, mathFont: CM },       // upper limit
		{ text: "«i»«=»1", x: 297, y: 650, size: 7, mathFont: CM },   // lower limit
		{ text: "«λ»(«X»)«k» «=» tr(«A»),", x: 316, y: 665, mathFont: CM, para: true },
		{ text: "the potential being the Newton polynomial of degree k here.", x: 82, y: 630, para: true },
	]), VIEW).sentence;
	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1, "the summation does not split the formula");
	assert.strictEqual(displays[0].rects.length, 1, "and it is one area");
	assert.ok(displays[0].rects[0][2] > 330, "the area reaches past the summation");
}

// --- a raised piece must not step out of its line ---------------------------

// An exponent comes back as its own piece with its own vertical extent. Left
// that way it draws a box higher than the rest of the line, putting a step in
// the middle of an otherwise flat highlight.
{
	const unit = segmentPage(layout([
		{ para: true, pieces: [
			{ text: "and the chains coincide with e‖" },
			{ text: "−16bN", dy: 4 },          // the exponent, its own fragment
			{ text: "‖ is the Gibbs measure here." },
		] },
	]), VIEW).sentence[0];
	const bands = new Set(unit.rects.map((r) => `${r[1].toFixed(2)}..${r[3].toFixed(2)}`));
	assert.strictEqual(bands.size, 1, `one line is one band, got ${[...bands].join(" / ")}`);
}

// --- a list item with a hanging indent ---------------------------------------

// Layout analysis breaks a paragraph where the next line is indented, which is
// every hanging-indent list item. The continuation carries on mid-expression —
// "hence c5(X) =" / "12 and ..." — so requiring a lower-case word to rejoin
// leaves the tail of the clause behind.
{
	const CM = "UVFEFX+CMMI10";
	const units = texts([
		{ text: "(i) every 5-cycle bounds a pentagonal face; hence «c»(«X») «=»", x: 60, y: 700, para: true, mathFont: CM },
		{ text: "12 and «c»(«X») «=» «n»/2 «−» 10;", x: 80, y: 683, para: true, mathFont: CM },
		{ text: "(ii) «X» has no 7-cycles: «c»(«X») «=» 0;", x: 60, y: 660, para: true, mathFont: CM },
	]);
	assert.ok(units[0].includes("12 and"), `the clause carries on: got ${JSON.stringify(units[0])}`);
	// ...but the next item is its own thing.
	assert.ok(!units[0].includes("(ii)"), "the next list item does not join it");
}



// --- a double sum with nested fractions -------------------------------------

// The hardest shape a display takes: two summation signs with limits stacked
// beneath them, each multiplying a fraction whose numerator and denominator sit
// above and below its bar, and an equation number out at the margin. Thirteen
// pieces, none of them in reading order.
{
	const CM = "UVFEFX+CMMI10";
	const page = [
		{ text: "can(«e»(«Y»)). The resulting kernel on «Ω»~n~ is", x: 82, y: 700, para: true },
		{ text: "«q»(«X», «X»′) «=»", x: 150, y: 650, mathFont: CM },
		{ text: "«Σ»", x: 250, y: 650, size: 16, mathFont: CM },          // sign, set large
		{ text: "«r»«∈»«R»(«X»)", x: 238, y: 628, size: 7, mathFont: CM },  // its limit, below
		{ text: "1", x: 322, y: 662, size: 9 },                            // numerator, above
		{ text: "|«R»(«X»)|", x: 310, y: 638, size: 9, mathFont: CM },
		{ text: "«Σ»", x: 368, y: 650, size: 16, mathFont: CM },
		{ text: "«e»«∈»«E»~n~(«r»(«X»))", x: 352, y: 628, size: 7, mathFont: CM },
		{ text: "«e»(«r»(«X»))«≅»«X»′", x: 358, y: 618, size: 7, mathFont: CM },
		{ text: "1", x: 452, y: 662, size: 9 },
		{ text: "|«E»~n~(«r»(«X»))|", x: 430, y: 638, size: 9, mathFont: CM },
		{ text: "(15)", x: 540, y: 650, para: true },
		{ text: "for «X»′ «6=» «X», with the right-hand side interpreted as zero here.", x: 82, y: 590, para: true },
	];
	const units = segmentPage(layout(page), VIEW).sentence;
	const displays = units.filter((u) => u.kind === "display");

	assert.strictEqual(displays.length, 1, "the whole double sum is one formula");
	assert.strictEqual(displays[0].rects.length, 1, "and one area");
	const [x1, y1, x2, y2] = displays[0].rects[0];
	assert.ok(x1 <= 150 && x2 >= 470, "the area spans from the q to the last denominator");
	assert.ok(y1 <= 620 && y2 >= 665, "and from the lowest limit to the highest numerator");
	assert.ok(x2 < 540, "stopping short of the equation number");
	assert.ok(!units.some((u) => u.text.includes("(15)")), "which is dropped");

	// The prose around it is untouched.
	assert.deepStrictEqual(units.filter((u) => u.kind === "text").map((u) => u.text.slice(0, 20)), [
		"can(e(Y)).",
		"The resulting kernel",
		"for X′ 6= X, with th",
	]);
}

// A subscript is an index, not a letter of a word: reading `E_n` as a two-letter
// run is what made a fraction like 1/|E_n(r(X))| score as prose.
{
	const withIndex = segmentPage(layout([
		{ text: "|«E»~n~(«r»(«X»))|", x: 300, y: 650, size: 9, mathFont: "UVFEFX+CMMI10", para: true },
		{ text: "and a line of ordinary prose to set the column margins here.", x: 82, y: 700, para: true },
		{ text: "and a second line of ordinary prose for the same purpose.", x: 82, y: 620, para: true },
	]), VIEW).sentence;
	assert.ok(withIndex.some((u) => u.kind === "display"), "an indexed variable reads as a formula");
}



// The harness's markers toggle. An unclosed "^" turns superscript on for the
// rest of the line and quietly makes every word after it a script, which looks
// exactly like a real misclassification — so the fixtures police themselves.
{
	const src = require("fs").readFileSync(__filename, "utf8");
	for (const m of src.matchAll(/text:\s*"([^"]*)"/g)) {
		const t = m.group === undefined ? m[1] : m[1];
		const line = src.slice(0, m.index).split("\n").length;
		assert.strictEqual(t.split("^").length % 2, 1, `line ${line}: unbalanced ^ in ${t.slice(0, 50)}`);
		assert.strictEqual(t.split("~").length % 2, 1, `line ${line}: unbalanced ~ in ${t.slice(0, 50)}`);
		assert.strictEqual(t.split("«").length, t.split("»").length, `line ${line}: unbalanced «» in ${t.slice(0, 50)}`);
	}
}



// --- one list item running into the next ------------------------------------

// An item that ends on a semicolon runs straight into the item after it: the
// layout sees no indent between them so it marks no paragraph break, and a
// semicolon is not a full stop, so nothing else separates them either.
{
	const CM = "UVFEFX+CMMI10";
	const units = texts([
		{ text: "(2) if «M»(«X») «=» ∅, stay at «X»; otherwise sample and set «X»′ «=»", x: 40, y: 700, para: true, mathFont: CM },
		{ text: "can(«A»(«X»,«α»));", x: 68, y: 686, para: true, mathFont: CM },
		{ text: "(3) accept «X»′ with probability min{1, «w»/«w»}, where", x: 40, y: 670, para: true, mathFont: CM },
		{ text: "«q»(«X», «X»′) «=» |{(«A»,«α») «∈» «M»(«X»)}|", x: 150, y: 640, para: true, mathFont: CM },
		{ text: "(18)", x: 540, y: 640, para: true },
		{ text: "otherwise stay at «X»;", x: 68, y: 610, para: true },
		{ text: "(4) record the state if and only if |«V»(«X»)| «=» «n» and «X» «∈» «Ω»~n~.", x: 40, y: 596, para: true, mathFont: CM },
	]);
	assert.ok(units.some((u) => u === "otherwise stay at X;"),
		`the tail of an item stands alone: got ${JSON.stringify(units)}`);
	assert.ok(units.some((u) => u.startsWith("(4) record")), "and the next item starts its own");
	assert.ok(!units.some((u) => u.includes("X; (4)")), "they are not run together");
	// The clause broken across the hanging indent still rejoins.
	assert.ok(units.some((u) => u.includes("set X′ = can(A(X,α));")),
		"a clause cut by a hanging indent is put back together");
}

assert.ok(LIST_LABEL_RE.test("(4) record the state"), "a bracketed number is a label");
assert.ok(LIST_LABEL_RE.test("3. Gibbs measures with"), "so is a numbered heading");
assert.ok(LIST_LABEL_RE.test("(iii) every 8-cycle is"), "and a roman numeral");
assert.ok(!LIST_LABEL_RE.test("1.2. State of the art."), "a dotted section number is not");
assert.ok(!LIST_LABEL_RE.test("(0, ∞). The target is"), "nor is an interval");
assert.ok(!LIST_LABEL_RE.test("(A, α) ∈ M(X) : A(X"), "nor a pair");
assert.ok(!LIST_LABEL_RE.test("for X′ 6= X, with the"), "nor ordinary prose");



// --- a line that merely begins with a bracketed number ----------------------

// "(16) equals 1 for every closed path" opens a line but is a cross-reference,
// not a list label. What separates the two is the line before: an item ends on
// a full stop or a semicolon, a sentence carried over ends mid-clause.
{
	const CM = "UVFEFX+CMMI10";
	const units = texts([
		{ text: "Consequently «P» is reversible on each class if and only if the right-hand side of", x: 40, y: 700, mathFont: CM },
		{ text: "(16) equals 1 for every closed path in that class, and in that case it satisfies.", x: 40, y: 686, para: true, mathFont: CM },
	]);
	assert.strictEqual(units.length, 1, `one sentence, got ${JSON.stringify(units)}`);
	assert.ok(units[0].includes("(16) equals 1"), "the cross-reference stays in the sentence");
}

// --- a lead-in ending in a colon, then the list -----------------------------

// A colon leaves the clause open, so the lead-in is rejoined to whatever
// follows — but not to a list item, which is its own thing.
{
	const CM = "UVFEFX+CMMI10";
	const units = texts([
		{ text: "The target is «π»~w~(«X»). From the current state «X»:", x: 40, y: 700, para: true, mathFont: CM },
		{ text: "(1) enumerate the set «M»(«X») of all pairs («A», «α») with «A» «∈» «A», «α» in «X», and", x: 68, y: 686, para: true, mathFont: CM },
		{ text: "«A»(«X», «α») «∈» «S»;", x: 88, y: 672, para: true, mathFont: CM },
	]);
	assert.ok(units.some((u) => u === "From the current state X:"),
		`the lead-in stands alone: got ${JSON.stringify(units)}`);
	// ...and the item keeps its own continuation, set in under the label.
	assert.ok(units.some((u) => u.startsWith("(1) enumerate") && u.includes("A(X, α) ∈ S;")),
		"the item keeps the line indented under it");
}

// --- a running head beside a page number ------------------------------------

// A page number and the running head share a row, so each vouches for the
// other being body text when isolation is measured against the nearest line.
{
	const units = texts([
		{ text: "10", x: 82, y: 740 },
		{ text: "P. IEVLEV AND E. SPODAREV", x: 300, y: 740, size: 8 },
		{ text: "polytopes in the class of simple polytopes all of whose facets are pentagons.", x: 82, y: 700, para: true },
		{ text: "And a second line of body text to establish the page.", x: 82, y: 686, para: true },
		{ text: "And a third line of body text for the same purpose.", x: 82, y: 672, para: true },
	]);
	assert.ok(!units.some((u) => u.includes("IEVLEV")), `the running head is dropped: got ${JSON.stringify(units)}`);
	assert.ok(!units.some((u) => u.includes("10")), "and so is the page number");
	assert.ok(units[0].startsWith("polytopes in the class"), "the body starts the page");
}



// --- a table ----------------------------------------------------------------

// Every cell of a row is its own piece, spread right across the measure. Read
// a cell at a time the row says nothing, so the row is one line.
{
	const CM = "UVFEFX+CMMI10";
	const row = (y, cells) => cells.map(([text, x]) => ({ text, x, y, para: true, mathFont: CM }));
	const units = texts([
		{ text: "The three chains are compared in the table below, which follows here.", x: 82, y: 740, para: true },
		{ text: "Each row gives the state space, the moves and the cost of one chain.", x: 82, y: 726, para: true },
		...row(700, [["state space", 200], ["moves", 330], ["irreducible?", 400], ["cost/step", 500]]),
		...row(680, [["Alg. 1 (Section 3)", 60], ["«Ω»~n~", 200], ["«A»~j~«A»~i~", 330], ["hypothesis", 400], ["«O»(«n»~2~) tests", 500]]),
		...row(660, [["Alg. 3 (Algorithm 4.4)", 60], ["«⊔»~m~(«Ω»~m~)", 200], ["«A»~i~", 330], ["theorem", 400], ["«O»(«n») tests", 500]]),
		{ text: "TABLE 2. The three chains. All three are reversible with the correct law.", x: 82, y: 620, para: true },
		{ text: "They differ in whether irreducibility is assumed or proved in each case.", x: 82, y: 606, para: true },
		{ text: "A further line of prose closes the page below the table here.", x: 82, y: 592, para: true },
	]);

	// The row is one band, not a box per cell with the column gaps cut out.
	const rowUnits = segmentPage(layout([
		{ text: "The three chains are compared in the table below, which follows here.", x: 82, y: 740, para: true },
		{ text: "Each row gives the state space, the moves and the cost of one chain.", x: 82, y: 726, para: true },
		...row(700, [["state space", 200], ["moves", 330], ["irreducible?", 400], ["cost/step", 500]]),
		...row(680, [["Alg. 1 (Section 3)", 60], ["«Ω»~n~", 200], ["«A»~j~«A»~i~", 330], ["hypothesis", 400], ["«O»(«n»~2~) tests", 500]]),
		...row(660, [["Alg. 3 (Algorithm 4.4)", 60], ["«⊔»~m~(«Ω»~m~)", 200], ["«A»~i~", 330], ["theorem", 400], ["«O»(«n») tests", 500]]),
		{ text: "TABLE 2. The three chains. All three are reversible with the correct law.", x: 82, y: 620, para: true },
		{ text: "They differ in whether irreducibility is assumed or proved in each case.", x: 82, y: 606, para: true },
		{ text: "A further line of prose closes the page below the table here.", x: 82, y: 592, para: true },
	]), VIEW).sentence;
	const alg3Unit = rowUnits.find((u) => u.text.includes("Alg. 3"));
	assert.strictEqual(alg3Unit.rects.length, 1, "the row is one band, not a box per cell");
	assert.ok(alg3Unit.rects[0][0] <= 61 && alg3Unit.rects[0][2] >= 530,
		"and the band runs the width of the row");
	// A cell is still a line of its own, for stepping through one at a time.
	const cells = segmentPage(layout([
		...row(700, [["state space", 200], ["moves", 330], ["irreducible?", 400], ["cost/step", 500]]),
		...row(680, [["Alg. 1 (Section 3)", 60], ["«Ω»~n~", 200], ["«A»~j~«A»~i~", 330], ["hypothesis", 400], ["«O»(«n»~2~) tests", 500]]),
		...row(660, [["Alg. 3 (Algorithm 4.4)", 60], ["«⊔»~m~(«Ω»~m~)", 200], ["«A»~i~", 330], ["theorem", 400], ["«O»(«n») tests", 500]]),
		{ text: "TABLE 2. The three chains are reversible with the correct law here.", x: 82, y: 620, para: true },
	]), VIEW).line;
	assert.ok(cells.some((u) => u.text === "theorem"), "a cell is a line at line size");

	const alg3 = units.find((u) => u.includes("Alg. 3"));
	assert.ok(alg3, `the row is a unit: got ${JSON.stringify(units)}`);
	assert.ok(alg3.includes("theorem") && alg3.includes("tests"),
		`the whole row is one line: got ${JSON.stringify(alg3)}`);
	assert.ok(!alg3.includes("Alg. 1"), "and stops at the row above it");
	assert.ok(units.some((u) => u.includes("Alg. 1") && u.includes("hypothesis")), "as does the row above");
	// The caption underneath is prose and splits into sentences as prose does.
	assert.ok(units.some((u) => u === "TABLE 2."), "the caption is read as prose");
}

// A row of maths is laid out like a table row but is not one: its pieces carry
// no words, so it stays a formula.
{
	const CM = "UVFEFX+CMMI10";
	const units = segmentPage(layout([
		{ text: "respect to the uniform distribution, its transition matrix is", x: 82, y: 700, para: true },
		{ text: "«P»(«X»,«Y») «=» min{«q»(«X»,«Y»)}", x: 116, y: 665, mathFont: CM },
		{ text: "(«X» «≠» «Y»),", x: 250, y: 665, mathFont: CM },
		{ text: "«P»(«X»,«X») «=» 1 «−» «Σ»", x: 330, y: 665, mathFont: CM },
		{ text: "«P»(«X»,«Z»),", x: 430, y: 665, mathFont: CM, para: true },
		{ text: "its lazy version is aperiodic and it converges here.", x: 82, y: 620, para: true },
	]), VIEW).sentence;
	assert.strictEqual(units.filter((u) => u.kind === "display").length, 1,
		"a row of formula pieces is still one formula");
}



// --- a displayed formula under a list item ----------------------------------

// A list item's own continuation and a displayed formula that follows the item
// are both set in from the label and both read as formulas. The indent cannot
// separate them — a formula's is no different from a deep hanging indent — but
// the space above can: a continuation is the next line at ordinary leading, a
// display is set off from the text.
{
	const CM = "UVFEFX+CMMI10";
	const units = segmentPage(layout([
		{ text: "Some ordinary prose to set the leading on this page for the test.", x: 40, y: 740, para: true },
		{ text: "A second line of prose, immediately below the first one here.", x: 40, y: 726, para: true },
		{ text: "(3) accept «X»′ with probability min{1, «w»(|«V»|)«q»/«w»(|«V»|)«q»}, where", x: 40, y: 712, para: true, mathFont: CM },
		// Set off below, with its pieces above and below the rule.
		{ text: "«q»(«X», «X»′) «=»", x: 150, y: 670, mathFont: CM },
		{ text: "|{(«A», «α») «∈» «M»(«X») : «A»(«X», «α») «≅» «X»′}|", x: 230, y: 682, mathFont: CM },
		{ text: "|«M»(«X»)|", x: 280, y: 658, mathFont: CM },
		{ text: "(18)", x: 540, y: 670, para: true },
		{ text: "otherwise stay at «X»;", x: 68, y: 620, para: true, mathFont: CM },
		{ text: "(4) record the state if and only if |«V»(«X»)| «=» «n».", x: 40, y: 606, para: true, mathFont: CM },
	]), VIEW).sentence;

	const item3 = units.find((u) => u.text.startsWith("(3) accept"));
	assert.ok(item3, `the item is a unit: got ${JSON.stringify(units.map((u) => u.text.slice(0, 30)))}`);
	assert.ok(item3.text.endsWith("where"), `the item ends at "where": got ${JSON.stringify(item3.text)}`);
	assert.strictEqual(item3.kind, "text", "and is prose, not a formula");

	const display = units.find((u) => u.kind === "display");
	assert.ok(display, "the formula under it stands on its own");
	assert.strictEqual(display.rects.length, 1, "and is highlighted as one area");
	assert.ok(units.some((u) => u.text === "otherwise stay at X;"), "the tail of the item is its own unit");
	assert.ok(units.some((u) => u.text.startsWith("(4) record")), "and so is the next item");
	assert.ok(!units.some((u) => u.text.includes("(18)")), "the equation number is dropped");
}



// --- what the plugin holds on to --------------------------------------------

// Pages are capped per document, but a reading session opens many documents,
// and without a cap on those the analysis of every one is held for as long as
// Zotero runs — a few megabytes each.
{
	const { cacheFor, pageCache, CACHE_DOCS } = require("./bootstrap.js");
	pageCache.clear();
	for (let i = 1; i <= CACHE_DOCS + 3; i++) cacheFor({ itemID: i }).set("0:sentence", []);
	assert.strictEqual(pageCache.size, CACHE_DOCS, "only a few documents are kept");

	// Least-recently-used, not first-in: the document being read must not be
	// the one dropped just because it was opened first.
	const oldest = [...pageCache.keys()][0];
	cacheFor({ itemID: oldest });                       // touch it
	cacheFor({ itemID: 999 }).set("0:sentence", []);    // force an eviction
	assert.ok(pageCache.has(oldest), "a document used again is not the one dropped");
	assert.strictEqual(pageCache.size, CACHE_DOCS, "and the cap still holds");

	// A reader with no item id gets a scratch map rather than sharing one key.
	const loose = cacheFor({});
	assert.strictEqual(loose.size, 0);
	assert.ok(!pageCache.has(undefined), "and it is not kept at all");
	pageCache.clear();
}

console.log("all tests passed");
