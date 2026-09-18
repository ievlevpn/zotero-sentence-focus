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
//   { rot: 90 }  the line runs down the page, as an arXiv stamp does
//   pieces: [{ hang: true }]  glyphs from an extension font (big braces,
//          operators), whose boxes cover only the top of their ink
//   pieces: [{ raw: true }]  text taken literally, markup characters and all
//   pieces: [{ font }]  the font this piece's glyphs claim to be in

const assert = require("assert");
const {
	segmentPage, splitSentences, prevToken, mergeTiny, solidColor, charsToLines, mergeBoxes,
	materialize, toPercent, toUserBox, pageAspect, wordRanges, lineRanges,
	GRANULARITIES, STYLES, CSS, describePage, padBoxes, LIST_LABEL_RE,
	countRead, eraseCount, showCount,
	blockText, collectBlocks, blockUnits,
	ANNOTATE_KEYS, ANNOTATION_COLORS, ANNOTATION_TYPES, annotateKeyPressed, keyLabel, placeAnnotate,
	copyKeyPressed, CLICK_MODES, JUMP_KEYS, jumpKeyPressed, TOGGLE_KEYS, toggleKeyPressed,
	sessions, spotKey, readSpots, writeSpots, saveSpot, spotFor, bestUnit, SPOT_LIMIT, SPOT_BYTES,
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
		let math = !!ln.math, sup = false, sub = false, group = null, dy = 0, pieceSize = null, hang = false, pieceFont = null;
		// { rot: 90 } sets the line down the page instead of across it, which
		// is how an arXiv stamp is printed in the margin.
		const vertical = ln.rot === 90;
		let pen = y;

		// Zotero hands back a ligature as ONE glyph whose `c` is several
		// characters ("ffi"), covered by a single rect.
		const emit = (text) => {
			const sz = pieceSize || ((sup || sub) ? size * 0.6 : size);
			const w = sz * 0.5 * (text.length > 1 ? text.length * 0.7 : 1);
			const off = (sup ? 0.35 * size : sub ? -0.2 * size : 0) + dy;
			if (vertical) {
				chars.push({
					c: text,
					rect: [x, pen - w, x + sz * 0.9, pen],
					fontSize: sz, fontName: math ? (ln.mathFont || MATH_FONT) : TEXT_FONT,
					bold: !!ln.bold, italic: math, baseline: pen, rotation: 90,
					spaceAfter: false, lineBreakAfter: false, paragraphBreakAfter: false, ignorable: false,
				});
				pen -= w;
				return;
			}
			chars.push({
				c: text,
				// A glyph from a TeX extension font: Zotero's box runs from a
				// quarter em below its baseline to its declared cap height of
				// next to nothing, while the ink hangs far below.
				rect: hang ? [x, y - 0.25 * sz + off, x + w, y + 0.04 * sz + off]
					: [x, y - 0.2 * sz + off, x + w, y + 0.7 * sz + off],
				fontSize: sz,
				fontName: pieceFont || (math ? (ln.mathFont || MATH_FONT) : TEXT_FONT),
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
		pieceSize = piece.size || null;
		hang = !!piece.hang;
		pieceFont = piece.font || null;
		for (const c of piece.text) {
			if (piece.raw) { emit(c); continue; }   // no markup: a literal brace
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
	assert.strictEqual(eq.rects.length, 1, "a formula is one band");
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
assert.deepStrictEqual(texts([{ text: "This is due to Riesz^3^ and was later extended.", para: true }]),
	["This is due to Riesz  and was later extended."]);
assert.deepStrictEqual(texts([{ text: "This is shown in (see the survey)^4^ and extended.", para: true }]),
	["This is shown in (see the survey)  and extended."]);

// An exponent is small and raised as well, and its digits come from the roman
// text font — but it is attached to a variable, or sits in a script with one.
// Masked as a marker it vanished from the text and put a hole in the highlight.
{
	const CM = "JMEJAK+NewPXMI";
	for (const [line, expected] of [
		["Consider «U»^«k»+1^ «=» «U»^«k»^ «−» «ωS»(«U»^«k»^). Every step is fine.", "Consider Uk+1 = Uk − ωS(Uk)."],
		["For «a»/«h»^2^ «+» «c» with «c» ≥ 0, compute it. Next.", "For a/h2 + c with c ≥ 0, compute it."],
		["Here x^2^ is the square of the variable. Next.", "Here x2 is the square of the variable."],
		["Take («a» «+» «b»)^2^ as the bound. Next.", "Take (a + b)2 as the bound."],
	]) {
		const units = segmentPage(layout([{ text: line, size: 10.9, mathFont: CM, para: true }]), VIEW).sentence;
		assert.strictEqual(units[0].text, expected);
		assert.strictEqual(units[0].rects.length, 1, `no hole in the highlight of ${JSON.stringify(expected)}`);
	}
	// ...and a real marker in mid-sentence is left out of the text, not the line.
	const units = segmentPage(layout([{ text: "This is due to Riesz^3^ and was later extended.", para: true }]), VIEW).sentence;
	assert.strictEqual(units[0].rects.length, 1, "stepping over a footnote marker leaves no hole");
}

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
	assert.ok(x1 <= 200 && x2 >= 262, "the band covers the whole formula");

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
	assert.ok(x1 <= 90 && x2 >= 460, "the band spans both equations");
	assert.ok(y2 - y1 > 15, "the area reaches down over the limit under the sum");
	// The band is the width of the text, so it runs past where the equation
	// number sits — but the number is no part of what is read.
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
	// The band is the width of the text, not the outline of the formula.
	assert.ok(x1 <= 105 && x2 >= 520, "the band runs the measure");
	assert.ok(y1 <= 620 && y2 >= 665, "and from the lowest limit to the highest numerator");
	assert.ok(!units.some((u) => u.text.includes("(15)")), "the equation number is still dropped");

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



// --- a table whose row arrives as one line ----------------------------------

// A row's cells need not arrive as separate pieces: where the layout sees one
// baseline it gives one line, cells and all. The wide gaps between columns are
// then internal to the line, and splitting boxes at them cuts the row up.
// Several of those gaps on one line is what a table looks like; one of them is
// the run up to an equation number.
{
	const units = segmentPage(layout([
		{ text: "The three chains are compared in the table below, which follows here.", x: 82, y: 740, para: true },
		{ text: "Each row gives the state space, the moves and the cost of one chain.", x: 82, y: 726, para: true },
		{ text: "Alg. 1 (Section 3)        On        AjAi        hypothesis        O(n2) tests", x: 105, y: 700 },
		{ text: "Alg. 2 (Algorithm 4.2)    On        AjAi        hypothesis        O(n2) tests", x: 105, y: 686 },
		{ text: "Alg. 3 (Algorithm 4.4)    Om        Ai          theorem           O(n) tests", x: 105, y: 672, para: true },
		{ text: "Table 2. The three chains, all reversible with the correct conditional law.", x: 118, y: 640, para: true },
		{ text: "They differ in whether irreducibility is assumed or proved in each case.", x: 118, y: 626, para: true },
	]), VIEW).sentence;

	const rows = units.filter((u) => u.text.startsWith("Alg."));
	assert.strictEqual(rows.length, 3, `each row is its own unit: got ${JSON.stringify(units.map((u) => u.text.slice(0, 24)))}`);
	for (const row of rows) {
		assert.strictEqual(row.rects.length, 1, `a row is one band: ${JSON.stringify(row.text.slice(0, 30))}`);
	}
	assert.ok(units.some((u) => u.text.startsWith("Table 2.")), "the caption is read as prose");
}

// --- a line above a displayed formula ---------------------------------------

// Absorbing into a formula's row goes by position, so the line above a display
// is within reach of it. A fraction's numerator is, and belongs there; the tail
// of a sentence is not. What separates them is that a formula's pieces carry no
// words at all.
{
	const CM = "UVFEFX+CMMI10";
	const units = segmentPage(layout([
		{ text: "(3) compute «q»(«X», «X»′) by (18) and «U»(«X»′) by (23), since (23) is not an identity for", x: 89, y: 660 },
		{ text: "the matrix exponential;", x: 108, y: 647, para: true },
		{ text: "(4) set «X»~t+1~ «=» «X»′ with probability min{1, «e»«−β»(«U»(«X»′)«−U»(«X»~t~))}", x: 89, y: 628, mathFont: CM, para: true },
		{ text: "(5) if «X»~t+1~ «∈» «Ω»~n~, output it.", x: 89, y: 600, para: true, mathFont: CM },
	]), VIEW).sentence;
	const item3 = units.find((u) => u.text.startsWith("(3) compute"));
	assert.ok(item3.text.endsWith("the matrix exponential;"),
		`the clause keeps its tail: got ${JSON.stringify(item3.text.slice(-40))}`);
	assert.ok(!units.some((u) => u.text.includes("exponential; (4)")), "which is not pulled into the formula below");
}



// A table of bare numbers has no words and no full stops anywhere in it, so
// nothing but the shape of the rows separates one from the next.
{
	const rows = ["20 1 30 1", "24 1 24 1", "26 1 21 1", "28 2 18–20 2", "30 3 17–20 3"];
	const page = [{ text: "Some prose above the table to set the column margins here.", x: 82, y: 740, para: true }];
	rows.forEach((r, i) => page.push({ text: r.replace(/ /g, "        "), x: 184, y: 700 - i * 15 }));
	page.push({ text: "Table 3. Exhaustive data for the order-eight potential here.", x: 118, y: 700 - rows.length * 15 - 20, para: true });

	const units = segmentPage(layout(page), VIEW).sentence;
	const numeric = units.filter((u) => /^\d/.test(u.text));
	assert.strictEqual(numeric.length, rows.length, `each row of figures is a unit: got ${numeric.length}`);
	for (const row of numeric) assert.strictEqual(row.rects.length, 1, "and one band");
	// They must not be swept into a formula either, having no words to protect them.
	assert.ok(!units.some((u) => u.kind === "display"), "a table of figures is not a formula");
}

// One wide gap is not a table: it is the run up to an equation number.
{
	const CM = "UVFEFX+CMMI10";
	const all = segmentPage(layout([
		{ text: "We therefore obtain the following bound on the quantity of interest.", x: 82, y: 700, para: true },
		{ text: "«E»[«X»] «=» 0,                                   (7)", x: 200, y: 680, mathFont: CM, para: true },
		{ text: "which finishes the argument and closes this section of the paper.", x: 82, y: 660, para: true },
		{ text: "A further line of prose to establish the column margins here.", x: 82, y: 646, para: true },
	]), VIEW).sentence;
	assert.ok(all.some((u) => u.kind === "display"), "a formula with an equation number is still a formula");
	assert.ok(!all.some((u) => u.text.includes("(7)")), "and the number is still dropped");
}



// --- a formula displayed under a numbered contribution ----------------------

// "1. Correct fixed-size chains." reads as a list item, and a formula shown
// under it sits indented at a gap the formula's own tall glyphs make look
// small — so the rule that keeps a list item's continuation would swallow it.
// Being set about the middle of the column is what a display does and what a
// continuation never does.
{
	const CM = "UVFEFX+CMMI10";
	const units = segmentPage(layout([
		{ text: "1. Correct fixed-size chains. In Section 3 we make precise the balanced move construction", x: 82, y: 284, para: true },
		{ text: "«X» «A»~i~«−−−−→» «Y» «A»~j~«−−−→» «X»′, «X», «X»′ «∈» «Ω»~n~,", x: 210, y: 262, mathFont: CM, para: true },
		{ text: "give the exact transition matrix, and prove:", x: 82, y: 240, para: true },
	]), VIEW).sentence;

	const display = units.find((u) => u.kind === "display");
	assert.ok(display, `the formula stands on its own: got ${JSON.stringify(units.map((u) => u.text.slice(0, 24)))}`);
	assert.strictEqual(display.rects.length, 1, "as one band");

	// And the band is the width of the text, not the outline of the formula:
	// it starts where the prose starts and ends where the prose ends.
	const prose = units.find((u) => u.text.startsWith("give the exact"));
	const [x1, , x2] = display.rects[0];
	assert.ok(Math.abs(x1 - prose.rects[0][0]) < 1, "the band starts at the measure");
	assert.ok(x2 > x1 + 380, "and runs its full width");
	// Narrower than the band it would have had if it traced the formula.
	assert.ok(x1 < 210, "which is wider than the formula itself");
}



// --- a formula at the foot of the page --------------------------------------

// The margin band reaches a formula set low on the page, and a formula's head
// is short and — once its limit is read as part of the same row — stands clear
// of the text above it. That is every test for page furniture except the one
// that matters: a running head is prose, and a line that is mostly algebra
// never is.
{
	const PAGE = [0, 0, 540, 720];
	const CM = "JMEJAK+NewPXMI";
	const units = segmentPage(layout([
		{ text: "For a test function on a shape-regular mesh, linear interpolation gives the bound.", x: 52, y: 140, para: true },
		{ text: "Taylor expansion of the foot, discount, and frozen cost yields, on compact sets,", x: 52, y: 92, para: true },
		// The limit under the max overlaps the line it hangs from, as on the page.
		{ text: "«S»~i~(«φ») «=» «λφ»(«x»~i~) «+» max", x: 116, y: 60, mathFont: CM },
		{ text: "«a»«∈»«A»~h~", x: 199, y: 55, size: 8, mathFont: CM },
		{ text: "{«−b»(«x»~i~, «a») «·» «Dφ»(«x»~i~)} «+» «O»(«τ»)", x: 300, y: 60, mathFont: CM, para: true },
		{ text: "BUILDING MONOTONE SCHEMES 17", x: 52, y: 31, size: 7.5, para: true },
	], PAGE), PAGE).sentence;

	assert.ok(!units.some((u) => u.text.includes("MONOTONE")), "the running head is still dropped");
	const display = units.find((u) => u.kind === "display");
	assert.ok(display, `the formula survives: got ${JSON.stringify(units.map((u) => u.text.slice(0, 30)))}`);
	assert.ok(display.text.includes("Si(φ)"), `and keeps its head: got ${JSON.stringify(display.text)}`);
}

// --- a formula built from extensible braces ---------------------------------

// The pieces of a big brace come from a font of their own and carry nothing
// printable at all. Left in place they are lines like any other, and one
// landing between the two halves of a formula cuts it in two.
{
	const CM = "JMEJAK+NewPXMI";
	const BRACE = "\uE000";      // an unmapped glyph, as an extensible brace gives
	const units = segmentPage(layout([
		{ text: "Positive interpolation may use the center node itself in the scheme.", x: 52, y: 660, para: true },
		{ text: "A second line of prose to give the page a body to measure against.", x: 52, y: 646, para: true },
		{ text: "A third line of prose, so the margins and leading are established.", x: 52, y: 632, para: true },
		{ text: "«U»~i~ «=» min", x: 178, y: 590, mathFont: CM },
		{ text: "«a»", x: 211, y: 582, size: 8, mathFont: CM },
		{ text: BRACE, x: 225, y: 560, size: 4, para: true },   // a brace piece, out of reach
		{ text: "«d»~i~ «+» «γw»~ii~«U»~i~", x: 232, y: 589, mathFont: CM, para: true },
		{ text: "Since the coefficient is positive, this is equivalent to the statement.", x: 52, y: 530, para: true },
	]), VIEW).sentence;

	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1,
		`the formula is one unit: got ${JSON.stringify(units.map((u) => u.text.slice(0, 30)))}`);
	assert.ok(displays[0].text.includes("Ui = min") && displays[0].text.includes("γwiiUi"),
		`both halves are in it: got ${JSON.stringify(displays[0].text)}`);
	assert.ok(!units.some((u) => u.text.includes(BRACE)), "and the brace piece is read as nothing");
}



// --- how tall a formula's band is -------------------------------------------

// Two ways the height went wrong, with one cause: it was taken from the
// formula's own printable glyphs. Those stop short of the braces around it,
// and reach past the line above it.
{
	const CM = "JMEJAK+NewPXMI";
	const BRACE = "";

	// Too short: the pieces of a brace carry no text, but the formula plainly
	// occupies the space they stand in.
	const withBraces = segmentPage(layout([
		{ text: "Positive interpolation may use the center node itself in this scheme.", x: 52, y: 630, para: true },
		{ text: "A second line of prose so the page has a body to measure against.", x: 52, y: 616, para: true },
		{ text: "«U»~i~ «=» min", x: 178, y: 590, mathFont: CM },
		{ text: BRACE, x: 225, y: 600, size: 11 },      // upper half of the brace
		{ text: BRACE, x: 225, y: 572, size: 11 },      // lower half
		{ text: "«d»~i~ «+» «γw»~ii~«U»~i~", x: 232, y: 589, mathFont: CM, para: true },
		{ text: "Since the coefficient is positive, this is equivalent to the statement.", x: 52, y: 545, para: true },
	]), VIEW).sentence;
	const formula = withBraces.find((u) => u.kind === "display");
	const [, low, , high] = formula.rects[0];
	assert.ok(high > 605, `the band reaches the top of the brace: got ${high.toFixed(0)}`);
	assert.ok(low < 572, `and the bottom of it: got ${low.toFixed(0)}`);

	// ...but never onto the lines around it.
	const above = withBraces.find((u) => u.text.startsWith("A second line"));
	const below = withBraces.find((u) => u.text.startsWith("Since the"));
	assert.ok(high <= above.rects[0][1], "and stops below the line above");
	assert.ok(low >= below.rects[0][3], "and above the line below");
}

// Too tall: a fraction reaches into the white space above its line, so the
// formula's box genuinely overlaps the box of the line before it. What it must
// not do is cover that line's glyphs.
{
	const CM = "JMEJAK+NewPXMI";
	const units = segmentPage(layout([
		{ text: "Approximate a short trajectory by the Euler foot rule given here.", x: 52, y: 628, para: true },
		{ text: "Define", x: 52, y: 583, para: true },
		{ text: "«γ» «=» «e»~−λτ~,     «c»~τ~ «=» 1 «−» «e»~−λτ~«λ»,", x: 204, y: 566, size: 11, mathFont: CM, para: true },
		{ text: "so that cτ is the exact discounted integral of a running cost here.", x: 52, y: 542, para: true },
		{ text: "With a finite control set and positive interpolation, set the scheme.", x: 52, y: 528, para: true },
	]), VIEW).sentence;

	const formula = units.find((u) => u.kind === "display");
	const define = units.find((u) => u.text === "Define");
	assert.ok(formula && define, "both are units");
	assert.ok(formula.rects[0][3] <= define.rects[0][1],
		`the band stops below "Define": formula top ${formula.rects[0][3].toFixed(0)}, Define bottom ${define.rects[0][1].toFixed(0)}`);
}



// A fraction's numerator stands above the line and its denominator below, so
// an equation number set level with the line falls *inside* the formula's
// extent. Read as a neighbour to stop short of, it cuts the denominator off.
{
	const CM = "JMEJAK+NewPXMI";
	const units = segmentPage(layout([
		{ text: "To verify equivalence, rewrite the minimum equation as inequalities.", x: 52, y: 560, para: true },
		{ text: "«U»~i~ «=» min", x: 205, y: 516, mathFont: CM },
		{ text: "«a»", x: 238, y: 509, size: 8, mathFont: CM },
		{ text: "«d»~i~ «+» «γ» «w»~ij~«U»~j~", x: 253, y: 526, mathFont: CM },   // numerator
		{ text: "1 «−» «γw»~ii~", x: 273, y: 506, mathFont: CM },                  // denominator
		{ text: ".        (4.7)", x: 335, y: 516, para: true },
		{ text: "The transformed local update is still monotone in its neighbours.", x: 52, y: 480, para: true },
	]), VIEW).sentence;

	const formula = units.find((u) => u.kind === "display");
	const [, low, , high] = formula.rects[0];
	assert.ok(low <= 506, `the band reaches the denominator: got ${low.toFixed(0)}`);
	assert.ok(high >= 530, `and the numerator: got ${high.toFixed(0)}`);
	assert.ok(!units.some((u) => u.text.includes("(4.7)")), "the equation number is dropped");
}

// The room left around a unit is measured against the size of its type, not
// the height of its line's band: a line carrying a fraction has a band three
// times its type size, and room measured against that swallows the line above.
{
	const CM = "JMEJAK+NewPXMI";
	const units = segmentPage(layout([
		{ text: "Approximate a short trajectory by the Euler foot rule given here.", x: 52, y: 620, para: true },
		{ text: "Define", x: 52, y: 580, para: true },
		{ pieces: [
			{ text: "«γ» «=» «e»~−λτ~,   «c»~τ~ «=»", x: 204 },
			{ text: "1 «−» «e»~−λτ~", x: 290, dy: 8 },     // numerator, above the line
			{ text: "«λ»", x: 300, dy: -8 },               // denominator, below
			{ text: ",", x: 335 },
		], y: 566, mathFont: CM, para: true },
		{ text: "so that cτ is the exact discounted integral of a running cost here.", x: 52, y: 540, para: true },
	]), VIEW).sentence;

	const formula = units.find((u) => u.kind === "display");
	const define = units.find((u) => u.text === "Define");
	assert.ok(formula.em < 14, `the em is the type size, not the band: got ${formula.em.toFixed(1)}`);
	assert.ok(formula.rects[0][3] <= define.rects[0][1],
		`the band stops below "Define": ${formula.rects[0][3].toFixed(0)} vs ${define.rects[0][1].toFixed(0)}`);
	assert.ok(formula.rects[0][3] > 570, "but still covers the numerator");
}



// --- a limit that is spelled out in words -----------------------------------

// The set an infimum is taken over can be written in English — "a(·)
// admissible from x" — and sits under the operator as a limit. Carrying words,
// it reads as prose and cuts the formula in half. What marks it as part of the
// formula is its size: a limit is set in script type, a sentence is not.
{
	const CM = "JMEJAK+NewPXMI";
	const units = segmentPage(layout([
		{ text: "exists and remains in K for all t ≥ 0. The infinite-horizon value is", x: 52, y: 348, para: true },
		{ text: "«u»(«x») «=» inf", x: 132, y: 319, mathFont: CM },
		{ text: "a(·) admissible from x", x: 166, y: 310, size: 8 },          // the limit, in words
		{ text: "«∫∞»", x: 247, y: 331, size: 11.5, mathFont: CM },
		{ text: "0", x: 254, y: 307, size: 8 },
		{ text: "«e»~−λt~«l» («y»(«t»), «a»(«t»)) «dt», «λ» «>» 0.        (8.1)", x: 270, y: 319, mathFont: CM, para: true },
		{ text: "We usually assume a compact control set and bounded continuous costs.", x: 52, y: 288, para: true },
	]), VIEW).sentence;

	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1,
		`the formula is one unit: got ${JSON.stringify(units.map((u) => u.text.slice(0, 28)))}`);
	assert.ok(displays[0].text.includes("u(x) = inf") && displays[0].text.includes("dt"),
		`from the u to the dt: got ${JSON.stringify(displays[0].text)}`);
	assert.ok(displays[0].text.includes("admissible"), "the limit is part of it");
	assert.ok(!units.some((u) => u.text.includes("(8.1)")), "the equation number is dropped");
}

// ...but a line of prose at body size is never a limit, whatever it overlaps.
{
	const CM = "JMEJAK+NewPXMI";
	const units = segmentPage(layout([
		{ text: "(3) compute «q»(«X») by (18), since (23) is not an identity for", x: 89, y: 660 },
		{ text: "the matrix exponential;", x: 108, y: 647, para: true },
		{ text: "(4) set «X»~t+1~ «=» «X»′ with probability min{1, «e»«−β»(«U»(«X»′))}", x: 89, y: 628, mathFont: CM, para: true },
	]), VIEW).sentence;
	const item3 = units.find((u) => u.text.startsWith("(3) compute"));
	assert.ok(item3.text.endsWith("the matrix exponential;"), "the clause keeps its tail");
}



// --- a stamp printed down the margin ----------------------------------------

// An arXiv stamp runs down the left-hand margin: eighteen points wide and the
// better part of the page tall. Its band therefore overlaps the band of nearly
// every line on the page, and anything that gathers lines by overlap will
// gather the whole page into one. Rows are lines of comparable height standing
// side by side, and text set at a different angle is not on a row at all.
{
	const PAGE = [0, 0, 595, 842];
	const units = segmentPage(layout([
		{ text: "arXiv:2412.01645v2 [math.PR] 14 Dec 2024", x: 18, y: 614, size: 20, rot: 90 },
		{ text: "Konstantinos Dareiotis, Mate Gerencser, Khoa Le, Chengcheng Ling", x: 104, y: 580, size: 12, para: true },
		{ text: "Abstract", x: 104, y: 550, para: true },
		{ text: "The aim of the paper is to show the well-posedness of rough differential", x: 104, y: 533, size: 10, para: true },
		{ text: "equations with distributional drifts driven by a Gaussian rough path lift.", x: 104, y: 521, size: 10, para: true },
	], PAGE), PAGE).sentence;

	const authors = units.find((u) => u.text.startsWith("Konstantinos"));
	assert.ok(authors, `the authors are a unit: got ${JSON.stringify(units.map((u) => u.text.slice(0, 26)))}`);
	assert.ok(!authors.text.includes("Abstract"), "and are not swept up with the abstract");
	assert.ok(units.some((u) => u.text === "Abstract"), "which stands on its own");
	assert.ok(units.some((u) => u.text.startsWith("The aim")), "as does the abstract");

	// The stamp is its own unit, and its box is the narrow strip it occupies.
	const stamp = units.find((u) => u.text.includes("arXiv"));
	assert.ok(stamp, "the stamp is read as its own unit");
	assert.ok(stamp.rects[0][2] - stamp.rects[0][0] < 60, "boxed to the margin it is printed in");
	// ...and it does not drag the measure of the page out to the margin.
	assert.ok(authors.rects[0][0] > 60, `the text keeps its own margin: got ${authors.rects[0][0].toFixed(0)}`);
}



// A full stop is followed by a space. Without one it is part of a word — an
// arXiv category, a file name, a version string — however much the next
// character looks like the start of a sentence.
assert.deepStrictEqual(texts([{ text: "It was filed under math.PR in 2024. Nothing else followed.", para: true }]),
	["It was filed under math.PR in 2024.", "Nothing else followed."]);
assert.deepStrictEqual(texts([{ text: "See config.Settings for the details. Then restart.", para: true }]),
	["See config.Settings for the details.", "Then restart."]);



// --- a table of contents ----------------------------------------------------

// Every entry is a title, a gap or a dot leader, and a page number. The leader
// is a row of full stops each followed by a space, so the last of them reads as
// the end of a sentence and hands the page number to the entry below; and a
// chapter line has no leader and no full stop, so nothing separates one from
// the next. An entry is a row of a table and is read as one.
{
	const PAGE = [0, 0, 595, 842];
	const G = "                                        ";   // the gap before a page number
	const units = segmentPage(layout([
		{ text: "Contents", x: 86, y: 397, size: 12, para: true },
		{ text: `1 Introduction${G}2`, x: 86, y: 374, bold: true, para: true },
		{ text: "1.1 The overview of the strategy . . . . . . . . . . . . . . 2", x: 101, y: 361 },
		{ text: "1.2 Setup and notation . . . . . . . . . . . . . . . . . . . 6", x: 101, y: 349 },
		{ text: "1.3 Formulation . . . . . . . . . . . . . . . . . . . . . . . 10", x: 101, y: 337, para: true },
		{ text: `2 Preliminaries${G}10`, x: 86, y: 318, bold: true, para: true },
		{ text: `3 Partial Malliavin calculus and conditional estimates${G}13`, x: 86, y: 274, bold: true },
		{ text: `4 Properties of the flow of the driftless equation${G}23`, x: 86, y: 256, bold: true },
		{ text: `A Auxiliary lemmas${G}63`, x: 86, y: 238, bold: true, para: true },
	], PAGE), PAGE).sentence;

	const entries = units.filter((u) => u.text !== "Contents");
	const shown = JSON.stringify(entries.map((u) => u.text.slice(0, 22)));
	assert.strictEqual(entries.length, 8, `each entry is one unit: got ${shown}`);
	// Each carries its own page number, not the next entry's.
	assert.ok(entries.some((u) => u.text.startsWith("1.1 The overview") && /2$/.test(u.text)),
		`an entry keeps its page number: got ${shown}`);
	assert.ok(entries.some((u) => u.text.startsWith("1.2 Setup")), "and the next one starts at its title");
	assert.ok(entries.some((u) => u.text.startsWith("3 Partial") && /13$/.test(u.text)),
		"a chapter line is an entry of its own");
	assert.ok(entries.every((u) => u.rects.length === 1), "each drawn as one band");
}



// What a contents entry is not. A year at the end of a sentence has no gap
// before it, an ellipsis is three stops and not a leader, and an equation
// number is bracketed.
assert.deepStrictEqual(texts([
	{ text: "The result was first proved by Riesz in a paper published in 1912. It", x: 82, y: 700 },
	{ text: "was extended by others. A later proof appeared in the year 1998.", x: 82, y: 686, para: true },
]), [
	"The result was first proved by Riesz in a paper published in 1912.",
	"It was extended by others.",
	"A later proof appeared in the year 1998.",
]);
assert.deepStrictEqual(texts([{ text: "We take the limit ... and then stop. Next one.", para: true }]),
	["We take the limit ... and then stop.", "Next one."]);

// --- a big operator that reaches up into the line above it -------------------

// A display set straight after a short last line: the integral sign is tall
// enough, with its upper limit, to overlap the band of "integral", and Zotero
// hands both over as one fragment — "integral ∫ t" — a line of prose with a
// formula glued to its end and a gulf in between. Read that way the sign and
// its limit join the sentence and the rest of the formula is left on its own.
{
	const PAGE = [0, 0, 595, 842];
	const TX = "CDJDPK+NewTXMI";
	const units = segmentPage(layout([
		{ text: "Let us give an overall view on the strategy of the paper and highlight what", x: 86, y: 158, size: 10.9 },
		{ text: "novel things arise. First of all, let us recall a thing we noted. Indeed, the", x: 86, y: 145, size: 10.9 },
		{ pieces: [
			{ text: "integral", x: 86 },
			{ text: "«∫»", x: 264, dy: -5.6, size: 17 },       // the sign, reaching up into the line
			{ text: "«t»", x: 275, dy: 6, size: 7.6 },         // its upper limit
		], y: 131, size: 10.9, mathFont: TX, para: true },
		{ text: "0", x: 270, y: 103, size: 8, para: true },        // lower limit
		{ text: "«σ»(«X»~s~) «dB»~s~", x: 283, y: 111, size: 10.9, mathFont: TX, para: true },
		{ text: "is not defined in the classical sense, since the drift is only a distribution.", x: 86, y: 85, size: 10.9 },
		{ text: "This is the heart of the matter and we treat it in the next section below.", x: 86, y: 72, size: 10.9, para: true },
	], PAGE), PAGE).sentence;

	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1,
		`the formula is one unit: got ${JSON.stringify(units.map((u) => [u.kind, u.text]))}`);
	assert.ok(displays[0].text.includes("σ"), `with its integrand: ${JSON.stringify(displays[0].text)}`);
	assert.ok(displays[0].rects[0][3] >= 138 && displays[0].rects[0][1] <= 103,
		`the band covers the sign and both limits: ${displays[0].rects[0].map((v) => v.toFixed(0))}`);
	const indeed = units.find((u) => u.text.startsWith("Indeed"));
	assert.strictEqual(indeed.text, "Indeed, the integral", "the sentence stops at its last word");
	assert.ok(indeed.rects.every((r) => r[1] > 140 || r[2] < 140), "and its highlight does not reach across to the sign");
	assert.ok(!units.some((u) => u.text === "0"), "the lower limit is not a unit of its own");
}


// ...but a word that opens a display row is part of the display.
{
	const CM = "UVFEFX+CMMI10";
	const units = segmentPage(layout([
		{ text: "We therefore consider the following optimisation problem over the simplex:", x: 72, y: 700, para: true },
		{ pieces: [
			{ text: "maximize", x: 190 },
			{ text: "«Σ»", x: 275, dy: -4, size: 16 },
			{ text: "«c»~i~«x»~i~", x: 291 },
		], y: 670, mathFont: CM, para: true },
		{ text: "«i»", x: 277, y: 652, size: 7, mathFont: CM, para: true },
		{ text: "and we show that its value is attained at a vertex of the simplex here.", x: 72, y: 630, para: true },
	]), VIEW).sentence;
	const display = units.find((u) => u.kind === "display");
	assert.ok(display && display.text.includes("maximize"),
		`the word stays with its formula: got ${JSON.stringify(units.map((u) => [u.kind, u.text]))}`);
}

// --- a big brace, whose box is a sliver across the top of it -----------------

// Zotero's box for a glyph runs from the font's descent to its cap height, and
// the fonts TeX sets big delimiters in declare a cap height of next to nothing
// and hang their glyphs below the baseline. So a brace's box covers only the
// very top of the brace: the band built from boxes stops flush with the top of
// the ink and short of its bottom.
{
	const CM = "JMEJAK+NewPXMI";
	const EX = "OKXVBW+NewPXEX";
	const size = 10.9, y = 600;
	// A \big brace is 1.2 em of ink centred on the axis, a quarter em above the
	// baseline: its top 0.85 em above, and its own baseline 0.04 em below that.
	const lift = 0.81 * size;
	const units = segmentPage(layout([
		{ text: "Positive interpolation may use the center node itself in this scheme.", x: 52, y: 660, size, para: true },
		{ text: "A second line of prose so the page has a body to measure against.", x: 52, y: 646, size, para: true },
		{ text: "and the scheme operator is defined for every node of the grid by", x: 52, y: 632, size, para: true },
		{ pieces: [
			{ text: "(«T»~h~«U»)~i~ «=» min", x: 160 },
			{ text: "{", x: 222, dy: lift, hang: true, raw: true },
			{ text: "«c»~τ~«ℓ»(«x»~i~, «a») «+» «γI»~h~«U»(«y»~a~)", x: 230 },
			{ text: "}", x: 352, dy: lift, hang: true, raw: true },
			{ text: ".", x: 360 },
			{ text: "(4.3)", x: 500 },
		], y, size, mathFont: CM, para: true },
		{ text: "«a»∈«A»~h~", x: 196, y: y - 11, size: 7.6, mathFont: CM, para: true },
		{ text: "Since the coefficient is positive, this is equivalent to the statement.", x: 52, y: 562, size, para: true },
	]), VIEW).sentence;

	const display = units.find((u) => u.kind === "display");
	assert.ok(display, `the formula is found: got ${JSON.stringify(units.map((u) => [u.kind, u.text]))}`);
	const inkTop = y + lift + 0.04 * size, inkBottom = inkTop - 1.2 * size;
	const [, low, , high] = display.rects[0];
	assert.ok(high >= inkTop + 0.1 * size, `room above the brace: band ${high.toFixed(1)} vs ink ${inkTop.toFixed(1)}`);
	assert.ok(low <= inkBottom + 0.2, `the bottom of the brace: band ${low.toFixed(1)} vs ink ${inkBottom.toFixed(1)}`);
	const above = units.find((u) => u.text.startsWith("and the scheme"));
	assert.ok(high <= above.rects[0][1], "still below the line above");
}

// --- the reading counter -------------------------------------------------------

// Each tab counts for itself, and every view of a tab's count follows it —
// the line in its menu, once per menu that is open. A view that has gone with
// its tab, or with a menu that was closed, is let go of.
{
	const view = () => ({
		textContent: "", style: {}, title: "",
		isConnected: true, ownerDocument: { defaultView: {} },
	});
	const tabA = {}, tabB = {};
	const menu = view(), second = view(), stale = view(), other = view();
	showCount(tabA, menu); showCount(tabA, second); showCount(tabA, stale);
	showCount(tabB, other);
	assert.strictEqual(menu.textContent, "0 sentences read in this tab", "nothing read yet");
	stale.isConnected = false;
	countRead(tabA); countRead(tabA); countRead(tabA);
	assert.strictEqual(menu.textContent, "3 sentences read in this tab");
	assert.strictEqual(second.textContent, "3 sentences read in this tab", "every open view follows");
	assert.strictEqual(stale.textContent, "0 sentences read in this tab", "a closed menu is no longer updated");
	assert.strictEqual(other.textContent, "0 sentences read in this tab", "another tab keeps its own count");
	countRead(tabB);
	assert.strictEqual(other.textContent, "1 sentence read in this tab");
	assert.strictEqual(menu.textContent, "3 sentences read in this tab");
	eraseCount(tabA);
	assert.strictEqual(menu.textContent, "0 sentences read in this tab");
	assert.strictEqual(other.textContent, "1 sentence read in this tab", "erasing one tab leaves the other alone");
	countRead(tabA);
	assert.strictEqual(menu.textContent, "1 sentence read in this tab");
}

// Counting can be turned off, and then nothing is counted — not even while a
// menu that was opened earlier is still showing the old total.
{
	const prefs = { "extensions.zotero.sentenceFocus.countReading": false };
	global.Zotero = { Prefs: { get: (key) => prefs[key] } };
	const el = { textContent: "", style: {}, isConnected: true, ownerDocument: { defaultView: {} } };
	const tab = {};
	showCount(tab, el);
	countRead(tab); countRead(tab);
	assert.strictEqual(el.textContent, "0 sentences read in this tab", "nothing is counted when counting is off");
	prefs["extensions.zotero.sentenceFocus.countReading"] = true;
	countRead(tab);
	assert.strictEqual(el.textContent, "1 sentence read in this tab", "and it resumes where it left off");
	delete global.Zotero;
}

// Where each document was left is kept in one preference: keyed by the item's
// own key, capped by count and by size, and anchored to the text rather than
// to a position in a list.
{
	const prefs = {};
	global.Zotero = {
		debug: () => {},
		Prefs: { get: (key) => prefs[key], set: (key, v) => { prefs[key] = v; }, clear: (key) => { delete prefs[key]; } },
	};
	const KEY = "extensions.zotero.sentenceFocus.resume";

	// The item key, not the local database id, which another copy of the
	// library numbers differently.
	assert.strictEqual(spotKey({ itemID: 7, _item: { libraryID: 1, key: "ABCD1234" } }), "1/ABCD1234");
	assert.strictEqual(spotKey({ itemID: 7 }), "7", "an older reader still gets a key");
	assert.strictEqual(spotKey({}), null);

	// Fifty documents, and the fifty-first pushes out the one read longest ago.
	const many = {};
	for (let i = 0; i < SPOT_LIMIT + 5; i++) many[`1/ITEM${i}`] = { kind: "pdf", page: i, at: 1000 + i };
	writeSpots(many);
	const kept = readSpots();
	assert.strictEqual(Object.keys(kept).length, SPOT_LIMIT);
	assert.ok(!kept["1/ITEM0"], "the oldest is dropped");
	assert.ok(kept[`1/ITEM${SPOT_LIMIT + 4}`], "the newest is kept");

	// And a few very long entries cannot push the preference past its ceiling.
	const fat = {};
	for (let i = 0; i < 40; i++) fat[`1/FAT${i}`] = { kind: "dom", selector: { value: "x".repeat(2000) }, at: 1000 + i };
	writeSpots(fat);
	assert.ok(prefs[KEY].length <= SPOT_BYTES, `kept under the ceiling: ${prefs[KEY].length}`);
	assert.ok(Object.keys(readSpots()).length < 40, "by keeping fewer of them");

	// Unreadable is the same as nothing: a bad value must not stop the plugin.
	prefs[KEY] = "{not json";
	assert.deepStrictEqual(readSpots(), {});
	assert.strictEqual(spotFor({ itemID: 7 }), null);

	delete global.Zotero;
}

// The saved place is found again by the boxes it covered, then by its text,
// and failing both by where it was on the page — never by its position in the
// list, which a change of step size or a re-read of the page would move.
{
	const unit = (top, text, rects) => ({ text, top, rects });
	const units = [
		unit(700, "The first sentence.", [[70, 690, 300, 700]]),
		unit(680, "The second sentence.", [[70, 670, 300, 680]]),
		unit(660, "The third sentence.", [[70, 650, 300, 660]]),
	];
	assert.strictEqual(bestUnit(units, { rects: [[72, 671, 290, 679]], text: "moved" }), 1, "the boxes win");
	assert.strictEqual(bestUnit(units, { rects: [[70, 100, 300, 110]], text: "The third sentence." }), 2,
		"and the text decides when the page has been re-set");
	assert.strictEqual(bestUnit(units, { rects: [[70, 655, 300, 662]], text: "gone entirely" }), 2,
		"a box that only touches one still finds it");
	assert.strictEqual(bestUnit(units, { rects: [], text: "" }), 0, "nothing to go on: the top of the page");
	// A box on a page whose text has changed beyond recognition lands nearby.
	assert.strictEqual(bestUnit(units, { rects: [[400, 658, 500, 662]], text: "nothing like it" }), 2);
}

// --- a table whose cells wrap ------------------------------------------------

// A table introduced by a colon, with cells long enough to wrap onto a second
// line. The colon left the lead-in open, so the header was pulled into its
// sentence as a continuation, and every row after it followed. A row whose
// first cell wraps arrives as two pieces side by side — the cell, and the rest
// of the row — plus the wrapped line below, and needs reading as one row.
{
	const PAGE = [0, 0, 595, 842];
	const size = 10.9;
	const row = (y, cells, extra = {}) => ({ pieces: cells.map(([x, text]) => ({ x, text })), y, size, ...extra });
	const units = segmentPage(layout([
		{ text: "Parametric families need somewhere to be evaluated. Each level label is", x: 85, y: 537, size },
		{ text: "mapped to a real number by the level value routine, which tries four patterns", x: 85, y: 523, size },
		{ text: "and returns the first match:", x: 85, y: 508, size, para: true },
		row(481, [[85, "Pattern"], [231, "Example"], [376, "Value"]], { para: true }),
		row(461, [[85, "a bare number"], [231, "34, -2.5"], [376, "the number itself"]]),
		{ text: "two numbers separated by", x: 85, y: 446, size },
		{ text: "-, –, —, to, or ..", x: 85, y: 431.5, size, para: true },
		row(446, [[231, "25-34"], [376, "the midpoint, 29.5"]], { para: true }),
		row(417, [[85, "a number followed by +"], [231, "85+"], [376, "the number, 85"]]),
		{ text: "< or under followed by a", x: 85, y: 402, size },
		{ text: "number", x: 85, y: 387, size, para: true },
		row(402, [[231, "<16, under 16"], [376, "the number, 16"]], { para: true }),
		{ text: "Surrounding whitespace is ignored. If every level parses, the resulting vector", x: 85, y: 347, size },
		{ text: "is the support. If any level fails, the variable falls back to positional indices.", x: 85, y: 332, size, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));

	const lead = units.find((u) => u.text.startsWith("Each level label"));
	assert.ok(lead.text.endsWith("first match:"), `the lead-in stops at the table: ${got}`);
	const wrapped = units.find((u) => u.text.includes("two numbers"));
	assert.ok(wrapped.text.includes("or ..") && wrapped.text.includes("midpoint"),
		`a row with a wrapped cell is one row: ${got}`);
	assert.strictEqual(wrapped.rects.length, 1, "drawn as one band");
	assert.ok(wrapped.rects[0][1] <= 430 && wrapped.rects[0][3] >= 453, "covering both of its lines");
	const last = units.find((u) => u.text.includes("under followed"));
	assert.ok(last.text.includes("number") && last.text.includes("<16"), `and so is the last one: ${got}`);
	for (const cell of ["Pattern", "a bare number", "a number followed"]) {
		const unit = units.find((u) => u.text.startsWith(cell));
		assert.ok(unit && !unit.text.includes("two numbers") && !unit.text.includes("first match"),
			`"${cell}" opens a row of its own: ${got}`);
	}
	assert.ok(units.some((u) => u.text === "Surrounding whitespace is ignored."), "the prose after it is untouched");
}

// ...and a row the layout kept on one line takes its wrapped cell too, while a
// caption set straight under the table does not join the last row.
{
	const PAGE = [0, 0, 595, 842];
	const size = 10.9;
	const row = (y, cells, extra = {}) => ({ pieces: cells.map(([x, text]) => ({ x, text })), y, size, ...extra });
	const units = segmentPage(layout([
		{ text: "The patterns are tried in the order given in the table below, first match wins.", x: 85, y: 537, size, para: true },
		row(510, [[85, "Pattern"], [231, "Example"], [376, "Value"]], { para: true }),
		row(490, [[85, "two numbers separated"], [231, "25-34"], [376, "the midpoint"]]),
		{ text: "by a dash", x: 85, y: 475.5, size, para: true },
		row(461, [[85, "a bare number"], [231, "34"], [376, "the number itself"]], { para: true }),
		{ text: "Table 2: Patterns.", x: 85, y: 447, size, para: true },
		{ text: "Surrounding whitespace is ignored, and so are the level labels that do not parse.", x: 85, y: 420, size, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));
	const wrapped = units.find((u) => u.text.startsWith("two numbers"));
	assert.ok(wrapped.text.includes("by a dash"), `the wrapped cell stays with its row: ${got}`);
	assert.strictEqual(wrapped.rects.length, 1, "one band");
	const lastRow = units.find((u) => u.text.startsWith("a bare number"));
	assert.ok(!lastRow.text.includes("Table 2"), `the caption is not a cell: ${got}`);
}

// --- a two-column table -----------------------------------------------------

// Two columns give each row one wide gap, which on a single line is also what
// the run up to an equation number looks like, so one gap alone never made a
// row. What makes these rows is that the gaps line up: every second cell starts
// at the same place, row after row.
{
	const PAGE = [0, 0, 595, 842];
	const size = 10.9;
	const row = (y, a, b, extra = {}) => ({ pieces: [{ x: 85, text: a }, { x: 304, text: b }], y, size, ...extra });
	const units = segmentPage(layout([
		row(742, "Kind", "Meaning", { para: true }),
		row(722, "uniform", "the default; nobody has supplied this"),
		row(707, "probs", "a vector of probabilities: an assertion,", { para: true }),
		{ text: "renormalised, never smoothed", x: 304, y: 692.5, size },
		row(678, "counts", "a vector of counts: evidence, smoothed", { para: true }),
		{ text: "toward a prior when used as a row", x: 304, y: 663, size },
		row(649, "parametric", "a named family with parameters,", { para: true }),
		{ text: "evaluated on the support", x: 304, y: 634, size },
		row(619, "inherit", "rows only: defer to the variable’s marginal", { para: true }),
		{ text: "A spec is specified — the predicate the audit uses — exactly when its kind is set,", x: 85, y: 578, size },
		{ text: "or parametric. A counts spec may carry two optional fields, both of them numbers.", x: 85, y: 563, size, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));
	const meanings = [["uniform", "supplied this"], ["probs", "never smoothed"],
		["counts", "used as a row"], ["parametric", "on the support"], ["inherit", "marginal"]];
	for (const [kind, meaning] of meanings) {
		const unit = units.find((u) => u.text.startsWith(kind));
		assert.ok(unit && unit.text.includes(meaning), `"${kind}" is one row with its meaning: ${got}`);
		assert.ok(meanings.every(([k, m]) => k === kind || !unit.text.includes(m)), `and only its own: ${got}`);
		assert.strictEqual(unit.rects.length, 1, "drawn as one band");
	}
	assert.ok(units.some((u) => u.text.startsWith("A spec is specified")), `the prose after it is its own: ${got}`);
}

// --- a cases formula ---------------------------------------------------------

// The branches of a cases formula stand beside a tall brace, and a branch can
// carry a word — "otherwise", "kind" — which made it read as a line of prose
// and cut the formula in two. Whatever stands beside a brace, within its
// height, is part of the formula it opens.
{
	const PAGE = [0, 0, 595, 842];
	const PX = "TROHAZ+TeXGyrePagellaMath-Regular";
	const size = 10.9;
	const units = segmentPage(layout([
		{ text: "The compilation map sends a spec and a level list to a point of the simplex.", x: 85, y: 480, size },
		{ text: "It is total: it never raises, and every failure path returns the uniform vector.", x: 85, y: 465, size, para: true },
		{ text: "«ν»(«w»)~j~ «=»", x: 138, y: 399.5, size, mathFont: PX },
		{ pieces: [
			{ text: "⎧", x: 178, dy: 24, raw: true }, { text: "⎪", x: 178, dy: 17, raw: true },
			{ text: "⎪", x: 178, dy: 10, raw: true },
		], y: 399.5, size, mathFont: PX },
		{ pieces: [
			{ text: "⎨", x: 178, dy: 3, raw: true }, { text: "⎪", x: 178, dy: -4, raw: true },
			{ text: "⎪", x: 178, dy: -11, raw: true }, { text: "⎩", x: 178, dy: -17, raw: true },
		], y: 399.5, size, mathFont: PX, para: true },
		{ text: "«w̃»~j~", x: 194, y: 421, size, mathFont: PX },
		{ text: "«∑»~l~ «w̃»~l~", x: 186, y: 402, size, mathFont: PX, para: true },
		{ text: "if «∑»~l~ «w̃»~l~ «>» 0,", x: 225, y: 410, size, mathFont: PX, para: true },
		{ text: "1/«k» otherwise,", x: 185, y: 383.5, size, mathFont: PX, para: true },
		{ text: "«w̃»~j~ «=» max(0, «w»~j~ ⋅ 1[«w»~j~ finite]) ∶", x: 310, y: 399.5, size, mathFont: PX, para: true },
		{ text: "non-finite entries become 0, negative entries are clipped to 0, and a vector that", x: 85, y: 355, size },
		{ text: "sums to zero yields the uniform vector rather than an error, as promised above.", x: 85, y: 341, size, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1, `the formula is one unit: ${got}`);
	assert.ok(displays[0].text.includes("otherwise") && displays[0].text.includes("max(0"),
		`with every branch and the definition beside it: ${got}`);
	for (const unit of units) {
		for (const r of unit.rects) assert.ok(r[3] - r[1] > 5, `no band collapses to a line: ${got}`);
	}
}

// ...and branches that read as whole phrases, a type name and a set of them.
{
	const PAGE = [0, 0, 595, 842];
	const PX = "TROHAZ+TeXGyrePagellaMath-Regular";
	const TT = "MYHUDI+LMMono10-Regular";
	const size = 10.9;
	const units = segmentPage(layout([
		{ text: "zero or less yields the uniform vector rather than an error. Then, ignoring smoothing for", x: 85, y: 341, size },
		{ text: "the moment,", x: 85, y: 326, size, para: true },
		{ text: "«σ»(spec, «L») «=»", x: 158, y: 266, size, mathFont: PX, para: true },
		{ pieces: [
			{ text: "⎧", x: 224, dy: 34, raw: true }, { text: "⎪", x: 224, dy: 27, raw: true },
			{ text: "⎪", x: 224, dy: 20, raw: true }, { text: "⎪", x: 224, dy: 13, raw: true },
			{ text: "⎪", x: 224, dy: 7, raw: true },
		], y: 266, size, mathFont: PX },
		{ pieces: [
			{ text: "⎨", x: 224, dy: 1, raw: true }, { text: "⎪", x: 224, dy: -6, raw: true },
			{ text: "⎪", x: 224, dy: -13, raw: true }, { text: "⎪", x: 224, dy: -20, raw: true },
			{ text: "⎩", x: 224, dy: -27, raw: true },
		], y: 266, size, mathFont: PX, para: true },
		{ text: "(1/«k», ... , 1/«k») kind «∈» {uniform, inherit},", x: 231, y: 292, size, mathFont: TT },
		{ text: "«ν»(«π»~k~(«v»)) kind «∈» {probs, counts},", x: 231, y: 273, size, mathFont: TT },
		{ text: "«ν»(«f»~θ~(«x»)) kind «=» parametric,", x: 231, y: 256, size, mathFont: PX },
		{ text: "(1/«k», ... , 1/«k») otherwise.", x: 231, y: 239.5, size, mathFont: PX, para: true },
		{ text: "The padding operator pads with zeros on the right, or truncates on the right, to length", x: 85, y: 210, size },
		{ text: "exactly k, so a length mismatch degrades rather than fails; the validator reports it.", x: 85, y: 196, size, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1, `the formula is one unit: ${got}`);
	assert.ok(displays[0].text.includes("uniform, inherit") && displays[0].text.includes("otherwise"),
		`from the first branch to the last: ${got}`);
}

// --- equation numbers on the left -------------------------------------------

// Some styles set the number at the left margin, a gulf away from the formula.
// Read as the start of a line of prose, "(1.2) −" ended on an operator and
// pulled the whole display into itself as the rest of its expression.
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const units = segmentPage(layout([
		{ text: "We will say either that a function is degenerate elliptic or that the equation holds,", x: 72, y: 450, size: 10 },
		{ text: "and the term proper is used in a similar fashion throughout the paper that follows.", x: 72, y: 438, size: 10, para: true },
		{ text: "Example 1.2. Degenerate elliptic linear equations. Example 1.1 immediately ex-", x: 72, y: 432, size: 10, hyphen: true },
		{ text: "tends to the more general linear equation", x: 72, y: 420, size: 10, para: true },
		{ pieces: [{ text: "(1.2)", x: 72 }, { text: "«−»", x: 132 }], y: 390, size: 10, para: true },
		{ text: "«N» «∑»", x: 143, y: 400, size: 10, mathFont: CM },
		{ text: "«i»,«j»=1", x: 141, y: 379, size: 7, mathFont: CM, para: true },
		{ text: "«a»~i,j~(«x») «∂»^2^«u»", x: 162, y: 390, size: 10, mathFont: CM, para: true },
		{ text: "«∂x»~i~«∂x»~j~", x: 191, y: 383, size: 10, mathFont: CM, para: true },
		{ text: "+ «c»(«x»)«u»(«x») «=» «f»(«x»)", x: 291, y: 390, size: 10, mathFont: CM },
		{ text: "where the matrix is symmetric; the corresponding operator is then given by", x: 72, y: 358, size: 10 },
		{ pieces: [{ text: "(1.3)", x: 72 }, { text: "«F»(«x», «r», «p», «X») «=» «−» trace(«A»(«x»)«X») «+»", x: 124 }],
			y: 328, size: 10, mathFont: CM, para: true },
		{ text: "«b»~i~(«x»)«p»~i~ «+» «c»(«x»)«r» «−» «f»(«x»).", x: 285, y: 328, size: 10, mathFont: CM, para: true },
		{ text: "In this case, the operator is degenerate elliptic if and only if the matrix is positive.", x: 84, y: 299, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 2, `two formulas: ${got}`);
	assert.ok(displays[0].text.includes("−") && displays[0].text.includes("f(x)"), `the first whole: ${got}`);
	assert.ok(displays.every((u) => !/\(1\.[23]\)/.test(u.text)), `the numbers are dropped: ${got}`);
	assert.ok(units.some((u) => u.kind === "text" && u.text.endsWith("general linear equation")),
		`the lead-in is its own sentence: ${got}`);
}

// ...while a list item, whose label sits a word space from its text, is not one.
assert.deepStrictEqual(texts([
	{ text: "(1) every cycle bounds a face, and the bound is sharp in the plane.", para: true },
	{ text: "(2) no cycle is longer than seven, which we show below in detail.", para: true },
]), ["(1) every cycle bounds a face, and the bound is sharp in the plane.",
	"(2) no cycle is longer than seven, which we show below in detail."]);

// --- a formula piece that carries a word --------------------------------------

// `trace` is a roman word inside a formula, and a piece carrying a word is never
// taken into a formula's row — that is what keeps a sentence's tail out of it.
// But this piece is interleaved with the formula on its own baseline: it starts
// before the piece beside it ends. Prose never shares a line with a formula so.
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const units = segmentPage(layout([
		{ text: "is a typical equation of the kind. The corresponding nonlinearities F have the form", x: 72, y: 691, size: 10, para: true },
		{ text: "and", x: 72, y: 647, size: 10, para: true },
		// The layout hands these two over in the other order, so they stay two lines.
		{ pieces: [{ text: "«α»", x: 196, dy: -7 }, { text: "inf[ «−» trace(«A»~α,β~(«x»)«X»)", x: 206 }],
			y: 627, size: 10, mathFont: CM, para: true },
		{ text: "«F»(«x», «r», «p», «X») «=» sup", x: 123, y: 627, size: 10, mathFont: CM, para: true },
		{ text: "«+» ⟨«b»~α,β~(«x»), «p»⟩ «+» «c»~α,β~(«x»)«r» «−» «f»~α,β~(«x»)],", x: 223, y: 605, size: 10, mathFont: CM, para: true },
		{ text: "each of which is clearly also proper. Notice that in the first case F is convex in", x: 72, y: 585, size: 10 },
		{ text: "all of its arguments while in the second case this is not so, as we show below.", x: 72, y: 574, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1, `the formula is one unit: ${got}`);
	assert.ok(displays[0].text.includes("sup") && displays[0].text.includes("trace") && displays[0].text.includes("],"),
		`all three pieces: ${got}`);
}

// --- prose lines crowded with formulas ----------------------------------------

// A line of running text can be mostly symbols — "corresponds to max{F(x, u, Du,
// D²u), |Du| − g(x)} = 0." — and score as a displayed formula. What it does
// not do is stand apart: it starts at the margin, straight under a full line
// that the layout did not end a paragraph on.
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const units = segmentPage(layout([
		{ text: "In accordance with remarks made in the previous example, if F is proper then so", x: 72, y: 326, size: 10 },
		{ text: "are the equations above.", x: 72, y: 314, size: 10, para: true },
		{ text: "Likewise, gradient constraints may be imposed in this way. A typical example", x: 84, y: 302, size: 10 },
		{ text: "corresponds to max[«F»(«x», «u», «Du», «D»^2^«u»), |«Du»| «−» «g»(«x»)] «=» 0.", x: 72, y: 290, size: 10, mathFont: CM, para: true },
		{ text: "Example 1.8. Functions of the eigenvalues. For «X» «∈» «S»(«N») we let «λ»~1~(«X»), . . . , «λ»~N~(«X»)", x: 72, y: 272, size: 10, mathFont: CM },
		{ text: "be its eigenvalues arranged in increasing order. If g is a function of them that", x: 72, y: 260, size: 10, para: true },
		{ text: "is defined on the space and is nondecreasing in each of them, then «F»(«x», «r», «p», «X») «=»", x: 72, y: 248, size: 10, mathFont: CM },
		{ text: "«g»(«x», «r», «p», «−λ»~1~(«X»), . . . , «−λ»~N~(«X»)) is proper. For instance, «F»(«X») «=» «−» max[«λ»~1~(«X»), . . . ,", x: 72, y: 236, size: 10, mathFont: CM, para: true },
		{ text: "«−λ»~N~(«X»), «F»(«X») «=» «−» min[«λ»~1~(«X»), . . . , «λ»~N~(«X»)] «=» «−λ»~1~(«X») and «F»(«X») «=» «−»(«λ»~2~(«X»))^3^", x: 72, y: 224, size: 10, mathFont: CM },
		{ text: "are degenerate elliptic. Another example is", x: 72, y: 213, size: 10, para: true },
		{ text: "«F»(«x», «r», «p», «X») «=» «−»|trace(«X»)|^«m»−1^ trace(«X») «+» |«p»|^«q»^ «+» «c»(«x»)«r» «−» «f»(«x»)", x: 114, y: 193, size: 10, mathFont: CM, para: true },
		{ text: "where c ≥ 0 and m, q > 0. The corresponding equation is written out below.", x: 72, y: 174, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	assert.ok(units.some((u) => u.kind === "text" && u.text.startsWith("A typical example") && u.text.endsWith("= 0.")),
		`the sentence runs through its formula: ${got}`);
	assert.ok(units.some((u) => u.text.startsWith("For instance") && u.text.endsWith("are degenerate elliptic.")),
		`and so does this one: ${got}`);
	assert.ok(units.some((u) => u.kind === "display" && u.text.includes("trace")), `the real display is still one: ${got}`);
}

// --- a contents list with no page numbers ----------------------------------------

// Entries with neither a leader nor a page number, and no paragraph breaks
// between them: nothing ended one before the next began. Each opens with its
// section number, and each is a short line.
{
	const PAGE = [0, 0, 612, 792];
	const units = segmentPage(layout([
		{ text: "7.D. A remark on (BC) in the classical sense", x: 90, y: 691, size: 10 },
		{ text: "7.E. Fully nonlinear boundary conditions", x: 90, y: 679, size: 10 },
		{ text: "8. Parabolic problems", x: 77, y: 667, size: 10 },
		{ text: "9. Singular equations: An example from geometry", x: 77, y: 655, size: 10 },
		{ text: "10. Applications and perspectives", x: 72, y: 643, size: 10 },
		{ text: "APPENDIX The proof of Theorem 3.2", x: 72, y: 631, size: 10, para: true },
		{ text: "1. Examples", x: 220, y: 609, size: 10, para: true },
		{ text: "We will record here many examples of degenerate elliptic equations mentioning,", x: 84, y: 591, size: 10 },
		{ text: "when appropriate, areas in which they arise. The reader is invited to scan the list", x: 72, y: 579, size: 10 },
		{ text: "and pause where interested. It is possible to proceed to the next section at any", x: 72, y: 567, size: 10 },
		{ text: "stage of the reading.", x: 72, y: 555, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));
	for (const entry of ["7.D. A remark on (BC) in the classical sense", "7.E. Fully nonlinear boundary conditions",
		"8. Parabolic problems", "9. Singular equations: An example from geometry",
		"10. Applications and perspectives", "APPENDIX The proof of Theorem 3.2"]) {
		assert.ok(units.some((u) => u.text === entry), `"${entry}" is an entry of its own: ${got}`);
	}
	assert.ok(units.some((u) => u.text === "The reader is invited to scan the list and pause where interested."),
		`the prose is untouched: ${got}`);
}

// ...but short lines of ragged prose are not a contents list, and neither is a
// numbered line or two inside a paragraph.
assert.deepStrictEqual(texts([
	{ text: "The first short line of a poem", x: 72, y: 700 },
	{ text: "and 2 of its lines that follow", x: 72, y: 688 },
	{ text: "3 times over, ragged on the right.", x: 72, y: 676, para: true },
]), ["The first short line of a poem and 2 of its lines that follow 3 times over, ragged on the right."]);

// --- a cases brace set as a single glyph ---------------------------------------

// A small cases brace is one glyph from the extension font, and it arrives on the
// line of the first branch. Its box is a sliver across its top (see the big brace
// test above), so as boxes go it reaches nowhere near the second branch — and
// "+∞ otherwise;", carrying a word, was left out of the formula. The brace's
// real extent comes back from the axis of the formula beside it.
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const size = 10;
	const units = segmentPage(layout([
		{ text: "equations. Allowing F to be discontinuous (even more, to become infinite), we may", x: 72, y: 257, size },
		{ text: "write the equation in our form by putting", x: 72, y: 245, size, para: true },
		{ text: "«F»(«x», «r», «p», «X») «=»", x: 140, y: 214.5, size, mathFont: CM, para: true },
		{ pieces: [
			{ text: "{", x: 206, dy: 21.1, hang: true, raw: true },
			{ text: "«−» det(«X») «+» «f»(«x», «r», «p») if «X» «≥» 0,", x: 217, dy: 8 },
		], y: 214.5, size, mathFont: CM, para: true },
		{ text: "«+∞» otherwise;", x: 217, y: 207, size, mathFont: CM, para: true },
		{ text: "F is then degenerate elliptic. This follows from the fact that the product is.", x: 72, y: 185, size, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1, `one formula: ${got}`);
	assert.ok(displays[0].text.includes("otherwise"), `with both branches: ${got}`);
	assert.ok(displays[0].rects[0][1] <= 205, `and the band covers the second: ${got}`);
}

// --- a cases brace from Computer Modern's extension font -------------------------

// CMEX glyphs hang from their baseline: TeX sets the top of a brace there and
// the rest of it below. Where the font declares an ordinary height, Zotero's
// box stands on that baseline like a letter's, so its top is well above the ink
// and its bottom nowhere near the second branch. The font says what the glyph
// is even where the box does not.
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const EX = "JIWGEV+CMEX10";
	const size = 10;
	const units = segmentPage(layout([
		{ text: "equations. Allowing F to be discontinuous (even more, to become infinite), we may", x: 72, y: 257, size },
		{ text: "write the equation in our form by putting", x: 72, y: 245, size, para: true },
		{ text: "«F»(«x», «r», «p», «X») «=»", x: 140, y: 214.5, size, mathFont: CM, para: true },
		{ pieces: [
			{ text: "{", x: 206, dy: 14, raw: true, font: EX },
			{ text: "«−» det(«X») «+» «f»(«x», «r», «p») if «X» «≥» 0,", x: 217, dy: 8 },
		], y: 214.5, size, mathFont: CM, para: true },
		{ text: "«+∞» otherwise;", x: 217, y: 207, size, mathFont: CM, para: true },
		{ text: "F is then degenerate elliptic. This follows from the fact that the product is.", x: 72, y: 185, size, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1, `one formula: ${got}`);
	assert.ok(displays[0].text.includes("otherwise"), `with both branches: ${got}`);
}

// --- a formula set off on a line of its own, with words in it ---------------------

// "T(x̂) = convex hull(UT(x̂))": the roman words leave too little of it looking
// like a formula. But it is centred, has a relation in it, and has space above
// and below it that a line of the paragraph never has.
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const units = segmentPage(layout([
		{ text: "where the set of generalized unit tangents to the set at the point is given by the formula", x: 72, y: 443, size: 10 },
		{ text: "above, and it is closed; the set is a cone in any case, whatever the regularity of the set.", x: 72, y: 431, size: 10 },
		{ text: "We turn now to the case that matters most, where the boundary is as smooth as we please.", x: 72, y: 419, size: 10, para: true },
		{ text: "If O is a smooth N-submanifold of the space with boundary and x in its boundary, then the", x: 72, y: 407, size: 10 },
		{ text: "generalized tangent cone", x: 72, y: 395, size: 10, para: true },
		{ text: "«T»~«O»~(«x»ˆ) «=» convex hull(UT~«O»~(«x»ˆ))", x: 213, y: 372, size: 10, mathFont: CM, para: true },
		{ text: "is a halfspace and O has an exterior normal n at x. In this event, the result says that", x: 72, y: 350, size: 10 },
		{ text: "the multiplier is nonnegative, and we conclude what we set out to show in the end, which", x: 72, y: 338, size: 10 },
		{ text: "is the statement of the lemma. Life is more complex when the multiplier is positive, and", x: 72, y: 326, size: 10 },
		{ text: "we treat that case separately in what follows.", x: 72, y: 314, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	assert.ok(units.some((u) => u.kind === "display" && u.text.includes("convex hull")), `the formula stands alone: ${got}`);
	assert.ok(units.some((u) => u.kind === "text" && u.text.startsWith("is a halfspace")), `and the prose after it: ${got}`);
}

// --- a left-hand number raised onto a line of its own -------------------------------

// When a formula is too wide for its number, the number is set on a line of
// its own above it — here with the brace of a cases formula landing in the
// middle of it in reading order, "(2.1{5)".
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const EX = "JIWGEV+CMEX10";
	const units = segmentPage(layout([
		{ text: "second fundamental form of the boundary at the point (oriented with the exterior normal)", x: 72, y: 631, size: 10 },
		{ text: "extended to the space by setting it to zero. Then", x: 72, y: 619.5, size: 10, para: true },
		{ pieces: [
			{ text: "(2.1", x: 72, dy: 11 },
			{ text: "{", x: 97, dy: 5, raw: true, font: EX },
			{ text: "5)", x: 93, dy: 11 },
			{ text: "(«p», «X») «∈» «J»(«x») if and only if either «p» «=» «Dφ»(«x») and «X» «≥» 0, or", x: 110 },
		], y: 594, size: 10, mathFont: CM, para: true },
		{ text: "«p» «=» «Dφ»(«x») «−» «λn», «λ» «>» 0 and «PXP» «≥» «λS».", x: 97, y: 580.5, size: 10, mathFont: CM, para: true },
		{ text: "Noting that the projection kills the normal, we see that the claim holds for all of them.", x: 72, y: 556, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1, `one formula: ${got}`);
	assert.ok(displays[0].text.includes("either") && displays[0].text.includes("λS"), `both rows: ${got}`);
	assert.ok(!displays[0].text.includes("2.1"), `without its number: ${got}`);
	assert.ok(units.some((u) => u.kind === "text" && u.text.endsWith("Then")), `the lead-in stops at Then: ${got}`);
}

// --- prose after a display, flush with the margin -------------------------------

// "where A = D²φ(x̂) ∈ S(N), N = N₁ + ⋯ + N_k." is mostly formula, and follows
// a formula closely enough to be taken into it. It opens with a word, at the
// margin: a display is set in, and never begins with "where".
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const units = segmentPage(layout([
		{ text: "for each positive number there exists a symmetric matrix for every index such that the", x: 72, y: 560, size: 10 },
		{ text: "and the block diagonal matrix with entries satisfies the bound below, for every choice", x: 72, y: 548, size: 10 },
		{ text: "of the parameter as above", x: 72, y: 536, size: 10, para: true },
		{ text: "«−»(1/«ε» «+» ‖«A»‖)«I» «≤» diag(«X»~1~, . . . , «X»~k~) «≤» «A» «+» «εA»^2^", x: 150, y: 499, size: 10, mathFont: CM, para: true },
		{ text: "where «A» «=» «D»^2^«φ»(«x») «∈» «S»(«N»), «N» «=» «N»~1~ «+» · · · «+» «N»~k~.", x: 72, y: 486, size: 10, mathFont: CM, para: true },
		{ text: "The norm of the symmetric matrix used in the bound above is the largest eigenvalue.", x: 84, y: 450, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	const where = units.find((u) => u.text.startsWith("where"));
	assert.ok(where && where.kind === "text", `"where ..." is prose: ${got}`);
	assert.ok(!units.some((u) => u.kind === "display" && u.text.includes("where")), `and not in the formula: ${got}`);
}

// --- initials across a line break, and before a surname ---------------------------

// "(see also M." / "G. Crandall and R. Newcomb [58])": a capital and a stop at
// the start of a line looks like a list label, and "and R. Newcomb" like the end
// of a sentence about R.
assert.deepStrictEqual(texts([
	{ text: "The closure was studied by P. L. Lions and H. M. Soner (see also M.", x: 72, y: 700 },
	{ text: "G. Crandall and R. Newcomb [58]). The closure of the semijets came later.", x: 72, y: 688, para: true },
]), [
	"The closure was studied by P. L. Lions and H. M. Soner (see also M. G. Crandall and R. Newcomb [58]).",
	"The closure of the semijets came later.",
]);
// ...while points named by single capitals still end a sentence.
assert.deepStrictEqual(texts([{ text: "The segment joins A and C. Then the claim follows at once.", para: true }]),
	["The segment joins A and C.", "Then the claim follows at once."]);

// --- a page rebuilt from a diagnostics report ------------------------------------

// Lines as a report prints them — x and y extents, size, main font, text,
// paragraph break, and the top of any hanging glyph — spread back into glyphs.
// Coarser than a hand-built page, but it carries a real page's geometry, which
// is where the surprises have been.
function fromReport(rows, opts = {}) {
	const chars = [];
	for (const [x0, x1, y0, y1, size, font, text, para, hang] of rows) {
		const start = chars.length;
		const glyphs = [...text].filter((c) => c !== " ");
		const w = (x1 - x0) / Math.max(1, glyphs.length);
		let x = x0;
		const cs = [...text];
		for (let j = 0; j < cs.length; j++) {
			const c = cs[j];
			if (c === " ") { if (chars.length > start) chars[chars.length - 1].spaceAfter = true; continue; }
			let fontName = font, base = y0 + 0.25 * size, rect = [x, y0, x + w, y1];
			// Maths as TeX sets it: Greek, operators and relations, and a letter
			// standing alone — a variable — in the maths fonts.
			const lone = /\p{L}/u.test(c) && !/\p{L}/u.test(cs[j - 1] || "") && !/\p{L}/u.test(cs[j + 1] || "");
			if (lone || /[α-ωΑ-Ω∂∆∈∉≤≥=<>+−×⊂⊃∋→]/.test(c)) fontName = "FSUMJD+CMMI10";
			// A bracket on a line with a hanging glyph is that glyph: an
			// extension-font bracket whose box stands on its baseline.
			if (hang && (opts.hangs || /[()]/).test(c)) { fontName = "JIWGEV+CMEX10"; base = hang - 1; rect = [x, base - 2.5, x + w, base + 7.5]; }
			chars.push({ c, rect, inlineRect: [x, y0, x + w, y1], fontSize: size, fontName, bold: false, italic: false,
				baseline: base, rotation: 0, spaceAfter: false, lineBreakAfter: false, paragraphBreakAfter: false, ignorable: false });
			x += w;
		}
		chars[chars.length - 1].lineBreakAfter = true;
		chars[chars.length - 1].paragraphBreakAfter = para;
		// { raised: [row, n] }: that row's first n glyphs are a number set a line
		// above its formula, and the formula starts right where the number ends
		// — no space between them, as on the page this was taken from.
		if (opts.raised && rows[opts.raised[0]][6] === text && rows[opts.raised[0]][2] === y0) {
			const own = chars.slice(start).filter((ch) => !/CMEX/.test(ch.fontName));
			const label = own.slice(0, opts.raised[1]), rest = own.slice(opts.raised[1]);
			let x = x0;
			for (const ch of label) {
				ch.rect = [x, y1 - size, x + 4.5, y1];
				ch.inlineRect = [x, y0, x + 4.5, y1];
				ch.baseline = y1 - 0.75 * size;
				x += 4.5;
			}
			const shift = x - rest[0].rect[0];
			for (const ch of rest) {
				ch.rect = [ch.rect[0] + shift, ch.rect[1], ch.rect[2] + shift, ch.rect[3]];
				ch.inlineRect = [ch.inlineRect[0] + shift, ch.inlineRect[1], ch.inlineRect[2] + shift, ch.inlineRect[3]];
			}
		}
	}
	return chars;
}

// A bracket on the top row of a two-row formula was measured against the axis
// of the row below, stretched down past the formula, and took the two lines of
// prose under it into the formula — "which is the nonparametric formulation…"
// highlighted as part of the Lévi equation.
{
	const PAGE = [0, 0, 612, 792];
	const units = segmentPage(fromReport([
		[72, 431, 689, 699, 10, "KOUGOH+CMR10", "which is proper if A ≥ 0 and b is nondecreasing with respect to r. Two relevant", false],
		[72, 143, 677, 687, 10, "KOUGOH+CMR10", "special cases are", true],
		[198, 304, 664, 674, 10, "FSUMJD+CMMI10", "−ν∆u + f (x, u, Du) = 0", true],
		[72, 431, 645, 655, 10, "KOUGOH+CMR10", "with ν > 0 and f nondecreasing in u, which may be regarded as a first-order", false],
		[72, 431, 633, 643, 10, "KOUGOH+CMR10", "Hamilton-Jacobi equation perturbed by an additional “viscosity” term −ν∆u (equa-", false],
		[72, 410, 621, 631, 10, "KOUGOH+CMR10", "tions of this type arise in optimal stochastic control), and the L ́evi’s equation", true],
		[98, 106, 588, 598, 10, "PXYEAU+CMSY10", "−", true],
		[108, 132, 594, 611, 10, "FSUMJD+CMMI10", "( ∂2u", true, 605],
		[116, 132, 579, 592, 10, "FSUMJD+CMMI10", "∂x21", true],
		[136, 163, 588, 606, 10, "FSUMJD+CMMI10", "+ ∂2u", true],
		[147, 162, 579, 592, 10, "FSUMJD+CMMI10", "∂x22", true],
		[164, 181, 602, 614, 10, "JIWGEV+CMEX10", ")(", true, 608],
		[181, 196, 588, 598, 10, "KOUGOH+CMR10", "1+", true],
		[198, 220, 594, 611, 10, "FSUMJD+CMMI10", "( ∂u", false, 605],
		[207, 222, 580, 591, 10, "FSUMJD+CMMI10", "∂x3", true],
		[224, 244, 600, 614, 10, "JIWGEV+CMEX10", ")2)", true, 608],
		[246, 273, 588, 606, 10, "FSUMJD+CMMI10", "− ∂2u", true],
		[257, 272, 579, 592, 10, "FSUMJD+CMMI10", "∂x23", true],
		[276, 306, 594, 614, 10, "JIWGEV+CMEX10", "(( ∂u", true, 608],
		[292, 308, 580, 591, 10, "FSUMJD+CMMI10", "∂x1", true],
		[309, 321, 600, 611, 10, "JIWGEV+CMEX10", ")2", true, 605],
		[323, 331, 588, 598, 10, "KOUGOH+CMR10", "+", true],
		[333, 356, 594, 611, 10, "FSUMJD+CMMI10", "( ∂u", false, 605],
		[342, 357, 580, 591, 10, "FSUMJD+CMMI10", "∂x2", true],
		[359, 379, 600, 614, 10, "JIWGEV+CMEX10", ")2)", true, 608],
		[118, 158, 556, 574, 10, "KOUGOH+CMR10", "+ 2 ∂2u", true],
		[134, 165, 549, 559, 10, "FSUMJD+CMMI10", "∂x1∂x3", true],
		[169, 191, 563, 580, 10, "FSUMJD+CMMI10", "( ∂u", false, 574],
		[177, 193, 549, 559, 10, "FSUMJD+CMMI10", "∂x3", true],
		[198, 209, 563, 573, 10, "FSUMJD+CMMI10", "∂u", false],
		[196, 211, 549, 559, 10, "FSUMJD+CMMI10", "∂x1", true],
		[215, 240, 556, 573, 10, "FSUMJD+CMMI10", "− ∂u", true],
		[226, 242, 549, 559, 10, "FSUMJD+CMMI10", "∂x2", true],
		[243, 293, 556, 580, 10, "KOUGOH+CMR10", ") + 2 ∂2u", true, 574],
		[269, 301, 549, 559, 10, "FSUMJD+CMMI10", "∂x2∂x3", true],
		[304, 326, 563, 580, 10, "FSUMJD+CMMI10", "( ∂u", false, 574],
		[312, 328, 549, 559, 10, "FSUMJD+CMMI10", "∂x3", true],
		[333, 345, 563, 573, 10, "FSUMJD+CMMI10", "∂u", false],
		[331, 346, 549, 559, 10, "FSUMJD+CMMI10", "∂x2", true],
		[350, 375, 556, 573, 10, "FSUMJD+CMMI10", "+ ∂u", true],
		[361, 377, 549, 559, 10, "FSUMJD+CMMI10", "∂x1", true],
		[379, 386, 570, 580, 10, "JIWGEV+CMEX10", ")", true, 574],
		[389, 407, 556, 566, 10, "KOUGOH+CMR10", "= 0,", true],
		[72, 431, 525, 536, 10, "KOUGOH+CMR10", "which is the nonparametric formulation for a hypersurface in C2 with vanishing", false],
		[72, 363, 513, 523, 10, "KOUGOH+CMR10", "L ́evi’s form. Note that in this example F = − trace(A(p)X) where", true],
		[153, 184, 477, 487, 10, "KOUGOH+CMR10", "A(p) =", true],
		[204, 339, 487, 500, 10, "ZFEOEJ+CMR7", "1 + p23 0 p3p1 − p2", true],
		[215, 339, 475, 488, 10, "ZFEOEJ+CMR7", "0 1 + p23 p3p2 + p1", true],
		[197, 334, 463, 476, 10, "ZFEOEJ+CMR7", "p3p1 − p2 p3p2 + p1 p21 + p22", true],
		[72, 253, 441, 451, 10, "KOUGOH+CMR10", "so that A ≥ 0 but det(A(p)) = 0 for all p.", true],
		[72, 431, 422, 432, 10, "KOUGOH+CMR10", "Example 1.6. Hamilton-Jacobi-Bellman and Isaacs equations. Hamilton-Jacobi-", false],
		[72, 431, 410, 420, 10, "KOUGOH+CMR10", "Bellman and Isaacs equations are, respectively, the fundamental partial differential", false],
	]), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text.slice(0, 40)]));
	const prose = units.find((u) => u.text.startsWith("which is the nonparametric"));
	assert.ok(prose && prose.kind === "text", `the prose after the formula is prose: ${got}`);
	const levi = units.find((u) => u.kind === "display" && u.text.includes("∂x21"));
	assert.ok(levi && !levi.text.includes("which"), `and not part of the formula: ${got}`);
	assert.ok(levi.rects.every((r) => r[1] >= prose.rects[0][3] - 0.5), `whose band stops above it: ${JSON.stringify(levi.rects)}`);
	assert.ok(units.some((u) => u.kind === "display" && u.text.startsWith("A(p)")), `the matrix is its own formula: ${got}`);
}

// A number crowded by a wide display still numbers it, while a list item's
// label, followed by words, is still part of its item.
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const units = segmentPage(layout([
		{ text: "where all the coefficients are bounded with respect to the parameters in question here,", x: 72, y: 290, size: 10 },
		{ text: "and the operators are proper for every choice of them, as we assume from now on. Then", x: 72, y: 278, size: 10 },
		{ text: "we consider the operator given by", x: 72, y: 266, size: 10, para: true },
		{ pieces: [{ text: "(1.9)", x: 72 }, { text: "«L»~«α»,«β»~«u» «=» «−»", x: 101 }], y: 245, size: 10, mathFont: CM, para: true },
		{ text: "«a»~«ij»~(«x»)«∂»~«ij»~«u» «+» «b»~«i»~(«x»)«∂»~«i»~«u» «+» «c»(«x»)«u» «−» «f»(«x»)", x: 172, y: 245, size: 10, mathFont: CM, para: true },
		{ text: "where all the coefficients are bounded with respect to the parameters in question.", x: 72, y: 211, size: 10, para: true },
		{ text: "(1) every cycle bounds a face, and the bound is sharp in the plane.", x: 72, y: 190, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	assert.ok(units.some((u) => u.kind === "display" && !u.text.includes("(1.9)")), `the number is dropped: ${got}`);
	assert.ok(units.some((u) => u.text.startsWith("(1) every cycle")), `the list label stays: ${got}`);
}

// The raised number on the real page: no space at all between "(2.15)" and
// "(p", since the formula starts where the number, a line above it, ends.
{
	const PAGE = [0, 0, 612, 792];
	const units = segmentPage(fromReport([
		[72, 431, 689, 699, 10, "KOUGOH+CMR10", "When unraveled, the above considerations lead to the following conclusion. Let", false],
		[72, 431, 677, 688, 10, "KOUGOH+CMR10", "O be an N -submanifold of RN with boundary, xˆ ∈ ∂O, ∂O be twice differentiable", false],
		[72, 431, 664, 675, 10, "KOUGOH+CMR10", "at xˆ, ~n be the outward normal, T∂O(xˆ) be the tangent plane to ∂O at xˆ, and", false],
		[72, 431, 629, 639, 10, "KOUGOH+CMR10", "second fundamental form of ∂O at xˆ (oriented with the exterior normal to O)", false],
		[72, 219, 617, 628, 10, "KOUGOH+CMR10", "extended to RN by S~n = 0. Then", false],
		[72, 414, 591, 615, 10, "KOUGOH+CMR10", "(2.1{5)(p, X) ∈ J 2,+O φ(xˆ) if and only if either p = Dφ(xˆ) and D2φ(xˆ) ≤ X, or", true, 604],
		[97, 345, 578, 590, 10, "FSUMJD+CMMI10", "p = Dφ(xˆ) − λ~n, λ > 0 and P D2φ(xˆ)P ≤ P XP − λS.", true],
		[72, 431, 553, 568, 10, "KOUGOH+CMR10", "Noting that P ~n ⊗ ~nP = 0, we see that if (p, X) ∈ J2,+O u(xˆ), S ≤ 0, and λ > 0, then", true],
	], { raised: [5, 6], hangs: /[{]/ }), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text.slice(0, 40)]));
	const displays = units.filter((u) => u.kind === "display");
	assert.strictEqual(displays.length, 1, `one formula: ${got}`);
	assert.ok(displays[0].text.includes("either") && !displays[0].text.includes("2.1"), `both rows, no number: ${got}`);
	assert.ok(units.some((u) => u.kind === "text" && u.text.endsWith("Then")), `Then ends its sentence: ${got}`);
}

// --- a glyph with no character, mid-line ---------------------------------------------

// "N_n ≍ n⁹": the ≍ arrives as nothing at all, leaving a gap wider than a word
// space in the middle of the line. Only a column's gulf is a reason to break a
// line's highlight in two.
{
	const CM = "UVFEFX+CMMI10";
	const unit = segmentPage(layout([
		{ pieces: [
			{ text: "number of 12-subsets grows like «n»^12^ while «N»~n~", x: 82 },
			{ text: "«n»^9^; see [4, §2].", x: 319 },         // 15pt on from N_n
		], y: 351, size: 10.9, mathFont: CM, para: true },
	]), VIEW).sentence[0];
	assert.strictEqual(unit.rects.length, 1, `one line, one box: ${JSON.stringify(unit.rects.map((r) => r.map(Math.round)))}`);
}

// --- a run-in numbered paragraph is not a hanging list item ----------------------------

// "3. Gibbs measures with spectral potentials. In Section 5 we replace the
// uniform target / by" and then a displayed formula, set in. A list item's
// continuation hangs under its text; this paragraph's second line is back at
// the margin, so the formula set in under it is a formula, not more of it.
{
	const PAGE = [0, 0, 612, 792];
	const units = segmentPage(fromReport([
		[82, 530, 430, 440, 10.9, "GGLDKP+SFRM1095", "size-varying chain and, in our view, the reason to prefer it. The price is that w must be", false],
		[82, 530, 417, 427, 10.9, "GGLDKP+SFRM1095", "chosen so that the chain does not spend almost all of its time at the wrong sizes; choosing", false],
		[82, 530, 389, 399, 10.9, "GGLDKP+SFRM1095", "Wang–Landau scheme [29]. Correctness does not depend on the quality of w; only efficiency", false],
		[82, 106, 376, 386, 10.9, "GGLDKP+SFRM1095", "does.", true],
		[82, 530, 359, 368, 10.9, "HBVJLZ+SFBX1095", "3. Gibbs measures with spectral potentials. In Section 5 we replace the uniform target", false],
		[82, 94, 346, 355, 10.9, "GGLDKP+SFRM1095", "by", true],
		[138, 213, 323, 341, 10.9, "UVFEFX+CMMI10", "πβ,k(X) := 1", true],
		[200, 219, 315, 326, 10.9, "EZVZGK+CMMI8", "Zβ,k", true],
		[225, 368, 323, 336, 10.9, "UVFEFX+CMMI10", "exp(−β pk(X)), pk(X) :=", true],
		[388, 530, 322, 336, 10.9, "UVFEFX+CMMI10", "λi(X)k = tr(AkX), (4)", true],
		[82, 530, 298, 308, 10.9, "GGLDKP+SFRM1095", "the potential being the Newton polynomial (power sum) of degree k of the adjacency spectrum,", false],
	]), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text.slice(0, 50)]));
	assert.ok(units.some((u) => u.kind === "text" && u.text.endsWith("uniform target by")), `the sentence stops at "by": ${got}`);
	assert.ok(units.some((u) => u.kind === "display" && u.text.includes("exp")), `and the formula is a formula: ${got}`);
}

// --- a table row with narrower gaps than the rows around it -----------------------------

// Its cells are closer together than the wide-gap test allows, so on its own
// it is a line of text; between two rows of the same table it is a row.
{
	const PAGE = [0, 0, 612, 792];
	const row = (y, cells, extra = {}) => ({ pieces: cells.map(([x, text]) => ({ x, text })), y, size: 10.9, ...extra });
	const units = segmentPage(layout([
		// Rows 1 and 3 and the header have two cell gaps each wider than the
		// wide-gap test; row 2's cells are closer, one gulf and two lesser gaps.
		row(700, [[221, "state space"], [310, "moves"], [370, "irreducible?"], [460, "cost/step"]], { para: true }),
		row(676, [[105, "Alg. 1 (Section 3)"], [221, "Omega"], [300, "AjAi"], [340, "hypothesis"], [460, "O(n2) tests"]], { para: true }),
		row(659, [[105, "Alg. 2 (Algorithm 4.2)"], [238, "Omega"], [304, "AjAi"], [346, "hypothesis (weaker)"], [460, "O(n2) tests"]], { para: true }),
		row(642, [[105, "Alg. 3 (Algorithm 4.4)"], [228, "sqcup Omega"], [300, "Ai"], [340, "theorem"], [460, "O(n) tests"]], { para: true }),
		{ text: "Table 2. The three chains. All three are reversible with the correct conditional", x: 118, y: 622, size: 10.9 },
		{ text: "law; they differ in whether irreducibility is assumed or proved.", x: 118, y: 609, size: 10.9, para: true },
	], PAGE), PAGE).sentence;
	const alg2 = units.find((u) => u.text.startsWith("Alg. 2"));
	assert.ok(alg2 && alg2.text.includes("tests"), `row 2 is one row: ${JSON.stringify(units.map((u) => u.text))}`);
	assert.strictEqual(alg2.rects.length, 1, `drawn as one band: ${JSON.stringify(alg2.rects.map((r) => r.map(Math.round)))}`);
}

// --- a formula's second half, carrying words, on the formula's own baseline --------------

// "p_k(X) = ∑_{v∈V(X)} ν_k(X, v),   ν_k(X, v) := #{closed k-walks based at v},"
// arrives as the formula's head and a separate line for the rest, which has
// italic words in it. It starts in the middle of the column, on the baseline
// of the formula before it: no line of prose starts there.
{
	const PAGE = [0, 0, 612, 792];
	const units = segmentPage(fromReport([
		[82, 530, 304, 314, 10.9, "GGLDKP+SFRM1095", "of [4] makes the character ranges of consecutive Ωn disjoint, which combines particularly well", false],
		[82, 530, 291, 301, 10.9, "MALVTH+SFTI1095", "Proposition 5.6 (The spectral potentials are local). For every k and every graph X of maximal", false],
		[82, 123, 278, 288, 10.9, "MALVTH+SFTI1095", "degree 3,", true],
		[137, 177, 257, 268, 10.9, "IBBQMF+CMR10", "pk(X) =", true],
		[188, 204, 268, 272, 10.9, "SPBXXP+CMEX10", "∑", true, 272],
		[180, 211, 245, 252, 8, "EZVZGK+CMMI8", "v∈V (X)", true],
		[213, 475, 257, 268, 10.9, "MALVTH+SFTI1095", "νk(X, v), νk(X, v) := #{closed k-walks based at v},", true],
		[82, 530, 225, 238, 10.9, "MALVTH+SFTI1095", "and νk(X, v) is determined by the ball of radius bk/2c around v and satisfies νk(X, v) ≤ 3k.", false],
		[82, 530, 212, 225, 10.9, "MALVTH+SFTI1095", "Consequently, suppose X′ is obtained from X by replacing a patch ΠX by a patch ΠX′ with the", false],
	], { hangs: /∑/ }), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text.slice(0, 50)]));
	const display = units.find((u) => u.kind === "display");
	assert.ok(display && display.text.includes("closed k-walks"), `the formula is whole: ${got}`);
	assert.ok(units.some((u) => u.kind === "text" && u.text.startsWith("and νk")), `and the prose after it is its own: ${got}`);
}

// --- the flow model ---------------------------------------------------------------

// Prose is what stands on the paragraph's margins; formulas are what is set off
// them. One page carrying each shape the rules used to be argued case by case.
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const P = (text, y, extra = {}) => ({ text, x: 72, y, size: 10, ...extra });
	const units = segmentPage(layout([
		P("We will record here many examples of degenerate elliptic equations and note how they", 700),
		P("arise, which is proper if the matrix is nonnegative and b is nondecreasing in its argument.", 688),
		// a line of prose that is mostly formula, at the margin
		P("corresponds to max[«F»(«x», «u», «Du»), |«Du»| «−» «g»(«x»)] «=» 0 «≤» «h»(«x»), «x» «∈» «Ω».", 676, { mathFont: CM, para: true }),
		{ text: "Two relevant special cases are the following ones, which we treat in turn below here", x: 84, y: 664, size: 10 },
		P("and state without any further proof, since both of them are quite standard by now:", 652, { para: true }),
		// a numbered display with a condition in words, its number close
		{ pieces: [{ text: "(2.4)", x: 72 }, { text: "«F»(«x», «u»(«x»), «p», «X») «≤» 0 for all «x» «∈» «O» and («p», «X») «∈» «J»(«x»)", x: 119 }],
			y: 632, size: 10, mathFont: CM, para: true },
		P("and a function is a solution when both hold; notice that with these normalizations we put", 612),
		// a cross-reference opening a line of prose
		P("(2.13) to find «λ»(«Z», «x») «≤» «o»(|«x»|^2^) or «λZ» «≤» «PXP» where the projection is as above", 600, { mathFont: CM }),
		P("and it is not hard to see that this is also quite sufficient for the claim made. Then", 588),
		// a short last line with no words at all
		P("«u» «≤» «v» in «Ω».", 576, { mathFont: CM, para: true }),
		// cases branches carrying words, beside a brace
		{ text: "«F»(«x», «r», «p», «X») «=»", x: 140, y: 548, size: 10, mathFont: CM, para: true },
		{ pieces: [{ text: "{", x: 206, dy: 7.5, raw: true, font: "JIWGEV+CMEX10" }, { text: "«−» det(«X») «+» «f»(«x») if «X» «≥» 0,", x: 217, dy: 6 }],
			y: 548, size: 10, mathFont: CM, para: true },
		{ text: "«+∞» otherwise;", x: 217, y: 540, size: 10, mathFont: CM, para: true },
		P("the operator is then degenerate elliptic, which follows from the fact that the determinant", 520),
		P("is nondecreasing on nonnegative matrices, and from the list of properties that follows here:", 508, { para: true }),
		// list items full of formulas
		{ text: "(i) We have «Z» «∈» «D»([0, «τ»], «R»^«d»^) and «I» «∈» «D»([0, 1]; «L»(«R»^«d»^)), with proba-", x: 88, y: 492, size: 10, mathFont: CM },
		{ text: "bility one, as the construction shows.", x: 104, y: 480, size: 10, para: true },
		{ text: "(ii) We have that «IZ» «∈» «D»([0, «τ»], «L»(«R»^«d»^)) and «IZ» «=» («IZ», «∂IZ»).", x: 88, y: 466, size: 10, mathFont: CM, para: true },
		P("The proof of both statements is postponed to the next section, where it is carried out.", 446, { para: true }),
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text.slice(0, 40)]));
	const kindOf = (has) => { const u = units.find((unit) => unit.text.includes(has)); return u && u.kind; };
	assert.strictEqual(kindOf("corresponds to max"), "text", `prose crowded with formula: ${got}`);
	assert.strictEqual(kindOf("for all x ∈ O"), "display", `a numbered display with words: ${got}`);
	assert.ok(!units.some((u) => u.text.includes("(2.4)")), `its number is dropped: ${got}`);
	assert.strictEqual(kindOf("(2.13) to find"), "text", `a cross-reference in prose: ${got}`);
	assert.ok(units.some((u) => u.kind === "text" && u.text.endsWith("Then u ≤ v in Ω.")), `a short last line: ${got}`);
	assert.strictEqual(kindOf("otherwise"), "display", `a branch with a word: ${got}`);
	assert.strictEqual(kindOf("(i) We have"), "text", `a list item full of formula: ${got}`);
	assert.strictEqual(kindOf("(ii) We have"), "text", `and its sibling: ${got}`);
}

// --- what a formula detector found the rules getting wrong --------------------------

// Run against a neural formula detector on the corpus, the flow model was wrong
// in a handful of recurring ways. One page each.
{
	const PAGE = [0, 0, 612, 792];
	const CM = "FSUMJD+CMMI10";
	const P = (text, y, extra = {}) => ({ text, x: 72, y, size: 10, ...extra });
	const units = segmentPage(layout([
		P("The fundamental solution satisfies the heat equation on the whole torus and therefore", 700),
		P("the estimates of the previous section apply to it verbatim, with the same constants too.", 688, { para: true }),
		// a paragraph's first line at an indent no full line has shown yet, before a display
		{ text: "For «s» «∈» [0, 1], we define the subspace «H»~«s»~ of «H» by", x: 89, y: 668, size: 10, mathFont: CM, para: true },
		{ text: "«H»~«s»~ «=» span{«q» «≤» «s»}", x: 230, y: 648, size: 10, mathFont: CM, para: true },
		// "define" set with a ligature: still a word
		P("and for every such «s» we {fi}nally de{fi}ne the operator as the restriction of the whole one.", 628, { mathFont: CM, para: true }),
		// items of nothing but formula, their labels right-aligned
		{ text: "(I) ‖«A»~«t»~ «−» «A»~«s»~‖ «≤» «K»~1~|«t» «−» «s»|,", x: 97, y: 608, size: 10, mathFont: CM, para: true },
		{ text: "(II) ‖«E»(«A»~«t»~ «−» «A»~«s»~)‖ «≤» «K»~2~|«t» «−» «s»|,", x: 93, y: 592, size: 10, mathFont: CM, para: true },
		{ text: "(III) ‖«A»~«t»~‖ «≤» «K»~3~|«t» «−» «s»|.", x: 90, y: 576, size: 10, mathFont: CM, para: true },
		P("where the constants depend on nothing but the dimension and the exponents given above.", 556, { para: true }),
		// a named equation tag, at the left margin
		{ pieces: [{ text: "(PE)", x: 72 }, { text: "«u»~«t»~ «+» «F»(«t», «x», «u», «Du») «=» 0", x: 160 }], y: 536, size: 10, mathFont: CM, para: true },
		P("which is the parabolic equation we study in what remains of this section of the paper.", 516, { para: true }),
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text.slice(0, 40)]));
	const kindOf = (has) => { const u = units.find((unit) => unit.text.includes(has)); return u && u.kind; };
	assert.strictEqual(kindOf("we define the subspace"), "text", `an indented first line: ${got}`);
	assert.strictEqual(kindOf("span"), "display", `and the display under it: ${got}`);
	assert.strictEqual(kindOf("(II)"), "text", `a list of formulas with right-aligned labels: ${got}`);
	assert.ok(units.some((u) => u.kind === "display" && u.text.includes("F(t, x, u, Du) = 0") && !u.text.includes("(PE)")),
		`a named tag is dropped: ${got}`);
}

// A bibliography keyed by names and years reads an entry at a time; a citation
// opening a line of prose, or a formula opening with a bracket, is not a key.
assert.deepStrictEqual(texts([
	{ text: "[IS01] P. Imkeller and B. Schmalfuss. The conjugacy of stochastic and random equations.", x: 72, y: 700, para: true },
	{ text: "[Lê20] K. Lê. A stochastic sewing lemma and applications. Electron. J. Probab. 25, (2020).", x: 72, y: 686, para: true },
]), [
	"[IS01] P. Imkeller and B. Schmalfuss. The conjugacy of stochastic and random equations.",
	"[Lê20] K. Lê. A stochastic sewing lemma and applications. Electron. J. Probab. 25, (2020).",
]);
assert.deepStrictEqual(texts([{ text: "[GG24] for a general criterion. It is sharp.", para: true }]),
	["[GG24] for a general criterion.", "It is sharp."]);

// --- stacked cells, lists of settings, and a plot's labels -------------------

// A cell of several lines in brackets, beside one of a different number of
// lines and a row label level with neither: the lines fall into rows of their
// own, but the page hands the cell over line by line down its column and then
// goes back up for the next one. The group is one row.
{
	const PAGE = [0, 0, 595, 842];
	const size = 8;
	const at = (x, y, text) => ({ text, x, y, size, para: true });
	const group = (y, label) => [
		at(85, y, label),
		at(200, y + 5, "3x3, 64"), at(200, y - 5, "3x3, 64"),
		at(330, y + 10, "1x1, 64"), at(330, y, "3x3, 64"), at(330, y - 10, "1x1, 256"),
	];
	const units = segmentPage(layout([
		{ pieces: [{ x: 85, text: "layer" }, { x: 200, text: "18-layer" }, { x: 330, text: "50-layer" }], y: 720, size, para: true },
		{ pieces: [{ x: 85, text: "conv1" }, { x: 200, text: "7x7, 64" }, { x: 330, text: "7x7, 64" }], y: 705, size, para: true },
		...group(680, "conv2"),
		...group(645, "conv3"),
		{ text: "Table 1. Architectures for ImageNet.", x: 85, y: 615, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));
	for (const [label, other] of [["conv2", "conv3"], ["conv3", "conv2"]]) {
		const row = units.filter((u) => u.text.includes(label));
		assert.strictEqual(row.length, 1, `"${label}" is in one row: ${got}`);
		assert.strictEqual((row[0].text.match(/\d+x\d+/g) || []).length, 5, `with all five of its lines: ${got}`);
		assert.ok(!row[0].text.includes(other) && !row[0].text.includes("conv1"), `and none of the others: ${got}`);
	}
}

// A list of settings written out column by column — the names, then the
// values — comes over the same way, but its lines pair off row by row.
{
	const PAGE = [0, 0, 595, 842];
	const size = 10;
	const at = (x, y, text) => ({ text, x, y, size, para: true });
	const units = segmentPage(layout([
		{ pieces: [{ x: 85, text: "Setting" }, { x: 300, text: "MNLI" }, { x: 400, text: "SST-2" }], y: 720, size, para: true },
		at(85, 700, "Optimizer"), at(85, 686, "Warmup Ratio"), at(85, 672, "LR Schedule"),
		at(330, 700, "AdamW"), at(340, 686, "0.1"), at(335, 672, "Linear"),
		{ pieces: [{ x: 85, text: "Batch Size" }, { x: 300, text: "16" }, { x: 400, text: "32" }], y: 652, size, para: true },
		{ pieces: [{ x: 85, text: "Epochs" }, { x: 300, text: "30" }, { x: 400, text: "60" }], y: 638, size, para: true },
		{ text: "Table 2. The hyperparameters.", x: 85, y: 610, size, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));
	for (const [name, value] of [["Optimizer", "AdamW"], ["Warmup Ratio", "0.1"], ["LR Schedule", "Linear"]]) {
		const row = units.find((u) => u.text.includes(name));
		assert.ok(row && row.text.includes(value), `"${name}" reads with "${value}": ${got}`);
		assert.ok(["Optimizer", "Warmup Ratio", "LR Schedule"].every((n) => n === name || !row.text.includes(n)), `and is a row of its own: ${got}`);
	}
}

// A plot's tick labels and legend line up in rows and columns as well as a
// table's cells do. The caption under them says what they are.
{
	const PAGE = [0, 0, 595, 842];
	const at = (x, y, text, size = 7) => ({ text, x, y, size, para: true });
	const plot = (dx) => [at(80 + dx, 700, "60"), at(80 + dx, 680, "40"), at(200 + dx, 684, "34-layer"),
		at(110 + dx, 668, dx ? "ResNet-18" : "plain-18"), at(80 + dx, 660, "20"), at(200 + dx, 664, "18-layer")];
	const lines = [...plot(0), ...plot(250),
		at(90, 648, "0 10 20 30 40"), at(340, 648, "0 10 20 30 40"),
		{ text: "Figure 4. Training on ImageNet. Thin curves denote training error.", x: 72, y: 625, size: 10, para: true }];
	const units = segmentPage(layout(lines, PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));
	const legend = units.find((u) => u.text.includes("plain-18"));
	assert.ok(legend && !/ResNet-18|\b[246]0\b/.test(legend.text), `a legend entry is not a table row: ${got}`);
}

// A results table: a header in two lines, a heading across the table longer
// than a short row, and group headings centred over the rows they head.
{
	const PAGE = [0, 0, 595, 842];
	const size = 9;
	const row = (y, cells) => ({ pieces: cells.map(([x, text]) => ({ x, text })), y, size, para: true });
	const units = segmentPage(layout([
		{ text: "We compare with the published systems on the", x: 72, y: 812, size: 10 },
		{ text: "leaderboard, and with our own single models too.", x: 72, y: 800, size: 10, para: true },
		row(768, [[125, "System"], [210, "Dev"], [253, "Test"]]),
		row(758, [[200, "EM"], [224, "F1"], [244, "EM"], [268, "F1"]]),
		{ text: "Top Leaderboard Systems (Dec 10th, 2018)", x: 103, y: 743, size, para: true },
		row(733, [[83, "Human"], [203, "-"], [226, "-"], [241, "82.3"], [264, "91.2"]]),
		row(723, [[83, "#1 Ensemble - nlnet"], [203, "-"], [226, "-"], [241, "86.0"], [264, "91.7"]]),
		{ text: "Published", x: 163, y: 698, size, para: true },
		row(688, [[83, "BiDAF+ELMo (Single)"], [203, "-"], [219, "85.6"], [248, "-"], [264, "85.8"]]),
		row(678, [[83, "R.M. Reader (Ensemble)"], [197, "81.2"], [219, "87.9"], [241, "82.3"], [264, "88.5"]]),
		{ text: "Ours", x: 172, y: 662, size, para: true },
		row(652, [[83, "BERTBASE (Single)"], [197, "80.8"], [219, "88.5"], [248, "-"], [270, "-"]]),
		row(642, [[83, "BERTLARGE (Single)"], [197, "84.1"], [219, "90.9"], [248, "-"], [270, "-"]]),
		{ text: "Table 2: SQuAD 1.1 results. The BERT ensemble", x: 72, y: 615, size: 10 },
		{ text: "is 7x systems which use different pre-training.", x: 72, y: 603, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));
	const header = units.find((u) => u.text.includes("System"));
	assert.ok(header && header.text.includes("EM") && !header.text.includes("Top"), `the header's two lines are one row: ${got}`);
	assert.strictEqual(header.kind, "text", "and it is no formula");
	for (const heading of ["Top Leaderboard", "Published", "Ours"]) {
		const unit = units.find((u) => u.text.includes(heading));
		assert.ok(unit && !/\d\d\.\d/.test(unit.text), `"${heading}" heads its rows, a row of its own: ${got}`);
	}
}

// A label of two lines set between rows — "DeBERTa XXL / LoRA" beside the
// rows it names — is read with a row, but its rows stay rows, and no row's
// band lies over its neighbour's.
{
	const PAGE = [0, 0, 595, 842];
	const size = 8;
	const row = (y, name, values) => ({ pieces: [{ x: 160, text: name }, ...values.map((v, i) => ({ x: 250 + 45 * i, text: v }))], y, size, para: true });
	const units = segmentPage(layout([
		{ text: "The hyperparameters we used for each of the tasks in the benchmark are", x: 72, y: 790, size: 10 },
		{ text: "listed in the table below, one setting to a row, with the method to the left.", x: 72, y: 778, size: 10, para: true },
		row(740, "Method", ["MNLI", "SST-2", "MRPC", "CoLA"]),
		row(720, "Batch Size", ["8", "8", "32", "4"]),
		row(710, "# Epochs", ["5", "16", "30", "10"]),
		{ text: "DeBERTa XXL", x: 85, y: 705, size, para: true },
		row(700, "Learning Rate", ["1E-04", "6E-05", "2E-04", "1E-04"]),
		{ text: "LoRA", x: 95, y: 695, size, para: true },
		row(690, "Weight Decay", ["0", "0.01", "0.01", "0"]),
		row(680, "CLS Dropout", ["0.15", "0", "0", "0.1"]),
		{ text: "Table 10: The hyperparameters for DeBERTa XXL.", x: 72, y: 655, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));
	const rate = units.find((u) => u.text.includes("Learning Rate"));
	assert.ok(rate && !rate.text.includes("Weight Decay") && !rate.text.includes("Epochs"), `a label between rows does not join them: ${got}`);
	assert.ok(!units.some((u) => u.text === "DeBERTa XXL" || u.text === "LoRA"), `the label is read with a row: ${got}`);
	const bands = units.filter((u) => /Batch|Epochs|Learning|Weight|Dropout|DeBERTa XXL|LoRA/.test(u.text) && !u.text.startsWith("Table")).map((u) => u.rects[0]);
	assert.strictEqual(bands.length, 5, `five rows: ${got}`);
	for (let i = 0; i < bands.length; i++) for (let j = i + 1; j < bands.length; j++) {
		const overlap = Math.min(bands[i][3], bands[j][3]) - Math.max(bands[i][1], bands[j][1]);
		assert.ok(overlap <= 0.01, `bands of neighbouring rows do not overlap: ${JSON.stringify(bands)}`);
	}
}

// --- displays, and what only looks like them -------------------------------

// Each case sits in a paragraph of prose, so the page's margins are known.
{
	const prose = (y) => [
		{ text: "The update rule is chosen with some care, since the moment estimates are", x: 72, y, size: 10 },
		{ text: "biased towards zero in the first steps, and so we correct them before use.", x: 72, y: y - 12, size: 10 },
		{ text: "The effective step is then bounded by the chosen learning rate in each case.", x: 72, y: y - 24, size: 10, para: true },
	];
	const unit = (lines, needle) => segmentPage(layout(lines, [0, 0, 595, 842]), [0, 0, 595, 842]).sentence.find((u) => u.text.includes(needle));

	// A heading in small capitals: the lower-case letters are capitals set
	// smaller, on the baseline — words, not subscripts.
	const heading = unit([...prose(760), {
		pieces: [{ x: 72, text: "2.1" }, { x: 100, text: "A" }, { text: "DAM’S", size: 8 }, { text: " U" }, { text: "PDATE", size: 8 }, { text: " R" }, { text: "ULE", size: 8 }],
		y: 710, size: 10, para: true,
	}, ...prose(690)], "DAM");
	assert.strictEqual(heading && heading.kind, "text", `a small-caps heading is no formula: ${JSON.stringify(heading)}`);

	// A caption quoting a formula.
	const caption = unit([...prose(760), { text: "Figure 2: Graphical model, where «τ = [1, 3]».", x: 180, y: 710, size: 10, para: true }, ...prose(680)], "Figure 2");
	assert.strictEqual(caption && caption.kind, "text", `a caption is no formula: ${JSON.stringify(caption)}`);

	// Bulleted items that are formulas, or nearly: a list all the same.
	const items = segmentPage(layout([...prose(760),
		{ text: "• «Â = A + Ā»,", x: 90, y: 710, size: 10, para: true },
		{ text: "• «T̂ = T ⊗ S» and «T̂γ = T ⊗ R»,", x: 90, y: 696, size: 10, para: true },
		{ text: "• «Ĝ = G ⊗ H».", x: 90, y: 682, size: 10, para: true },
		...prose(662)], [0, 0, 595, 842]), [0, 0, 595, 842]).sentence.filter((u) => u.text.includes("•"));
	assert.ok(items.length >= 2 && items.every((u) => u.kind === "text"), `bulleted items are prose: ${JSON.stringify(items)}`);

	// A formula too long to centre, set flush left: its operator names — Ric
	// taking its argument straight after it — are no words of prose.
	const long = unit([...prose(760), { text: "where", x: 72, y: 718, size: 10, para: true },
		{ text: "«H(X, Y) = −∇R − 2(»Ric«(Y, X) − 4»Ric«(Y, Y) − ∇»Ric«(Y, X)) + 2|»Ric«(Y, ·)|² − 4∇»Ric«(X, X)»", x: 72, y: 698, size: 10, para: true },
		...prose(676)], "H(X, Y)");
	assert.strictEqual(long && long.kind, "display", `a flush-left formula with operator names is a display: ${JSON.stringify(long)}`);
}

// A running head with the page's number at one end — "34 Properties of the
// flow …" — is furniture, however long and lower-case its title.
{
	const PAGE = [0, 0, 595, 842];
	const units = segmentPage(layout([
		{ pieces: [{ x: 86, text: "34" }, { x: 275, text: "Properties of the flow of the driftless equation" }], y: 765, size: 10.9, para: true },
		{ text: "which shows the bound. We now turn to the second estimate, which is the harder", x: 86, y: 730, size: 10.9 },
		{ text: "of the two, and whose proof takes up the rest of this section of the article.", x: 86, y: 716, size: 10.9 },
		{ text: "It rests on the comparison principle proved in the previous section of it.", x: 86, y: 702, size: 10.9, para: true },
		{ pieces: [{ x: 86, text: "Properties of the flow of the driftless equation" }, { x: 498, text: "35" }], y: 40, size: 10.9, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));
	assert.ok(!units.some((u) => u.text.includes("Properties of the flow")), `running heads are dropped: ${got}`);
	assert.ok(units[0].text.startsWith("which shows the bound."), `the page starts with its text: ${got}`);
}

// --- IEEE two-column pages, Word lists and tables ------------------------------

// A list in a Word document, its items set off by dashes.
{
	const PAGE = [0, 0, 595, 842];
	const units = segmentPage(layout([
		{ text: "For every case the model produced three outputs, which were stored for the review:", x: 72, y: 760, size: 11, para: true },
		{ pieces: [{ x: 90, text: "- " }, { x: 108, text: "A predicted segmentation «S(x)»," }], y: 740, size: 11, para: true },
		{ pieces: [{ x: 90, text: "- " }, { x: 108, text: "A confidence score «C(x)»," }], y: 724, size: 11, para: true },
		{ pieces: [{ x: 90, text: "- " }, { x: 108, text: "The similarity between «S(x)» and the reference contour." }], y: 708, size: 11, para: true },
		{ text: "Cases were selected if they were flagged as low confidence by the model or the review.", x: 72, y: 686, size: 11, para: true },
	], PAGE), PAGE).sentence;
	const items = units.filter((u) => u.text.startsWith("-"));
	assert.ok(items.length === 3 && items.every((u) => u.kind === "text"), `dashed items are prose: ${JSON.stringify(units.map((u) => [u.kind, u.text]))}`);
}

// A regression table whose row labels are set as equations: its caption says
// it is a table.
{
	const PAGE = [0, 0, 595, 842];
	const size = 11;
	const row = (y, k, v) => ({ pieces: [{ x: 150, text: `«Treatment × Week~−${k}~»` }, { x: 390, text: v }], y, size, para: true });
	const units = segmentPage(layout([
		{ text: "Table A2. Parallel Trend Test", x: 74, y: 780, size, para: true },
		{ text: "Number of errors", x: 380, y: 760, size, para: true },
		row(740, 13, "0.050 (0.102)"), row(723, 12, "0.064 (0.081)"), row(706, 11, "0.061 (0.077)"), row(689, 10, "0.061 (0.074)"),
		{ text: "Note: SEs are clustered at the doctor level, and estimated with all control variables.", x: 78, y: 660, size: 9, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => [u.kind, u.text]));
	const rows = units.filter((u) => u.text.includes("Treatment"));
	assert.ok(rows.length === 4 && rows.every((u) => u.kind === "text" && /\(0\.\d+\)/.test(u.text)), `a named table's formula cells are rows: ${got}`);
}

// --- EPUB ----------------------------------------------------------------------

// A book's text comes from its document: blocks of text nodes, split into
// sentences by the same rules, each unit mapped back to the nodes it runs
// between. A tiny stand-in for the DOM is enough to walk.
{
	const el = (name, ...children) => {
		const node = { nodeType: 1, localName: name, isConnected: false, childNodes: children };
		children.forEach((c, k) => { c.parentElement = node; c.nextSibling = children[k + 1] || null; });
		node.firstChild = children[0] || null;
		return node;
	};
	const t = (text) => ({ nodeType: 3, nodeValue: text });
	const intro = t("It was a bright cold day in April, and the clocks were striking thirteen. Mr. ");
	const smith = t("Smith slipped   quickly through the glass doors.");
	const root = el("replaced-body",
		el("h1", t("Chapter One. The Beginning")),
		el("p", intro, el("em", smith)),
		el("ul", el("li", t("First item. And another one.")), el("li", t("Second item"))),
		el("p", t("Before a break."), el("br"), t("After it"), el("style", t("p{color:red}"))),
		el("div", t("Loose text "), el("p", t("inside a paragraph.")), t(" and after")),
	);
	const blocks = collectBlocks(root, null);
	assert.deepStrictEqual(blocks.map((b) => b.text), [
		"Chapter One. The Beginning",
		"It was a bright cold day in April, and the clocks were striking thirteen. Mr. Smith slipped quickly through the glass doors.",
		"First item. And another one.",
		"Second item",
		"Before a break. After it",
		"Loose text",
		"inside a paragraph.",
		"and after",
	], "blocks end where elements that are blocks start and end; styles are not read; spaces collapse");
	assert.deepStrictEqual(blockUnits(blocks[0], "sentence").map((u) => u.text), ["Chapter One. The Beginning"], "a heading is one unit");
	const units = blockUnits(blocks[1], "sentence");
	assert.deepStrictEqual(units.map((u) => u.text), [
		"It was a bright cold day in April, and the clocks were striking thirteen.",
		"Mr. Smith slipped quickly through the glass doors.",
	], "an abbreviation does not end a sentence across an element boundary");
	const second = units[1];
	assert.strictEqual(second.startNode, intro, "a unit starts in the node its first letter is in");
	assert.strictEqual(second.startOffset, intro.nodeValue.indexOf("Mr."));
	assert.strictEqual(second.endNode, smith, "and ends in the node of its last");
	assert.strictEqual(second.endOffset, smith.nodeValue.length, "just after its last character");
	assert.deepStrictEqual(blockUnits(blocks[2], "word").map((u) => u.text), ["First", "item.", "And", "another", "one."]);
	assert.deepStrictEqual(blockUnits(blocks[1], "paragraph").length, 1);
	const b = blockText([{ text: "  a  b " }, { text: "\n c", node: {} }]);
	assert.strictEqual(b.text, "a b c", "white space collapses across pieces and is trimmed");
}

// --- stops inside references and asides ----------------------------------------

{
	const text = "i (1) ‘You are great, Lord, and highly to be praised (Ps. 47: 2): great is your power and your wisdom is immeasurable’ (Ps. 146:5). Man, a little piece of your creation, desires to praise you, a human being ‘bearing his mortality with him’ (2 Cor. 4: 10), carrying with him the witness of his sin and the witness that you ‘resist the proud’ (1 Pet. 5:5). Nevertheless, to praise you is the desire of man.";
	const got = splitSentences(text, [], []).map(([a, b]) => text.slice(a, b));
	assert.deepStrictEqual(got.map((t) => t.slice(0, 12)), ["i (1) ‘You a", "Man, a littl", "Nevertheless"],
		`a stop inside a citation does not end the sentence: ${JSON.stringify(got)}`);
	const aside = "The bound is sharp. (See Section 8.2 for details.) At fixed ε it improves. Duke Math. J. 55 (1987), 369–384.";
	const parts = splitSentences(aside, [], []).map(([a, b]) => aside.slice(a, b));
	assert.deepStrictEqual(parts, ["The bound is sharp.", "(See Section 8.2 for details.)", "At fixed ε it improves.", "Duke Math. J. 55 (1987), 369–384."],
		`an aside ends where its bracket closes; a journal and its volume stay together: ${JSON.stringify(parts)}`);
	const ref = "Responses are smaller. Fig. 7 shows the deviations.";
	assert.strictEqual(splitSentences(ref, [], []).length, 2, "a sentence may still open with Fig. 7");
}

// --- what the audit turned up ----------------------------------------------

// A line broken at a hyphen carries the break on the hyphen, which is dropped
// from the text; the highlight must still stop at the end of the line.
{
	const PAGE = [0, 0, 612, 792];
	const units = segmentPage(layout([
		{ text: "Other notable differentiating characteristics of the method are listed", x: 72, y: 200, size: 10 },
		{ text: "below, where each one is described in turn and compared with the differ", x: 72, y: 188, size: 10, hyphen: true },
		{ text: "ent baselines that the literature offers for this particular task.", x: 412, y: 700, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const rects = units[0].rects;
	assert.ok(rects.every((r) => r[3] - r[1] < 40), `a hyphen at a line break is not a box over the whole page: ${JSON.stringify(rects)}`);
	assert.strictEqual(rects.length, 3, "one box a line");
}

// A tall inline fraction on one line reaches down into the band of the next;
// the two are still two lines, and their words keep the space between them.
{
	const PAGE = [0, 0, 612, 792];
	const units = segmentPage(layout([
		{ text: "An important property of the update rule is its careful choice of sizes.", x: 72, y: 300, size: 10, para: true },
		{ pieces: [{ x: 72, text: "Assuming «ε = 0», the effective step taken is «∆t = α ·»" }, { x: 330, text: "«m»", dy: 6 }, { x: 330, text: "«v»", dy: -13 }], y: 286, size: 10 },
		{ text: "The effective stepsize has two upper bounds in the cases below.", x: 72, y: 272, size: 10, para: true },
	], PAGE), PAGE).sentence;
	const got = JSON.stringify(units.map((u) => u.text));
	assert.ok(/mv The effective/.test(got), `two lines of prose are not read as one, their words running together: ${got}`);
}

// A glyph placed far off the page — one bad transform — must not size the
// column histogram by its coordinate, nor throw out of it.
{
	const PAGE = [0, 0, 612, 792];
	const lines = Array.from({ length: 8 }, (_, k) => ({ text: `Line ${k} of ordinary prose running the measure of the page.`, x: 72, y: 700 - 14 * k, size: 10 }));
	for (const x of [1e9, Infinity, NaN]) {
		const page = layout([...lines, { text: "stray", x: 100, y: 400, size: 10, para: true }], PAGE);
		for (const ch of page.slice(-5)) { ch.rect = [x, 400, x + 5, 410]; ch.inlineRect = ch.rect; }
		const started = Date.now();
		const units = segmentPage(page, PAGE).sentence;
		assert.ok(Date.now() - started < 2000, `a stray glyph at ${x} does not stall the page`);
		assert.ok(units.length >= 4, `and the page is still read: ${units.length} units`);
		assert.ok(units.every((u) => u.rects.every((r) => r.every(Number.isFinite))), "every box is a real rectangle");
	}
}

// Text the book hides is not read into the sentence beside it.
{
	const el = (name, style, ...children) => {
		const node = { nodeType: 1, localName: name, isConnected: true, style, childNodes: children };
		children.forEach((c, k) => { c.parentElement = node; c.nextSibling = children[k + 1] || null; });
		node.firstChild = children[0] || null;
		return node;
	};
	const t = (text) => ({ nodeType: 3, nodeValue: text });
	const root = el("replaced-body", null,
		el("p", null, t("The hallway smelt of boiled cabbage."), el("span", { display: "none" }, t("Skip to main content")), t(" At one end of it a poster.")),
	);
	const win = { getComputedStyle: (node) => ({ display: (node.style && node.style.display) || "inline", visibility: "visible" }) };
	const blocks = collectBlocks(root, win);
	assert.deepStrictEqual(blocks.map((b) => b.text), ["The hallway smelt of boiled cabbage. At one end of it a poster."],
		"hidden text is not part of the paragraph");
}

// The annotating shortcut. Zotero's reader and its main window have most of
// the keyboard already, so the one this takes has to be matched exactly:
// Alt/Option+H and nothing that merely looks like it.
{
	const key = (over) => Object.assign({ code: "KeyH", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, over);
	assert.ok(annotateKeyPressed(key({ altKey: true })), "the default shortcut fires");
	// On a Mac, Option+H types "˙" — the key code is what identifies it, and
	// the event's `key` is never looked at.
	assert.ok(annotateKeyPressed(Object.assign(key({ altKey: true }), { key: "˙" })), "and fires when Option has changed the character");
	assert.ok(!annotateKeyPressed(key({})), "a bare H types an H");
	assert.ok(!annotateKeyPressed(key({ altKey: true, shiftKey: true })), "an extra Shift is a different chord");
	assert.ok(!annotateKeyPressed(key({ altKey: true, ctrlKey: true })), "so is Ctrl-Alt-H, which the reader may want");
	assert.ok(!annotateKeyPressed(key({ altKey: true, metaKey: true })), "and Cmd+Alt+H is macOS hiding windows");
	assert.ok(!annotateKeyPressed(key({ code: "KeyU", altKey: true })), "another letter is another shortcut");
	// The other offered chords are matched only when they are the chosen one.
	assert.ok(!annotateKeyPressed(key({ ctrlKey: true, shiftKey: true })), "Ctrl+Shift+H is not the default");

	assert.strictEqual(keyLabel(ANNOTATE_KEYS[0][1]), "Alt+H");
	assert.strictEqual(keyLabel(null), "Off");
	// Every shortcut offered is one the matcher can recognise, and "off" means off.
	for (const [value, spec] of ANNOTATE_KEYS) {
		if (value === "off") { assert.strictEqual(spec, null); continue; }
		assert.ok(/^Key[A-Z]$/.test(spec.code), `${value} names a letter key`);
	}
	const pane = require("fs").readFileSync("prefs.xhtml", "utf8");
	const options = /id="sf-annotate-key">([\s\S]*?)<\/html:select>/.exec(pane);
	assert.ok(options, "the shortcut menu is in the Settings pane");
	const offered = [...options[1].matchAll(/value="([a-z-]+)"/g)].map((m) => m[1]);
	assert.deepStrictEqual(offered, ANNOTATE_KEYS.map(([value]) => value),
		"Settings offers the same shortcuts the reader menu does");
}

// The copy key is the platform's own, and nothing that merely looks like it:
// Cmd-Shift-C and Ctrl-Alt-C belong to other things.
{
	const key = (over) => Object.assign({ code: "KeyC", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, over);
	assert.ok(copyKeyPressed(key({ ctrlKey: true })), "the copy key is recognised");
	assert.ok(!copyKeyPressed(key({ ctrlKey: true, shiftKey: true })), "Ctrl+Shift+C is not it");
	assert.ok(!copyKeyPressed(key({ ctrlKey: true, altKey: true })), "nor Ctrl+Alt+C");
	assert.ok(!copyKeyPressed(key({ ctrlKey: true, metaKey: true })), "nor both modifiers at once");
	assert.ok(!copyKeyPressed(key({})), "and a bare C types a C");
	assert.ok(!copyKeyPressed(key({ ctrlKey: true, code: "KeyV" })), "paste is not copy");
}

// The key that brings the page back to the ruler. Alt/Option+J by default,
// and the pane offers what the plugin knows.
{
	const key = (over) => Object.assign({ code: "KeyJ", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, over);
	assert.ok(jumpKeyPressed(key({ altKey: true })), "the jump key fires");
	assert.ok(!jumpKeyPressed(key({})), "a bare J types a J");
	assert.ok(!jumpKeyPressed(key({ altKey: true, shiftKey: true })), "Shift makes it another chord");
	assert.ok(!jumpKeyPressed(key({ code: "KeyH", altKey: true })), "and Alt+H is the annotating key");
	assert.strictEqual(keyLabel(JUMP_KEYS[1][1]), "\\", "the bare backslash is shown as itself");

	const pane = require("fs").readFileSync("prefs.xhtml", "utf8");
	const options = /id="sf-jump-key">([\s\S]*?)<\/html:select>/.exec(pane);
	assert.ok(options, "the jump menu is in the Settings pane");
	const offered = [...options[1].matchAll(/value="([a-z-]+)"/g)].map((m) => m[1]);
	assert.deepStrictEqual(offered, JUMP_KEYS.map(([value]) => value),
		"Settings offers the same shortcuts the reader menu does");
}

// The key that turns the ruler on and off. It is listened for whether or not
// the ruler is running, so it must not be a chord any other key could be set
// to — hence the single choice.
{
	const key = (over) => Object.assign({ code: "KeyR", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }, over);
	assert.ok(toggleKeyPressed(key({ altKey: true })), "the toggle key fires");
	assert.ok(!toggleKeyPressed(key({})), "a bare R types an R");
	assert.ok(!toggleKeyPressed(key({ altKey: true, metaKey: true })), "Cmd+Alt+R is something else");
	assert.deepStrictEqual(TOGGLE_KEYS.map(([value]) => value), ["alt-r", "off"]);
	// No chord is offered by two of the shortcut settings at once.
	const chords = [...TOGGLE_KEYS, ...JUMP_KEYS, ...ANNOTATE_KEYS]
		.map(([, spec]) => spec && `${spec.code}/${spec.mod}/${spec.shift}/${spec.alt}`).filter(Boolean);
	assert.strictEqual(new Set(chords).size, chords.length, "no two shortcut settings offer the same chord");

	const pane = require("fs").readFileSync("prefs.xhtml", "utf8");
	const options = /id="sf-toggle-key">([\s\S]*?)<\/html:select>/.exec(pane);
	assert.ok(options, "the toggle menu is in the Settings pane");
	const offered = [...options[1].matchAll(/value="([a-z-]+)"/g)].map((m) => m[1]);
	assert.deepStrictEqual(offered, TOGGLE_KEYS.map(([value]) => value));
}

// The reader menu and the Settings pane offer the same three click modes.
{
	const pane = require("fs").readFileSync("prefs.xhtml", "utf8");
	const options = /id="sf-click">([\s\S]*?)<\/html:select>/.exec(pane);
	assert.ok(options, "the click menu is in the Settings pane");
	const offered = [...options[1].matchAll(/value="([a-z-]+)"/g)].map((m) => m[1]);
	assert.deepStrictEqual(offered, CLICK_MODES, "Settings offers the modes the plugin knows");
}

// Zotero's own eight annotation colours, in Zotero's own order: the digits in
// the popup have to pick what Alt-1..8 picks in the reader.
{
	assert.strictEqual(ANNOTATION_COLORS.length, 8);
	assert.strictEqual(ANNOTATION_COLORS[0][0], "#ffd400");
	for (const [hex, name] of ANNOTATION_COLORS) {
		assert.ok(/^#[0-9a-f]{6}$/.test(hex), `${name} is a colour Zotero will store`);
	}
	assert.deepStrictEqual(ANNOTATION_TYPES.map(([v]) => v), ["highlight", "underline"]);
}

// The popup goes under what is being annotated, and never off the window.
{
	const panel = { offsetWidth: 240, offsetHeight: 150, style: {} };
	const doc = { documentElement: { clientWidth: 1000, clientHeight: 700 } };
	placeAnnotate(doc, panel, { left: 300, right: 500, top: 200, bottom: 220 });
	assert.strictEqual(panel.style.left, "300px");
	assert.strictEqual(panel.style.top, "228px", "under the sentence");
	// A sentence near the bottom puts the popup above itself instead.
	placeAnnotate(doc, panel, { left: 300, right: 500, top: 640, bottom: 660 });
	assert.strictEqual(panel.style.top, "482px", "above the sentence");
	// And one at the right edge is pulled back inside.
	placeAnnotate(doc, panel, { left: 980, right: 995, top: 100, bottom: 120 });
	assert.strictEqual(panel.style.left, "752px", "inside the right edge");
	// With nothing to anchor to it still lands on the window.
	placeAnnotate(doc, panel, null);
	assert.strictEqual(panel.style.left, "380px");
	assert.strictEqual(panel.style.top, "70px");
}

console.log("all tests passed");
