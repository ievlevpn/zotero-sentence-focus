/* Sentence Focus — a Zotero plugin (bootstrapped, Zotero 7+).
 *
 * A reading ruler that moves a sentence at a time instead of a line at a time.
 * The hard part is deciding where a sentence ends in a typeset PDF, where a
 * period may be a decimal point, an abbreviation, a subscript inside a formula,
 * an author initial or a list label — and where one sentence is spread over
 * several lines, two columns and a display equation.
 *
 * The text comes from Zotero's own pdf.js fork, which hands out structured
 * per-character data (`pdfDocument.getPageData`). That already gives us line
 * breaks, paragraph breaks (from real layout analysis) and soft-hyphen flags,
 * so this file only has to add the parts Zotero doesn't do: math detection,
 * display-equation blocks and sentence boundaries.
 *
 * No build step: plain bootstrapped plugin. Zip the folder — see README.md.
 */

// --- preferences -----------------------------------------------------------

const PREF = (k) => `extensions.zotero.sentenceFocus.${k}`;
const DEFAULTS = {
	style: "tint",              // tint | underline | dim
	color: "#ffd23f",
	opacity: 38,                // percent
	padding: 100,               // percent of the built-in breathing room
	behind: true,               // blend so the highlight sits under the ink
	granularity: "sentence",    // word | line | sentence | paragraph
	autoScroll: "offscreen",    // never | offscreen | always
	scrollMargin: 30,           // percent of the viewer height to keep clear at the top
	mergeDisplay: false,        // fold display equations into the neighbouring sentence
	followClick: true,
};

function pref(key) {
	try {
		const v = Zotero.Prefs.get(PREF(key), true);
		if (v !== undefined && v !== null && v !== "") return v;
	} catch (e) { /* unset */ }
	return DEFAULTS[key];
}

// --- math detection --------------------------------------------------------

// Font names that only ever carry formula glyphs. LaTeX subsets fonts as
// "ABCDEF+CMMI10", so these are substring tests, not exact ones. The bare
// /math/ catches the whole modern OpenType family at once (LatinModernMath,
// NewCMMath, XITSMath, TeXGyrePagellaMath, CambriaMath, FiraMath, ...).
const MATH_FONT_RE = /cm(?:mi|sy|ex)|ms[ab]m|eu[fs]m|rsfs|bbold|stmary|wasy|[rt]tx(?:mi|sy|ex)|px(?:mi|sy)|mt2?(?:mi|sy|ex)|math/i;

// Symbol blocks that mean "formula" whatever font they came in.
function isMathCode(cp) {
	return (cp >= 0x2200 && cp <= 0x22ff)   // mathematical operators
		|| (cp >= 0x2190 && cp <= 0x21ff)   // arrows
		|| (cp >= 0x27c0 && cp <= 0x27ef)   // misc mathematical symbols A
		|| (cp >= 0x2980 && cp <= 0x2aff)   // misc mathematical symbols B / supplemental
		|| (cp >= 0x1d400 && cp <= 0x1d7ff) // mathematical alphanumeric symbols
		|| (cp >= 0x2100 && cp <= 0x214f)   // letterlike symbols
		|| cp === 0x00b1 || cp === 0x00d7 || cp === 0x00f7 || cp === 0x221e;
}

const GREEK = (cp) => (cp >= 0x0370 && cp <= 0x03ff) || (cp >= 0x1f00 && cp <= 0x1fff);

// `greekIsMath` is decided per page: in a Greek-language document the alphabet
// is prose, and treating it as math would suppress every sentence break.
function isMathChar(ch, greekIsMath) {
	if (ch.mathFont !== undefined ? ch.mathFont : MATH_FONT_RE.test(ch.font)) return true;
	const cp = ch.c.codePointAt(0);
	if (isMathCode(cp)) return true;
	return greekIsMath && GREEK(cp);
}

const RELATION_RE = /[=≠≤≥≈≃≅≡∼<>∈∉⊂⊆⊃⊇→↦⇒⇔∝∫∑∏]/;

// Operator names, set in roman inside a formula. `n_min ≤ m ≤ n_max` under a
// union sign is algebra, not a sentence with two words in it.
const MATH_WORDS = new Set(`
min max sup inf lim log ln exp sin cos tan cot sec csc sinh cosh tanh arcsin arccos arctan
arg det dim ker tr rank span deg gcd lcm mod hom diag sgn erf card supp ess
`.trim().split(/\s+/));

// --- abbreviations ---------------------------------------------------------

// A period after one of these is never a sentence end, whatever follows. The
// list leans on what actually appears mid-sentence in mathematical writing:
// "by Thm. 2.1", "see Fig. 3", "w.r.t. the measure", "cf. Section 4".
const ABBREV_NEVER = new Set(`
fig figs eq eqs eqn eqns ineq sec secs ch chap chaps app apps thm thms prop props
lem lems cor cors def defn defs rem rems ex exs alg algs tbl tab tabs ref refs
no nos vol vols pt pts p pp par pars col cols ln art
cf viz resp approx approximately const resp est incl excl
e.g i.e w.r.t s.t w.l.o.g w.p a.s a.e i.i.d q.e.d
dr prof mr mrs ms st jr sr mt messrs
univ dept inst inc ltd co corp assoc soc natl intl
vs v ca circa ibid op cit ed eds trans repr suppl rev
min max sup inf lim deg dim char var cov corr resp
jan feb mar apr jun jul aug sept sep oct nov dec
mon tue tues wed thu thurs fri sat sun
`.trim().split(/\s+/));

// These do end sentences, but only when something sentence-shaped follows.
const ABBREV_MAYBE = new Set(["etc", "al", "ff", "seq", "et"]);

// --- materialising the char stream ----------------------------------------

// Zotero hands back one object per glyph across an Xray boundary; reading the
// same property twice there is not free. Copy each glyph once into a plain
// object and let everything downstream work on those. This is also what makes
// the analysis testable from node: the pure functions below never touch Zotero.
//
// char in:  { c, rect, inlineRect, fontSize, fontName, bold, italic, baseline,
//             rotation, spaceAfter, lineBreakAfter, paragraphBreakAfter, ignorable }
function materialize(raw) {
	const out = [];
	let greek = 0, letters = 0;
	// Font names repeat glyph after glyph; the regexes that read them run once
	// per font. The cache lives for this call only, so it cannot grow across
	// the documents a session opens.
	const fonts = new Map();
	const fontFacts = (name) => {
		let facts = fonts.get(name);
		if (!facts) {
			facts = { math: MATH_FONT_RE.test(name), extension: EXTENSION_FONT_RE.test(name.replace(/^[A-Z]{6}\+/, "")) };
			fonts.set(name, facts);
		}
		return facts;
	};
	for (const ch of raw) {
		const c = ch.c;
		if (!c) continue;
		const rect = ch.rect;
		if (!rect) continue;
		const irect = ch.inlineRect || rect;
		const cp = c.codePointAt(0);
		if (/\p{L}/u.test(c)) {
			letters++;
			if (GREEK(cp)) greek++;
		}
		const font = ch.fontName || "";
		const facts = fontFacts(font);
		out.push({
			c,
			rect: [rect[0], rect[1], rect[2], rect[3]],
			irect: [irect[0], irect[1], irect[2], irect[3]],
			size: ch.fontSize || (rect[3] - rect[1]) || 10,
			font,
			mathFont: facts.math,
			extension: facts.extension,
			bold: !!ch.bold,
			italic: !!ch.italic,
			baseline: typeof ch.baseline === "number" ? ch.baseline : rect[1],
			rot: ch.rotation || 0,
			space: !!ch.spaceAfter,
			lineEnd: !!ch.lineBreakAfter,
			paraEnd: !!ch.paragraphBreakAfter,
			skip: !!ch.ignorable,
			math: false,
			marker: false,
		});
	}
	// A page that is mostly Greek letters is Greek prose, not algebra.
	const greekIsMath = !(letters > 40 && greek / letters > 0.2);
	for (const ch of out) ch.math = isMathChar(ch, greekIsMath);
	return out;
}

// --- lines -----------------------------------------------------------------

// A typed array sorts numbers natively, without a comparator call per step.
const median = (a) => {
	if (!a.length) return 0;
	const s = Float64Array.from(a).sort();
	return s[s.length >> 1];
};

const percentile = (a, p) => {
	if (!a.length) return 0;
	const s = Float64Array.from(a).sort();
	return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

// Split the page's glyphs into visual lines and measure each one: how much of
// it is formula, how many real words it has, and whether it carries a
// right-hand equation number.
//
// Zotero's own line breaks cannot be taken at face value. It ends a line
// wherever two consecutive glyphs fail an overlap test on their bottom edges,
// and a superscript followed by a glyph sitting on the maths axis — `k` then
// `=` — fails it: the superscript's foot is above the `=`, and the `=`'s foot
// is below the superscript. So `p_k(X)^k = tr(A)` comes back as two lines,
// and because the two pieces sit side by side rather than stacked, Zotero's
// paragraph heuristic marks the cut as a paragraph break as well. Mathematical
// papers are therefore full of lines chopped in half mid-formula. Stitching
// them back together first is what keeps a sentence from stopping at an `=`.
function charsToLines(chars) {
	const frags = [];
	let from = 0;
	for (let i = 0; i < chars.length; i++) {
		if (!chars[i].lineEnd && i !== chars.length - 1) continue;
		frags.push([from, i]);
		from = i + 1;
	}

	const merged = [];
	for (const frag of frags.flatMap((f) => unglueFormula(chars, f, frags))) {
		const prev = merged[merged.length - 1];
		if (prev && sameVisualLine(chars, prev, frag)) {
			stitch(chars, prev[1], frag[0]);
			prev[1] = frag[1];
		} else {
			merged.push(frag);
		}
	}

	const lines = [];
	for (const [a, b] of merged) {
		const line = makeLine(chars, a, b);
		if (line) lines.push(line);
	}
	return lines;
}

// A display set straight after a short last line can come back glued to it.
// A big operator with its limits is tall enough to overlap the band of the
// words before it, and Zotero, finding them on one line, hands over a single
// fragment — "integral ∫ t" — whose tail belongs to the formula below while
// the rest of that formula arrives as lines of its own. Prose never leaves a
// gulf of several ems inside a line, and what stands beyond this one carries
// no words and reaches above or below the type beside it: that is a formula
// piece, and it is cut free to join the rows it belongs to. The words must
// carry on the paragraph above — starting under its lines and following one
// that runs past the gulf — or they are part of the display itself, as
// "maximize" is before the sum it maximises.
function unglueFormula(chars, frag, frags) {
	const [a, b] = frag;
	for (let k = a; k < b; k++) {
		const left = chars[k];
		if (/\s/.test(left.c)) continue;
		let n = k + 1;
		while (n <= b && /\s/.test(chars[n].c)) n++;
		if (n > b) break;
		const size = left.size || 10;
		if (chars[n].rect[0] - left.rect[2] <= 3 * size) continue;
		if (!hasWord(chars, a, k) || hasWord(chars, n, b)) continue;
		let math = false;
		for (let i = n; i <= b; i++) if (chars[i].math) math = true;
		if (!math) continue;
		const L = rawBBox(chars, a, k), R = rawBBox(chars, n, b);
		const reach = Math.max(L[1] - R[1], R[3] - L[3]);
		if (reach < 0.3 * size) continue;
		const carriesOn = frags.some((f) => {
			const P = rawBBox(chars, f[0], f[1]);
			return P[1] > L[3] - 0.3 * size && P[1] < L[3] + 1.5 * size
				&& Math.abs(P[0] - L[0]) <= 2 * size && P[2] >= R[0];
		});
		if (!carriesOn) continue;
		left.lineEnd = true;
		left.paraEnd = true;
		left.space = false;
		// Zotero gave every glyph the band of the whole fragment; each part
		// gets back its own.
		for (const [from, to, box] of [[a, k, L], [n, b, R]]) {
			for (let i = from; i <= to; i++) {
				chars[i].irect[1] = box[1];
				chars[i].irect[3] = box[3];
			}
		}
		return [[a, k], ...unglueFormula(chars, [n, b], frags)];
	}
	return [frag];
}

// A run of three or more letters at the size of its neighbours, outside any
// formula font: a word of prose, not a variable or an operator name.
function hasWord(chars, from, to) {
	let run = 0;
	for (let i = from; i <= to; i++) {
		const ch = chars[i];
		if (!ch.math && ch.c.length === 1 && /\p{L}/u.test(ch.c)) {
			if (++run >= 3) return true;
		} else if (ch.c.length > 1 && /\p{L}/u.test(ch.c) && !ch.math) {
			return true;
		} else {
			run = 0;
		}
	}
	return false;
}

function rawBBox(chars, from, to) {
	let r = null;
	for (let i = from; i <= to; i++) {
		const q = chars[i].rect;
		if (!r) r = [q[0], q[1], q[2], q[3]];
		else {
			r[0] = Math.min(r[0], q[0]); r[1] = Math.min(r[1], q[1]);
			r[2] = Math.max(r[2], q[2]); r[3] = Math.max(r[3], q[3]);
		}
	}
	return r;
}

// Two consecutive fragments are one visual line when they sit in the same
// horizontal band and the second carries on where the first stopped. The width
// of the gap is what separates a formula cut — a word space at most — from the
// next column, which is a gutter away. The band test alone already rules out
// the common column case, where the foot of one column meets the head of the
// next.
function sameVisualLine(chars, a, b) {
	if (chars[a[0]].rot !== chars[b[0]].rot) return false;
	const A = rawBBox(chars, a[0], a[1]);
	const B = rawBBox(chars, b[0], b[1]);
	if (!A || !B) return false;
	const overlap = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
	const minHeight = Math.min(A[3] - A[1], B[3] - B[1]);
	if (minHeight <= 0 || overlap < 0.4 * minHeight) return false;
	const size = chars[b[0]].size || 10;
	// A small step back is allowed: TeX sometimes sets a script by moving left
	// again. Anything genuinely on its own line fails the band test above.
	return B[0] >= A[0] - 0.5 * size && B[0] <= A[2] + size;
}

// Zotero measures word spacing within a fragment, so the gap at a cut it made
// never got a space flag. Put it back, and drop the breaks that only existed
// because of the cut.
function stitch(chars, endOfPrev, startOfNext) {
	const a = chars[endOfPrev], b = chars[startOfNext];
	a.lineEnd = false;
	a.paraEnd = false;
	if (b.rect[0] - a.rect[2] > 0.2 * (a.size || 10)) a.space = true;
}

// A glyph's box is not its ink. Zotero's pdf.js fork gives every glyph the
// box from the font's descent to its ascent — capped at its cap height, and
// with a descent of more than half an em cut to a quarter. The fonts TeX sets
// its big delimiters and operators in hang their glyphs *below* the baseline
// and declare a cap height of next to nothing, so a brace comes back as a
// sliver across the top of its ink: the top is exact and the bottom is short by
// most of the glyph. Such a box is easy to tell from any other — its part above
// the baseline is a fraction of its part below.
//
// Not every such font gives itself away by its box: where it declares an
// ordinary height, the box stands on the baseline like a letter's, its top well
// above the ink. So the extension fonts are also known by name — cmex, txex,
// pxex, NewPXEX — and for any hanging glyph the top of the ink is taken at the
// baseline, not at the top of its box.
const EXTENSION_FONT_RE = /^(?:cm|lm|eu|tx|px|zpl|newtx|newpx|mt|stix)?ex[a-z]*\d*$/i;

function hangsBelowBaseline(ch) {
	if (ch.rot) return false;
	if (ch.extension !== undefined ? ch.extension : EXTENSION_FONT_RE.test(ch.font.replace(/^[A-Z]{6}\+/, ""))) return true;
	const above = ch.rect[3] - ch.baseline, below = ch.baseline - ch.rect[1];
	return below > 0 && above < 0.5 * below;
}

function hangingInkTop(ch) {
	return Math.min(ch.rect[3], ch.baseline + 0.1 * (ch.size || 10));
}

function makeLine(chars, from, to) {
	let text = "";
	let mathCount = 0, glyphs = 0;
	const sizes = [], bases = [];
	let rect = null;
	for (let i = from; i <= to; i++) {
		const ch = chars[i];
		if (!/\s/.test(ch.c)) {
			glyphs++;
			if (ch.math) mathCount++;
			sizes.push(ch.size);
			bases.push(ch.baseline);
		}
		text += ch.c;
		if (ch.space) text += " ";
		const r = ch.irect;
		if (!rect) rect = [r[0], r[1], r[2], r[3]];
		else {
			rect[0] = Math.min(rect[0], r[0]);
			rect[1] = Math.min(rect[1], r[1]);
			rect[2] = Math.max(rect[2], r[2]);
			rect[3] = Math.max(rect[3], r[3]);
		}
	}
	if (!glyphs || !rect) return null;
	// Nothing printable: the pieces an extensible brace or a large parenthesis
	// is built from come in a font of their own and map to no character at
	// all. They are no part of what is read — left among the lines, one
	// landing between the halves of a formula cuts it in two — but they are
	// part of what a formula *occupies*, so the geometry is kept.
	const blank = !/[\p{L}\p{N}\p{S}\p{P}]/u.test(text);
	// The line's body type, not its middle glyph. On `n_min ≤ m ≤ n_max` the
	// indices outnumber the letters they belong to, so the median size is the
	// size of a subscript — and against that ruler nothing on the line looks
	// like a subscript at all, which is how `n` and `min` came to be read as
	// the single four-letter word "nmin".
	const size = percentile(sizes, 0.75) || 10;
	const baseline = median(bases);
	// One pass over the line's letter runs settles two things at once: how many
	// real words it carries, and how much of it is formula material. Both are
	// judged without looking at a single font name, which is what carries
	// formula detection through the many journals that set their maths in a
	// Times or Palatino family — whose font names say nothing about maths, and
	// where `P`, `X` and `q` arrive looking exactly like italic prose.
	const formulaish = new Array(to - from + 1).fill(false);
	let textWords = 0;
	let runStart = -1;
	let runText = "";
	let runIsMath = true;
	const closeRun = (end) => {
		if (runStart < 0) return;
		const length = runText.length;
		const mark = () => { for (let k = runStart; k < end; k++) formulaish[k - from] = true; };
		// An operator's name — Ric, Hess, tr — is set in roman like a word, but
		// takes its argument straight after it, "Ric(Y, X)", "Hess_L(Y, Y)": no
		// word of prose runs into a parenthesis.
		let next = end;
		if (!chars[end - 1].space) {
			while (next <= to && chars[next].size < 0.85 * size && chars[next].baseline < baseline - 0.1 * size && !chars[next].space) next++;
		}
		const operator = !chars[end - 1].space && next <= to && chars[next].c === "("
			&& (next === end || !chars[next - 1].space);
		if (length >= 2 && operator) { mark(); runStart = -1; runText = ""; runIsMath = true; return; }
		// One letter between non-letters is a variable; prose italicises whole
		// words. An operator name — min, max, log, det — is set in roman inside
		// a formula, and counting it as a word makes algebra look like prose.
		if (length === 1 || runIsMath || MATH_WORDS.has(runText.toLowerCase())) mark();
		else if (length >= 3) textWords++;
		runStart = -1;
		runText = "";
		runIsMath = true;
	};
	for (let i = from; i <= to + 1; i++) {
		const ch = i <= to ? chars[i] : null;
		// A glyph set smaller than the line is a script — an index, an exponent
		// — and is formula material in its own right. It also must not glue the
		// letters on either side of it into a word: `E_n` is a variable with an
		// index, not a two-letter run.
		// Small capitals are set smaller too, but on the line's baseline, where
		// no index or exponent sits: "ADAM’S UPDATE RULE" is words.
		const smallCap = !!ch && /\p{Lu}/u.test(ch.c) && Math.abs(ch.baseline - baseline) <= 0.05 * size;
		const script = !!ch && ch.size < 0.85 * size && !smallCap;
		// A ligature carries several characters in one glyph and is a word, so
		// length is what tells a variable from "ffi".
		const isLetter = !!ch && !script && ch.c.length === 1 && /\p{L}/u.test(ch.c);
		// A ligature inside a run of letters — the "fi" of "define" — is part of
		// that word; ending the run there left "de" and "ne", no word at all.
		const ligature = !!ch && !script && runStart >= 0 && ch.c.length > 1 && /^\p{L}+$/u.test(ch.c);
		if (ligature) {
			runText += ch.c;
			runIsMath = runIsMath && ch.math;
			if (ch.space) closeRun(i + 1);
			continue;
		}
		if (isLetter) {
			if (runStart < 0) { runStart = i; runText = ""; runIsMath = true; }
			runText += ch.c;
			runIsMath = runIsMath && ch.math;
			// Zotero hands over no space characters, only a flag on the glyph
			// before one: without closing the run there, "for all" was a single
			// six-letter word and a line of prose held one word per clause.
			if (ch.space) closeRun(i + 1);
			continue;
		}
		closeRun(i);
		if (script && ch && ch.c.trim()) formulaish[i - from] = true;
	}
	for (let i = from; i <= to; i++) {
		const ch = chars[i];
		if (/\s/.test(ch.c)) continue;
		if (ch.math || RELATION_RE.test(ch.c)) formulaish[i - from] = true;
	}
	const variableFrac = formulaish.filter(Boolean).length / glyphs;
	// Per glyph, what it counted as — kept so the fractions can be taken again
	// without an equation number once one is found (see markEquationNumbers).
	const glyphKinds = new Uint8Array(to - from + 1);
	for (let i = from; i <= to; i++) {
		if (/\s/.test(chars[i].c)) continue;
		glyphKinds[i - from] = 1 | (formulaish[i - from] ? 2 : 0) | (chars[i].math ? 4 : 0);
	}
	// Zotero normalises inline rects per fragment, so a line it cut has pieces
	// with mismatched bands. One band for the whole line keeps the highlight
	// from stepping up and down across a formula.
	for (let i = from; i <= to; i++) {
		const ir = chars[i].irect;
		ir[1] = rect[1];
		ir[3] = rect[3];
	}

	// Columns of a table show up as wide gaps inside one line, because where
	// the layout sees one baseline it gives one line, cells and all. Several
	// such gaps is a row; one of them is the run up to an equation number, and
	// justified prose never stretches a word space this far.
	let wideGaps = 0, lastGapAt = -1;
	// Cells at two scales. A gulf of two and a half ems is a column gap nobody
	// could take for anything else; a table of figures sets its columns much
	// closer — about an em — which is still three word spaces.
	const tightCells = [[chars[from].rect[0], chars[from].rect[2]]];
	for (let i = from + 1; i <= to; i++) {
		const r = chars[i].rect;
		if (/\s/.test(chars[i].c)) continue;
		const cell = tightCells[tightCells.length - 1];
		if (r[0] - cell[1] > 0.8 * size) tightCells.push([r[0], r[2]]);
		else { cell[0] = Math.min(cell[0], r[0]); cell[1] = Math.max(cell[1], r[2]); }
	}
	const cells = [[chars[from].rect[0], chars[from].rect[2]]];
	for (let i = from + 1; i <= to; i++) {
		const r = chars[i].rect;
		if (r[0] - chars[i - 1].rect[2] > 2.5 * size) {
			wideGaps++;
			lastGapAt = i;
			cells.push([r[0], r[2]]);
		} else {
			const cell = cells[cells.length - 1];
			cell[0] = Math.min(cell[0], r[0]);
			cell[1] = Math.max(cell[1], r[2]);
		}
	}

	// A contents entry is a row too: a title, then a dot leader or a gap, then
	// a page number. A leader is a run of full stops each followed by a space;
	// a bare number after a wide gap is a page number (an equation number is
	// bracketed, and is dealt with elsewhere).
	const leader = /(?:\.\s*){4,}/.test(text);
	let lastCell = "";
	if (lastGapAt >= 0) for (let i = lastGapAt; i <= to; i++) lastCell += chars[i].c;
	// The number stands alone in its cell: "the number, 16" ends a table row.
	// ...and what comes before it is a title, words rather than figures: "base
	// 6 512 2048 8 … 65" ends a row of a table.
	const title = text.slice(0, Math.max(0, text.length - lastCell.length));
	const pageNumber = wideGaps >= 1 && /^\s*\d{1,4}\s*$/.test(lastCell)
		&& (title.match(/\p{L}/gu) || []).length >= 0.5 * title.replace(/\s/g, "").length;

	// The top of the tallest glyph that hangs from its baseline, and where the
	// rest of the line stands — see displayBand for what they are needed for.
	let hangTop = null;
	const standing = [];
	// Opening delimiters among them, each with where it stands: a brace that
	// opens a cases formula (see absorbBraceRows).
	const hangingOpeners = [];
	for (let i = from; i <= to; i++) {
		const ch = chars[i];
		if (/\s/.test(ch.c)) continue;
		if (hangsBelowBaseline(ch)) {
			const top = hangingInkTop(ch);
			hangTop = hangTop === null ? top : Math.max(hangTop, top);
			if (OPENER_PIECE_RE.test(ch.c)) hangingOpeners.push({ left: ch.rect[0], right: ch.rect[2], top });
		} else {
			standing.push(ch.baseline);
		}
	}

	// Where a list item's text starts, after its label. Labels are set
	// right-aligned — "(i)" narrower than "(iii)" — so sibling items line up
	// there rather than at their left edges.
	let itemStart = null;
	const label = LIST_LABEL_RE.exec(text);
	if (label) {
		const labelGlyphs = label[0].slice(0, -1).replace(/\s/g, "").length;
		let seen = 0;
		for (let i = from; i <= to; i++) {
			if (/\s/.test(chars[i].c)) continue;
			if (seen === labelGlyphs) { itemStart = chars[i].rect[0]; break; }
			seen += chars[i].c.length;
		}
	}

	const line = {
		from, to, text, rect, size, baseline, wideGaps, cells, tightCells, hangTop, hangingOpeners, itemStart,
		standingBaseline: standing.length ? median(standing) : null,
		standingGlyphs: standing.length,
		tabular: wideGaps >= 2 || leader || pageNumber,
		// A contents entry is a title and a page number: two cells, not three.
		contents: leader || (pageNumber && wideGaps === 1),
		glyphKinds,
		mathFrac: mathCount / glyphs,
		variableFrac,
		formulaFrac: Math.max(mathCount / glyphs, variableFrac),
		textWords,
		hasRelation: RELATION_RE.test(text),
		paraEnd: chars[to].paraEnd,
		rot: chars[from].rot,
		bold: chars[from].bold,
		kind: "text",
		blank,
		furniture: blank,
		eqNumFrom: -1,
		eqNumTo: -1,
		leftLabelTo: -1,
		leftLabelGap: 0,
		leftLabelRaised: false,
		labelFrom: -1,
		labelGap: 0,
	};
	markEquationNumber(chars, line);
	markSuperscripts(chars, line);
	return line;
}

// "(2.1)" pushed out to the margin is a label, not part of the sentence. Find
// the last gap on the line and note what sits after it; whether that really is
// a label depends on where the column's right margin is, which is not known
// until the columns are, so the decision waits for markEquationNumbers.
function markEquationNumber(chars, line) {
	const { from, to } = line;
	for (let i = to; i > from; i--) {
		const gap = chars[i].rect[0] - chars[i - 1].rect[2];
		if (gap < 1.2 * line.size) continue;
		let tail = "";
		for (let j = i; j <= to; j++) tail += chars[j].c;
		if (EQ_LABEL_RE.test(tail.trim())) {
			line.labelFrom = i;
			line.labelGap = gap;
		}
		break; // only the last gap can hold a right-margin label
	}
	// Some styles set the number at the left margin instead, and there the
	// first gap is the one that matters. Where the formula is too wide for it,
	// the number is raised onto a line of its own above the formula — which
	// the layout still hands over as one line, sometimes with a brace from the
	// formula below landing in the middle of it: "(2.1{5)". So the pieces of a
	// big delimiter are passed over in reading the number, and a number raised
	// clear of what follows it needs no gap to be one.
	let head = "";
	const labelBases = [];
	for (let i = from; i < to; i++) {
		const ch = chars[i];
		if (!hangsBelowBaseline(ch)) {
			head += ch.c;
			if (ch.c.trim()) labelBases.push(ch.baseline);
		}
		if (head.trim().length > 16) break;
		const next = chars[i + 1];
		if (hangsBelowBaseline(next)) continue;
		const gap = next.rect[0] - ch.rect[2];
		// A raised number ends where the formula below it begins, with no space
		// between them; the step down in baseline is the break instead.
		const stepsDown = labelBases.length > 0 && median(labelBases) - next.baseline >= 0.5 * line.size;
		// On the left, an equation's number is bracketed in parentheses and has
		// a digit in it; "[IS01]" opening a bibliography entry is a key.
		if (EQ_LABEL_RE.test(head.trim()) && /^\s*\((?:.*\d.*|[A-Z][A-Za-z′']{0,4})\)\s*$/.test(head) && (gap >= 0.3 * line.size || stepsDown)) {
			const rest = [];
			for (let j = i + 1; j <= to; j++) {
				if (chars[j].c.trim() && !hangsBelowBaseline(chars[j]) && chars[j].size >= 0.85 * line.size) rest.push(chars[j].baseline);
			}
			line.leftLabelTo = i;
			line.leftLabelGap = gap;
			line.leftLabelRaised = rest.length > 0 && median(labelBases) - median(rest) >= 0.5 * line.size;
			break;
		}
		if (gap >= 1.2 * line.size) break;
	}
}

// Footnote and citation markers ("...holds.12 The next") read to a splitter as
// a decimal point. They are small, raised, and not part of a formula. Masking
// them out of the text is Zotero's own trick for its read-aloud segmentation.
//
// An exponent is small and raised too, and its digits are set in the roman
// text font — `h²`, `U^{k+1}` — so the font does not tell it from a marker.
// What does is what it is attached to: a marker follows a word or a stop, an
// exponent follows a variable or sits in a script with a variable or an
// operator in it.
function markSuperscripts(chars, line) {
	const raised = (ch) => ch.size <= 0.85 * line.size && ch.baseline >= line.baseline + 0.15 * line.size;
	for (let i = line.from; i <= line.to; i++) {
		const ch = chars[i];
		if (ch.math) continue;
		if (!/[\d*†‡§¶]/.test(ch.c)) continue;
		if (!raised(ch)) continue;
		if (isExponent(chars, line, i, raised)) continue;
		ch.marker = true;
	}
}

function isExponent(chars, line, i, raised) {
	let a = i, b = i;
	while (a > line.from && raised(chars[a - 1]) && !chars[a - 1].space) a--;
	while (b < line.to && !chars[b].space && raised(chars[b + 1])) b++;
	for (let k = a; k <= b; k++) {
		const c = chars[k];
		if (c.math || /[\p{L}+−=<>()]/u.test(c.c)) return true;
	}
	if (a === line.from || chars[a - 1].space) return false;
	const base = chars[a - 1];
	if (base.math) return true;
	// A variable set in the text font: one letter standing on its own.
	if (!/\p{L}/u.test(base.c) || base.c.length > 1) return /[)\]|]/.test(base.c) && hasMathBefore(chars, line, a - 1);
	const before = a - 2 >= line.from ? chars[a - 2] : null;
	return !before || before.space || !/\p{L}/u.test(before.c);
}

// A closing bracket that closes a formula — `(a+b)²` — rather than a remark.
function hasMathBefore(chars, line, close) {
	for (let k = close - 1; k >= line.from && k >= close - 40; k--) {
		const c = chars[k];
		if (/[(\[|]/.test(c.c)) return false;
		if (c.math || RELATION_RE.test(c.c) || /[+−]/.test(c.c)) return true;
	}
	return false;
}

// --- page geometry ---------------------------------------------------------

// Columns are found from vertical whitespace: bin the x axis, look for a run of
// empty bins away from the margins, and cut there. Two-column papers need this
// because "is this line indented?" only means anything within its own column.
function detectColumns(lines, viewBox) {
	const x0 = viewBox[0], x1 = viewBox[2];
	const whole = (ls) => ({ left: x0, right: x1, top: Infinity, bottom: -Infinity, lines: ls });
	// Text set at another angle keeps its own company: a stamp printed down the
	// margin is eighteen points wide and most of the page tall, and reading it
	// as part of the text would drag the measure out to the paper's edge.
	const text = lines.filter((ln) => !ln.rot);
	if (x1 - x0 <= 0 || text.length < 6) return finishRegions([whole(text.length ? text : lines)]);
	return finishRegions(cutRegions(text, x1 - x0, 0));
}

// Columns come in regions. A two-column paper sets a table or a figure across
// both columns, a title and an abstract above them — and a gutter that must run
// the height of the page is broken by every one of those. So the page is cut
// as a layout is built: down a gutter where there is one, and otherwise across
// a band of white space, but only where cutting across lets a gutter be found
// on one side of it. A page in one column is never cut at all, and comes back
// as the one region it always was.
//
// A gutter separates two bodies of text. The channel between a table's columns
// is white too, but what stands either side of it is not text: short pieces,
// not lines running most of their side's width.
function cutRegions(ls, pageWidth, depth) {
	const region = () => [{ left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity, lines: ls }];
	if (depth > 5 || ls.length < 6) return region();
	const v = verticalGutter(ls, pageWidth);
	if (v !== null) {
		const left = ls.filter((l) => centerX(l) < v), right = ls.filter((l) => centerX(l) >= v);
		return [...cutRegions(left, pageWidth, depth + 1), ...cutRegions(right, pageWidth, depth + 1)];
	}
	for (const y of horizontalGaps(ls).slice(0, 3)) {
		const top = ls.filter((l) => (l.rect[1] + l.rect[3]) / 2 > y), bottom = ls.filter((l) => (l.rect[1] + l.rect[3]) / 2 <= y);
		if (!top.length || !bottom.length) continue;
		const upper = cutRegions(top, pageWidth, depth + 1), lower = cutRegions(bottom, pageWidth, depth + 1);
		if (upper.length > 1 || lower.length > 1) return [...upper, ...lower];
	}
	return region();
}

function verticalGutter(ls, pageWidth) {
	const left = Math.min(...ls.map((l) => l.rect[0])), right = Math.max(...ls.map((l) => l.rect[2]));
	const width = right - left;
	if (width < 0.4 * pageWidth) return null;
	// One bin a point: a gutter between two columns can be as narrow as
	// seventeen points, and coarser bins lose it to rounding at both edges.
	const BINS = Math.max(1, Math.ceil(width));
	const cov = new Uint8Array(BINS);
	for (const ln of ls) {
		const a = Math.max(0, Math.floor(ln.rect[0] - left));
		const b = Math.min(BINS - 1, Math.ceil(ln.rect[2] - left));
		for (let i = a; i <= b; i++) cov[i] = 1;
	}
	// Only gaps in the middle are gutters; the rest are margins.
	let best = null, runStart = -1;
	const from = Math.floor(0.15 * BINS), to = Math.ceil(0.85 * BINS);
	for (let i = from; i <= to; i++) {
		if (!cov[i] && runStart < 0) runStart = i;
		if (cov[i] || i === to) {
			if (runStart >= 0 && (!best || i - runStart > best.w)) best = { at: (runStart + i) / 2, w: i - runStart };
			runStart = -1;
		}
	}
	if (!best || best.w < 8) return null;
	const x = left + best.at;
	const top = Math.max(...ls.map((l) => l.rect[3])), bottom = Math.min(...ls.map((l) => l.rect[1]));
	const minLines = Math.max(3, Math.ceil(ls.length * 0.15));
	for (const side of [ls.filter((l) => centerX(l) < x), ls.filter((l) => centerX(l) >= x)]) {
		if (side.length < minLines) return null;
		const span = Math.max(...side.map((l) => l.rect[3])) - Math.min(...side.map((l) => l.rect[1]));
		if (span < 0.5 * (top - bottom)) return null;
		const sideWidth = Math.max(...side.map((l) => l.rect[2])) - Math.min(...side.map((l) => l.rect[0])) || 1;
		// Enough of it runs its width: a column can hold a table of its own,
		// but half of a table split down its middle holds almost no long line.
		const long = side.filter((l) => l.rect[2] - l.rect[0] >= 0.6 * sideWidth).length;
		if (long < Math.max(3, 0.25 * side.length)) return null;
	}
	return x;
}

// Bands of white space running the full width, widest first.
function horizontalGaps(ls) {
	const sorted = [...ls].sort((a, b) => b.rect[3] - a.rect[3]);
	const heights = median(ls.map((l) => l.rect[3] - l.rect[1])) || 10;
	const gaps = [];
	let floor = sorted[0].rect[1];
	for (let i = 1; i < sorted.length; i++) {
		const l = sorted[i];
		if (l.rect[3] < floor - 0.8 * heights) gaps.push({ y: (floor + l.rect[3]) / 2, size: floor - l.rect[3] });
		floor = Math.min(floor, l.rect[1]);
	}
	return gaps.sort((a, b) => b.size - a.size).map((g) => g.y);
}

// Each region measured to the text it holds: its box, and nothing it does not.
function finishRegions(regions) {
	const cols = [];
	for (const r of regions) {
		if (!r.lines.length) continue;
		cols.push({
			left: Math.min(...r.lines.map((l) => l.rect[0])),
			right: Math.max(...r.lines.map((l) => l.rect[2])),
			bottom: Math.min(...r.lines.map((l) => l.rect[1])),
			top: Math.max(...r.lines.map((l) => l.rect[3])),
			members: new Set(r.lines),
		});
	}
	return cols;
}

const centerX = (ln) => (ln.rect[0] + ln.rect[2]) / 2;

// Set about the middle of its column. Displayed maths is; a line of prose that
// happens to start further in — a hanging indent — is not.
function isCentred(line) {
	const col = line.col;
	if (!col) return false;
	const width = (col.right - col.left) || 1;
	return Math.abs(centerX(line) - (col.left + col.right) / 2) < 0.06 * width;
}

function assignColumns(lines, cols) {
	for (const ln of lines) {
		// A line the cutting placed; otherwise — text at another angle, or a
		// page too short to cut — the region that holds its middle, or the first.
		ln.col = cols.find((c) => c.members.has(ln))
			|| cols.find((c) => centerX(ln) >= c.left && centerX(ln) <= c.right
				&& (ln.rect[1] + ln.rect[3]) / 2 >= c.bottom && (ln.rect[1] + ln.rect[3]) / 2 <= c.top)
			|| cols[0];
	}
	// The line sets are only needed to place lines; keeping them would hold every
	// line of the page for as long as its columns are referenced.
	for (const c of cols) delete c.members;
}

// Running heads, page numbers and footers: near a margin, short, no bigger
// than the body text, and standing apart from the block they border. All four
// conditions together, because dropping a real first line of prose — or the
// title of a paper, which is also short and near the top — is much worse than
// keeping a page number.
function markFurniture(lines, viewBox) {
	if (lines.length < 4) return;
	const height = viewBox[3] - viewBox[1];
	const bodySize = median(lines.map((l) => l.size));
	const topBand = viewBox[3] - 0.1 * height;
	const bottomBand = viewBox[1] + 0.1 * height;

	for (const line of lines) {
		const inTop = line.rect[1] >= topBand;
		const inBottom = line.rect[3] <= bottomBand;
		if (!inTop && !inBottom) continue;
		if (line.size > 1.15 * bodySize) continue;          // a title, not a header
		// A formula set low on the page has every mark of a running head — it
		// is short, it sits in the margin band, and once its limits are read
		// as part of its own row it stands clear of the text above it. What it
		// is not is prose.
		if (line.formulaFrac >= 0.25) continue;
		const width = line.rect[2] - line.rect[0];
		const colWidth = (line.col ? line.col.right - line.col.left : viewBox[2] - viewBox[0]) || 1;
		// Short, or a bare number, or set without a single lower-case letter —
		// a running head is usually capitals or small capitals and can run most
		// of the measure, so width alone would miss it.
		const looksLikeFurniture = width < 0.6 * colWidth
			|| /^[\s\d.,|\u2013\u2014-]+$/.test(line.text)
			|| /^[^\p{Ll}]+$/u.test(line.text.trim());
		if (!looksLikeFurniture) continue;

		// Isolation, measured against the nearest line that is *not* on this
		// same row. A page number and the running head across from it are one
		// row, and each would otherwise vouch for the other being body text.
		let nearest = Infinity;
		for (const other of lines) {
			if (other === line) continue;
			const overlap = Math.min(other.rect[3], line.rect[3]) - Math.max(other.rect[1], line.rect[1]);
			if (overlap > 0) continue;
			const gap = other.rect[1] > line.rect[3]
				? other.rect[1] - line.rect[3]
				: line.rect[1] - other.rect[3];
			nearest = Math.min(nearest, gap);
		}
		if (nearest < 1.6 * line.size) continue;
		line.furniture = true;
	}
}


// A display equation is set apart from the prose around it: mostly formula
// glyphs, few real words, and either centred in its column or indented from
// it. Scored rather than hard-gated, so a centred one-line formula with no
// equation number and an indented multi-line one both land in the same place.
// A display too wide for its margin crowds its number: "(1.9) L_{α,β}u = −"
// leaves a space, not a gulf. A list item's label is followed by words; a
// number followed by nothing but formula numbers that formula.
function numbersFormula(line) {
	if (!/^\s*\([A-Z]?\.?\d{1,3}(?:\.\d{1,3}){0,2}[a-z]?\)/.test(line.text)) return false;
	let glyphs = 0, formula = 0;
	for (let i = line.leftLabelTo + 1; i <= line.to; i++) {
		const kind = line.glyphKinds[i - line.from];
		if (!kind) continue;
		glyphs++;
		if (kind & 2) formula++;
	}
	// A condition can follow — "for r ≥ s" — but the line is mostly formula.
	return glyphs >= 2 && formula / glyphs >= 0.5 && line.textWords <= 3;
}

function remeasureWithoutNumber(line) {
	const start = line.eqNumTo >= 0 ? line.eqNumTo + 1 : line.from;
	const end = line.eqNumFrom >= 0 ? line.eqNumFrom - 1 : line.to;
	let glyphs = 0, formula = 0, math = 0;
	for (let i = start; i <= end; i++) {
		const kind = line.glyphKinds[i - line.from];
		if (!kind) continue;
		glyphs++;
		if (kind & 2) formula++;
		if (kind & 4) math++;
	}
	if (!glyphs) return;
	line.mathFrac = math / glyphs;
	line.variableFrac = formula / glyphs;
	line.formulaFrac = Math.max(line.mathFrac, line.variableFrac);
}

function classifyLine(line) {
	// Words once meant prose here when they were undercounted three to one;
	// counted properly, a formula's condition — "if and only if either" —
	// carries several, and a numbered line is a formula whatever it says.
	const numbered = line.eqNumFrom >= 0 || line.eqNumTo >= 0;
	if (line.formulaFrac < 0.25 || (line.textWords >= (numbered ? 8 : 6))) return "text";
	const col = line.col || { left: line.rect[0], right: line.rect[2] };
	const colWidth = (col.right - col.left) || 1;
	let score = 1;
	if (line.formulaFrac >= 0.5) score++;
	if (line.hasRelation) score++;
	if (line.rect[0] - col.left > 1.5 * line.size) score++;
	if (isCentred(line)) score++;
	if (line.textWords <= 2) score++;
	// Nothing on the line is a word. A row of maths often reaches the reader in
	// pieces — "P(X,Z)," on its own, once the layout has cut the line at a
	// summation sign — and each piece has to stand on its own feet here, or it
	// falls through to prose and takes the paragraph below it with it.
	if (line.textWords === 0 && line.formulaFrac >= 0.4) score++;
	if (line.eqNumFrom >= 0 || line.eqNumTo >= 0) score += 2;
	return score >= 4 ? "display" : "text";
}

// "(3)" alone out at the right margin, level with a formula, is a label for it:
// not part of the formula and certainly not part of the paragraph underneath.
// `markEquationNumber` catches the ones that arrive inside the formula's own
// line; this catches the ones that arrive as a line of their own.
const EQ_LABEL_RE = /^[([]\s*[^()[\]]{1,14}\s*[)\]]$/;

// An equation number arrives in one of two shapes: at the end of the formula's
// own line, or as a line of its own. Both are settled here, where the columns
// are known — the right-hand margin is the thing that tells a label from a
// parenthesis, and a gap alone is not enough. Set tightly ("(3)" can sit only
// a few points clear of the formula), the gap test would strip ordinary
// parentheses; the margin is what makes the looser test safe.
function markEquationNumbers(lines) {
	let previous = null;
	for (const line of lines) {
		if (line.furniture) continue;
		const before = previous;
		previous = line;
		const col = line.col;
		const atRightMargin = !!col && line.rect[2] >= col.right - 0.06 * (col.right - col.left);
		const atLeftMargin = !!col && line.rect[0] <= col.left + 0.06 * (col.right - col.left);

		if (EQ_LABEL_RE.test(line.text.trim())) {
			const height = line.rect[3] - line.rect[1];
			const level = (other) => other !== line && !other.furniture && other.col === col
				&& Math.min(other.rect[3], line.rect[3]) - Math.max(other.rect[1], line.rect[1]) > 0.3 * height;
			// At the right margin, with the formula to its left; or at the left
			// margin with the formula a gulf to its right — a list label sits a
			// word space from its item.
			const hasRowMate = atRightMargin
				? lines.some((other) => level(other) && other.rect[2] <= line.rect[0])
				: atLeftMargin && lines.some((other) => level(other) && other.rect[0] >= line.rect[2] + 2.5 * line.size);
			if (hasRowMate) line.furniture = true;
			continue;
		}
		if (line.labelFrom >= 0 && (line.labelGap >= 2.5 * line.size || atRightMargin)) {
			line.eqNumFrom = line.labelFrom;
		}
		// A list label sits half an em from its item; an equation's number is
		// set well clear of its formula. A number, as opposed to "(a)" or "(iii)",
		// needs only a little more than an em to be taken for one.
		const numeric = /^\s*\([A-Z]?\.?\d{1,3}(?:\.\d{1,3}){0,2}[a-z]?\)/.test(line.text);
		const clear = line.leftLabelGap >= (numeric ? 1.2 : 2.5) * line.size;
		// A cross-reference opening a line of prose — "…we put (x̃, g(x̃)) into" /
		// "(2.13) to find λ⟨Zx̃, x̃⟩ ≤ …" — is followed by formula too, but the line
		// before it runs the measure and does not end there.
		const carriedOn = !!before && before.col === col && !before.paraEnd
			&& before.rect[2] >= col.right - 0.06 * (col.right - col.left);
		if (line.leftLabelTo >= 0 && atLeftMargin && (clear || line.leftLabelRaised || (numbersFormula(line) && !carriedOn))) {
			line.eqNumTo = line.leftLabelTo;
		}
		// The number's digits are no part of the formula, and on a short piece
		// — "(1.2) −", the rest of the row cut away at a summation sign — they
		// outnumber it enough to make it read as prose.
		if (line.eqNumFrom >= 0 || line.eqNumTo >= 0) remeasureWithoutNumber(line);
	}
}

// The band a row of displayed maths occupies. Pieces of one formula overlap
// each other or sit a hair apart — a summation's limits, a fraction's numerator
// and denominator — so they gather into one region; two rows of an align
// environment gather into one as well, which is what they are.
function displayRows(lines) {
	const rows = [];
	for (const line of lines) {
		if (line.furniture || line.kind !== "display") continue;
		rows.push({ col: line.col, rot: line.rot, rect: line.rect.slice(), size: line.size });
	}
	let merged = true;
	while (merged) {
		merged = false;
		for (let i = rows.length - 1; i > 0 && !merged; i--) {
			for (let j = i - 1; j >= 0; j--) {
				const a = rows[j], b = rows[i];
				if (a.col !== b.col || a.rot !== b.rot) continue;
				const gap = Math.max(a.rect[1], b.rect[1]) - Math.min(a.rect[3], b.rect[3]);
				if (gap > 1.6 * Math.max(a.size, b.size)) continue;
				a.rect = [
					Math.min(a.rect[0], b.rect[0]), Math.min(a.rect[1], b.rect[1]),
					Math.max(a.rect[2], b.rect[2]), Math.max(a.rect[3], b.rect[3]),
				];
				a.size = Math.max(a.size, b.size);
				rows.splice(i, 1);
				merged = true;
				break;
			}
		}
	}
	return rows;
}

// --- the flow of the text ---------------------------------------------------
//
// What a displayed formula is, is decided by how the page is set rather than
// by what the line looks like. Prose is set in a flow: a column of lines on
// the paragraph's own margins, one baseline-skip apart, each full line running
// the measure. A line on that flow carrying words is prose, however much of it
// is formula — "corresponds to max{F(x, u, Du, D²u), |Du| − g(x)} = 0.", "where
// A = D²φ(x̂) ∈ S(N)". Everything set off the flow — indented, centred, beside
// a brace, on a formula's baseline — that has any formula in it is a displayed
// formula, whatever words it carries: "otherwise", "trace", "closed k-walks".
// Numbered lines are always formulas, and so is a full line with no words in
// it at all.
//
// A margin is the flow's when the paragraph uses it: the column's own left
// edge; or a left edge shared, at the baseline skip, by lines one of which
// runs the measure — a list item's continuation, a first line's indent, a
// caption or quotation set narrower than the column, whose lines run to its
// own right edge.
//
// Where a column has too little prose to find its margins, the older rules
// that judge each line on its own are used instead.
function classifyByFlow(lines, cols) {
	const unmeasured = [];
	for (const col of cols) {
		const all = lines.filter((line) => line.col === col && !line.rot);
		const own = all.filter((line) => !line.furniture);
		if (!flowColumn(own, col, all)) unmeasured.push(...own);
	}
	const orphans = lines.filter((line) => !line.furniture && (line.rot || !cols.includes(line.col)));
	return unmeasured.concat(orphans);
}

function flowColumn(own, col, all = own) {
	const width = (col.right - col.left) || 1;
	const worded = (line) => line.textWords >= 1 && !line.tabular && line.eqNumFrom < 0 && line.eqNumTo < 0;
	const wide = own.filter((line) => worded(line) && line.rect[2] - line.rect[0] > 0.6 * width);
	if (wide.length < 3) return false;
	const left = median(wide.map((line) => line.rect[0]));
	const right = median(wide.map((line) => line.rect[2]));
	const size = median(wide.map((line) => line.size)) || 10;
	const pitches = [];
	for (let i = 1; i < own.length; i++) {
		const d = own[i - 1].baseline - own[i].baseline;
		if (wide.includes(own[i - 1]) && wide.includes(own[i]) && d > 0.9 * size && d < 1.8 * size) pitches.push(d);
	}
	const pitch = median(pitches) || 1.2 * size;

	const full = (line) => line.rect[2] >= right - size;
	// TeX sets its margins exactly; a formula that merely starts near one is
	// off by more than a point or two.
	// (A quarter of an em: an italic capital or an f overhangs its origin.)
	const onMargin = (x, m) => Math.abs(x - m) <= 0.25 * size;
	const sameLeft = (a, b) => onMargin(a.rect[0], b.rect[0]);
	const skip = (a, b) => {
		const d = a.baseline - b.baseline;
		return d > 0.75 * pitch && d < 1.35 * pitch;
	};
	for (const line of own) line.flow = false;
	// A formula too long to centre is set flush left and runs past the right
	// margin — "d/dτ ⟨∇_Y Y, X⟩ = … + 2Y·Ric(Y, X) − X·Ric(Y, Y)". Prose never
	// overruns the measure by an em, and an operator's name or two in it make
	// it no line of words.
	const overfull = (line) => line.rect[2] > right + size && line.textWords <= 2 && line.formulaFrac >= 0.5 && line.hasRelation;
	// On the column's margin, or on an indent some full line of prose starts
	// at: a paragraph's first line, a list item's continuation.
	// Only lines that are unmistakably prose establish a margin: a displayed
	// formula wide enough to run the measure would otherwise vouch for itself.
	const margins = [left];
	const prose = (line) => line.textWords >= 3 && line.formulaFrac < 0.35;
	for (const line of wide) {
		if (full(line) && prose(line) && line.rect[0] - left <= 4 * size && !margins.some((m) => onMargin(line.rect[0], m))) {
			margins.push(line.rect[0]);
		}
	}
	// A list item is prose however much formula it holds, and it is known by
	// its label: a label opening a full line, or opening a line at the same
	// place as another item's.
	// Items made of nothing but formula — "(I) ‖A_t − A_s‖ ≤ K₁|t − s|^β₁," — are
	// items too, when a sibling's text starts where theirs does.
	// Unless the list is itself a formula: items standing behind a brace, with
	// the equation's number to the left of them all — "(3.4) { (i) … (ii) …".
	// Nothing stands to the left of an item in a list of prose.
	const behindSomething = (line) => all.some((other) => other !== line && !other.flow
		&& other.rect[2] <= line.rect[0] + 0.25 * size && other.rect[2] > left + 0.5 * size
		&& other.rect[1] < line.rect[3] && other.rect[3] > line.rect[1] - 2 * size
		&& (other.blank || other.eqNumTo >= 0 || EQ_LABEL_RE.test(other.text.trim()) || DELIMITER_PIECE_RE.test(other.text)
			|| (other.hangingOpeners && other.hangingOpeners.length)));
	const listItem = (line) => line.itemStart !== null && !line.tabular && line.eqNumFrom < 0 && line.eqNumTo < 0
		&& !behindSomething(line);
	for (const line of own) {
		if (line.flow || !listItem(line)) continue;
		const siblings = own.some((other) => other !== line && listItem(other)
			&& (sameLeft(line, other) || onMargin(line.itemStart, other.itemStart)));
		if ((worded(line) && full(line)) || siblings) line.flow = true;
	}
	// An item's text, carried past a formula displayed inside the item, comes
	// back to where the item's text started — "In particular, t ↦ K(t, s) is
	// decreasing." under "(ii) For s ∈ [0, 1), the map …".
	const itemMargins = own.filter((line) => line.flow && listItem(line)).map((line) => line.itemStart);
	const onItemText = (line) => itemMargins.some((m) => onMargin(line.rect[0], m));
	for (let i = 0; i < own.length; i++) {
		const line = own[i], above = own[i - 1];
		// The column's own edge is enough; an indent is only prose's when the
		// line runs the measure or reads as prose — a formula can start a point
		// or two from a paragraph's indent.
		if (line.flow || overfull(line)) continue;
		if (worded(line) && (onMargin(line.rect[0], left) || onItemText(line)
			|| (margins.some((m) => onMargin(line.rect[0], m)) && (full(line) || prose(line))))) line.flow = true;
		// A paragraph's first line at its indent, before any line on the page
		// has shown that indent to be one: a few ems in, and reading as prose —
		// "For s ∈ [0, 1], we define the subspace H_s of H by".
		// Formula-heavy as it may be, a line of words justified out to the
		// right margin is prose too: "From now on we will assume that ‖f₁‖ ≤ 1
		// and ‖f₂‖ ≤ 1, which is not a".
		else if ((prose(line) || (full(line) && line.textWords >= 6)) && line.textWords >= 4
			&& line.rect[0] > left && line.rect[0] - left <= 2.5 * size
			&& (!above || !above.flow || above.paraEnd || !full(above))) line.flow = true;
		// A short last line at the margin carrying on a full line of prose —
		// "Then" / "u ≤ v in Ω." — needs no words to be the sentence's end.
		// (Zotero's paragraph break is no evidence against it: a tall exponent on
		// the short line is enough to make it guess one. A colon is — that is
		// how a display is introduced.)
		// It may also start a little in, where a limit hangs left of its sum —
		// "∑_{i=0} Ψ_i finishes the proof." — when it carries words.
		else if (above && above.flow && !/:\s*$/.test(above.text) && full(above)
			&& (onMargin(line.rect[0], left) || onItemText(line)
				|| (line.textWords >= 2 && line.rect[0] > left && line.rect[0] - left <= 1.5 * size))
			&& line.eqNumFrom < 0 && line.eqNumTo < 0 && !line.tabular && skip(above, line)) line.flow = true;
	}
	// On a margin the paragraph establishes, which can be passed down a list
	// item or a caption line by line.
	for (let pass = 0; pass < 4; pass++) {
		let changed = false;
		for (let i = 0; i < own.length; i++) {
			const line = own[i];
			if (line.flow || !worded(line)) continue;
			const above = own[i - 1], below = own[i + 1];
			const chained = (other, upper, lower) => other && worded(other) && skip(upper, lower) && (
				// the same margin, one of the two running the measure — or both
				// running to the same narrower edge
				(sameLeft(line, other) && (full(line) || full(other)
					// a caption or quotation: narrower than the column, and set
					// centred in it — which a formula's branches are not
					// — at the text's own leading: two displays one above the other
					// are centred too, but set apart further
					|| (Math.abs(line.rect[2] - other.rect[2]) <= 0.5 * size
						&& line.rect[2] - line.rect[0] > 0.5 * (right - left)
						&& Math.abs((line.rect[0] - left) - (right - line.rect[2])) <= 1.5 * size
						&& Math.abs(upper.baseline - lower.baseline) <= 1.15 * pitch)))
				// a list item's hanging indent under its label
				|| (other === above && other.flow && LIST_LABEL_RE.test(other.text)
					&& line.rect[0] - other.rect[0] > 0.4 * size && line.rect[0] - other.rect[0] <= 4 * size));
			if (chained(above, above, line) || chained(below, line, below)) {
				line.flow = true;
				changed = true;
			}
		}
		if (!changed) break;
	}
	// A piece of an inline formula — a fraction's numerator the layout set
	// apart — stands inside a line of the flow and belongs to it.
	// Where a piece stands. A big delimiter alone is given a box a sliver
	// high at the top of its glyph, which hangs down from there.
	const standsAt = (l) => (l.hangTop !== null && l.textWords === 0 && l.rect[3] - l.rect[1] < 0.5 * size
		? l.hangTop - size : (l.rect[1] + l.rect[3]) / 2);
	// So does a piece the layout cut from such a line at a tall glyph — an
	// inline fraction's big parentheses, and the rest of the line after them —
	// set level with the pieces before it and straight after them. Pieces
	// found so pass the line on to the next.
	for (let pass = 0; pass < 8; pass++) {
		let changed = false;
		for (const line of own) {
			if (line.flow || line.inline || line.tabular) continue;
			const middle = standsAt(line);
			const anchor = own.find((other) => (other.flow || other.inline) && ((other.flow && middle > other.rect[1] && middle < other.rect[3]
				&& line.rect[0] >= other.rect[0] - size && line.rect[2] <= other.rect[2] + size)
				|| (Math.abs(line.baseline - other.baseline) <= 0.3 * size
					&& line.rect[0] - other.rect[2] < 1.5 * size && line.rect[0] > other.rect[2] - size)
				|| (line.rect[0] - other.rect[2] < 2 * size && line.rect[0] > other.rect[2] - size
					&& (other.flow || other.textWords === 0 || line.textWords === 0)
					// level with the line of prose the pieces carry on
					&& middle > (other.inlineOf || other).rect[1] - 0.3 * size && middle < (other.inlineOf || other).rect[3] + 0.3 * size)));
			if (anchor) { line.inline = true; line.inlineOf = anchor.inlineOf || anchor; changed = true; }
		}
		if (!changed) break;
	}
	for (const line of own) {
		if (line.tabular) continue;
		// A caption is words about a figure, whatever formula it quotes —
		// "Figure 2: Graphical model …, where τ = [1, 3]." — and is set centred,
		// off the paragraph's margins, like a display.
		if (line.flow || line.inline || (CAPTION_RE.test(line.text) && line.textWords >= 2)) { line.kind = "text"; continue; }
		const numbered = line.eqNumFrom >= 0 || line.eqNumTo >= 0;
		// A symbol or two in a line of words — the variable in a contents entry —
		// does not make it a formula; a relation, or formula enough, does.
		const formula = line.hasRelation || line.formulaFrac >= 0.15 || (line.mathFrac > 0 && line.textWords <= 2);
		// A heading is set bold or large; a big operator is large too, but has no
		// words to be a heading with.
		const heading = (line.bold || line.size > 1.15 * size) && line.textWords >= 1;
		line.kind = numbered || (formula && !heading) ? "display" : "text";
	}
	return true;
}

// A piece of a formula can carry a word — `trace`, `if` — and arrive as a line
// of its own. What gives it away is that it shares a baseline with a formula
// and overlaps it: it starts before the formula piece beside it ends. A line of
// prose never stands in the middle of a formula like that.
function interleaved(line, lines) {
	const height = line.rect[3] - line.rect[1];
	return lines.some((other) => other !== line && other.kind === "display" && !other.furniture
		&& other.col === line.col && other.rot === line.rot
		&& Math.min(other.rect[2], line.rect[2]) - Math.max(other.rect[0], line.rect[0]) > 0
		&& Math.min(other.rect[3], line.rect[3]) - Math.max(other.rect[1], line.rect[1])
			> 0.5 * Math.min(height, other.rect[3] - other.rect[1]));
}

// The rest of a formula's row can come over as a line of its own, carrying
// words — "ν_k(X, v) := #{closed k-walks based at v}," after "p_k(X) = ∑". It
// stands on the formula's baseline and starts just after a piece of it, well
// in from the margin: where no line of prose ever starts.
function carriesFormulaOn(line, rows, measure) {
	const m = measure.get(line.col);
	if (line.tabular || !m || line.rect[0] < m.left + 3 * line.size) return false;
	const height = line.rect[3] - line.rect[1];
	// Measured against the formula's row as a whole: the pieces just before the
	// line — a summation sign, the limit under it — are each too thin or too
	// low to share its band, but together they span it.
	return rows.some((row) => row.col === line.col && row.rot === line.rot
		&& row.rect[2] <= line.rect[0] + 0.5 * line.size && line.rect[0] - row.rect[2] < 1.5 * line.size
		&& Math.min(row.rect[3], line.rect[3]) - Math.max(row.rect[1], line.rect[1]) > 0.7 * height);
}

// A line of running text can be crowded with symbols — "corresponds to
// max{F(x, u, Du, D²u), |Du| − g(x)} = 0." — and score as a displayed formula.
// What such a line does not do is stand apart. A display is set off: indented
// or centred, or at least after a break. A line flush with the margin, straight
// under a full line of the same paragraph, is that paragraph carrying on. The
// line above has either no paragraph break after it or stops mid-expression, on
// a comma or an operator; each line put back can vouch for the next.
// Where each column's prose actually starts and stops, from its wide lines of
// text. The column itself can be wider, stretched by a formula overhanging the
// measure.
function proseMeasure(lines) {
	const byCol = new Map();
	for (const line of lines) {
		if (line.furniture || line.kind !== "text" || line.rot) continue;
		if (!byCol.has(line.col)) byCol.set(line.col, []);
		byCol.get(line.col).push(line);
	}
	const measure = new Map();
	for (const [col, prose] of byCol) {
		const wide = prose.filter((l) => l.rect[2] - l.rect[0] > 0.6 * ((col && col.right - col.left) || 1));
		if (wide.length >= 3) measure.set(col, { left: median(wide.map((l) => l.rect[0])), right: median(wide.map((l) => l.rect[2])) });
	}
	return measure;
}

function keepRunningLines(lines) {
	const measure = proseMeasure(lines);
	let previous = null;
	for (const line of lines) {
		if (line.furniture) continue;
		const m = measure.get(line.col);
		// A display is set in from the margin and does not begin with a word.
		// "where A = D²φ(x̂) ∈ S(N), N = N₁ + ⋯ + N_k." at the margin, just under
		// a formula, is the sentence after it — mostly symbols, but prose.
		if (m && line.kind === "display" && !line.rot && line.eqNumFrom < 0 && line.eqNumTo < 0
			&& Math.abs(line.rect[0] - m.left) <= 0.5 * line.size && opensWithWord(line)) {
			line.kind = "text";
		}
		if (m && previous && line.kind === "display" && previous.kind === "text" && previous.col === line.col
			&& !line.rot && !previous.rot && line.textWords >= 1
			&& line.eqNumFrom < 0 && line.eqNumTo < 0
			&& Math.abs(line.rect[0] - m.left) <= 0.5 * line.size
			&& previous.rect[2] >= m.right - 1.5 * line.size
			&& (!previous.paraEnd || /[,=+−(\[{]\s*$/u.test(previous.text))
			&& previous.rect[1] - line.rect[3] < 1.2 * line.size) {
			line.kind = "text";
		}
		previous = line;
	}
}

// "7.D.", "8", "10.", "A.1", "IV." opening a line: a section's number.
const SECTION_LABEL_RE = /^\s*(?:\d{1,3}(?:\.(?:\d{1,3}|[A-Z]))*\.?|[A-Z](?:\.\d{1,3})+\.?|[A-Z]\.|[IVXLC]{1,6}\.)\s+\S/u;

// A table of contents without page numbers or leaders: the entries run on with
// no paragraph breaks and no full stops, so nothing ends one before the next
// begins. What they do have is a section number at the head of each, on a line
// that stops well short of the measure — and three such lines in a row is a
// list of entries, where a numbered line or two inside a paragraph is not. A
// short line just after the run that starts no deeper than its entries do is
// the last entry of it ("APPENDIX ..."); a wrapped title, set in under its
// title, is not a new entry and carries on the one above.
function markContentsEntries(lines) {
	const measure = proseMeasure(lines);
	const flow = lines.filter((line) => !line.furniture && !line.rot);
	const short = (line) => {
		const m = measure.get(line.col);
		return !!m && line.kind === "text" && line.rect[2] < m.right - 3 * line.size;
	};
	const tight = (a, b) => a.col === b.col && a.rect[1] - b.rect[3] < 1.2 * b.size && a.rect[1] > b.rect[1];
	let i = 0;
	while (i < flow.length) {
		let j = i;
		while (j < flow.length && short(flow[j]) && SECTION_LABEL_RE.test(flow[j].text)
			&& (j === i || tight(flow[j - 1], flow[j]))) j++;
		if (j - i >= 3) {
			const deepest = Math.max(...flow.slice(i, j).map((line) => line.rect[0]));
			for (let k = i; k < j; k++) flow[k].entryStart = true;
			while (j < flow.length && short(flow[j]) && tight(flow[j - 1], flow[j])
				&& flow[j].rect[0] <= deepest + flow[j].size && /^\s*\p{Lu}/u.test(flow[j].text)) {
				flow[j].entryStart = true;
				j++;
			}
			i = j;
		} else {
			i = Math.max(i + 1, j);
		}
	}
}

// A formula can carry enough roman words — "T(x̂) = convex hull(UT(x̂))" — to
// fall short of looking like one. What it keeps is how it is set: centred, a
// relation in it, and space above and below it that no line of a paragraph has.
// A heading is centred and set off too, but carries no relation, and is set in
// bold or at a size of its own.
function promoteSetOffFormulas(lines, typicalGap) {
	const flow = lines.filter((line) => !line.furniture && !line.rot);
	for (let i = 1; i < flow.length - 1; i++) {
		const line = flow[i], above = flow[i - 1], below = flow[i + 1];
		if (line.kind !== "text" || line.tabular || line.bold || !line.hasRelation) continue;
		if (line.formulaFrac < 0.1 || line.textWords > 3 || !isCentred(line)) continue;
		if (above.col !== line.col || below.col !== line.col) continue;
		const room = typicalGap + 0.6 * line.size;
		if (above.rect[1] - line.rect[3] > room && line.rect[1] - below.rect[3] > room) line.kind = "display";
	}
}

// The line's first token is a word of prose: three letters or more, none of
// them from a formula font, and not an operator name like `max`.
function opensWithWord(line) {
	const m = /^\s*(\p{L}+)/u.exec(line.text);
	if (!m || m[1].length < 3 || MATH_WORDS.has(m[1].toLowerCase())) return false;
	let seen = 0;
	for (let i = 0; seen < m[1].length && i < line.glyphKinds.length; i++) {
		const kind = line.glyphKinds[i];
		if (!kind) continue;
		if (kind & 4) return false;
		seen++;
	}
	return true;
}

// The glyphs a tall delimiter is built from: the brace, bracket and parenthesis
// pieces, or the ordinary bracket characters a math font sets at size.
const DELIMITER_PIECE_RE = /^[\s{}()[\]|‖\u239b-\u23b3\u27e8\u27e9]+$/u;
// A delimiter that opens: what a cases formula's branches stand to the right of.
const OPENER_PIECE_RE = /^[{([⟨|‖\u239b-\u239d\u23a1-\u23a3\u23a7-\u23aa]$/u;

// A cases formula sets its branches beside a tall brace, and a branch can carry
// words — "otherwise", "if x is odd", a type name in a program — enough to read
// as prose and cut the formula in two. The brace says otherwise: nothing but a
// formula stands beside one, within its height. A brace is found as the column
// of delimiter pieces it is built from, and it has to be at least two lines
// tall and share its height with a line already read as a formula, so that a
// bracket set large inside a sentence reaches nothing.
function absorbBraceRows(lines) {
	const pieces = lines.filter((line) => line.blank || (!line.furniture && DELIMITER_PIECE_RE.test(line.text)));
	const spans = [];
	for (const piece of pieces.sort((p, q) => q.rect[3] - p.rect[3])) {
		const span = spans.find((sp) => sp.col === piece.col && sp.rot === piece.rot
			&& piece.rect[0] < sp.right + piece.size && piece.rect[2] > sp.left - piece.size
			&& piece.rect[3] >= sp.bottom - 0.5 * piece.size);
		if (span) {
			span.left = Math.min(span.left, piece.rect[0]);
			span.right = Math.max(span.right, piece.rect[2]);
			span.bottom = Math.min(span.bottom, piece.rect[1]);
			span.members.add(piece);
		} else {
			spans.push({ col: piece.col, rot: piece.rot, left: piece.rect[0], right: piece.rect[2],
				bottom: piece.rect[1], top: piece.rect[3], size: piece.size, members: new Set([piece]) });
		}
	}
	// A small brace is one glyph, and it arrives on the line of its first branch
	// with a box that covers only its top (see hangsBelowBaseline). Its extent
	// comes back from the formula it opens: centred on the axis of the piece set
	// just to its left, it reaches as far below that axis as it stands above.
	for (const line of lines) {
		if (line.furniture || !line.hangingOpeners || !line.hangingOpeners.length) continue;
		for (const opener of line.hangingOpeners) {
			let lead = null;
			for (const other of lines) {
				if (other === line || other.furniture || other.kind !== "display" || !other.standingGlyphs) continue;
				if (other.col !== line.col || other.rot !== line.rot) continue;
				if (other.rect[2] > opener.left + other.size || other.rect[2] < opener.left - 3 * other.size) continue;
				if (other.rect[3] > opener.top + 0.5 * other.size || other.rect[3] < opener.top - 3 * other.size) continue;
				// On the delimiter's own row: a brace set as one glyph is small,
				// its top at most a couple of ems above the axis it is centred
				// on. A piece of the row below — a denominator, the next line
				// of the formula — would put the axis far too low and stretch
				// the brace down into whatever follows.
				const rise = opener.top - (other.standingBaseline + 0.25 * other.size);
				if (rise <= 0 || rise > 2 * other.size) continue;
				if (!lead || other.rect[2] > lead.rect[2]) lead = other;
			}
			if (!lead) continue;
			const axis = lead.standingBaseline + 0.25 * lead.size;
			spans.push({ col: line.col, rot: line.rot, left: opener.left, right: opener.right,
				bottom: 2 * axis - opener.top, top: opener.top, size: lead.size, members: new Set([line]) });
		}
	}
	for (const span of spans) {
		if (span.top - span.bottom < 2 * span.size) continue;
		const beside = lines.filter((line) => !line.furniture && !span.members.has(line) && !line.flow && !line.inline
			&& line.tableRow === undefined
			&& line.col === span.col && line.rot === span.rot && !line.tabular
			// A branch is never a full line of text.
			&& !(line.col && line.rect[2] - line.rect[0] > 0.8 * (line.col.right - line.col.left))
			&& (line.rect[1] + line.rect[3]) / 2 > span.bottom && (line.rect[1] + line.rect[3]) / 2 < span.top);
		if (!beside.some((line) => line.kind === "display")) continue;
		for (const line of beside) line.kind = "display";
		for (const piece of span.members) if (!piece.furniture) piece.kind = "display";
	}
}

// Once a row is known to carry a displayed formula, everything standing in it
// belongs to that formula — the tail after a summation sign, the limits above
// and below, the numerator of a fraction. Judging each piece on its own cannot
// work: the numerator of `1/|R(X)|` is the single character "1", which has no
// letters to read as variables and no symbols to read as operators, and scores
// as prose however it is measured. What settles it is where the piece stands.
//
// Absorbing one piece widens the row, which can bring another within reach, so
// this runs until nothing more moves. A line is only taken if it sits *inside*
// the row horizontally — a line of prose reaches well past a formula's span —
// and a line carrying several real words is prose whatever it overlaps.
function absorbDisplayRows(lines) {
	let rows = displayRows(lines);
	if (!rows.length) return;
	// The body type of the page. Anything set well below it is script type —
	// an index, an exponent, the set an infimum is taken over — and script
	// type is part of a formula even when it is spelled out in words, as
	// "a(·) admissible from x" under an inf is. A sentence is never set in it.
	const bodySize = median(lines.filter((line) => !line.furniture).map((line) => line.size)) || 10;
	const measure = proseMeasure(lines);
	for (let pass = 0; pass < lines.length; pass++) {
		let absorbed = false;
		for (const line of lines) {
			// Position alone reaches a line above or below the row, which is right
		// for a fraction's numerator and wrong for the tail of a sentence. So
		// a piece must either carry no words — an operator name like `min`
		// does not count as one — or be set in script type.
		if (line.furniture || line.kind === "display" || line.flow || line.inline || line.tableRow !== undefined) continue;
		if (line.flow === false) {
			// Off the flow, words are no evidence of prose: only where it stands.
		} else if (carriesFormulaOn(line, rows, measure)) {
			line.kind = "display";
			absorbed = true;
			continue;
		}
		if (line.flow === undefined && line.textWords > 0 && line.size >= 0.85 * bodySize && !interleaved(line, lines)) continue;
			const height = line.rect[3] - line.rect[1];
			const width = line.rect[2] - line.rect[0];
			if (height <= 0) continue;
			const centre = (line.rect[1] + line.rect[3]) / 2;
			for (const row of rows) {
				if (row.col !== line.col || row.rot !== line.rot) continue;
				// Horizontally inside the row, not merely touching it.
				const inside = Math.min(row.rect[2], line.rect[2]) - Math.max(row.rect[0], line.rect[0]);
				if (inside < 0.7 * Math.min(width, row.rect[2] - row.rect[0])) continue;
				// Standing in the row's band, or half a line clear of it.
				if (centre < row.rect[1] - 0.8 * height || centre > row.rect[3] + 0.8 * height) continue;
				line.kind = "display";
				absorbed = true;
				break;
			}
		}
		if (!absorbed) break;
		rows = displayRows(lines);
	}
}

// --- blocks ----------------------------------------------------------------

// "(4) record ...", "3. Gibbs measures ...", "(iii) every ..." — a line opening
// with a list or section label starts something new. Without this an item that
// ends on a semicolon runs straight into the next one: the layout sees no
// indent between them so it marks no paragraph break, and a semicolon is not a
// full stop, so nothing else separates them either.
// A bullet is a label too: "• One has V_β = {0} for every β < α."
const LIST_LABEL_RE = /^\s*(?:[([]?\s*(?:\d{1,3}|[ivxlcdm]{1,5}|\p{L})\s*[).\]]\s+|[•◦▪▸‣]\s*)\S/iu;
const CLAUSE_END_RE = /[.;:!?\u2026]["'\u201d\u2019)\]]*\s*$/;

// A bibliography entry's key. Keys come numbered, "[12]", or made of the
// authors' names and a year, "[ABLM24]", "[Lê20]" — followed by an author's
// name or initial. "[GG24] for a general criterion" is a citation in a
// sentence, and "[Du]V" a formula.
const BIB_KEY_RE = /^\s*(?:[[(]\d{1,3}[\])]|\[[\p{L}\p{N}ˆ^'’+-]{2,12}\](?=\s+\p{Lu}|\p{Lu}\.))/u;

// "(see also M." / "G. Crandall": a name's initials broken across a line. The
// second line opens with a capital and a stop, which is also what a lettered
// list item looks like; the first ending on a lone initial is what it is not.
function continuesInitials(before, after) {
	return /(?:^|[\s(])\p{Lu}\.\s*$/u.test(before) && /^\s*\p{Lu}\.\s+\p{Lu}/u.test(after);
}

// --- tables ---------------------------------------------------------------------
//
// A table is found the way a reader finds one: rows of cells, one under the
// next, whose gaps line up into columns. Within each column of the page:
//
// - lines standing side by side are a visual row, and a row is split into cells
//   at gaps of about an em — the space a table leaves between its columns, and
//   three word spaces;
// - a table is a run of rows of several cells in one size of type, one after
//   another at a table's spacing, allowing short rows between them —
//   "Published", "(A)", the lines of a stacked cell — and stopping at a line
//   of prose, at a caption, or at a gap wider than a row's;
// - text whose nearest caption is a figure's — a plot's ticks and legend, a
//   diagram's boxes — is no table;
// - its columns are the gutters that most of those rows leave white; a run
//   with none, or of fewer than three rows, or whose rows are formulas — a
//   matrix, an aligned derivation — is no table;
// - a visual row filling fewer than half the columns with text, none of its
//   cells running across a gutter and not naming itself in the first column,
//   belongs to the nearer of the rows either side of it: a cell's wrapped
//   line, a header's second line. A row of one cell spanning the table — a
//   group's heading — is a row of its own;
// - the lines of a cell stacked beside cells of a different number of lines,
//   which the page hands over down the column, are one row;
// - each row is read as one thing and highlighted as a band across the table.
const sameSize = (a, b) => Math.max(a, b) <= 1.35 * Math.min(a, b);

function detectTables(lines, cols) {
	let nextId = 1, nextTable = 1;
	for (const col of cols) {
		// Contents entries line up like a table's rows, and are read by rules
		// of their own (see markContentsEntries).
		// A row's label set apart at the left — "(A)" beside the rows it heads —
		// reads to the page's other rules as an equation's number, and is kept.
		const label = (l) => EQ_LABEL_RE.test(l.text.trim());
		const own = lines.filter((l) => l.col === col && (!l.furniture || label(l)) && !l.rot && !l.blank && !l.contents);
		if (own.length < 3) continue;
		const colWidth = (col.right - col.left) || 1;
		const size = median(own.map((l) => l.size)) || 10;

		const rows = [];
		for (const line of [...own].sort((a, b) => b.rect[3] - a.rect[3])) {
			const h = line.rect[3] - line.rect[1];
			// A table is set in one size of type; a figure's labels beside a
			// column of prose are not in a row with its lines.
			// And side by side with every line of the row, not only with the
			// row as it has grown: a label set between two rows overlaps both,
			// and would otherwise chain them into one.
			const overlap = (a, b) => Math.min(a.rect[3], b.rect[3]) - Math.max(a.rect[1], b.rect[1]);
			const row = rows.find((r) => overlap(r, line) > 0.5 * Math.min(h, r.rect[3] - r.rect[1])
				&& r.lines.every((m) => overlap(m, line) > 0) && sameSize(r.size, line.size));
			if (row) {
				row.lines.push(line);
				row.rect = [Math.min(row.rect[0], line.rect[0]), Math.min(row.rect[1], line.rect[1]), Math.max(row.rect[2], line.rect[2]), Math.max(row.rect[3], line.rect[3])];
			} else {
				rows.push({ lines: [line], rect: line.rect.slice(), size: line.size });
			}
		}
		rows.sort((a, b) => b.rect[3] - a.rect[3]);
		for (const row of rows) {
			const cells = row.lines.flatMap((l) => l.tightCells.map((c) => c.slice())).sort((a, b) => a[0] - b[0]);
			const merged = [];
			for (const c of cells) {
				const last = merged[merged.length - 1];
				if (last && c[0] - last[1] <= 0.8 * size) last[1] = Math.max(last[1], c[1]);
				else merged.push(c);
			}
			row.cells = merged;
		}

		const caption = (row) => row.lines.some((l) => /^\s*(?:Table|TABLE|Tab\.|Figure|FIGURE|Fig\.)\s*\d/.test(l.text));
		// A line of prose running the measure: its gaps are word spaces, which
		// justification stretches to an em at most — not a gulf between cells.
		const widestGap = (l) => Math.max(0, ...l.tightCells.slice(1).map((c, k) => c[0] - l.tightCells[k][1]));
		// So are a paragraph's lines when a figure stands beside them, and the
		// figure's labels fall level with them: long lines of words, set one
		// under another on a common margin, running from the column's edge —
		// and words, where a table's rows set tight are mostly figures.
		// (The layout can join a label and the prose level with it into one
		// line, so it is the line's stretches of words that are compared.)
		const paragraph = new Set();
		const stretches = [];
		for (const l of own) {
			const glyphs = l.text.replace(/\s/g, "");
			if ((glyphs.match(/\p{L}/gu) || []).length < 0.6 * glyphs.length) continue;
			for (const c of l.tightCells) {
				if (c[1] - c[0] >= 15 * l.size && (c[0] <= col.left + l.size || c[1] >= col.right - l.size)) stretches.push({ l, c });
			}
		}
		for (const s of stretches) {
			const beside = (t) => t.l !== s.l && Math.abs(t.c[0] - s.c[0]) <= s.l.size
				&& Math.abs(t.l.rect[1] - s.l.rect[1]) <= 1.8 * Math.max(s.l.size, t.l.size);
			if (stretches.some(beside)) paragraph.add(s.l);
		}
		const prose = (row) => row.lines.some((l) => paragraph.has(l)
			|| (l.flow && l.rect[2] - l.rect[0] >= 0.8 * colWidth && widestGap(l) < 1.5 * size));
		const multi = (row) => row.cells.length >= 2 && !prose(row) && !caption(row);
		const short = (row) => row.rect[2] - row.rect[0] < 0.6 * colWidth && !prose(row) && !caption(row);

		// Short rows between rows of cells — a cell's wrapped line, a stacked
		// cell's lines set half a line off its neighbours' — belong to the
		// table if a row of cells follows close under them.
		// So does a group's heading across the table — "Top Leaderboard Systems
		// (Dec 10th, 2018)" — however long, set within the rows either side.
		const within = (row, a, b) => !prose(row) && !caption(row) && row.lines.length === 1
			&& row.rect[0] >= Math.min(a.rect[0], b.rect[0]) - size && row.rect[2] <= Math.max(a.rect[2], b.rect[2]) + size;
		const leadsToRow = (k) => {
			for (let m = k; m < Math.min(rows.length, k + 6); m++) {
				if (m > k && (rows[m - 1].rect[1] - rows[m].rect[3] > 1.6 * size || !sameSize(rows[k].size, rows[m].size))) return false;
				if (m > k && multi(rows[m])) {
					return rows.slice(k, m).every((r) => short(r) || (k > 0 && within(r, rows[k - 1], rows[m])));
				}
				if (multi(rows[m])) return false;
			}
			return false;
		};
		let i = 0;
		while (i < rows.length) {
			if (!multi(rows[i])) { i++; continue; }
			const run = [rows[i]];
			let j = i;
			while (j + 1 < rows.length) {
				const next = rows[j + 1], prev = rows[j];
				if (prev.rect[1] - next.rect[3] > 1.6 * size || !sameSize(run[0].size, next.size)) break;
				if (multi(next) || leadsToRow(j + 1)) {
					run.push(next);
					j++;
				} else {
					break;
				}
			}
			// A last row's cell can wrap too, onto a line set tight under it.
			while (j + 1 < rows.length && short(rows[j + 1]) && sameSize(run[0].size, rows[j + 1].size)
				&& rows[j].rect[1] - rows[j + 1].rect[3] <= 0.6 * size) {
				run.push(rows[j + 1]);
				j++;
			}
			i = j + 1;
			const table = tableOf(run, colWidth, size, col);
			if (!table || figureText(run, lines, size)) continue;
			const tableId = nextTable++;
			// A label set between two rows — "DeBERTa XXL" beside the rows it
			// names, "(A)" level with the middle of its group — is read with one
			// of them, but its band stays the row's own: stretched over the label,
			// it would lie over the neighbouring row's band.
			const groupOf = new Map();
			table.rows.forEach((group, g) => { for (const r of group) for (const l of r.lines) groupOf.set(l, g); });
			const straddles = (l) => {
				if (l.tightCells.length !== 1) return false;
				for (const [m, g] of groupOf) {
					if (g !== groupOf.get(l) && Math.min(l.rect[3], m.rect[3]) - Math.max(l.rect[1], m.rect[1]) > 0.2 * (m.rect[3] - m.rect[1])) return true;
				}
				return false;
			};
			const boxes = [];
			for (const group of table.rows) {
				const id = nextId++;
				const members = group.flatMap((r) => r.lines);
				const core = members.filter((l) => !straddles(l));
				const own = core.length ? core : members;
				const top = Math.max(...own.map((l) => l.rect[3])), bottom = Math.min(...own.map((l) => l.rect[1]));
				// One box for the whole row, shared by its lines.
				const box = [table.left, bottom, table.right, top];
				boxes.push(box);
				for (const r of group) {
					for (const line of r.lines) {
						line.tableRow = id;
						line.tableId = tableId;
						// A cell's label is read with its row, not dropped as a number.
						line.furniture = false;
						// Nor is a row that opens with a number a contents entry.
						line.entryStart = false;
						line.eqNumFrom = -1;
						line.eqNumTo = -1;
						line.tabular = true;
						line.kind = "text";
						line.flow = false;
						line.inline = false;
						line.tableBox = box;
						line.tableColumn = table.columnOf(line.rect[0]);
					}
				}
			}
			// A label the layout ran into its row's line still reaches into the
			// next row; neighbouring bands meet halfway rather than overlap.
			boxes.sort((a, b) => b[3] - a[3]);
			for (let k = 1; k < boxes.length; k++) {
				const upper = boxes[k - 1], lower = boxes[k];
				if (lower[3] > upper[1] && lower[3] < upper[3] && upper[1] > lower[1]) {
					const mid = (lower[3] + upper[1]) / 2;
					upper[1] = mid;
					lower[3] = mid;
				}
			}
		}
	}
	// Read a table's rows together and in order, and a row's cells together,
	// whatever order the layout hands them over in: a table read down its
	// columns would otherwise scatter each row, and a line the layout slips in
	// between two cells would cut a row in two. The table takes the place of
	// its first line.
	const byTable = new Map();
	for (const l of lines) {
		if (l.tableId === undefined) continue;
		if (!byTable.has(l.tableId)) byTable.set(l.tableId, []);
		byTable.get(l.tableId).push(l);
	}
	if (!byTable.size) return;
	// Within a row, column by column across the table, and a column's lines
	// downwards: a name, then the affiliation and address set under it.
	for (const members of byTable.values()) {
		members.sort((a, b) => (a.tableRow - b.tableRow) || (a.tableColumn - b.tableColumn) || (b.rect[3] - a.rect[3]) || (a.rect[0] - b.rect[0]));
	}
	const ordered = [];
	for (const l of lines) {
		if (l.tableId === undefined) { ordered.push(l); continue; }
		const members = byTable.get(l.tableId);
		if (members) { ordered.push(...members); byTable.delete(l.tableId); }
	}
	lines.splice(0, lines.length, ...ordered);
}

// A plot's tick labels and legend, a diagram's boxes, fall into rows and
// columns too. What a block of text is, its caption says: the caption reached
// first going up or down from it, past the figure's other labels but not past
// a line of prose. A figure's text is not a table.
const CAPTION_RE = /^\s*(?:(Table|TABLE|Tab\.)|Figure|FIGURE|Fig\.)\s*[\dA-Z]/;
function figureText(run, lines, size) {
	const left = Math.min(...run.map((r) => r.rect[0])), right = Math.max(...run.map((r) => r.rect[2]));
	const inRun = new Set(run.flatMap((r) => r.lines));
	const near = lines.filter((l) => !inRun.has(l) && !l.blank && l.rect[0] < right && l.rect[2] > left);
	const words = (l) => l.textWords >= 4 && Math.max(0, ...l.tightCells.slice(1).map((c, k) => c[0] - l.tightCells[k][1])) < 1.5 * l.size;
	let best = null, bestReach = Infinity;
	for (const down of [true, false]) {
		let edge = down ? run[run.length - 1].rect[1] : run[0].rect[3];
		const start = edge, seen = new Set();
		for (;;) {
			const next = near.filter((l) => !seen.has(l) && (down
				? l.rect[3] <= edge + 0.5 * size && edge - l.rect[3] <= 4 * Math.max(size, l.size)
				: l.rect[1] >= edge - 0.5 * size && l.rect[1] - edge <= 4 * Math.max(size, l.size)))
				.sort((p, q) => (down ? q.rect[3] - p.rect[3] : p.rect[1] - q.rect[1]));
			if (!next.length) break;
			const line = next[0];
			const m = CAPTION_RE.exec(line.text);
			if (m) {
				const reach = Math.abs((down ? line.rect[3] : line.rect[1]) - start);
				if (reach < bestReach) { bestReach = reach; best = m; }
				break;
			}
			if (words(line)) break;
			seen.add(line);
			edge = down ? Math.min(edge, line.rect[1]) : Math.max(edge, line.rect[3]);
		}
	}
	return !!best && !best[1];
}

function tableOf(run, colWidth, size, col) {
	const multiRows = run.filter((r) => r.cells.length >= 2);
	if (run.length < 3 || multiRows.length < 2) return null;
	// Rows of words and figures, not formula: at least two rows with two cells
	// of words or figures in them — figures even in a line read as formula,
	// "3×3, 64", but not a big operator's glyph that happens to map to "1". (A
	// formula's pieces set beside a line of prose — an integral sign and its
	// limits next to "it follows that" — make rows of cells too.)
	const figures = (l) => l.hangTop === null && (l.text.match(/\d/g) || []).length >= 0.4 * l.text.replace(/\s/g, "").length;
	const runningProse = (l) => l.flow && l.textWords >= 3 && l.tightCells.length <= 1;
	const wordCells = (r) => r.lines.reduce((n, l) => n
		+ (!runningProse(l) && (l.kind !== "display" || figures(l)) ? l.tightCells.length : 0), 0);
	if (multiRows.filter((r) => wordCells(r) >= 2).length < 2) return null;
	// A list set with hanging labels — a bibliography's keys, numbered notes —
	// has a column of labels and a column of running text, which runs to the
	// margin row after row. A table's cells stop short of it.
	const running = multiRows.filter((r) => r.rect[2] >= col.right - size
		&& r.lines.some((l) => l.textWords >= 4)).length;
	if (running >= 0.6 * multiRows.length) return null;
	const left = Math.min(...run.map((r) => r.rect[0])), right = Math.max(...run.map((r) => r.rect[2]));
	if (right - left < 0.4 * colWidth) return null;
	// A matrix or an aligned derivation is laid out the same way; its rows are
	// formulas, a table's are words and figures.
	let glyphs = 0, formula = 0;
	for (const r of run) for (const l of r.lines) {
		const n = l.to - l.from + 1;
		glyphs += n;
		formula += n * l.formulaFrac;
	}
	if (formula > 0.35 * glyphs) return null;
	// ...and whose lines were already read as a formula. (An integral sign can
	// arrive as the digit "1", which no measure of formula glyphs counts.) A
	// table of figures with a ± in its cells is read as formula line by line,
	// but its cells are figures, not formula.
	let displayed = 0;
	for (const r of run) for (const l of r.lines) if (l.kind === "display") displayed += l.to - l.from + 1;
	if (displayed > 0.5 * glyphs && formula > 0.15 * glyphs) return null;
	// Gutters: stretches that nearly all rows of several cells leave white.
	const width = Math.ceil(right - left) + 1;
	const count = new Uint16Array(width);
	for (const r of multiRows) {
		for (const c of r.cells) {
			for (let x = Math.max(0, Math.floor(c[0] - left)); x <= Math.min(width - 1, Math.ceil(c[1] - left)); x++) count[x]++;
		}
	}
	const allowed = Math.ceil(0.2 * multiRows.length);
	const gutters = [];
	let start = -1;
	for (let x = 0; x < width; x++) {
		const white = count[x] <= allowed;
		if (white && start < 0) start = x;
		if ((!white || x === width - 1) && start >= 0) {
			if (start > 0 && !white && x - start >= 0.6 * size) gutters.push([left + start, left + x]);
			start = -1;
		}
	}
	if (!gutters.length) return null;
	// The columns a cell falls in, and whether it runs across a gutter.
	const columnOf = (x) => gutters.filter((g) => (g[0] + g[1]) / 2 <= x).length;
	const spans = (c) => gutters.some((g) => c[0] < g[0] && c[1] > g[1]);
	const occupied = (r) => new Set(r.cells.map((c) => columnOf((c[0] + c[1]) / 2))).size;
	const columns = gutters.length + 1;
	// What a continuation line holds is text — a wrapped cell's second line, a
	// header's — or a lone short label. A sparse row of figures, a row that
	// fills in only the columns that changed, is a row of its own.
	const cellText = (r, c) => r.lines.filter((l) => l.rect[0] < c[1] && l.rect[2] > c[0]).map((l) => l.text).join(" ");
	const textual = (r) => {
		const words = r.cells.filter((c) => /\p{L}{2,}/u.test(cellText(r, c))).length;
		return words >= 0.5 * r.cells.length || (r.cells.length === 1 && r.rect[2] - r.rect[0] < 4 * size);
	};
	// A row that names itself in the first column and gives a value beside it
	// — "Warmup Ratio 0.1" under "Optimizer AdamW" — is a row, however sparse.
	const labelled = (r) => occupied(r) >= 2 && r.cells.some((c) => columnOf((c[0] + c[1]) / 2) === 0);
	// Nor is a group's heading, which heads the rows under it rather than
	// carrying on one: set in the middle of the table — "Published", "Ours" —
	// or with the rows under it set in from it — "Fine-tuning approach".
	const centre = (left + right) / 2;
	const heading = (r, k) => r.lines.length === 1 && occupied(r) === 1
		&& (Math.abs((r.rect[0] + r.rect[2]) / 2 - centre) <= size
			|| (k + 1 < run.length && run[k + 1].cells[0][0] >= r.rect[0] + 0.5 * size
				&& run[k + 1].cells[0][0] <= r.rect[0] + 3 * size
				&& columnOf(run[k + 1].cells[0][0]) === columnOf(r.rect[0])));
	const partial = run.map((r, k) => occupied(r) <= columns / 2 && !r.cells.some(spans) && textual(r) && !labelled(r) && !heading(r, k));
	// Rows of several cells need to agree with the gutters found from them.
	if (multiRows.filter((r) => !r.cells.some(spans)).length < 2) return null;

	const owner = run.map((_, k) => k);
	const find = (k) => (owner[k] === k ? k : (owner[k] = find(owner[k])));
	for (let k = 0; k < run.length; k++) {
		if (!partial[k]) continue;
		const above = k > 0 ? run[k - 1].rect[1] - run[k].rect[3] : Infinity;
		const below = k + 1 < run.length ? run[k].rect[1] - run[k + 1].rect[3] : Infinity;
		// Text wraps downwards, so a part row belongs to the row above it unless
		// the row below is plainly closer — as it is to the first lines of a
		// bracketed cell whose label sits level with its middle line.
		const target = below < 0.7 * above ? k + 1 : k - 1;
		if (target < 0 || target >= run.length) continue;
		const a = find(k), b = find(target);
		if (a !== b) owner[a] = b;
	}
	// A cell of several lines stacked one over another — a bracketed block of
	// layers — is one cell however its lines fall into rows, and the page's
	// content says so: it hands the cell's lines over one after another down
	// the column, then goes back up for the next cell to the right. A table set
	// row by row goes across instead, and down only from a row's end to the
	// next row's start.
	const rowOf = new Map();
	run.forEach((r, k) => { for (const l of r.lines) rowOf.set(l, k); });
	const stream = [...rowOf.keys()].sort((a, b) => a.from - b.from);
	const overlaps = (a, b) => Math.min(a.rect[2], b.rect[2]) - Math.max(a.rect[0], b.rect[0]) > 0.5 * Math.min(a.rect[2] - a.rect[0], b.rect[2] - b.rect[0]);
	const oneCell = (l) => l.tightCells.length === 1;
	// A list of settings written out column by column has as many lines in
	// each column as rows; cells of several lines each, stacked beside cells
	// of a different number, leave the columns at odds.
	const unevenColumns = (a, b) => {
		const counts = new Map();
		for (let k = a; k <= b; k++) {
			for (const l of run[k].lines) {
				const c = columnOf((l.rect[0] + l.rect[2]) / 2);
				counts.set(c, (counts.get(c) || 0) + 1);
			}
		}
		const n = b - a + 1;
		return [...counts.values()].some((m) => m >= 2 && m < n);
	};
	for (let s = 0; s < stream.length;) {
		let e = s;
		while (e + 1 < stream.length && oneCell(stream[e]) && oneCell(stream[e + 1])
			&& rowOf.get(stream[e + 1]) > rowOf.get(stream[e]) && overlaps(stream[e], stream[e + 1])) e++;
		const after = stream[e + 1];
		const cell = stream.slice(s, e + 1);
		// (A label of two lines in the first column — "DeBERTa XXL / LoRA" —
		// names the rows beside it; it does not make them one.)
		if (e > s && after && rowOf.get(after) < rowOf.get(stream[e])
			&& columnOf((stream[s].rect[0] + stream[s].rect[2]) / 2) > 0
			&& after.rect[0] >= Math.min(...cell.map((l) => l.rect[2])) - 0.5 * size
			&& unevenColumns(rowOf.get(stream[s]), rowOf.get(stream[e]))) {
			for (let k = rowOf.get(stream[s]); k < rowOf.get(stream[e]); k++) {
				const a = find(k), b = find(k + 1);
				if (a !== b) owner[a] = b;
			}
		}
		s = e + 1;
	}
	// A header set in two lines — "Dev" and "Test" over "EM F1 EM F1" — is
	// one row: a heading spanning columns, and the headings of those columns
	// set tight under it, words rather than figures.
	const allWords = (r) => r.lines.every((l) => /\p{L}{2,}/u.test(l.text) && !/(?:^|\s)[\d.,±%()+\-−]*\d[\d.,±%()+\-−]*(?=\s|$)/u.test(l.text));
	const under = (r, top) => top.cells.some((t) => r.cells.filter((c) => Math.abs((c[0] + c[1]) / 2 - (t[0] + t[1]) / 2) <= (t[1] - t[0]) / 2 + size).length >= 2);
	for (let k = 1; k < run.length && allWords(run[k - 1]) && allWords(run[k])
		&& run[k - 1].rect[1] - run[k].rect[3] <= 0.5 * size && under(run[k], run[k - 1]); k++) {
		const a = find(k), b = find(k - 1);
		if (a !== b) owner[a] = b;
	}
	const byRoot = new Map();
	run.forEach((r, k) => {
		const root = find(k);
		if (!byRoot.has(root)) byRoot.set(root, []);
		byRoot.get(root).push(r);
	});
	return { left, right, columnOf, rows: [...byRoot.values()] };
}

// The gap that normally separates two lines of one paragraph. Measured within
// a column, so a column break does not count as a gap.
function typicalLineGap(lines) {
	const gaps = [];
	for (let i = 1; i < lines.length; i++) {
		const a = lines[i - 1], b = lines[i];
		if (a.col !== b.col || a.furniture || b.furniture) continue;
		const gap = a.rect[1] - b.rect[3];
		if (gap > -2 && gap < 40) gaps.push(gap);
	}
	return median(gaps);
}

// Group lines into things a sentence may live inside. Display equations are
// their own blocks (they are their own unit of attention); prose blocks end
// where Zotero's layout analysis says a paragraph ends.
//
// That analysis has one gap worth filling. Zotero removes the paragraph break
// before any one-line paragraph whose first glyph shares a font with the
// paragraph above — which is exactly a run-in section heading, since "1.2." is
// set in the same roman as the body text. The heading arrives glued to the end
// of the previous paragraph. The vertical gap is what gives it away, so a jump
// well beyond the page's normal line spacing ends a block whatever Zotero said.
function linesToBlocks(lines, typicalGap, mergeDisplay) {
	const blocks = [];
	let cur = null;
	let previous = null;
	for (let i = 0; i < lines.length; i++) {
		const ln = lines[i];
		if (ln.furniture) { cur = null; continue; }
		let next = null;
		for (let j = i + 1; j < lines.length && !next; j++) {
			if (!lines[j].furniture) next = lines[j];
		}
		// Folding equations into their sentence means the sentence has to
		// survive the formula. A displayed formula is set off with blank space
		// and the layout puts a paragraph break either side of it, so both of
		// the reasons a block would end have to be suspended where a formula
		// meets the prose — otherwise the sentence is cut into the part before
		// the formula, the formula, and the part after, which is the opposite
		// of what the setting asks for.
		// Text set at another angle is its own thing entirely.
		if (cur && previous && previous.rot !== ln.rot) cur = null;
		// A row of cells is one thing and the row under it is another, whatever
		// the layout says about paragraphs — table rows carry no full stops
		// and often no paragraph breaks either.
		const inRow = ln.tableRow !== undefined && previous && previous.tableRow === ln.tableRow;
		if (cur && !inRow && (ln.tabular || previous && previous.tabular)) cur = null;
		// Cells of one table row are one line; the row after it is another.
		if (cur && previous && previous.tableRow !== ln.tableRow) cur = null;
		// An entry of a contents list begins a block of its own, and so does an
		// entry of a bibliography.
		if (cur && (ln.entryStart || (/^\s*\[/.test(ln.text) && BIB_KEY_RE.test(ln.text)
			&& previous && (previous.paraEnd || /\.\s*$/.test(previous.text))))) cur = null;
		// A line may open with a bracketed number without being a list item:
		// "(16) equals 1 for every closed path" is a cross-reference carrying a
		// sentence over. What tells them apart is the line before — an item
		// ends on a full stop or a semicolon, a sentence carried over ends
		// mid-clause.
		if (cur && previous && LIST_LABEL_RE.test(ln.text) && !continuesInitials(previous.text, ln.text)
			&& (previous.paraEnd || CLAUSE_END_RE.test(previous.text))) {
			cur = null;
		}
		const bridgeBefore = mergeDisplay && (ln.kind === "display" || (previous && previous.kind === "display"));
		const bridgeAfter = mergeDisplay && (ln.kind === "display" || (next && next.kind === "display"));

		if (!bridgeBefore && !inRow && cur && previous && previous.col === ln.col
			&& previous.rect[1] - ln.rect[3] > typicalGap + 0.6 * ln.size) {
			cur = null;
		}
		previous = ln;
		if (ln.kind === "display" && !mergeDisplay) {
			const last = blocks[blocks.length - 1];
			// Measured against everything the block already covers, not against
			// the piece added last. The pieces of a formula do not arrive in
			// reading order — a summation sign is followed by its upper limit,
			// set high above the line, and then its lower limit, set well below
			// it — so comparing neighbours puts a gulf between those two and
			// cuts the formula in half. An align environment stacks several
			// rows the same way.
			// Measured against the larger of the two type sizes. A summation
			// sign is set far bigger than the limits hung beneath it, so a
			// limit's own size is the wrong ruler for the distance between
			// them: judged by that, the limit is a paragraph away.
			const reach = last ? 1.6 * Math.max(last.size, ln.size) : 0;
			if (last && last.kind === "display" && last.col === ln.col
				&& last.rect[1] - ln.rect[3] < reach
				&& ln.rect[1] - last.rect[3] < reach) {
				last.lines.push(ln);
				last.size = Math.max(last.size, ln.size);
				last.rect = [
					Math.min(last.rect[0], ln.rect[0]), Math.min(last.rect[1], ln.rect[1]),
					Math.max(last.rect[2], ln.rect[2]), Math.max(last.rect[3], ln.rect[3]),
				];
			} else {
				blocks.push({ kind: "display", lines: [ln], col: ln.col, size: ln.size, rect: ln.rect.slice() });
			}
			cur = null;
			continue;
		}
		if (!cur) { cur = { kind: "text", lines: [], tableRow: ln.tableRow, tabular: ln.tabular }; blocks.push(cur); }
		cur.lines.push(ln);
		const rowContinues = ln.tableRow !== undefined && next && next.tableRow === ln.tableRow;
		// The layout ends a paragraph wherever it cut a line at a tall glyph;
		// the piece carrying the line on is no new paragraph.
		const reach = (l) => (l.hangTop !== null && l.textWords === 0 ? [Math.min(l.rect[1], l.hangTop - 2 * l.size), l.rect[3]] : [l.rect[1], l.rect[3]]);
		const lineContinues = next && next.inline && next.col === ln.col && next.rect[0] >= ln.rect[2] - ln.size
			&& Math.min(reach(next)[1], reach(ln)[1]) - Math.max(reach(next)[0], reach(ln)[0]) > -0.3 * ln.size;
		if (ln.paraEnd && !bridgeAfter && !rowContinues && !lineContinues) cur = null;
	}
	return blocks;
}

// Layout analysis breaks a paragraph wherever the geometry jumps — including
// at the foot of a column, where the sentence plainly carries on. Rejoin two
// prose blocks when the first stops mid-sentence and the second picks up in
// lower case. Requiring lower case is what keeps headings out of this.
function joinContinuations(blocks, typicalGap) {
	for (let i = blocks.length - 1; i > 0; i--) {
		const b = blocks[i], a = blocks[i - 1];
		if (a.kind !== "text") continue;
		if (a.lines[0] && b.lines[0] && a.lines[0].rot !== b.lines[0].rot) continue;
		// A table row is complete in itself, and the lead-in to a table stops
		// on a colon without the header being the rest of its sentence.
		if (a.tabular || b.tabular || a.tableRow !== undefined || b.tableRow !== undefined) continue;
		const at = a.lines.map((l) => l.text).join(" ").trim();
		const bt = (b.lines[0] || { text: "" }).text.trim();
		if (!at || !bt) continue;
		// A colon or semicolon does not end a sentence, so a block that stops on
		// one is still open; only a full stop counts as finished here.
		if (/[.!?…][\s"'”’)\]]*$/.test(at)) continue;
		// Stopping on a relation or an operator means the expression is cut in
		// half. That is what a hanging indent does to a list item — "hence
		// c5(X) =" / "12 and ..." — and the second half, being short and full
		// of symbols, is easily taken for a formula standing on its own. Prose
		// introducing a real displayed formula stops on a word, a comma or a
		// colon, never on an equals sign, so this is the one case where a
		// formula may be pulled back into the sentence before it.
		const openExpression = /[=+×÷<>≤≥≈≡∼∈∉⊂⊆→↦−–—-]\s*$/u.test(at);
		// A list item is its own thing, whatever the lead-in before it ended on.
		if ((LIST_LABEL_RE.test(bt) && !continuesInitials(at, bt)) || (b.lines[0] && b.lines[0].entryStart) || (/^\s*\[/.test(bt) && BIB_KEY_RE.test(bt) && /\.\s*$/.test(at))) continue;
		// A hanging indent is a list item's own shape: the label sits out to the
		// left and everything after it is set in under it. So a line set in
		// under a block that *opens with a list label* is the rest of that
		// item, however it reads on its own. Asking that the block be a list
		// item is what keeps a displayed formula out — a formula is also set in
		// from the margin, by an amount no different from a deep hanging
		// indent, and nothing in the geometry alone tells the two apart.
		const head = a.lines[0], tail = a.lines[a.lines.length - 1], next = b.lines[0];
		// ...and it has to be the *next* line, at ordinary leading. A formula
		// displayed under a list item is set in from the label exactly as the
		// item's own continuation is, and reads as a formula just as that does;
		// what a continuation does not have is the space above it that sets a
		// display apart from the text.
		const tight = !!(next && tail
			&& tail.rect[1] - next.rect[3] <= typicalGap + 0.6 * next.size);
		// ...and it must not be centred. A numbered contribution reads as a list
		// item — "1. Correct fixed-size chains." — and a formula displayed
		// under one sits indented, at a gap the tall glyphs of the formula
		// itself make look small. Being set about the middle of the column is
		// what a display does and a continuation never does.
		// ...and the item must have a hanging indent at all. A run-in numbered
		// paragraph — "3. Gibbs measures with spectral potentials. In Section 5
		// we replace …" — opens with a label too, but its own next line is back
		// at the margin, and what is set in under it is a displayed formula.
		const hangs = a.lines.slice(1).every((l) => l.rect[0] > head.rect[0] + 0.5 * l.size);
		const indented = !!(next && head && tail && tight && hangs
			&& LIST_LABEL_RE.test(head.text)
			// (a line already read as prose is no display, however near the
			// middle its end happens to leave it)
			&& (next.flow || !isCentred(next))
			// (nor is a numbered line, which is a display wherever it stands)
			&& next.eqNumFrom < 0 && next.eqNumTo < 0
			&& next.rect[3] < tail.rect[1]
			&& next.rect[0] > head.rect[0] + 0.5 * next.size);
		// The tail of a list item is short and full of symbols and is easily
		// taken for a formula of its own. It may be pulled back into the item
		// when the item stops mid-expression or when it is set in under it —
		// which a real displayed formula, set in much further, is not.
		if (b.kind !== "text" && !openExpression && !indented) continue;
		const unfinished = openExpression || indented || /[,([{:]\s*$/u.test(at);
		if (!unfinished && !/^\p{Ll}/u.test(bt)) continue;
		a.lines.push(...b.lines);
		blocks.splice(i, 1);
	}
	return blocks;
}

// --- block text ------------------------------------------------------------

// Flatten a block's glyphs into one string, keeping a char index for every
// position so a sentence range can be turned back into rectangles. Soft
// hyphens (flagged `ignorable` by Zotero) close up; footnote markers and
// equation numbers become spaces so they neither split a sentence nor get
// highlighted as part of one.
function buildBlockText(chars, lines) {
	let text = "";
	const map = [];
	const lineStarts = [];
	const push = (s, idx) => { text += s; for (let i = 0; i < s.length; i++) map.push(idx); };
	for (let li = 0; li < lines.length; li++) {
		const ln = lines[li];
		lineStarts.push(text.length);
		const stop = ln.eqNumFrom >= 0 ? ln.eqNumFrom - 1 : ln.to;
		let lastKept = -1;
		for (let i = ln.eqNumTo >= 0 ? ln.eqNumTo + 1 : ln.from; i <= stop; i++) {
			const ch = chars[i];
			if (ch.skip) continue;               // soft hyphen at a line break
			push(ch.marker ? " " : ch.c, ch.marker ? -1 : i);
			if (!ch.marker) lastKept = i;
			if (ch.space) push(" ", -1);
		}
		if (li < lines.length - 1) {
			// No space when the line ended on a hyphen Zotero told us to drop.
			const ended = chars[ln.to];
			if (!(ended && ended.skip) && lastKept >= 0) push(" ", -1);
		}
	}
	return { text, map, lineStarts };
}

// --- sentence boundaries ---------------------------------------------------

const TERMINATOR_RE = /[.!?…]/;
const CLOSER_RE = /[.!?…'"’”)\]}»›]/;
const OPENER_RE = /[\p{Lu}\p{N}"“'‘(\[«$—–]/u;

// The alphabetic token ending just before `i`, dots included, so "w.r.t" and
// "i.e" come back whole rather than as "t" and "e".
function prevToken(text, i) {
	let j = i, out = "";
	while (j > 0) {
		const c = text[j - 1];
		if (/\p{L}/u.test(c)) { out = c + out; j--; continue; }
		if (c === "." && out && j - 1 > 0 && /\p{L}/u.test(text[j - 2])) { out = "." + out; j--; continue; }
		break;
	}
	return out;
}

// Decide whether the terminator at `i` (whose closing quotes and brackets run
// to `end`) really ends a sentence. Everything here is a reason to say no; the
// last few lines are the only ways to say yes.
function isBoundary(text, i, end, math, lineStarts) {
	const ch = text[i];

	// Inside a formula: a subscript dot, a decimal, "f.g" in a diagram chase.
	// The glyph itself may come from a text font even in maths, so a period
	// flanked by formula on both sides counts as formula too.
	if (math[i] || (math[i - 1] && math[end])) return false;

	// A sentence ends and another begins with a space between them. Without
	// one this is an identifier — "math.PR", a file name, a version — however
	// much the character after it looks like the start of a sentence.
	if (end < text.length && !/\s/.test(text[end])) return false;

	let j = end;
	while (j < text.length && /\s/.test(text[j])) j++;
	const atEnd = j >= text.length;
	const next = atEnd ? "" : text[j];

	if (ch === ".") {
		// 3.14, Section 2.1, version 1.0 — a period between two digits.
		if (/\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || "")) return false;
	}

	// A lower-case word after the period means the sentence did not stop —
	// unless it is a formula variable, as in "... is finite. f(x) denotes ...".
	if (!atEnd && /\p{Ll}/u.test(next) && !math[j]) return false;

	// "..." only closes a sentence when something new starts after it.
	if (ch === "…" || text.slice(Math.max(0, i - 2), i + 1) === "...") {
		if (!atEnd && !/\p{Lu}/u.test(next)) return false;
	}

	if (ch === ".") {
		const tok = prevToken(text, i);
		const low = tok.toLowerCase();
		if (ABBREV_NEVER.has(low)) return false;
		if (ABBREV_MAYBE.has(low) && !atEnd && !OPENER_RE.test(next)) return false;

		// Author initials: "J. R. R. Tolkien". A single capital is an initial
		// when another initial follows it or one precedes it — which leaves
		// "... in Appendix A. We now ..." free to end a sentence.
		if (/^\p{Lu}$/u.test(tok)) {
			if (/^\s*\p{Lu}\./u.test(text.slice(end))) return false;
			if (/\p{Lu}\.\s*$/u.test(text.slice(0, i - 1))) return false;
			// "Crandall and R. Newcomb": a single initial after a surname and
			// "and". Points named by capitals — "joins A and C. Then" — have a
			// capital, not a name, before the "and".
			if (!math[i - 1] && /\p{Lu}\p{Ll}{2,}\s+(?:and|&)\s+$/u.test(text.slice(0, i - 1))
				&& /^\s*\p{Lu}\p{Ll}/u.test(text.slice(end))) return false;
		}

		// "1.", "(a)", "2.3.1." or "A.1." opening a list item or a run-in
		// section heading, judged by sitting at the very start of a visual
		// line. Appendices number their sections with a letter, so a segment
		// is a letter or a small number either way. The dotted form is why the
		// window reaches past a couple of characters: in "2.3.1." the final
		// period is six characters in.
		for (const ls of lineStarts) {
			if (i < ls || i - ls > 8) continue;
			if (/^[\s([]*(?:(?:\p{L}|\d{1,3})(?:\.(?:\p{L}|\d{1,3})){0,3}|[ivxlcdm]{1,4})$/iu.test(text.slice(ls, i))) return false;
		}
	}

	if (atEnd) return true;
	if (OPENER_RE.test(next)) return true;
	if (math[j]) return true;          // the next sentence opens with a formula
	return false;
}

// Split a block into [start, end) ranges. `math[k]` says whether the glyph at
// text position k came from a formula; `lineStarts` are the text offsets where
// each visual line begins.
function splitSentences(text, math, lineStarts) {
	// A bibliography entry is one unit: it is full of initials, abbreviated
	// journal names and years, and none of those breaks are worth having.
	if (BIB_KEY_RE.test(text)) return [[0, text.length]];
	// ...and so is one numbered "47." rather than keyed, known by what a
	// reference carries and a numbered list item does not: a year and pages.
	if (/^\s*\d{1,3}\.\s/.test(text) && /\b(?:1[89]|20)\d{2}\b/.test(text)
		&& /\d+\s*[–-]\s*\d+|\bpp\.|preprint|to appear/i.test(text)) return [[0, text.length]];

	const out = [];
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		if (!TERMINATOR_RE.test(text[i])) continue;
		let end = i + 1;
		while (end < text.length && CLOSER_RE.test(text[end])) end++;
		if (!isBoundary(text, i, end, math, lineStarts)) continue;
		out.push([start, end]);
		start = end;
		while (start < text.length && /\s/.test(text[start])) start++;
		i = end - 1;
	}
	if (start < text.length && /\S/.test(text.slice(start))) out.push([start, text.length]);
	if (!out.length) return [[0, text.length]];
	return mergeTiny(text, out);
}

// A fragment with nothing to read in it — a stray ")." left by a bad guess
// upstream — belongs to its neighbour rather than being a stop of its own.
// Digits count as something to read: a section number like "1.2." holds no
// letters at all, and swallowing it into the sentence above would drag the
// highlight onto the heading below.
const contentLength = (s) => (s.match(/[\p{L}\p{N}]/gu) || []).length;

function mergeTiny(text, ranges) {
	const out = [];
	for (const r of ranges) {
		if (contentLength(text.slice(r[0], r[1])) < 2 && out.length) out[out.length - 1][1] = r[1];
		else out.push(r);
	}
	// A leading scrap has no predecessor to join, so it leads the next piece.
	if (out.length > 1 && contentLength(text.slice(out[0][0], out[0][1])) < 2) {
		out[1][0] = out[0][0];
		out.shift();
	}
	return out;
}

// --- rectangles ------------------------------------------------------------

// Turn a run of char indices into the boxes to paint. A new box starts at a
// line break and at any wide horizontal gap, so a sentence never paints over
// the blank channel before an equation number or across a column gutter.
function rectsForChars(chars, idx) {
	const out = [];
	let run = null;
	const flush = () => { if (run) out.push(run.rect); run = null; };
	for (let k = 0; k < idx.length; k++) {
		const i = idx[k];
		const ch = chars[i];
		if (!ch || ch.skip || /^\s+$/.test(ch.c)) continue;
		if (run && i === run.last) continue;   // same glyph reached twice
		if (run) {
			const prev = chars[run.last];
			const gap = ch.rect[0] - prev.rect[2];
			// A footnote marker is left out of the text but not out of the
			// line: stepping over one must not put a hole in the highlight.
			let skipped = true;
			for (let j = run.last + 1; j < i; j++) {
				const between = chars[j];
				if (!(between.marker || between.skip || /^\s*$/.test(between.c))) { skipped = false; break; }
			}
			const broke = prev.lineEnd || i <= run.last || !skipped || ch.rot !== prev.rot
				// A gulf between cells breaks a line; less does not. A glyph
				// that maps to no character at all — `≍` in "N_n ≍ n⁹" — leaves a
				// hole wider than a word space in the middle of a sentence.
				|| gap > 2.5 * Math.max(prev.size, ch.size, 4) || gap < -prev.size;
			if (broke) flush();
		}
		if (!run) run = { rect: [ch.irect[0], ch.irect[1], ch.irect[2], ch.irect[3]], last: i };
		else {
			const r = run.rect, s = ch.irect;
			r[0] = Math.min(r[0], s[0]); r[1] = Math.min(r[1], s[1]);
			r[2] = Math.max(r[2], s[2]); r[3] = Math.max(r[3], s[3]);
			run.last = i;
		}
	}
	flush();
	return out;
}

// Which column a unit sits in. A unit that starts just outside every tightened
// column — a hanging indent, a bullet — takes the nearest one rather than
// sorting to the front of the page.
function colIndexFor(left, cols) {
	for (let i = 0; i < cols.length; i++) {
		if (left >= cols[i].left - 1 && left <= cols[i].right + 1) return i;
	}
	let best = 0, bestDist = Infinity;
	for (let i = 0; i < cols.length; i++) {
		const d = Math.min(Math.abs(left - cols[i].left), Math.abs(left - cols[i].right));
		if (d < bestDist) { bestDist = d; best = i; }
	}
	return best;
}

// --- one page, start to finish --------------------------------------------

// The whole pipeline, kept free of Zotero so test.js can drive it directly.
// Every granularity is derived from the same block text and the same index
// map, so a word, a line, a sentence and a paragraph all agree about what
// counts as text — the equation number that was dropped for one is dropped for
// all of them. Computing the four together costs a fraction of a millisecond
// and means switching granularity never re-reads the page.
const GRANULARITIES = ["word", "line", "sentence", "paragraph"];

// The single rectangle a displayed formula occupies. Maths is set in two
// dimensions — a fraction draws its numerator then moves back and down for the
// denominator, a summation hangs its limits above and below — so following the
// glyphs produces a ragged row of boxes with holes between them. One area is
// both what the formula is and the only shape that cannot come out ragged.
// How far a formula's band reaches up and down. It covers everything standing
// on the row — including the pieces of a brace, which carry no text but plainly
// belong to the formula — and then stops short of the lines above and below.
// A tall formula's box genuinely overlaps its neighbours' boxes, because a
// fraction reaches into the white space above the line; what it must not do is
// cover their glyphs.
function displayBand(block, lines) {
	let bottom = block.rect[1], top = block.rect[3];
	// A brace reaches past the row on both sides — that is what makes it a
	// brace — so a piece counts as standing on the row if it comes within a
	// line of it. Taking one in extends the reach, which can bring the next
	// one in, so this repeats until nothing more is found.
	const reach = block.size || 10;
	const members = new Set(block.lines);
	for (let pass = 0; pass < 8; pass++) {
		let grew = false;
		for (const line of lines) {
			if (!line.blank || line.col !== block.col) continue;
			if (line.rect[2] < block.rect[0] || line.rect[0] > block.rect[2]) continue;
			if (line.rect[1] > top + reach || line.rect[3] < bottom - reach) continue;
			members.add(line);
			if (line.rect[1] < bottom) { bottom = line.rect[1]; grew = true; }
			if (line.rect[3] > top) { top = line.rect[3]; grew = true; }
		}
		if (!grew) break;
	}
	// A big delimiter or operator is centred on the maths axis, a quarter of an
	// em above the baseline of the row it encloses — which is what gives back
	// the ink its box leaves out (see hangsBelowBaseline): it reaches as far
	// below the axis as its top stands above it. Its top is exact, with none of
	// the room a letter's box keeps above the letter, so it is given some.
	//
	// Each glyph is centred on the axis of its own row: a formula set over two
	// rows has two axes, and measuring a brace on the top row against the
	// bottom row's axis stretches it into the text below. The row is the line
	// of the formula whose axis the glyph's top stands a little above — no
	// more than a couple of ems, which is as tall as a single glyph gets.
	//
	// Which lines are neighbours is settled before the band is stretched, so
	// that a stretch too far cannot make the line it lands on look like part
	// of the formula.
	const core = [bottom, top];
	for (const line of members) {
		if (line.hangTop === null) continue;
		let row = null;
		for (const other of block.lines) {
			if (!other.standingGlyphs) continue;
			const rise = line.hangTop - (other.standingBaseline + 0.25 * other.size);
			if (rise <= 0 || rise > 2 * other.size) continue;
			if (!row || other.standingGlyphs > row.standingGlyphs) row = other;
		}
		if (!row) continue;
		const axis = row.standingBaseline + 0.25 * row.size;
		top = Math.max(top, line.hangTop + 0.12 * row.size);
		bottom = Math.min(bottom, 2 * axis - line.hangTop);
	}
	for (const line of lines) {
		if (line.blank || line.furniture || line.col !== block.col) continue;
		if (block.lines.includes(line)) continue;
		// A line whose middle falls inside the row is standing *on* it — an
		// equation number, the full stop after a fraction — and is no
		// neighbour to stop short of. Judging by the middle rather than the
		// edges matters at both ends: a tall formula overlaps the box of the
		// line above it, and a line level with the formula overlaps the
		// formula's own numerator and denominator.
		const middle = (line.rect[1] + line.rect[3]) / 2;
		if (middle >= core[0] && middle <= core[1]) continue;
		if (middle > core[1]) top = Math.min(top, line.rect[1]);
		else bottom = Math.max(bottom, line.rect[3]);
	}
	// Formula lines hemmed in by pieces of another formula can be clamped down
	// to nothing — a highlight one hairline tall. Its own glyphs are a better
	// answer than that.
	const own = block.rect[3] - block.rect[1];
	if (top - bottom < 0.6 * own) return [block.rect[1], block.rect[3]];
	return [bottom, top];
}

function boundingArea(chars, idx, col, band) {
	let box = null;
	for (const i of idx) {
		const ch = chars[i];
		if (!ch || ch.skip || !ch.c.trim()) continue;
		const r = ch.irect;
		if (!box) box = [r[0], r[1], r[2], r[3]];
		else {
			box[0] = Math.min(box[0], r[0]); box[1] = Math.min(box[1], r[1]);
			box[2] = Math.max(box[2], r[2]); box[3] = Math.max(box[3], r[3]);
		}
	}
	if (!box) return [];
	// A displayed formula is marked across the full width of the text rather
	// than hugging its glyphs. A formula's outline is ragged — limits under a
	// summation sign, a fraction wider than the line it sits on — and a band
	// that traces it reads as a shape rather than a mark on the page.
	if (col) { box[0] = col.left; box[2] = col.right; }
	if (band) { box[1] = band[0]; box[3] = band[1]; }
	return [box];
}

// Fold away boxes that sit on top of one another. Inline maths is set in two
// dimensions just as displayed maths is — a fraction in the middle of a
// sentence hands back a box for the numerator and an identical one for the
// denominator — and one box is both cheaper and, since a group is composited
// once, exactly as correct. Boxes on one line share a band exactly, so they
// only ever have to be compared along x, and a real gap (the channel before an
// equation number) is far too wide to be closed by this.
function mergeBoxes(rects) {
	if (rects.length < 2) return rects;
	// Boxes are gathered into visual rows by how much they overlap vertically,
	// not by an exact match on their extent. An exponent arrives as its own
	// piece with its own raised extent, and leaving it on its own band draws a
	// box higher than the rest of the line — a step in the middle of an
	// otherwise flat highlight. Two consecutive lines of prose barely overlap,
	// so they stay the separate rows they are.
	const rows = [];
	for (const r of rects) {
		const height = r[3] - r[1];
		let row = null;
		for (const candidate of rows) {
			const overlap = Math.min(candidate.band[1], r[3]) - Math.max(candidate.band[0], r[1]);
			if (overlap >= 0.5 * Math.min(height, candidate.band[1] - candidate.band[0])) {
				row = candidate;
				break;
			}
		}
		if (!row) { row = { band: [r[1], r[3]], items: [] }; rows.push(row); }
		else {
			row.band[0] = Math.min(row.band[0], r[1]);
			row.band[1] = Math.max(row.band[1], r[3]);
		}
		row.items.push(r);
	}

	const out = [];
	for (const row of rows) {
		row.items.sort((p, q) => p[0] - q[0]);
		let cur = null;
		for (const r of row.items) {
			if (cur && r[0] <= cur[2]) { cur[2] = Math.max(cur[2], r[2]); continue; }
			if (cur) out.push(cur);
			cur = [r[0], row.band[0], r[2], row.band[1]];
		}
		if (cur) out.push(cur);
	}
	return out;
}

function rangeToUnit(chars, text, map, a, b, kind, wholeArea, col, band) {
	// One glyph can stand behind several characters: Zotero normalises the
	// "ffi" ligature to a three-character string but keeps it as a single
	// glyph with a single rect. Those characters all map to the same index,
	// and it must only be counted once — a box per character would stack three
	// of them on one glyph, and a multiply blend paints that darker than the
	// rest of the line.
	const idx = [];
	for (let k = a; k < b; k++) {
		const i = map[k];
		if (i >= 0 && i !== idx[idx.length - 1]) idx.push(i);
	}
	if (!idx.length) return null;
	const rects = mergeBoxes(wholeArea ? boundingArea(chars, idx, col, band) : rectsForChars(chars, idx));
	if (!rects.length) return null;
	// The unit's own line height. Padding is measured against this rather than
	// the box, because a displayed formula's box spans every row it occupies
	// and would otherwise be padded by a multiple of its whole height.
	// The size of the type, not the height of the line's band. A line carrying
	// a fraction has a band three times its type size, and room measured
	// against that swallows the line above.
	const sizes = [];
	for (const i of idx) {
		const ch = chars[i];
		if (ch && !ch.skip && ch.c.trim()) sizes.push(ch.size);
	}
	return {
		kind,
		em: percentile(sizes, 0.75) || (rects[0][3] - rects[0][1]) || 1,
		text: text.slice(a, b).trim(),
		rects,
		top: Math.max(...rects.map((r) => r[3])),
		left: Math.min(...rects.map((r) => r[0])),
	};
}

function lineRanges(text, lineStarts) {
	const out = [];
	for (let i = 0; i < lineStarts.length; i++) {
		const a = lineStarts[i];
		const b = i + 1 < lineStarts.length ? lineStarts[i + 1] : text.length;
		if (/\S/.test(text.slice(a, b))) out.push([a, b]);
	}
	return out;
}

function wordRanges(text) {
	const out = [];
	const re = /\S+/gu;
	let m;
	while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
	return out;
}

// Everything from raw glyphs to classified lines. Shared with the diagnostics
// dump, so what a report describes is exactly what the segmentation saw.
function analysePage(rawChars, viewBox, opts = {}) {
	const chars = materialize(rawChars);
	// Counted before charsToLines stitches fragments together, so a report can
	// show how badly the layout cut the page up in the first place.
	let fragments = 0;
	for (const ch of chars) if (ch.lineEnd) fragments++;
	const lines = chars.length ? charsToLines(chars) : [];
	if (!lines.length) return { chars, lines, cols: [], fragments };

	const cols = detectColumns(lines, viewBox);
	assignColumns(lines, cols);
	markFurniture(lines, viewBox);
	markEquationNumbers(lines);      // before classifying: a label scores a line
	for (const ln of lines) {
		if (!ln.furniture) ln.kind = classifyLine(ln);
	}
	const unmeasured = classifyByFlow(lines, cols);
	if (unmeasured.length) {
		promoteSetOffFormulas(unmeasured, typicalLineGap(unmeasured));
		keepRunningLines(unmeasured);
	}
	markContentsEntries(lines);
	// Tables before formulas are grown: a cell that is off the flow and set
	// beside a formula cell would otherwise be taken into the formula.
	detectTables(lines, cols);
	absorbBraceRows(lines);
	absorbDisplayRows(lines);
	return { chars, lines, cols, fragments };
}

// A plain-text account of how a page was read: what each line was taken for,
// and the numbers and font names behind that. Every wrong call so far has come
// down to one of these, and guessing at them from a screenshot has cost more
// than one round of being wrong.
function describePage(rawChars, viewBox, opts = {}) {
	const { chars, lines, cols, fragments } = analysePage(rawChars, viewBox, opts);
	const out = [
		`viewBox ${viewBox.map((n) => Math.round(n)).join(" ")}   mergeDisplay ${!!opts.mergeDisplay}`,
		`fragments ${fragments} -> lines ${lines.length}`,
		`columns ${cols.map((c) => `${Math.round(c.left)}..${Math.round(c.right)}` + (cols.length > 1 ? ` y ${Math.round(c.bottom)}..${Math.round(c.top)}` : "")).join("   ") || "(none)"}`,
		"",
		"--- lines ---",
	];
	for (const ln of lines) {
		const fonts = new Map();
		for (let i = ln.from; i <= ln.to; i++) {
			const font = chars[i].font || "(unnamed)";
			fonts.set(font, (fonts.get(font) || 0) + 1);
		}
		const top = [...fonts].sort((a, b) => b[1] - a[1]).slice(0, 3)
			.map(([font, n]) => `${font}(${n})`).join(" ");
		out.push(
			`${(ln.furniture ? "dropped" : ln.kind).padEnd(8)}`
			+ ` x ${Math.round(ln.rect[0])}..${Math.round(ln.rect[2])}`
			+ ` y ${Math.round(ln.rect[1])}..${Math.round(ln.rect[3])}`
			+ ` size ${ln.size.toFixed(1)} math ${ln.mathFrac.toFixed(2)} var ${ln.variableFrac.toFixed(2)}`
			+ ` words ${ln.textWords} rel ${ln.hasRelation ? "y" : "n"} eqnum ${ln.eqNumFrom >= 0 ? "y" : ln.eqNumTo >= 0 ? "left" : "n"}`
			+ ` para ${ln.paraEnd ? "y" : "n"}`
			+ (ln.hangTop !== null ? ` hang ${Math.round(ln.hangTop)}` : "")
			+ (ln.tableRow !== undefined ? ` row ${ln.tableRow}` : ln.tabular ? " tabular" : "")
			+ (ln.flow ? " flow" : ln.inline ? " inline" : ""),
			`         fonts ${top}`,
			`         text  ${JSON.stringify(ln.text.slice(0, 90))}`,
		);
	}

	// What all that turned into, which is the half a screenshot does show —
	// having both in one place is what makes a report worth pasting.
	out.push("", "--- units (sentence) ---");
	for (const unit of segmentPage(rawChars, viewBox, { ...opts, only: "sentence" }).sentence) {
		// The boxes as well as the text: where a highlight is drawn is half of
		// what can go wrong, and it cannot be read off the lines above.
		const boxes = unit.rects
			.map((r) => `[${r.map((n) => Math.round(n)).join(",")}]`)
			.join(" ");
		out.push(
			`${unit.kind.padEnd(8)} em ${unit.em.toFixed(1)}  ${JSON.stringify(unit.text.slice(0, 92))}`,
			`         ${boxes}`,
		);
	}
	return out.join("\n");
}

// `opts.only` names the one step size wanted. The reader only ever keeps the
// units it is stepping by, and building all four — every word boxed on the
// page, then thrown away — is most of the work past the analysis itself.
function segmentPage(rawChars, viewBox, opts = {}) {
	const out = { word: [], line: [], sentence: [], paragraph: [] };
	const wanted = opts.only && GRANULARITIES.includes(opts.only) ? [opts.only] : GRANULARITIES;
	const { chars, lines, cols } = analysePage(rawChars, viewBox, opts);
	if (!lines.length) return out;

	const gap = typicalLineGap(lines);
	const blocks = joinContinuations(linesToBlocks(lines, gap, !!opts.mergeDisplay), gap);
	for (const block of blocks) {
		const { text, map, lineStarts } = buildBlockText(chars, block.lines);
		if (!/\p{L}|\p{N}/u.test(text)) continue;
		const math = map.map((i) => i >= 0 && chars[i].math);
		// A formula and a table row are each one thing to read, and the full
		// stops in them are not the ends of sentences: a contents entry's dot
		// leader is a row of them, and splitting there hands its page number
		// to the entry below.
		const whole = block.kind === "display" || block.tabular || block.tableRow !== undefined;
		const ranges = {
			word: () => wordRanges(text),
			line: () => lineRanges(text, lineStarts),
			sentence: () => (whole ? [[0, text.length]] : splitSentences(text, math, lineStarts)),
			paragraph: () => [[0, text.length]],
		};
		// The same for every step size: where the block sits and how tall a
		// formula's band is.
		const oneThing = block.kind === "display" || block.tableRow !== undefined || block.tabular;
		// Only a formula is widened to the measure; a table row keeps to the
		// row it occupies.
		// A table row found as part of a table is marked across the table.
		const tableBox = block.tableRow !== undefined && block.lines[0] && block.lines[0].tableBox;
		const measure = block.kind === "display" ? (block.lines[0] && block.lines[0].col)
			: tableBox ? { left: tableBox[0], right: tableBox[2] } : null;
		const band = block.kind === "display" ? displayBand(block, lines) : tableBox ? [tableBox[1], tableBox[3]] : null;
		for (const g of wanted) {
			// A displayed formula and a row of table cells are both read as one
			// thing, so both are highlighted as the one area they occupy — a
			// box per cell leaves the row in pieces with the column gaps cut
			// out of it. Stepping word by word still wants the tokens boxed
			// individually, and at line size a cell is a line of its own.
			const wholeArea = oneThing && g !== "word" && g !== "line";
			for (const [a, b] of ranges[g]()) {
				const unit = rangeToUnit(chars, text, map, a, b, block.kind, wholeArea, measure, band);
				if (!unit) continue;
				// Reading order is by region, and regions can share an x range — the
				// left column above a figure and the left column below it.
				const region = cols.indexOf(block.lines[0] && block.lines[0].col);
				if (region >= 0) unit.col = region;
				out[g].push(unit);
			}
		}
	}
	// Reading order: down a column, then on to the next one.
	for (const g of wanted) {
		for (const u of out[g]) if (u.col === undefined) u.col = colIndexFor(u.left, cols);
		out[g].sort((u, v) => (u.col - v.col) || (v.top - u.top));
	}
	return out;
}

// --- reader plumbing -------------------------------------------------------

// Everything below this line talks to Zotero.

const Cu = typeof Components !== "undefined" ? Components.utils : null;

// reader -> live state. Keyed by the reader object so two tabs stay independent.
const sessions = new Map();
// itemID -> Map(pageIndex -> units). A PDF's text never changes, so a page
// analysed once stays analysed for the session.
const pageCache = new Map();
const CACHE_PAGES = 60;   // pages, per document and per step size
const CACHE_WORD_PAGES = 15;  // a page's words outnumber its sentences twenty to one
const CACHE_DOCS = 4;     // documents whose analysis is kept at all

const pageLimit = () => (granularity() === "word" ? CACHE_WORD_PAGES : CACHE_PAGES);

let onRenderToolbar;  // kept so shutdown can unregister it
let prefPane;

function viewerOf(reader) {
	const win = reader && reader._internalReader && reader._internalReader._primaryView
		&& reader._internalReader._primaryView._iframeWindow;
	const app = win && win.PDFViewerApplication;
	if (!app || !app.pdfDocument) return null;
	return { win, app, doc: win.document, pdf: app.pdfDocument, viewer: app.pdfViewer };
}

// pdf.js builds a page view for every page as soon as the document loads, so
// this resolves even for pages that have never been scrolled into sight. Xrays
// are waived because all we read off the viewport are numbers.
function pageViewOf(v, pageIndex) {
	try {
		const pv = Cu.waiveXrays(v.viewer.getPageView(pageIndex));
		if (!pv || !pv.div || !pv.viewport) return null;
		return pv;
	} catch (e) {
		return null;
	}
}

// Looked up rather than held. A session that kept a reference to its map would
// go on using it after the analysis was invalidated — the map would still be
// there, just no longer the one `pageCache` hands out — so a setting that
// changes how pages are read would appear to do nothing on every page already
// visited.
function cacheFor(reader) {
	const key = reader && reader.itemID;
	if (key == null) return new Map();       // odd reader shape: don't share a key
	let m = pageCache.get(key);
	if (m) {
		pageCache.delete(key);               // re-insert: Map order is the LRU order
	} else {
		m = new Map();
	}
	pageCache.set(key, m);
	// Pages are capped per document, but a reading session opens many
	// documents, and without this the analysis of every one of them is held
	// for as long as Zotero runs.
	while (pageCache.size > CACHE_DOCS) pageCache.delete(pageCache.keys().next().value);
	return m;
}

const cacheOf = (session) => cacheFor(session.reader);

// Analyse one page, or hand back the analysis we already have. A page being
// fetched is remembered as a promise, so a prefetch and a keypress that want
// the same page share one trip to the worker instead of racing for it.
// Keyed by step size as well as page. Analysing a page works out all four
// sizes in one pass, but keeping all four costs about ten times what keeping
// one does — a page's words outnumber its sentences twenty to one — and the
// step size is changed rarely. So only the size in use is kept; changing it
// costs one re-read of each page revisited.
const cacheKey = (pageIndex) => `${pageIndex}:${granularity()}`;

function unitsAt(session, pageIndex) {
	const key = cacheKey(pageIndex);
	const cached = cacheOf(session).get(key);
	if (cached) return Promise.resolve(cached);
	let pending = session.inflight.get(key);
	if (!pending) {
		pending = computeUnits(session, pageIndex, key);
		session.inflight.set(key, pending);
		pending.then(() => session.inflight.delete(key), () => session.inflight.delete(key));
	}
	return pending;
}

async function computeUnits(session, pageIndex, key) {
	const v = viewerOf(session.reader);
	if (!v) return [];
	let units = [];
	try {
		const data = Cu.waiveXrays(await v.pdf.getPageData(Cu.cloneInto({ pageIndex }, v.win)));
		if (data && data.chars) {
			const g = granularity();
			const all = segmentPage(data.chars, data.viewBox || [0, 0, 612, 792], { mergeDisplay: !!pref("mergeDisplay"), only: g });
			units = all[g] || all.sentence || [];
		}
	} catch (e) {
		Zotero.debug(`Sentence Focus: page ${pageIndex + 1} unreadable - ` + e);
	}
	const cache = cacheOf(session);
	cache.set(key, units);
	// Map iterates in insertion order, so the oldest page goes first.
	while (cache.size > pageLimit()) cache.delete(cache.keys().next().value);
	return units;
}

// --- painting --------------------------------------------------------------

// The wrapper deliberately has no box of its own. A positioned wrapper forms a
// stacking context, and that isolates the highlight's mix-blend-mode from the
// page canvas underneath — the blend then falls back to ordinary alpha, which
// lays a wash over the glyphs and leaves them muddy instead of leaving the ink
// alone. `display: contents` makes the boxes paint as direct children of the
// page div. Zotero draws its own annotation overlay this way for exactly the
// same reason; the page div is `position: relative`, so the boxes still
// measure against the page.
const CSS = `
.sfz-layer{display:contents}
.sfz-veil{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:3}
.sfz-veil.sfz-blend{mix-blend-mode:var(--sfz-blend)}
`;

// A highlighter darkens paper and lightens ink, so the blend has to follow the
// page rather than the OS theme: Zotero's reader recolours the PDF itself, and
// `prefers-color-scheme` inside the viewer says nothing about that. Read the
// background actually behind the glyphs instead.
//
// The page element itself is often transparent, with the white coming from a
// wrapper further out — and `rgba(0, 0, 0, 0)` read as a colour is black,
// which would pick the dark-page blend and wash every glyph out. So skip any
// fully transparent background and keep climbing; assume paper if nothing
// opaque turns up.
function pageLuminance(v, el) {
	for (let node = el, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
		try {
			const bg = v.win.getComputedStyle(node).backgroundColor;
			const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i.exec(bg || "");
			if (!m) continue;
			if (m[4] !== undefined && Number(m[4]) === 0) continue;
			return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
		} catch (e) { /* keep climbing */ }
	}
	return 1;
}

function blendFor(v, pv) {
	if (!pref("behind")) return "normal";
	return pageLuminance(v, pv.div) < 0.5 ? "screen" : "multiply";
}

// Held weakly: a strong reference to an injected <style> would keep the whole
// document of a reader the user closed an hour ago.
const injectedStyles = [];

function injectStyle(doc, id, css) {
	if (!doc || doc.getElementById(id)) return;
	const el = doc.createElement("style");
	el.id = id;
	el.textContent = css;
	(doc.head || doc.documentElement).append(el);
	if (typeof WeakRef !== "function") return;
	// The list itself is the only thing that grows with the number of readers
	// ever opened, so the spent references are swept out now and then.
	if (injectedStyles.length > 50) {
		for (let i = injectedStyles.length - 1; i >= 0; i--) {
			if (!injectedStyles[i].deref()) injectedStyles.splice(i, 1);
		}
	}
	injectedStyles.push(new WeakRef(el));
}

function dropInjectedStyles() {
	for (const ref of injectedStyles) {
		const el = ref.deref();
		if (el) { try { el.remove(); } catch (e) { /* document already gone */ } }
	}
	injectedStyles.length = 0;
}

function injectCSS(doc) {
	injectStyle(doc, "sfz-style", CSS);
}

// pdf.js already carries the page's PDF-points-to-pixels matrix. Reusing it
// and then expressing the result as a percentage of the page box means the
// highlight tracks zooming and page rotation without recomputing anything.
function toPercent(rect, vp) {
	const t = vp && vp.transform;
	if (!t || t.length < 6) return { left: 0, top: 0, width: 0, height: 0 };
	const W = vp.width || 1, H = vp.height || 1;
	const px = (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
	const a = px(rect[0], rect[1]);
	const b = px(rect[2], rect[3]);
	return {
		left: Math.min(a[0], b[0]) / W * 100,
		top: Math.min(a[1], b[1]) / H * 100,
		width: Math.abs(a[0] - b[0]) / W * 100,
		height: Math.abs(a[1] - b[1]) / H * 100,
	};
}

function clearPaint(session) {
	for (const el of session.painted) {
		try { el.remove(); } catch (e) { /* page already torn down */ }
	}
	session.painted = [];
}

// The step size the user is reading at. Read from the pref each time so a
// change takes effect without rebuilding anything.
function granularity() {
	const g = String(pref("granularity"));
	return GRANULARITIES.includes(g) ? g : "sentence";
}

function currentUnit(session) {
	const units = cacheOf(session).get(cacheKey(session.pageIndex));
	return units && units[session.unitIndex];
}

const SVG_NS = "http://www.w3.org/2000/svg";

// The highlight styles, in one place: the reader menu builds its chips from
// this list, and test.js checks the preferences pane offers the same set.
const STYLES = [
	["tint", "Tint", "A flat wash with square edges."],
	["rounded", "Rounded", "The same wash, with the corners taken off."],
	["soft", "Soft", "Feathered edges that fade out instead of stopping."],
	["marker", "Marker", "A chisel-tip stroke: slanted ends and a soft edge."],
	["underline", "Underline", "A rule under each line; nothing covers the text."],
	["dim", "Dim rest", "Veils the rest of the page instead of marking the unit."],
];
const STYLE_NAMES = new Set(STYLES.map(([value]) => value));

function styleName() {
	const name = String(pref("style"));
	return STYLE_NAMES.has(name) ? name : DEFAULTS.style;
}

let idSeq = 0;
const uniqueId = (prefix) => `${prefix}-${++idSeq}`;

// The drawing units are square: x runs 0..100 across the page and y runs
// 0..100*aspect down it. A corner radius, a blur and a slant are then the same
// size in both directions — with a viewBox of 0 0 100 100 on a taller-than-wide
// page they would all come out visibly squashed. Proportions do not change with
// zoom, so expressing everything this way still scales for free.
function pageAspect(pv) {
	const width = pv.viewport.width || 0;
	const height = pv.viewport.height || 0;
	const aspect = height / width;
	return (isFinite(aspect) && aspect > 0) ? aspect : 1.294;   // US Letter
}

function toUserBox(rect, vp, aspect) {
	const p = toPercent(rect, vp);
	return { x: p.left, y: p.top * aspect, w: p.width, h: p.height * aspect };
}

// Room around the marked text, measured in line heights so it grows with the
// type rather than with the page. A displayed formula gets a good deal more of
// it sideways: it is set off from the prose by blank space to begin with, and a
// box drawn tight against the outermost glyph reads as a clamp rather than a
// highlight.
const PADDING = {
	text: { x: 0.20, y: 0.06 },
	display: { x: 0.60, y: 0.08 },
};

function padBoxes(boxes, em, isDisplay, scale) {
	const pad = isDisplay ? PADDING.display : PADDING.text;
	const x = em * pad.x * scale;
	const y = em * pad.y * scale;
	return boxes.map((b) => ({ x: b.x - x, y: b.y - y, w: b.w + 2 * x, h: b.h + 2 * y }));
}

// Every box of a unit is drawn into ONE <svg>, filled opaque, and the strength
// and blend are applied to that group as a whole. This is what makes a unit a
// single wash of colour: maths is set in two dimensions, so a sentence
// containing a fraction hands over boxes that sit on top of one another, and
// boxes composited one at a time would darken wherever they overlap — a
// stronger patch on exactly the glyph the reader is trying to look at. Drawn
// as a group, overlapping boxes of the same opaque colour are idempotent.
function paint(session, scroll) {
	clearPaint(session);
	const v = viewerOf(session.reader);
	if (!v) { stopSession(session.reader); return; }   // tab closed under us
	const unit = currentUnit(session);
	if (!unit) return;
	const pv = pageViewOf(v, session.pageIndex);
	if (!pv) return;
	injectCSS(v.doc);

	const style = styleName();
	const strength = Math.min(0.95, Math.max(0.05, (Number(pref("opacity")) || DEFAULTS.opacity) / 100));
	// A rule two pixels tall carries far less colour than a wash over a whole
	// line, so the same setting has to push it harder to read as the same
	// weight on the page.
	const alpha = style === "underline" ? Math.min(0.95, strength * 1.7) : strength;
	const color = solidColor(String(pref("color")));
	const aspect = pageAspect(pv);
	const raw = unit.rects.map((r) => toUserBox(r, pv.viewport, aspect));
	// The page matrix is a rotation and a uniform scale, so one box's diagonal
	// against its own diagonal in points converts the unit's line height into
	// drawing units whatever the page rotation is.
	const first = unit.rects[0];
	const pointsDiagonal = Math.hypot(first[2] - first[0], first[3] - first[1]) || 1;
	const em = (unit.em || 1) * (Math.hypot(raw[0].w, raw[0].h) / pointsDiagonal);
	const scale = Math.max(0, Number(pref("padding")) || 0) / 100;
	const boxes = padBoxes(raw, em, unit.kind === "display", scale);

	const svg = v.doc.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "sfz-veil" + (style === "dim" ? "" : " sfz-blend"));
	svg.setAttribute("viewBox", `0 0 100 ${100 * aspect}`);
	svg.setAttribute("preserveAspectRatio", "none");
	svg.style.opacity = String(alpha);
	if (style !== "dim") svg.style.setProperty("--sfz-blend", blendFor(v, pv));
	drawHighlight(v.doc, svg, style, boxes, color, 100 * aspect);

	// The wrapper exists only so one remove() clears the whole highlight; it
	// has no box of its own, so the svg still measures against the page div.
	const layer = v.doc.createElement("div");
	layer.className = "sfz-layer";
	layer.append(svg);
	pv.div.append(layer);
	session.painted.push(layer);

	if (scroll) ensureVisible(v, pv, unit);
}

function drawHighlight(doc, svg, style, boxes, color, pageHeight) {
	if (style === "dim") { paintDim(doc, svg, boxes, pageHeight, color); return; }

	const lineHeight = median(boxes.map((b) => b.h)) || 1;
	// Feathering is one filter over the whole group, so neighbouring boxes melt
	// into each other rather than each growing its own halo.
	const spread = style === "soft" ? lineHeight * 0.22 : style === "marker" ? lineHeight * 0.06 : 0;
	const target = spread ? blurGroup(doc, svg, spread) : svg;
	// Blur eats into the shape from both sides, so a feathered box starts
	// slightly larger and ends up covering what it was asked to cover.
	const grow = style === "soft" ? spread * 1.15 : 0;
	const fill = style === "marker" ? inkGradient(doc, svg, color) : color;

	for (const box of boxes) {
		const b = grow
			? { x: box.x - grow, y: box.y - grow, w: box.w + 2 * grow, h: box.h + 2 * grow }
			: box;
		if (style === "underline") {
			const thickness = Math.max(0.08, b.h * 0.13);
			addBox(doc, target, b.x, b.y + b.h - thickness, b.w, thickness, fill, thickness / 2);
		} else if (style === "marker") {
			addStroke(doc, target, b, fill);
		} else {
			// Enough to read as rounded, not so much that the lines of a
			// wrapped sentence stop touching: rounding each one right off
			// leaves a scalloped edge down the side of the paragraph.
			const radius = style === "tint" ? 0 : Math.min(b.h * 0.28, b.w / 2);
			addBox(doc, target, b.x, b.y, b.w, b.h, fill, radius);
		}
	}
}

// Ink from a marker pen is not flat: it runs lighter where the tip lifts and
// pools a little lower down. A gentle vertical gradient is enough to suggest
// it. Safe inside the group because strokes on different lines never overlap.
function inkGradient(doc, svg, color) {
	const id = uniqueId("sfz-ink");
	const gradient = doc.createElementNS(SVG_NS, "linearGradient");
	gradient.setAttribute("id", id);
	gradient.setAttribute("x1", "0");
	gradient.setAttribute("y1", "0");
	gradient.setAttribute("x2", "0");
	gradient.setAttribute("y2", "1");
	for (const [offset, opacity] of [["0", "0.72"], ["0.4", "1"], ["1", "0.9"]]) {
		const stop = doc.createElementNS(SVG_NS, "stop");
		stop.setAttribute("offset", offset);
		stop.setAttribute("stop-color", color);
		stop.setAttribute("stop-opacity", opacity);
		gradient.append(stop);
	}
	const defs = doc.createElementNS(SVG_NS, "defs");
	defs.append(gradient);
	svg.append(defs);
	return `url(#${id})`;
}

function addBox(doc, parent, x, y, width, height, fill, radius) {
	const rect = doc.createElementNS(SVG_NS, "rect");
	rect.setAttribute("x", x);
	rect.setAttribute("y", y);
	rect.setAttribute("width", Math.max(0, width));
	rect.setAttribute("height", Math.max(0, height));
	rect.setAttribute("fill", fill);
	if (radius > 0) {
		rect.setAttribute("rx", radius);
		rect.setAttribute("ry", radius);
	}
	parent.append(rect);
	return rect;
}

// A chisel-tip marker leaves a stroke with slanted ends. The parallelogram is
// centred on the box, so the slant leans without dragging the colour off the
// words at either end.
function addStroke(doc, parent, b, color) {
	const lean = b.h * 0.42 / 2;
	const overshoot = b.h * 0.08;
	const x1 = b.x - overshoot, x2 = b.x + b.w + overshoot;
	const points = [
		[x1 + lean, b.y],
		[x2 + lean, b.y],
		[x2 - lean, b.y + b.h],
		[x1 - lean, b.y + b.h],
	];
	const poly = doc.createElementNS(SVG_NS, "polygon");
	poly.setAttribute("points", points.map((p) => p.join(",")).join(" "));
	poly.setAttribute("fill", color);
	parent.append(poly);
	return poly;
}

function blurGroup(doc, svg, spread) {
	const id = uniqueId("sfz-blur");
	const filter = doc.createElementNS(SVG_NS, "filter");
	filter.setAttribute("id", id);
	// Room for the blur to spread; the default filter region would clip it.
	filter.setAttribute("x", "-20%");
	filter.setAttribute("y", "-60%");
	filter.setAttribute("width", "140%");
	filter.setAttribute("height", "220%");
	const blur = doc.createElementNS(SVG_NS, "feGaussianBlur");
	blur.setAttribute("stdDeviation", String(Math.max(0.04, spread)));
	filter.append(blur);
	const defs = doc.createElementNS(SVG_NS, "defs");
	defs.append(filter);
	svg.append(defs);
	const group = doc.createElementNS(SVG_NS, "g");
	group.setAttribute("filter", `url(#${id})`);
	svg.append(group);
	return group;
}

// Dimming needs the negative of the unit, so the veil is masked: white keeps
// the wash, the unit's boxes are punched out in black. The veil is neutral
// rather than the accent colour — dimming takes contrast away from the rest of
// the page, and a black wash does that on light or dark paper alike.
function paintDim(doc, svg, boxes, pageHeight) {
	const id = uniqueId("sfz-mask");
	const mask = doc.createElementNS(SVG_NS, "mask");
	mask.setAttribute("id", id);
	mask.setAttribute("maskUnits", "userSpaceOnUse");
	mask.setAttribute("x", "0");
	mask.setAttribute("y", "0");
	mask.setAttribute("width", "100");
	mask.setAttribute("height", String(pageHeight));
	addBox(doc, mask, 0, 0, 100, pageHeight, "white");
	for (const b of boxes) addBox(doc, mask, b.x, b.y, b.w, b.h, "black", Math.min(b.h * 0.3, 0.7));
	const defs = doc.createElementNS(SVG_NS, "defs");
	defs.append(mask);
	svg.append(defs);
	addBox(doc, svg, 0, 0, 100, pageHeight, "#000").setAttribute("mask", `url(#${id})`);
}

function solidColor(hex) {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex).trim());
	return m ? `#${m[1]}` : DEFAULTS.color;
}

// Where the unit sits on screen, worked out from the page box and the same
// percentages the highlight uses — so it is right whatever the style is, and
// right for the dim style, which paints no boxes to measure.
function unitClientBox(pv, unit) {
	const page = pv.div.getBoundingClientRect();
	if (!page.height) return null;
	let top = Infinity, bottom = -Infinity;
	for (const r of unit.rects) {
		const b = toPercent(r, pv.viewport);
		top = Math.min(top, page.top + b.top / 100 * page.height);
		bottom = Math.max(bottom, page.top + (b.top + b.height) / 100 * page.height);
	}
	return top === Infinity ? null : { top, bottom };
}

// Scrolling is deliberately reluctant. Nudging the page on every step makes
// the text crawl under a stationary ruler, which is the opposite of what a
// reading ruler is for, so the default only scrolls when the unit has gone off
// screen entirely. When it does scroll it leaves a margin above: landing a
// sentence flush against the top edge gives the eye nothing to lead into.
function ensureVisible(v, pv, unit) {
	const mode = String(pref("autoScroll"));
	if (mode === "never") return;
	const container = v.doc.getElementById("viewerContainer");
	if (!container) return;
	const box = unitClientBox(pv, unit);
	const view = container.getBoundingClientRect();
	if (!box || !view.height) return;
	if (mode !== "always" && box.top >= view.top && box.bottom <= view.bottom) return;

	const margin = Math.min(80, Math.max(0, Number(pref("scrollMargin")) || 0)) / 100 * view.height;
	// A unit taller than the space below the margin is pinned to the margin
	// anyway: showing its start beats centring something that cannot fit.
	container.scrollTop += box.top - (view.top + margin);
}

// --- navigation ------------------------------------------------------------

// Moves are queued rather than run as they arrive. Each one reads the current
// index and writes the next, so two overlapping moves — a held-down key while
// a page is still being analysed — would otherwise both step off the same
// starting point and land together.
function enqueue(session, fn) {
	session.queue = session.queue
		.then(fn)
		.catch((e) => Zotero.debug("Sentence Focus: " + ((e && e.stack) || e)));
	return session.queue;
}

function pageCount(session) {
	const v = viewerOf(session.reader);
	return v ? v.pdf.numPages : 0;
}

// Walk to the next/previous sentence, crossing into neighbouring pages and
// stepping over any that hold no text at all (plates, scans without an OCR
// layer). Bounded so a run of empty pages cannot spin.
async function move(session, delta) {
	const total = pageCount(session);
	if (!total) return false;
	let page = session.pageIndex;
	let units = await unitsAt(session, page);
	let i = session.unitIndex + delta;
	let hops = 0;
	while ((i < 0 || i >= units.length) && hops++ < 64) {
		page += delta > 0 ? 1 : -1;
		if (page < 0 || page >= total) return false;
		units = await unitsAt(session, page);
		i = delta > 0 ? 0 : units.length - 1;
	}
	if (!units.length || i < 0 || i >= units.length) return false;
	session.pageIndex = page;
	session.unitIndex = i;
	paint(session, true);
	prefetch(session);
	return true;
}

// Keep the neighbouring pages warm so crossing a page boundary is not the one
// move that stutters.
function prefetch(session) {
	const total = pageCount(session);
	for (const p of [session.pageIndex + 1, session.pageIndex - 1]) {
		if (p >= 0 && p < total && !cacheOf(session).has(cacheKey(p))) {
			Promise.resolve().then(() => unitsAt(session, p)).catch(() => {});
		}
	}
}

// The first sentence at or below the top of what the reader is showing, so
// switching the ruler on picks up where the eye already is.
function pickVisible(session, units) {
	const v = viewerOf(session.reader);
	const pv = v && pageViewOf(v, session.pageIndex);
	const container = v && v.doc.getElementById("viewerContainer");
	if (!pv || !container || !units.length) return 0;
	const pageBox = pv.div.getBoundingClientRect();
	if (!pageBox.height) return 0;
	const cut = (container.getBoundingClientRect().top - pageBox.top) / pageBox.height * 100;
	for (let i = 0; i < units.length; i++) {
		const top = Math.min(...units[i].rects.map((r) => toPercent(r, pv.viewport).top));
		if (top >= cut - 1) return i;
	}
	return units.length - 1;
}

async function focusPage(session, pageIndex, which) {
	const units = await unitsAt(session, pageIndex);
	session.pageIndex = pageIndex;
	if (!units.length) { clearPaint(session); return; }
	session.unitIndex = which === "visible" ? pickVisible(session, units)
		: which === "last" ? units.length - 1 : 0;
	paint(session, which !== "visible");
	prefetch(session);
}

// A click puts the ruler where the reader is looking. The point is measured as
// a fraction of the page box, which is the same space the highlight boxes are
// already in, so no extra coordinate maths is needed.
async function focusAtPoint(session, pageEl, clientX, clientY) {
	const v = viewerOf(session.reader);
	if (!v) return;
	const pageIndex = Number(pageEl.dataset.pageNumber) - 1;
	if (!Number.isInteger(pageIndex) || pageIndex < 0) return;
	const pv = pageViewOf(v, pageIndex);
	if (!pv) return;
	const box = pageEl.getBoundingClientRect();
	if (!box.width || !box.height) return;
	const x = (clientX - box.left) / box.width * 100;
	const y = (clientY - box.top) / box.height * 100;

	const units = await unitsAt(session, pageIndex);
	if (!units.length) return;
	let best = -1, bestScore = Infinity;
	for (let i = 0; i < units.length; i++) {
		for (const r of units[i].rects) {
			const b = toPercent(r, pv.viewport);
			// Distance to the box, with a vertical bias: clicking in the gap
			// between two lines should take the line, not the far column.
			const dx = Math.max(b.left - x, 0, x - (b.left + b.width));
			const dy = Math.max(b.top - y, 0, y - (b.top + b.height));
			const score = dy * 6 + dx;
			if (score < bestScore) { bestScore = score; best = i; }
		}
	}
	if (best < 0 || bestScore > 12) return;   // clicked well away from any text
	session.pageIndex = pageIndex;
	session.unitIndex = best;
	paint(session, false);
	prefetch(session);
}

// --- session lifecycle -----------------------------------------------------

function isTypingTarget(target) {
	const el = target && target.closest && target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])");
	return !!el;
}

// `[` and `]` are the same keys line_focus uses and collide with nothing in
// the reader. They are taken on the way down, in both the reader document and
// the nested pdf.js one, because whichever has focus is where the key lands.
function startSession(reader, doc, btn) {
	const v = viewerOf(reader);
	if (!v) {
		Zotero.debug("Sentence Focus: no PDF view in this tab");
		return null;
	}
	const session = {
		reader, btn,
		pageIndex: Math.max(0, (v.viewer.currentPageNumber || 1) - 1),
		unitIndex: 0,
		painted: [],
		handlers: [],
		inflight: new Map(),
		queue: Promise.resolve(),
	};

	const onKey = (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
		if (isTypingTarget(e.target)) return;
		const delta = (e.code === "BracketRight" || e.key === "]") ? 1
			: (e.code === "BracketLeft" || e.key === "[") ? -1 : 0;
		if (!delta) return;
		e.preventDefault();
		e.stopPropagation();
		enqueue(session, async () => {
			if (await move(session, delta) && delta > 0) countRead(session.reader);
		});
	};
	const onClick = (e) => {
		if (!pref("followClick")) return;
		const pageEl = e.target && e.target.closest && e.target.closest(".page");
		if (!pageEl) return;
		// A drag that selected text also ends in a click; leave that alone.
		try {
			const sel = v.win.getSelection();
			if (sel && !sel.isCollapsed) return;
		} catch (err) { /* no selection API here */ }
		enqueue(session, () => focusAtPoint(session, pageEl, e.clientX, e.clientY));
	};
	// pdf.js recycles page elements as they scroll out of the buffer, taking
	// the highlight with them. Repaint when the focused page comes back.
	const onRendered = (ev) => {
		const idx = (ev && ev.pageNumber ? ev.pageNumber - 1 : -1);
		if (idx === session.pageIndex && !session.painted.some((el) => el.isConnected)) paint(session, false);
	};

	const docs = [doc, v.doc].filter((d, i, a) => d && a.indexOf(d) === i);
	for (const d of docs) {
		d.addEventListener("keydown", onKey, true);
		session.handlers.push(() => d.removeEventListener("keydown", onKey, true));
	}
	v.doc.addEventListener("click", onClick, true);
	session.handlers.push(() => v.doc.removeEventListener("click", onClick, true));
	try {
		v.app.eventBus.on("pagerendered", onRendered);
		session.handlers.push(() => { try { v.app.eventBus.off("pagerendered", onRendered); } catch (e) { /* gone */ } });
	} catch (e) {
		Zotero.debug("Sentence Focus: no event bus - " + e);
	}
	// Belt and braces: whether or not the event bus reached us, a scroll that
	// finds the highlight gone puts it back. Checking one flag per scroll event
	// costs nothing, and a lost ruler is the one bug that would be obvious.
	const container = v.doc.getElementById("viewerContainer");
	if (container) {
		const onScroll = () => {
			if (session.painted.length && !session.painted.some((el) => el.isConnected)) paint(session, false);
		};
		container.addEventListener("scroll", onScroll, { passive: true });
		session.handlers.push(() => container.removeEventListener("scroll", onScroll));
	}

	// Closing the tab unloads its documents. Letting go of the session there
	// rather than at the next sweep is what lets the tab's reader — and with it
	// its reading count — be collected as soon as the tab is gone.
	const onUnload = () => stopSession(reader);
	for (const d of docs) {
		const win = d.defaultView;
		if (!win) continue;
		win.addEventListener("unload", onUnload, { once: true });
		session.handlers.push(() => { try { win.removeEventListener("unload", onUnload); } catch (e) { /* gone */ } });
	}

	sessions.set(reader, session);
	enqueue(session, () => focusPage(session, session.pageIndex, "visible"));
	return session;
}

function stopSession(reader) {
	const session = sessions.get(reader);
	if (!session) return;
	sessions.delete(reader);
	try { clearPaint(session); } catch (e) { /* its document is unloading */ }
	for (const off of session.handlers) {
		try { off(); } catch (e) { /* document already gone */ }
	}
	setButtonState(session.btn, false);
}

function setButtonState(btn, on) {
	if (!btn) return;
	btn.setAttribute("aria-pressed", on ? "true" : "false");
	btn.style.opacity = on ? "1" : ".65";
}

function toggle(reader, doc, btn) {
	closeMenu();
	sweepClosedReaders();
	if (sessions.has(reader)) { stopSession(reader); return; }
	const session = startSession(reader, doc, btn);
	setButtonState(btn, !!session);
}

// --- reading counter -------------------------------------------------------

// How many steps forward have been taken in a tab. Only `]` counts, and only
// when it moved: stepping back to reread something is not reading more, and
// pressing on at the end of a document goes nowhere. Each tab keeps its own
// count, and turning the ruler off and on again does not reset it.
//
// Keyed weakly by the reader, so closing the tab takes its count with it —
// nothing here holds a closed tab alive, and there is no teardown to forget.
// Each count also holds, weakly, every place it is shown: the badge in the
// corner of the tab's button, and the menu while it is open.
const readCounts = new WeakMap();   // reader -> { count, views: Set<WeakRef> }
// Every badge in every tab, only so that shutdown can take them off toolbars.
const badges = new Set();

function counterOf(reader) {
	let counter = readCounts.get(reader);
	if (!counter) {
		counter = { count: 0, views: new Set() };
		readCounts.set(reader, counter);
	}
	return counter;
}

function countRead(reader) {
	counterOf(reader).count++;
	renderCounters(reader);
}

function eraseCount(reader) {
	counterOf(reader).count = 0;
	renderCounters(reader);
}

function showCount(reader, el) {
	const ref = new WeakRef(el);
	counterOf(reader).views.add(ref);
	if (el.dataset.sfzCounter === "badge") badges.add(ref);
	renderCounter(el, counterOf(reader).count);
}

function renderCounters(reader) {
	const counter = counterOf(reader);
	for (const ref of [...counter.views]) {
		const el = ref.deref();
		// Gone with its tab, or left behind when the toolbar was rebuilt.
		if (!el || !el.isConnected || !el.ownerDocument.defaultView) {
			counter.views.delete(ref);
			badges.delete(ref);
			continue;
		}
		renderCounter(el, counter.count);
	}
}

function renderCounter(el, count) {
	const noun = count === 1 ? "sentence" : "sentences";
	if (el.dataset.sfzCounter === "badge") {
		el.textContent = String(count);
		// Not `hidden`: the reader's toolbar styles its children's display.
		el.style.display = count === 0 ? "none" : "";
		if (el.parentNode) {
			el.parentNode.title = `Sentence focus — ${count} ${noun} read in this tab. `
				+ "Click to turn on, [ and ] to step, right-click for settings";
		}
	} else {
		el.textContent = `${count} ${noun} read in this tab`;
	}
}

// --- in-reader settings menu -----------------------------------------------

// The Settings pane holds the same knobs, but step size and colour are things
// you want to change with the book open rather than three windows away. This
// panel lives in the reader's own document, next to the button that opened it.
const MENU_CSS = `
.sfz-menu{position:fixed;z-index:99999;box-sizing:border-box;width:17em;
 background:Canvas;color:CanvasText;border:1px solid color-mix(in srgb,CanvasText 25%,Canvas);
 border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.28);padding:9px 11px 11px;
 font:13px system-ui,sans-serif;max-height:80vh;overflow-y:auto}
.sfz-menu h3{font:600 10px system-ui,sans-serif;text-transform:uppercase;letter-spacing:.05em;
 color:GrayText;margin:10px 0 5px}
.sfz-menu h3:first-child{margin-top:0}
.sfz-chips{display:flex;flex-wrap:wrap;gap:4px}
.sfz-chip{font:11px system-ui,sans-serif;padding:3px 8px;border-radius:10px;cursor:pointer;
 border:1px solid color-mix(in srgb,CanvasText 25%,Canvas);background:transparent;color:GrayText}
.sfz-chip[aria-pressed=true]{background:Highlight;border-color:Highlight;color:HighlightText}
.sfz-row{display:flex;align-items:center;gap:8px;margin:6px 0}
.sfz-row label{flex:1;cursor:pointer}
.sfz-row output{min-width:2.9em;text-align:right;color:GrayText;font-variant-numeric:tabular-nums}
.sfz-menu input[type=range]{flex:1;min-width:0}
.sfz-menu input[type=color]{width:2.7em;height:1.5em;padding:0;border:none;background:none;cursor:pointer}
.sfz-foot{color:GrayText;font-size:11px;margin:9px 0 0;line-height:1.4;
 border-top:1px solid color-mix(in srgb,CanvasText 15%,Canvas);padding-top:7px}
.sfz-foot kbd{font:11px ui-monospace,monospace;border:1px solid color-mix(in srgb,CanvasText 30%,Canvas);
 border-radius:3px;padding:0 3px}
.sfz-version{float:right;opacity:.7;font-variant-numeric:tabular-nums}
.sfz-diag{margin-top:10px;width:100%;border-radius:5px;padding:4px 8px}
.sfz-count{flex:1;font-variant-numeric:tabular-nums}
`;

let openMenuPanel = null;   // { el, cleanup } of the single open menu, or null

function injectMenuCSS(doc) {
	injectStyle(doc, "sfz-menu-style", MENU_CSS);
}

function closeMenu() {
	if (!openMenuPanel) return;
	const menu = openMenuPanel;
	openMenuPanel = null;   // null first: a torn-down document makes cleanup throw
	try { menu.cleanup(); menu.el.remove(); } catch (e) { /* already gone */ }
}

function setPref(key, value) {
	try { Zotero.Prefs.set(PREF(key), value, true); } catch (e) {
		Zotero.debug("Sentence Focus: could not save " + key + " - " + e);
	}
}

function buildMenu(doc, reader) {
	const panel = doc.createElement("div");
	panel.className = "sfz-menu";
	const make = (tag, cls, text) => {
		const el = doc.createElement(tag);
		if (cls) el.className = cls;
		if (text != null) el.textContent = text;
		return el;
	};
	const heading = (text) => panel.append(make("h3", null, text));

	const chips = (key, options) => {
		const row = make("div", "sfz-chips");
		const sync = () => {
			for (const b of row.children) b.setAttribute("aria-pressed", String(b.dataset.value === String(pref(key))));
		};
		for (const [value, label, title] of options) {
			const b = make("button", "sfz-chip", label);
			b.dataset.value = value;
			if (title) b.title = title;
			b.addEventListener("click", () => { setPref(key, value); sync(); });
			row.append(b);
		}
		sync();
		panel.append(row);
	};

	const slider = (key, label, min, max) => {
		const row = make("div", "sfz-row");
		const name = make("label", null, label);
		const input = doc.createElement("input");
		input.type = "range";
		input.min = String(min); input.max = String(max); input.step = "1";
		input.value = String(pref(key));
		const out = make("output", null, `${input.value}%`);
		name.addEventListener("click", () => input.focus());
		input.addEventListener("input", () => { out.textContent = `${input.value}%`; setPref(key, Number(input.value)); });
		row.append(name, input, out);
		panel.append(row);
	};

	const toggle = (key, label, title) => {
		const row = make("div", "sfz-row");
		const input = doc.createElement("input");
		input.type = "checkbox";
		input.checked = !!pref(key);
		const name = make("label", null, label);
		if (title) row.title = title;
		name.addEventListener("click", () => { input.checked = !input.checked; setPref(key, input.checked); });
		input.addEventListener("change", () => setPref(key, input.checked));
		row.append(input, name);
		panel.append(row);
	};

	heading("Reading");
	{
		const row = make("div", "sfz-row");
		const count = make("span", "sfz-count");
		count.dataset.sfzCounter = "menu";
		showCount(reader, count);
		const erase = make("button", "sfz-chip", "Erase");
		erase.title = "Start counting from zero again.";
		erase.addEventListener("click", () => eraseCount(reader));
		row.append(count, erase);
		panel.append(row);
	}

	heading("Step by");
	chips("granularity", [
		["word", "Word"], ["line", "Line"], ["sentence", "Sentence"], ["paragraph", "Paragraph"],
	]);

	heading("Highlight");
	chips("style", STYLES);
	{
		const row = make("div", "sfz-row");
		const name = make("label", null, "Colour");
		const input = doc.createElement("input");
		input.type = "color";
		input.value = String(pref("color"));
		name.addEventListener("click", () => input.click());
		input.addEventListener("input", () => setPref("color", input.value));
		row.append(name, input);
		panel.append(row);
	}
	slider("opacity", "Strength", 5, 90);
	slider("padding", "Breathing room", 0, 200);
	toggle("behind", "Keep the ink on top", "Blends the highlight with the page so the glyphs stay at full strength instead of being covered.");

	heading("Scrolling");
	chips("autoScroll", [
		["never", "Never", "The page never moves on its own."],
		["offscreen", "If off screen", "Only scrolls when the unit has left the view entirely."],
		["always", "Always", "Keeps the unit at the margin on every step."],
	]);
	slider("scrollMargin", "Keep clear of top", 0, 60);

	heading("Sentences");
	toggle("mergeDisplay", "Equations join the sentence");
	toggle("followClick", "Click moves the ruler");

	const diagnostics = make("button", "sfz-chip sfz-diag", "Copy page diagnostics");
	diagnostics.title = "How this page was read, for reporting a mis-highlight.";
	diagnostics.addEventListener("click", () => copyDiagnostics(reader, diagnostics));
	panel.append(diagnostics);

	const foot = make("p", "sfz-foot");
	foot.append(
		doc.createTextNode("Step with "),
		make("kbd", null, "["), doc.createTextNode(" and "), make("kbd", null, "]"),
		doc.createTextNode(". Right-click the ¶ button for this menu."),
		make("span", "sfz-version", version ? ` v${version}` : ""),
	);
	panel.append(foot);
	return panel;
}

// Dump how the current page was read, onto the clipboard. One click beats
// several rounds of guessing at a screenshot.
async function copyDiagnostics(reader, button) {
	const v = viewerOf(reader);
	if (!v) return;
	const session = sessions.get(reader);
	const pageIndex = session ? session.pageIndex : Math.max(0, (v.viewer.currentPageNumber || 1) - 1);
	let report = `Sentence Focus ${version || "?"} — page ${pageIndex + 1}\n`;
	try {
		const data = Cu.waiveXrays(await v.pdf.getPageData(Cu.cloneInto({ pageIndex }, v.win)));
		report += describePage(data.chars, data.viewBox || [0, 0, 612, 792], { mergeDisplay: !!pref("mergeDisplay") });
	} catch (e) {
		report += `could not read the page: ${e}`;
	}
	let copied = false;
	try {
		Zotero.Utilities.Internal.copyTextToClipboard(report);
		copied = true;
	} catch (e) {
		Zotero.debug("Sentence Focus diagnostics:\n" + report);
	}
	if (button) {
		button.textContent = copied ? "Copied to clipboard" : "Written to the debug log";
		button.disabled = true;
	}
}

function openMenu(doc, btn, reader) {
	closeMenu();
	injectMenuCSS(doc);
	const panel = buildMenu(doc, reader);
	doc.body.append(panel);

	// Anchor under the button, pulled back inside the window if it would spill.
	const anchor = btn.getBoundingClientRect();
	const width = panel.offsetWidth || 240;
	const left = Math.max(6, Math.min(anchor.left, (doc.documentElement.clientWidth || width) - width - 6));
	panel.style.left = `${left}px`;
	panel.style.top = `${anchor.bottom + 6}px`;

	const onDown = (e) => { if (!panel.contains(e.target) && e.target !== btn) closeMenu(); };
	const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeMenu(); } };
	// The PDF sits in a nested iframe, so clicks and keys there never reach the
	// reader document; both have to be listened to for dismissal to work.
	const v = viewerOf(reader);
	const docs = [doc, v && v.doc].filter((d, i, a) => d && a.indexOf(d) === i);
	for (const d of docs) {
		d.addEventListener("pointerdown", onDown, true);
		d.addEventListener("keydown", onKey, true);
	}
	openMenuPanel = {
		el: panel,
		cleanup: () => {
			for (const d of docs) {
				d.removeEventListener("pointerdown", onDown, true);
				d.removeEventListener("keydown", onKey, true);
			}
		},
	};
}

// --- plugin entry points ---------------------------------------------------

// Closing a reader tab fires no event we can hang a teardown on, so sessions
// whose view has gone are swept whenever any reader toolbar is built.
function sweepClosedReaders() {
	for (const reader of [...sessions.keys()]) {
		if (!viewerOf(reader)) stopSession(reader);
	}
}

function renderButton(event) {
	const { reader, doc, append } = event;
	sweepClosedReaders();
	const btn = doc.createElement("button");
	btn.className = "toolbar-button";
	btn.title = "Sentence focus — click to turn on, [ and ] to step, right-click for settings";
	btn.textContent = "¶";
	btn.style.cssText = "font-size:15px;cursor:pointer;background:none;border:none;";
	const existing = sessions.get(reader);
	if (existing) existing.btn = btn;      // the old toolbar went away with its tab
	setButtonState(btn, !!existing);
	btn.addEventListener("click", (e) => {
		// Modifier-click opens the settings too: right-click is awkward on a
		// trackpad, and this is the button people will already be aiming at.
		if (e.altKey || e.ctrlKey || e.metaKey) { openMenu(doc, btn, reader); return; }
		toggle(reader, doc, btn);
	});
	btn.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		e.stopPropagation();
		openMenu(doc, btn, reader);
	});

	// The count rides in the button's corner. The toolbar gives each element a
	// plugin appends a slot of its own, so a sibling lands under the button
	// rather than beside it; inside the button it takes no room at all, and
	// clicks go straight through it to the button.
	btn.style.position = "relative";
	const badge = doc.createElement("span");
	badge.dataset.sfzCounter = "badge";
	badge.style.cssText = "position:absolute;right:0;bottom:1px;pointer-events:none;"
		+ "font:600 8.5px/1 system-ui,sans-serif;font-variant-numeric:tabular-nums;opacity:.8;";
	btn.append(badge);
	showCount(reader, badge);
	append(btn);
}

// What each preference costs to change. Style and colour are read on every
// paint, so they only need a repaint. Step size keeps the cached pages — they
// hold every granularity — but the current index means something different
// afterwards, so the ruler is re-placed on what is on screen. Only a change to
// the analysis itself throws the cache away. Scrolling and click behaviour are
// read where they are used and need nothing at all.
const PREF_EFFECT = {
	style: "paint", color: "paint", opacity: "paint", behind: "paint", padding: "paint",
	granularity: "refocus",
	mergeDisplay: "reanalyse",
	autoScroll: "none", scrollMargin: "none", followClick: "none",
};

function applyPrefEffect(effect) {
	sweepClosedReaders();
	// Everything already analysed was analysed under the old setting, whether
	// or not a ruler happens to be switched on in that tab at the moment.
	if (effect === "reanalyse") pageCache.clear();
	for (const session of sessions.values()) {
		if (effect === "paint") { paint(session, false); continue; }
		if (effect === "reanalyse") session.inflight.clear();
		enqueue(session, () => focusPage(session, session.pageIndex, "visible"));
	}
}

let prefObservers = [];
let version = "";

function startup({ id, version: pluginVersion, rootURI }) {
	version = pluginVersion || "";
	Zotero.debug(`Sentence Focus ${version} starting`);
	Zotero.SentenceFocus = { PREF, DEFAULTS, version };
	for (const [key, effect] of Object.entries(PREF_EFFECT)) {
		if (effect === "none") continue;
		try {
			prefObservers.push(Zotero.Prefs.registerObserver(PREF(key), () => applyPrefEffect(effect), true));
		} catch (e) { /* observer registration is a nicety */ }
	}
	Zotero.PreferencePanes.register({
		pluginID: id,
		src: rootURI + "prefs.xhtml",
		scripts: [rootURI + "prefs.js"],
		stylesheets: [rootURI + "prefs.css"],
		label: "Sentence Focus",
	}).then((paneID) => { prefPane = paneID; },
		(e) => Zotero.debug("Sentence Focus: prefs pane failed to register - " + e));

	onRenderToolbar = (event) => renderButton(event);
	Zotero.Reader.registerEventListener("renderToolbar", onRenderToolbar, id);
}

function shutdown() {
	closeMenu();
	for (const reader of [...sessions.keys()]) stopSession(reader);
	for (const ref of badges) {
		const el = ref.deref();
		if (el) try { el.remove(); } catch (e) { /* tab gone */ }
	}
	badges.clear();
	dropInjectedStyles();
	pageCache.clear();
	for (const o of prefObservers) {
		try { Zotero.Prefs.unregisterObserver(o); } catch (e) { /* already gone */ }
	}
	prefObservers = [];
	if (prefPane) Zotero.PreferencePanes.unregister(prefPane);
	prefPane = null;
	delete Zotero.SentenceFocus;
	if (onRenderToolbar && Zotero.Reader.unregisterEventListener) {
		Zotero.Reader.unregisterEventListener("renderToolbar", onRenderToolbar);
	}
	onRenderToolbar = null;
}

function install() {}
function uninstall() {}

// node-only: lets test.js drive the pure analysis; a no-op inside Zotero.
if (typeof module !== "undefined") {
	module.exports = {
		materialize, charsToLines, sameVisualLine, detectColumns, assignColumns, markFurniture,
		classifyLine, isCentred, linesToBlocks, joinContinuations, buildBlockText, typicalLineGap, LIST_LABEL_RE,
		CLAUSE_END_RE,
		splitSentences, isBoundary, prevToken, rectsForChars, boundingArea, mergeBoxes, segmentPage, colIndexFor,
		analysePage, describePage, markEquationNumbers, cacheFor, pageCache, CACHE_DOCS,
		absorbDisplayRows, displayRows, displayBand,
		lineRanges, wordRanges, GRANULARITIES,
		solidColor, toPercent, toUserBox, pageAspect, padBoxes, PADDING, mergeTiny, blendFor,
		pageLuminance, CSS, STYLES,
		countRead, eraseCount, showCount,
	};
}
