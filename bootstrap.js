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
	if (MATH_FONT_RE.test(ch.font)) return true;
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
		out.push({
			c,
			rect: [rect[0], rect[1], rect[2], rect[3]],
			irect: [irect[0], irect[1], irect[2], irect[3]],
			size: ch.fontSize || (rect[3] - rect[1]) || 10,
			font: ch.fontName || "",
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

const median = (a) => {
	if (!a.length) return 0;
	const s = [...a].sort((x, y) => x - y);
	return s[s.length >> 1];
};

const percentile = (a, p) => {
	if (!a.length) return 0;
	const s = [...a].sort((x, y) => x - y);
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
	for (const frag of frags) {
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
		const length = end - runStart;
		const mark = () => { for (let k = runStart; k < end; k++) formulaish[k - from] = true; };
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
		const script = !!ch && ch.size < 0.85 * size;
		// A ligature carries several characters in one glyph and is a word, so
		// length is what tells a variable from "ffi".
		const isLetter = !!ch && !script && ch.c.length === 1 && /\p{L}/u.test(ch.c);
		if (isLetter) {
			if (runStart < 0) { runStart = i; runText = ""; runIsMath = true; }
			runText += ch.c;
			runIsMath = runIsMath && ch.math;
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
	// Zotero normalises inline rects per fragment, so a line it cut has pieces
	// with mismatched bands. One band for the whole line keeps the highlight
	// from stepping up and down across a formula.
	for (let i = from; i <= to; i++) {
		const ir = chars[i].irect;
		ir[1] = rect[1];
		ir[3] = rect[3];
	}

	const line = {
		from, to, text, rect, size, baseline,
		mathFrac: mathCount / glyphs,
		variableFrac,
		formulaFrac: Math.max(mathCount / glyphs, variableFrac),
		textWords,
		hasRelation: RELATION_RE.test(text),
		paraEnd: chars[to].paraEnd,
		rot: chars[from].rot,
		bold: chars[from].bold,
		kind: "text",
		furniture: false,
		eqNumFrom: -1,
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
}

// Footnote and citation markers ("...holds.12 The next") read to a splitter as
// a decimal point. They are small, raised, and not part of a formula. Masking
// them out of the text is Zotero's own trick for its read-aloud segmentation.
function markSuperscripts(chars, line) {
	for (let i = line.from; i <= line.to; i++) {
		const ch = chars[i];
		if (ch.math) continue;
		if (!/[\d*†‡§¶]/.test(ch.c)) continue;
		if (ch.size > 0.85 * line.size) continue;
		if (ch.baseline < line.baseline + 0.15 * line.size) continue;
		ch.marker = true;
	}
}

// --- page geometry ---------------------------------------------------------

// Columns are found from vertical whitespace: bin the x axis, look for a run of
// empty bins away from the margins, and cut there. Two-column papers need this
// because "is this line indented?" only means anything within its own column.
function detectColumns(lines, viewBox) {
	const x0 = viewBox[0], x1 = viewBox[2];
	const span = x1 - x0;
	const full = () => tighten([{ left: x0, right: x1 }], lines) || [{ left: x0, right: x1 }];
	if (span <= 0 || lines.length < 6) return full();

	const BINS = 100;
	const cov = new Uint8Array(BINS);
	for (const ln of lines) {
		const a = Math.max(0, Math.floor((ln.rect[0] - x0) / span * BINS));
		const b = Math.min(BINS - 1, Math.ceil((ln.rect[2] - x0) / span * BINS));
		for (let i = a; i <= b; i++) cov[i] = 1;
	}
	// Only gaps in the middle of the page are gutters; the rest are margins.
	const cuts = [];
	let runStart = -1;
	for (let i = 15; i <= 85; i++) {
		if (!cov[i] && runStart < 0) runStart = i;
		if (cov[i] || i === 85) {
			if (runStart >= 0 && i - runStart >= 4) cuts.push((runStart + i) / 2);
			runStart = -1;
		}
	}
	if (!cuts.length || cuts.length > 2) return full();

	const edges = [x0, ...cuts.map((c) => x0 + c / BINS * span), x1];
	const cols = [];
	for (let i = 0; i < edges.length - 1; i++) cols.push({ left: edges[i], right: edges[i + 1] });
	// A gutter separates two bodies of text, and runs the height of the page to
	// do it. One wide gap does not: the blank run before an equation number
	// leaves a "column" holding that number and nothing else, and the channel
	// between a table's last two columns leaves one holding only that table.
	// Every margin on the page would then be measured against it.
	const minLines = Math.max(3, Math.ceil(lines.length * 0.15));
	const pageSpan = Math.max(...lines.map((l) => l.rect[3])) - Math.min(...lines.map((l) => l.rect[1])) || 1;
	for (const col of cols) {
		const held = lines.filter((ln) => centerX(ln) >= col.left && centerX(ln) < col.right);
		if (held.length < minLines) return full();
		const span = Math.max(...held.map((l) => l.rect[3])) - Math.min(...held.map((l) => l.rect[1]));
		if (span < 0.5 * pageSpan) return full();
	}
	return tighten(cols, lines) || full();
}

// Shrink each column onto the text it actually holds. A column that still
// reaches the paper's edge makes every line look indented from its left margin
// and every full-width line look centred in it, and puts the right-hand margin
// — where equation numbers live — somewhere out in the blank paper.
function tighten(cols, lines) {
	for (const col of cols) {
		const own = lines.filter((ln) => centerX(ln) >= col.left && centerX(ln) < col.right);
		if (!own.length) return null;
		col.left = Math.min(...own.map((l) => l.rect[0]));
		col.right = Math.max(...own.map((l) => l.rect[2]));
	}
	return cols;
}

const centerX = (ln) => (ln.rect[0] + ln.rect[2]) / 2;

function assignColumns(lines, cols) {
	for (const ln of lines) {
		ln.col = cols.find((c) => centerX(ln) >= c.left && centerX(ln) <= c.right) || cols[0];
	}
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
function classifyLine(line) {
	if (line.formulaFrac < 0.25 || line.textWords >= 4) return "text";
	const col = line.col || { left: line.rect[0], right: line.rect[2] };
	const colWidth = (col.right - col.left) || 1;
	let score = 1;
	if (line.formulaFrac >= 0.5) score++;
	if (line.hasRelation) score++;
	if (line.rect[0] - col.left > 1.5 * line.size) score++;
	if (Math.abs(centerX(line) - (col.left + col.right) / 2) < 0.06 * colWidth) score++;
	if (line.textWords <= 1) score++;
	// Nothing on the line is a word. A row of maths often reaches the reader in
	// pieces — "P(X,Z)," on its own, once the layout has cut the line at a
	// summation sign — and each piece has to stand on its own feet here, or it
	// falls through to prose and takes the paragraph below it with it.
	if (line.textWords === 0 && line.formulaFrac >= 0.4) score++;
	if (line.eqNumFrom >= 0) score += 2;
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
	for (const line of lines) {
		if (line.furniture) continue;
		const col = line.col;
		const atRightMargin = !!col && line.rect[2] >= col.right - 0.06 * (col.right - col.left);

		if (EQ_LABEL_RE.test(line.text.trim())) {
			if (!atRightMargin) continue;
			const height = line.rect[3] - line.rect[1];
			const hasRowMate = lines.some((other) => other !== line && !other.furniture
				&& other.col === col && other.rect[2] <= line.rect[0]
				&& Math.min(other.rect[3], line.rect[3]) - Math.max(other.rect[1], line.rect[1]) > 0.3 * height);
			if (hasRowMate) line.furniture = true;
			continue;
		}
		if (line.labelFrom >= 0 && (line.labelGap >= 2.5 * line.size || atRightMargin)) {
			line.eqNumFrom = line.labelFrom;
		}
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
		rows.push({ col: line.col, rect: line.rect.slice(), size: line.size });
	}
	let merged = true;
	while (merged) {
		merged = false;
		for (let i = rows.length - 1; i > 0 && !merged; i--) {
			for (let j = i - 1; j >= 0; j--) {
				const a = rows[j], b = rows[i];
				if (a.col !== b.col) continue;
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
	for (let pass = 0; pass < lines.length; pass++) {
		let absorbed = false;
		for (const line of lines) {
			if (line.furniture || line.kind === "display" || line.textWords >= 4) continue;
			const height = line.rect[3] - line.rect[1];
			const width = line.rect[2] - line.rect[0];
			if (height <= 0) continue;
			const centre = (line.rect[1] + line.rect[3]) / 2;
			for (const row of rows) {
				if (row.col !== line.col) continue;
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
const LIST_LABEL_RE = /^\s*[([]?\s*(?:\d{1,3}|[ivxlcdm]{1,5}|\p{L})\s*[).\]]\s+\S/iu;
const CLAUSE_END_RE = /[.;:!?\u2026]["'\u201d\u2019)\]]*\s*$/;

// A table row arrives as one piece per cell, spread right across the measure.
// Read a cell at a time it says nothing — "theorem" on its own, then "O(n)
// tests" — so a row of cells is treated as one line and highlighted as one.
//
// A row of displayed maths is laid out the same way and must not be caught by
// this. What separates them is words: a table's cells carry them ("hypothesis",
// "cost/step"), a formula's pieces do not, so a row needs two cells with a real
// word in them before it counts as a table.
function markTableRows(lines) {
	const rows = [];
	for (const line of lines) {
		if (line.furniture) continue;
		const height = line.rect[3] - line.rect[1];
		let row = null;
		for (const candidate of rows) {
			if (candidate.col !== line.col) continue;
			const overlap = Math.min(candidate.rect[3], line.rect[3]) - Math.max(candidate.rect[1], line.rect[1]);
			if (overlap > 0.5 * Math.min(height, candidate.rect[3] - candidate.rect[1])) { row = candidate; break; }
		}
		if (!row) { rows.push({ col: line.col, rect: line.rect.slice(), members: [line] }); continue; }
		row.rect[1] = Math.min(row.rect[1], line.rect[1]);
		row.rect[3] = Math.max(row.rect[3], line.rect[3]);
		row.members.push(line);
	}
	let id = 0;
	for (const row of rows) {
		if (row.members.length < 3) continue;
		if (row.members.filter((m) => m.textWords >= 1).length < 2) continue;
		id++;
		for (const member of row.members) {
			member.kind = "text";     // a row of cells is read, not set apart
			member.tableRow = id;
		}
	}
}

// The gap that normally separates two lines of one paragraph. Measured within
// a column, so a column break does not count as a gap.
function typicalLineGap(lines) {
	const gaps = [];
	for (let i = 1; i < lines.length; i++) {
		const a = lines[i - 1], b = lines[i];
		if (a.col !== b.col) continue;
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
		// Cells of one table row are one line; the row after it is another.
		if (cur && previous && previous.tableRow !== ln.tableRow) cur = null;
		const inRow = ln.tableRow !== undefined && previous && previous.tableRow === ln.tableRow;
		// A line may open with a bracketed number without being a list item:
		// "(16) equals 1 for every closed path" is a cross-reference carrying a
		// sentence over. What tells them apart is the line before — an item
		// ends on a full stop or a semicolon, a sentence carried over ends
		// mid-clause.
		if (cur && previous && LIST_LABEL_RE.test(ln.text)
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
		if (!cur) { cur = { kind: "text", lines: [] }; blocks.push(cur); }
		cur.lines.push(ln);
		const rowContinues = ln.tableRow !== undefined && next && next.tableRow === ln.tableRow;
		if (ln.paraEnd && !bridgeAfter && !rowContinues) cur = null;
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
		if (LIST_LABEL_RE.test(bt)) continue;
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
		const indented = !!(next && head && tail && tight
			&& LIST_LABEL_RE.test(head.text)
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
		for (let i = ln.from; i <= stop; i++) {
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
	if (/^\s*[[(]\d{1,3}[\])]/.test(text)) return [[0, text.length]];

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
			const broke = prev.lineEnd || i !== run.last + 1 || ch.rot !== prev.rot
				|| gap > Math.max(1.2 * prev.size, 10) || gap < -prev.size;
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
function boundingArea(chars, idx) {
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
	return box ? [box] : [];
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

function rangeToUnit(chars, text, map, a, b, kind, wholeArea) {
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
	const rects = mergeBoxes(wholeArea ? boundingArea(chars, idx) : rectsForChars(chars, idx));
	if (!rects.length) return null;
	// The unit's own line height. Padding is measured against this rather than
	// the box, because a displayed formula's box spans every row it occupies
	// and would otherwise be padded by a multiple of its whole height.
	const heights = [];
	for (const i of idx) {
		const ch = chars[i];
		if (ch && !ch.skip && ch.c.trim()) heights.push(ch.irect[3] - ch.irect[1]);
	}
	return {
		kind,
		em: median(heights) || (rects[0][3] - rects[0][1]) || 1,
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
	absorbDisplayRows(lines);
	markTableRows(lines);            // after absorbing, so a formula's row is already one
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
		`columns ${cols.map((c) => `${Math.round(c.left)}..${Math.round(c.right)}`).join("   ") || "(none)"}`,
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
			+ ` words ${ln.textWords} rel ${ln.hasRelation ? "y" : "n"} eqnum ${ln.eqNumFrom >= 0 ? "y" : "n"}`
			+ ` para ${ln.paraEnd ? "y" : "n"}`,
			`         fonts ${top}`,
			`         text  ${JSON.stringify(ln.text.slice(0, 90))}`,
		);
	}

	// What all that turned into, which is the half a screenshot does show —
	// having both in one place is what makes a report worth pasting.
	out.push("", "--- units (sentence) ---");
	for (const unit of segmentPage(rawChars, viewBox, opts).sentence) {
		out.push(`${unit.kind.padEnd(8)} ${unit.rects.length} box  ${JSON.stringify(unit.text.slice(0, 110))}`);
	}
	return out.join("\n");
}

function segmentPage(rawChars, viewBox, opts = {}) {
	const out = { word: [], line: [], sentence: [], paragraph: [] };
	const { chars, lines, cols } = analysePage(rawChars, viewBox, opts);
	if (!lines.length) return out;

	const gap = typicalLineGap(lines);
	const blocks = joinContinuations(linesToBlocks(lines, gap, !!opts.mergeDisplay), gap);
	for (const block of blocks) {
		const { text, map, lineStarts } = buildBlockText(chars, block.lines);
		if (!/\p{L}|\p{N}/u.test(text)) continue;
		const math = map.map((i) => i >= 0 && chars[i].math);
		const sentences = block.kind === "display"
			? [[0, text.length]]
			: splitSentences(text, math, lineStarts);
		const ranges = {
			word: wordRanges(text),
			line: lineRanges(text, lineStarts),
			sentence: sentences,
			paragraph: [[0, text.length]],
		};
		for (const g of GRANULARITIES) {
			// Stepping word by word through a formula still wants the tokens
			// boxed individually; at every larger size the formula is one area.
			const wholeArea = block.kind === "display" && g !== "word";
			for (const [a, b] of ranges[g]) {
				const unit = rangeToUnit(chars, text, map, a, b, block.kind, wholeArea);
				if (unit) out[g].push(unit);
			}
		}
	}
	// Reading order: down a column, then on to the next one.
	for (const g of GRANULARITIES) {
		for (const u of out[g]) u.col = colIndexFor(u.left, cols);
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
const CACHE_PAGES = 60;   // four granularities each, so keep the window modest

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
	if (!m) { m = new Map(); pageCache.set(key, m); }
	return m;
}

const cacheOf = (session) => cacheFor(session.reader);

// Analyse one page, or hand back the analysis we already have. A page being
// fetched is remembered as a promise, so a prefetch and a keypress that want
// the same page share one trip to the worker instead of racing for it.
function unitsFor(session, pageIndex) {
	const cached = cacheOf(session).get(pageIndex);
	if (cached) return Promise.resolve(cached);
	let pending = session.inflight.get(pageIndex);
	if (!pending) {
		pending = computeUnits(session, pageIndex);
		session.inflight.set(pageIndex, pending);
		pending.then(() => session.inflight.delete(pageIndex), () => session.inflight.delete(pageIndex));
	}
	return pending;
}

async function computeUnits(session, pageIndex) {
	const v = viewerOf(session.reader);
	if (!v) return [];
	let units = [];
	try {
		const data = Cu.waiveXrays(await v.pdf.getPageData(Cu.cloneInto({ pageIndex }, v.win)));
		if (data && data.chars) {
			units = segmentPage(data.chars, data.viewBox || [0, 0, 612, 792], { mergeDisplay: !!pref("mergeDisplay") });
		}
	} catch (e) {
		Zotero.debug(`Sentence Focus: page ${pageIndex + 1} unreadable - ` + e);
	}
	const cache = cacheOf(session);
	cache.set(pageIndex, units);
	// Map iterates in insertion order, so the oldest page goes first.
	if (cache.size > CACHE_PAGES) cache.delete(cache.keys().next().value);
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

function injectCSS(doc) {
	if (!doc || doc.getElementById("sfz-style")) return;
	const s = doc.createElement("style");
	s.id = "sfz-style";
	s.textContent = CSS;
	(doc.head || doc.documentElement).append(s);
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

function listIn(all) {
	return (all && (all[granularity()] || all.sentence)) || [];
}

function currentUnit(session) {
	return listIn(cacheOf(session).get(session.pageIndex))[session.unitIndex];
}

async function unitsAt(session, pageIndex) {
	return listIn(await unitsFor(session, pageIndex));
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
	display: { x: 0.60, y: 0.22 },
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
	if (!total) return;
	let page = session.pageIndex;
	let units = await unitsAt(session, page);
	let i = session.unitIndex + delta;
	let hops = 0;
	while ((i < 0 || i >= units.length) && hops++ < 64) {
		page += delta > 0 ? 1 : -1;
		if (page < 0 || page >= total) return;
		units = await unitsAt(session, page);
		i = delta > 0 ? 0 : units.length - 1;
	}
	if (!units.length || i < 0 || i >= units.length) return;
	session.pageIndex = page;
	session.unitIndex = i;
	paint(session, true);
	prefetch(session);
}

// Keep the neighbouring pages warm so crossing a page boundary is not the one
// move that stutters.
function prefetch(session) {
	const total = pageCount(session);
	for (const p of [session.pageIndex + 1, session.pageIndex - 1]) {
		if (p >= 0 && p < total && !cacheOf(session).has(p)) {
			Promise.resolve().then(() => unitsFor(session, p)).catch(() => {});
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
		enqueue(session, () => move(session, delta));
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

	sessions.set(reader, session);
	enqueue(session, () => focusPage(session, session.pageIndex, "visible"));
	return session;
}

function stopSession(reader) {
	const session = sessions.get(reader);
	if (!session) return;
	sessions.delete(reader);
	clearPaint(session);
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
	if (sessions.has(reader)) { stopSession(reader); return; }
	const session = startSession(reader, doc, btn);
	setButtonState(btn, !!session);
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
`;

let openMenuPanel = null;   // { el, cleanup } of the single open menu, or null

function injectMenuCSS(doc) {
	if (!doc || doc.getElementById("sfz-menu-style")) return;
	const el = doc.createElement("style");
	el.id = "sfz-menu-style";
	el.textContent = MENU_CSS;
	(doc.head || doc.documentElement).append(el);
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
		classifyLine, linesToBlocks, joinContinuations, buildBlockText, typicalLineGap, LIST_LABEL_RE,
		CLAUSE_END_RE,
		splitSentences, isBoundary, prevToken, rectsForChars, boundingArea, mergeBoxes, segmentPage, colIndexFor,
		analysePage, describePage, markEquationNumbers,
		absorbDisplayRows, displayRows, markTableRows,
		lineRanges, wordRanges, GRANULARITIES,
		solidColor, toPercent, toUserBox, pageAspect, padBoxes, PADDING, mergeTiny, blendFor,
		pageLuminance, CSS, STYLES,
	};
}
