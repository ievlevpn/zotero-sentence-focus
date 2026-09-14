# Sentence Focus (Zotero plugin)

A reading ruler for Zotero's PDF reader that moves **a sentence at a time**
instead of a line at a time. Press `]` to step forward, `[` to step back, or
click anywhere on the page to put the ruler on the sentence under the pointer.
It also steps by word, line or paragraph if you would rather.

Click the `¶` button in the reader toolbar to turn it on; **right-click** it
(or ⌥/Ctrl-click) for the settings, which are also in
**Zotero → Settings → Sentence Focus**.

It is built for academic PDFs, and in particular for mathematical ones: a
sentence that wraps over four lines, runs down one column and continues at the
top of the next, with a formula in the middle of it, is highlighted as the one
thing it is.

Inspired by [line_focus](https://github.com/JunyeolYu/line_focus), which does
the same thing per line.

## Install (dev)

```sh
# Build the installable .xpi (just a zip of these files):
cd zotero-sentence-focus
zip -r sentence-focus.xpi manifest.json bootstrap.js icon.svg prefs.xhtml prefs.js prefs.css
```

Then in Zotero: **Tools → Plugins → gear icon → Install Plugin From File…** and
pick `sentence-focus.xpi`. Open any PDF and look for `¶` in the reader toolbar.

For live development, point Zotero at the folder instead of zipping: create a
file named `sentence-focus@local` (the id from `manifest.json`) inside your
Zotero profile's `extensions/` directory whose contents are the absolute path
to this folder, then restart Zotero.

## How it finds sentences

The text comes from Zotero's own pdf.js fork, which hands out structured
per-character data — `pdfDocument.getPageData(...)` returns a glyph stream with
rectangles, font names, sizes, baselines, and flags for line breaks, paragraph
breaks and soft hyphens. That is much better ground to work from than scraping
the rendered text layer: paragraph boundaries come from real layout analysis,
and end-of-line hyphens are already marked for removal.

On top of that, the plugin adds the parts Zotero does not do.

**Visual lines.** Zotero's line breaks cannot be taken at face value. It ends a
line wherever two consecutive glyphs fail an overlap test on their *bottom*
edges, and a superscript followed by a glyph sitting on the maths axis fails
it: in `λ(X)^k = tr(A)`, the foot of the `k` is above the `=`, and the foot of
the `=` is below the `k`. The line comes back in two pieces — and because the
pieces sit side by side rather than stacked, Zotero's paragraph heuristic marks
the cut as a *paragraph break* too. A mathematical paper is full of these. So
the first thing the plugin does is stitch fragments back into real visual
lines, joining two pieces when they share a horizontal band and the second
carries on within a word space of the first. Without this a sentence simply
stops at the first `=` after a superscript.

The same test fails the other way too. A display set straight after a short
last line — "Indeed, the integral" — can have a big operator tall enough, with
its upper limit, to overlap the band of those words, and Zotero hands them over
as one fragment: `integral ∫ t`. The sign then joins the sentence and the rest
of the formula is left on its own. So a fragment is also **cut** at a gulf of
more than three ems when the words before it carry on the paragraph above, and
what stands beyond it carries no words, is formula material and reaches above or
below the type beside it. The paragraph condition is what keeps `maximize` with
the sum it opens: a word that starts a display row is indented away from the
lines above it.

Two more things are not words, though they are spelled with letters. An
**operator name** — `min`, `max`, `log`, `det` — is set in roman inside a
formula, and counting it as prose is what made the range under a union sign,
`n_min ≤ m ≤ n_max`, read as a sentence with two words in it. And a line's type
size is taken as its **75th percentile**, not its median: on that same range
the indices outnumber the letters they belong to, so the median size *is* the
size of a subscript, and against that ruler nothing on the line looks like a
subscript at all — which is how `n` and `min` came to be read as the single
four-letter word `nmin`.

A line with **nothing printable** on it is not a line at all. The pieces an
extensible brace or a large parenthesis is built from come in a font of their
own and map to no character — left in place they are lines like any other, and
one landing between the halves of a formula cuts it in two. They are kept, all
the same, because they are part of what a formula *occupies*.

A glyph set smaller than its line is a **script** — an index, an exponent — and
counts as formula material in its own right. It also does not glue the letters
either side of it into a word: `E_n` is a variable with an index, not a
two-letter run, and reading it as a run is what made a fraction like
`1/|E_n(r(X))|` score as prose.

**Maths.** A glyph counts as formula material if its font is one only formulas
use — `CMMI`, `CMSY`, `CMEX`, `MSAM`/`MSBM`, the `tx`/`newtx` and `px` families,
or any of the modern OpenType math fonts, all of which carry `math` in the name
— or if it comes from a mathematical Unicode block. LaTeX subsets fonts as
`ABCDEF+CMMI10`, so these are substring tests. This is what separates a period
inside a formula from one that ends a sentence.

Font names alone are not enough to find a *formula*, though. Plenty of journals
set their maths in a Times or Palatino family, where `P`, `X` and `q` come back
in a font whose name says nothing about maths and which is, glyph for glyph,
the same italic the prose uses for emphasis. So how formula-like a line is gets
measured without reference to any font name: **a variable is a single letter
standing between non-letters**, where prose italicises whole words. That, plus
the glyphs that are maths by Unicode whatever they claim to be, is what carries
display detection across typesetting conventions. A line with four or more real
words is prose either way.

**Display equations: the flow of the text.** Whether a line is a displayed
formula is decided by *how the page is set*, not by what the line looks like.
Judged on its own, a line is a pile of evidence that cuts both ways — a
formula's condition carries words ("otherwise", "if and only if either", "closed
k-walks based at v"), and a line of prose can be mostly formula ("corresponds
to max{F(x, u, Du, D²u), |Du| − g(x)} = 0.") — and every rule that weighed such
evidence line by line grew an exception for the next paper.

Prose is set in a **flow**: lines on the paragraph's own margins, a baseline
skip apart, each full line running the measure. So, per column:

- the **measure** is taken from the column's wide lines of words, and the
  baseline skip from pairs of them;
- a **margin** is the column's own left edge, or an indent that a line of
  unmistakable prose (several words, little formula) starts at while running
  the measure — a paragraph's first line, a list item's continuation;
- a line carrying words is **prose** if it stands on the column's edge, or on an
  indent while running the measure or reading as prose; or if it shares its left
  edge, a baseline skip away, with a neighbour on the flow — which passes a list
  item's continuation, a hanging indent, or a caption or quotation set
  narrower than the column and centred in it, down line by line;
- a **list item** is prose however much formula it holds: a label opening a full
  line, or a sibling item's text starting where its own does (labels are set
  right-aligned, so "(i)" and "(iii)" start apart but their text lines up) —
  unless something stands to the left of the items, a brace or an equation
  number, which makes the whole list one displayed formula; and a line on an
  item's text indent, carried on past a display, is prose too;
- a paragraph's **first line** at an indent no full line has shown yet, reading
  as prose, is prose — "For s ∈ [0, 1], we define the subspace H_s of H by";
- a **short last line** at the margin carrying on a full line of prose — "Then"
  / "u ≤ v in Ω." — is prose without a word in it, and may start a little in
  where a limit hangs left of its sum;
- a fragment on a prose line's baseline, straight after it, or a piece standing
  inside it, is part of it.

Everything **off the flow** that has a relation in it, or formula enough, is a
displayed formula, whatever words it carries; off the flow with no formula, it
is a heading, a caption or a title. A numbered line is a formula, and so is a
full line with no words at all. What stands beside or stacked with a formula —
a numerator, a limit, a brace's other branch — joins it by position, and a
line on the flow never does.

A word is a run of letters, a ligature included — "define" set with an `fi` was
once two runs of two letters and no word at all.

These rules were checked against a neural formula detector run over the corpus
(`tools/detect.mjs`, with the model kept out of the repository): on 10,000 lines
the two now disagree on two, and in both the detector is the one that is wrong.
The detector is not part of the plugin, and the comparison is for finding where
the rules go wrong, not for deciding at run time.

A margin is matched to within a quarter of an em: TeX sets margins exactly, an
italic capital overhangs its origin by a point or two, and a centred formula
that merely starts near an indent is off by more. A column with too few lines
of prose to find its measure — a page that is nearly all formula, a short
synthetic page — falls back to the older rules, which score each line on how
much of it is formula, how few words it has, whether it carries a relation,
whether it is centred or indented, and whether it is numbered.

Consecutive display lines — an `align` environment — merge into one. The
equation number itself is dropped: it is neither highlighted nor treated as
text.

**How tall the band is** decides itself from the page rather than from the
formula. Taken from the formula's own printable glyphs it is wrong in both
directions: too short, because those glyphs stop short of the braces around
them, and too tall, because a fraction reaches up into the white space above
its line and overlaps the box of the line before it.

So the band covers everything **standing on the row** — the pieces of a brace
included, reaching a line further on each pass until nothing more is found —
and is then clamped so that it never crosses onto a neighbouring line.

**Pieces with words in them.** A piece of a formula can carry a roman word —
`trace`, `if` — and arrive as a line of its own, and a piece with a word is
normally kept out of a formula's row: that is what stops a sentence's tail
being swallowed by the display above it. The exception is a piece that shares a
baseline with a formula *and overlaps it*, starting before the piece beside it
ends. Prose never stands in the middle of a formula like that.

The rest of a formula's row can also come over as a line of its own —
*ν_k(X, v) := #{closed k-walks based at v},* after *p_k(X) = ∑_{v∈V(X)}* —
with words in it and beside the formula rather than inside it. It stands on the
formula's baseline, just after the formula's row, well in from the margin:
where no line of prose starts.

**Prose crowded with symbols.** The opposite mistake: a line of running text
can be mostly formula — *corresponds to max{F(x, u, Du, D²u), |Du| − g(x)} =
0.* — and score as a display. What it does not do is stand apart. A line flush
with the prose margin, directly under a full-width line that the layout did not
end a paragraph on (or that stops on a comma or an operator), is that paragraph
carrying on, and each line put back can vouch for the one after it. The margin
is measured from the column's wide prose lines rather than taken from the
column itself, which a formula overhanging the measure can stretch.

**Cases.** The branches of a cases formula stand beside a tall brace, and a
branch can carry words — *otherwise*, *if x is odd*, a type name — enough to
read as prose and cut the formula in two. The brace settles it: nothing but a
formula stands beside one, within its height. A brace is found as the column of
delimiter pieces it is built from (`⎧ ⎪ ⎨ ⎩`, or pieces that map to nothing),
and it must be at least two lines tall and share its height with a line already
read as a formula, so a bracket set large inside a sentence reaches nothing.

A small brace is not built from pieces: it is one glyph from the extension
font, arriving on the line of the first branch, with a box that covers only its
top (see below). Its height comes back from the formula it opens — centred on
the axis of the piece set just to its left, `F(x, r, p, X) =`, it reaches as
far below that axis as it stands above — and from there it is a brace like any
other, so `+∞ otherwise;` joins its formula.

The axis has to be the delimiter's **own row's**. A formula set over two rows
has two axes, and a bracket on the top row measured against the row below came
out stretched far past the formula, taking the two lines of prose under it into
the formula with it. A glyph set whole is small — its top at most a couple of
ems above the axis it is centred on — so a row further down than that is not
its row; and a branch of a cases formula is never a full line of text, so a
full line is never taken into one. The band is guarded the same way: which
lines are its neighbours is settled before any glyph stretches it.

Not every extension font gives itself away by its box. Computer Modern's CMEX,
in many PDFs, declares an ordinary height, and then a brace's box stands on the
baseline like a letter's, its top well above the ink and its bottom nowhere
near the second branch. So the extension fonts are also known by **name** —
`cmex`, `txex`, `pxex`, `NewPXEX` — and the top of a hanging glyph's ink is
taken at its baseline rather than at the top of its box.

**Set off, with words in it.** `T(x̂) = convex hull(UT(x̂))` carries enough
roman words to fall short of looking like a formula. What it keeps is how it is
set: centred, a relation in it, and space above and below that no line of a
paragraph has. A centred heading is set off too, but carries no relation and is
set in bold.

Clamping a band against its neighbours can also squeeze it to nothing, when a
formula's lines are hemmed in by the pieces of another; a band clamped below
most of its own glyphs' height falls back to their extent instead of being drawn
as a hairline.

**A glyph's box is not its ink**, and for big delimiters the difference is most
of the glyph. Zotero's pdf.js fork boxes every glyph from the font's descent to
its ascent, capped at the font's cap height, with any descent deeper than half
an em cut to a quarter. The fonts TeX sets big braces and operators in hang
their glyphs *below* the baseline and declare a cap height of next to nothing,
so a brace's box is a sliver across the top of it: the top is exact, with none
of the room a letter's box keeps above the letter, and the bottom is short by
nearly the whole glyph. Such a box gives itself away — its part above the
baseline is a fraction of its part below — and the ink is recovered from how it
is set: a big delimiter is centred on the maths axis, a quarter em above the
row's baseline, so it reaches as far below the axis as its top stands above
it. The band takes that in, and a little room above the top. The diagnostics
report prints `hang` with the top of such a glyph on any line that has one.

A line is judged by its **middle**, and that matters at both ends. A line whose
middle falls inside the row is standing *on* it — an equation number, the full
stop after a fraction — and is no neighbour to stop short of; judged by its
edges instead, an equation number level with a fraction reads as a line below
and cuts the denominator off. And a line whose middle falls outside is a
neighbour even where the boxes overlap, which is what a tall formula does to
the line above it.

A displayed formula is also *highlighted* differently: as a single band the
**width of the text**, rather than glyph by glyph or traced around its own
outline. A formula's outline is ragged — limits under a summation sign, a
fraction wider than the line it sits on — and a band that follows it reads as a
shape rather than as a mark on the page. The band runs the measure, which is
also where an equation number sits; the number is still no part of what is
read. Maths is set in two dimensions — a
fraction draws its numerator then moves back and down for the denominator, a
summation hangs its limits above and below — so following the glyphs gives a
ragged row of boxes with holes between them. Stepping word by word through a
formula still boxes the individual tokens; at every larger step size the
formula is one area.

A formula's pieces do not arrive in reading order, either: a summation sign is
followed by its upper limit, set high above the line, and then its lower limit,
set well below it. A block that grew by comparing each piece against the one
before it would find a gulf between those two and cut the formula in half, so a
display block grows against everything it already covers — and measures the
distance against the **larger** of the two type sizes, because a summation sign
is set far bigger than the limits hung beneath it and their own size is the
wrong ruler for the gap between them.

Some pieces cannot be judged at all. The numerator of `1/|R(X)|` is the single
character `1`: no letters to read as variables, no symbols to read as
operators, and prose on every measure. What settles it is where it stands, so
once a row is known to carry a formula, anything standing **inside that row**
joins it. Absorbing one piece widens the row, which can bring another within
reach, so that repeats until nothing more moves. A double sum with limits
stacked under both signs and a fraction after each arrives in thirteen pieces
and comes out as one.

Position alone reaches the line *above* the row as well as the pieces in it,
which is right for a fraction's numerator and wrong for the tail of a sentence.
So a line is only taken if it carries **no words at all** — an operator name
like `min` not counting as one — *or* is set in **script type**.

The second clause is there because the set an infimum is taken over can be
written in English: `inf` over *a(·) admissible from x*. That is a limit, and
plainly part of the formula, but it has words in it. What marks it is its size
— a limit is set well below the body type, and a sentence never is.

Getting there needs the row, not the pieces. A display line reaches the plugin
in fragments — two equations set side by side, the tail after a summation sign,
the limit beneath it — and a fragment judged on its own can go wrong:
`P(X,Z),` has no words and no relation sign, scores as prose, and then drags
the paragraph below it into the highlight. So once any line on a row is known
to be a formula, **everything level with it in the same column joins that
formula**, whatever it scored. A line carrying four or more real words is prose
whatever it overlaps and is never taken.

An equation number arrives in one of two shapes — at the end of the formula's
own line, or as a line of its own — and both are settled once the columns are
known, because the **right-hand margin** is what tells a label from an ordinary
parenthesis. A gap alone will not do it: `(3)` can sit only a few points clear
of the formula it numbers, and a gap test tight enough to catch that would
strip real parentheses out of running prose.

Some styles — the AMS journals among them — set the number at the **left**
margin instead, a gulf away from the formula. There the first gap on the line is
the one that matters, and the gulf is what tells the number from a list label,
which sits a word space from its item. Taken for the start of a line of prose,
`(1.2) −` ended on an operator and pulled the whole display into itself as the
rest of its expression. Once a number is found on either side, the line's
formula fractions are taken again without it: on a short piece of a row cut
at a summation sign, the number's digits outnumber the formula.

When a formula is too wide for it, the number is **raised** onto a line of its
own above the formula, and the layout still hands both over as one line —
sometimes with the formula's brace landing in the middle of the number in
reading order, `(2.1{5)`. The pieces of a big delimiter are passed over in
reading the number, and a number standing half a line or more above what
follows it needs no gulf to be one — nor even a space: on the page this was
seen on, the formula begins exactly where the raised number ends, and the step
down in baseline is the only break between them. Nor does one crowded by a display too wide
for its margin — `(1.9) L_{α,β}u = −` leaves a space, not a gulf — when what
follows the number is nothing but formula; a list item's label is followed by
words.

A display is also set in from the margin and never begins with a word, so a
line at the margin that opens with one — *where A = D²φ(x̂) ∈ S(N), N = N₁ + ⋯ +
N_k.*, straight under a formula — is the sentence after the formula, however
full of symbols.

**Sentence boundaries.** Every `.`, `?`, `!` and `…` is a candidate, and most
of the work is in throwing candidates out:

| Looks like a full stop | Why it isn't |
| --- | --- |
| `f.g`, `x_{i.j}` | the period is in a formula font |
| `3.14`, `Version 2.0` | digits on both sides |
| `see Fig. 3`, `by Thm. 2.1`, `i.e. the map` | a known abbreviation before it |
| `J. R. R. Tolkien` | a run of author initials |
| `Crandall and R. Newcomb` | a single initial after a surname and "and" |
| `1. the first case` | a list label at the start of a line |
| `1.2. State of the art` | a run-in section heading's number |
| `the bound holds.¹² The rest` | a raised footnote marker read as a decimal |
| `... and then` | an ellipsis not followed by a capital |
| `[12] Smith, J. A. Some paper.`, `[Lê20] K. Lê. A lemma.` | a bibliography entry, kept whole — and begun as a block of its own when its key, followed by an author, opens a line |

A footnote marker is masked out of the text, but an **exponent** must not be:
its digits come from the roman text font too — `h²`, `U^{k+1}` — so small,
raised and not in a maths font describes both. What separates them is what the
raised digits are attached to. A marker follows a word, a stop or a remark in
brackets; an exponent follows a variable, closes a bracketed formula, or shares
its script with a letter or an operator. A glyph that is masked still belongs
to the line, so the highlight steps over it rather than leaving a hole.

A candidate must also be followed by a **space**. Without one the full stop is
part of a word — `math.PR`, a file name, a version string — however much the
next character looks like the start of a sentence.

A candidate that survives all of those still has to be followed by something
that opens a sentence — a capital, a digit, an opening bracket or quote, or a
formula. `Appendix A. We now conclude.` breaks; `J. R. Smith` does not.

A line's highlight breaks only at a gulf between cells. A glyph that maps to
no character — `≍` in *N_n ≍ n⁹* — leaves a hole wider than a word space in the
middle of a sentence, and the highlight runs across it.

**Sentences that are not in one piece.** Layout analysis ends a paragraph
wherever the geometry jumps, including at the foot of a column and at every
hanging indent — which is every list item whose continuation is set in. A
continuation normally reads as one, in lower case, but a clause broken across a
hanging indent carries on with a number: *hence c₅(X) =* / *12 and …*. What
marks that as unfinished is the operator the first half stops on rather than
the shape of the second — and the second half, being short and full of symbols,
is easily taken for a formula standing on its own, so this is the one case
where a formula may be pulled back into the sentence before it. Prose
introducing a real displayed formula stops on a word, a comma or a colon, never
on an equals sign.

When one block stops mid-sentence and the next picks up in lower case, or the
first stops mid-expression, they are rejoined — so
a sentence spanning two columns, or one interrupted by a paragraph break the
layout invented, stays a single unit. Requiring lower case is what keeps
headings from being swallowed.

**Paragraph breaks that went missing.** The same analysis errs the other way
too. Zotero removes the paragraph break before any *one-line* paragraph whose
first glyph shares a font with the paragraph above — which is exactly a run-in
section heading, because `1.2.` is set in the same roman as the body text. The
heading then arrives glued to the end of the previous paragraph, and the only
thing left distinguishing it is the vertical gap. So a jump well beyond the
page's normal line spacing ends a block whatever Zotero said. Without this the
ruler drags `1.2.` along behind the last sentence of the section above it.

**Text at another angle.** An arXiv stamp runs down the left-hand margin —
eighteen points wide and most of the page tall — so its band overlaps the band
of nearly every line on the page. Anything that gathers lines by vertical
overlap will gather the whole page into one around it, and anything that
measures the text's margin will measure it out to the paper's edge. Text set at
a different angle therefore keeps its own company: it shares no block, no row
and no column with the text of the page, and rows are gathered from lines of
*comparable* height — overlap measured against the taller of the two, not the
shorter.

**Columns.** Found from vertical whitespace: bin the x axis, look for a run of
empty bins away from the margins, and cut there. Two constraints keep that
honest. A gutter has to separate two *bodies* of text and run the height of the
page to do it — one wide gap does not, or the blank run before an equation
number would leave a "column" holding that number and nothing else, and the
channel between a table's last two columns would leave one holding only that
table. And every column is then shrunk onto the text it
actually holds: a column still reaching the paper's edge makes every line look
indented from its left margin and every full-width line look centred in it, and
puts the right-hand margin somewhere out in the blank paper.

**List items.** A line opening with a list or section label — `(4) record …`,
`3. Gibbs measures …`, `(iii) every …` — starts a new block. Without that an
item ending on a semicolon runs straight into the next one: the layout sees no
indent between them so it marks no paragraph break, and a semicolon is not a
full stop, so nothing else separates them either.

But a line may open with a bracketed number without being an item at all:
*(16) equals 1 for every closed path* is a cross-reference carrying a sentence
over. What tells the two apart is the line *before* — an item ends on a full
stop or a semicolon, a sentence carried over ends mid-clause.

An item's own continuation must also not be **centred**. A numbered
contribution reads as a list item — *1. Correct fixed-size chains.* — and a
formula displayed under one sits indented, at a gap the formula's own tall
glyphs make look small. Being set about the middle of the column is what a
display does and what a continuation never does.

An item's own continuation is set in **under its label**, which is what a
hanging indent is, so a line set in under a block that opens with a label is
the rest of that item however it reads on its own — and it has to be the *next*
line, at ordinary leading. Both conditions are needed. A formula displayed
under a list item is set in from the label exactly as the item's continuation
is, and reads as a formula just as that does; what a continuation does not have
is the space above it that sets a display apart from the text. And the item
must have a hanging indent at all: a run-in numbered paragraph — *3. Gibbs
measures with spectral potentials. In Section 5 we …* — opens with a label too,
but its own second line is back at the margin, and what is set in under it is a
displayed formula.

**Tables.** A table is found the way a reader finds one: rows of cells, one
under the next, whose gaps line up into columns. A row reaches the plugin in
pieces — one per cell, or a run of cells the layout saw on one baseline — so
rows are gathered first: lines standing side by side, **in one size of type**,
are a visual row, and a row is cut into cells at gaps of about an em. A table is
then a run of rows of several cells at a table's spacing, allowing short rows
between them, and stopping at a line of prose, a caption, or a gap wider than a
row's. Its columns are the **gutters** that nearly all of those rows leave
white. A run with no gutter, of fewer than three rows, or whose rows are
formulas — a matrix, an aligned derivation — is no table; nor is a list whose
second column runs to the margin row after row, like a bibliography.

A visual row is not always a row of the table. A cell too long for its column
wraps; a header's cell takes two lines; *these* partial rows — filling fewer
than half the columns with text, crossing no gutter — belong to the nearer row
beside them. A row that names itself in the first column and gives a value
beside it (*Warmup Ratio 0.1*) is a row however sparse, and so is a row of
figures that fills in only the columns that changed (Transformer's rows (A)–(D)).
A group's heading — centred over its rows (*Published*, *Ours*), or with its
rows set in under it (*Fine-tuning approach*) — is a row of its own, and a
heading running across the table does not end it. A header in two lines, a
heading spanning columns with the columns' own headings set tight under it
(*Dev* over *EM F1*), is one row.

A **stacked cell** — a bracketed block of three layers beside a block of two,
with the row's label level with neither — breaks into visual rows that belong
to no one row. What binds it is the order the page hands its text over in: down
the cell's lines, then back up for the next cell to the right, where a table
set row by row goes across. Down-and-back-up alone is not enough, since a list
of settings written out column by column comes over the same way; its columns
have as many lines as it has rows, while stacked cells leave the columns at odds.

**Figures** have rows and columns too: a plot's tick labels and legend, a
diagram's boxes. What a block of text is, its caption says — the caption reached
first going up or down from it, past the figure's other labels but not past a
line of prose. And a figure's labels set beside a column of text are kept out of
that text's rows by their type size, and by the text's lines standing one under
another on a common margin, as a paragraph's do.

Each table row is read as one thing and **highlighted as one band** across the
table, and a table is read row by row, a row column by column — a name, then
the affiliation and address set under it — whatever order the layout used. A
row is also a block of its own: a table carries no full stops and often no
paragraph breaks, so without that a whole table of figures reads as one
sentence. Nothing is pulled into a table from outside either: a lead-in that
ends on a colon is still open as far as sentences go, but the header under it
is not the rest of it.

**Contents.** An entry in a table of contents is a row by the same token: a
title, then a dot leader or a gap, then a page number. A leader is a run of full
stops each followed by a space — which is exactly what a full stop ending a
sentence looks like, so the last one before the page number used to end the
entry and hand its number to the entry below. A chapter line with no leader has
no full stop at all, so nothing separated one chapter from the next. A line
with a leader, or with a bare number after a wide gap, is now a row. A year
ending a sentence has no gap before it, an ellipsis is three stops rather than a
leader, and an equation number is bracketed, so none of those qualifies.

Some contents lists have neither leaders nor page numbers, and no paragraph
breaks between entries either, so nothing ended one before the next began.
They do have a **section number** at the head of each entry — `7.D.`, `8.`,
`10.` — on a line that stops well short of the measure. Three such lines in a
row, at ordinary leading, are a list of entries, and each begins a block of its
own; a numbered line or two inside a paragraph is not a list. A short
capitalised line right after the run, set no deeper than its entries
(`APPENDIX …`), is the list's last entry, while a wrapped title set in under
its own title carries on the entry above.

**Page furniture.** A running head is prose, and a line that is mostly algebra
never is — which matters because a formula set low on the page has every other
mark of a running head: it is short, it sits in the margin band, and once its
limits are read as part of its own row it stands clear of the text above it.

Beyond that, running heads and page numbers are dropped only when all of a
margin position, a body-sized font, a short line — or a line with no
lower-case letter in it, since a running head is often capitals and can run
most of the measure — and a clear gap to the text agree. Losing the first line
of a page is worse than keeping a page number, so the test is deliberately hard
to pass. The gap is measured against the nearest line that is *not on the same
row*: a page number and the running head across from it are one row, and each
would otherwise vouch for the other being body text.

## Speed

Pages are analysed one at a time, on demand, and cached; the neighbouring pages
are warmed in the background so crossing a page boundary isn't the move that
stutters.

What the cache holds is bounded twice over, because a reading session opens
many documents and none of this is worth holding for as long as Zotero runs.
A page is kept **per step size**, and only that one is built: a page's words
outnumber its sentences twenty to one, so boxing every word only to throw it
away when stepping by sentence was most of the work past the analysis. Sixty pages are kept per document, fifteen at word size, and four
documents at all, evicted least-recently-used so the document being read is
never the one dropped. The ceiling, every cache full, is about 6 MB. The cache holds only what a
highlight is drawn from — text, boxes, a type size — never a page's lines or
glyphs, which are dropped as soon as a page is analysed.

The analysis itself takes **1.9 ms** a page on average and under 4 ms at worst,
measured over 207 pages of four mathematical papers (`tools/profile.mjs`), so
what you wait on is the one round-trip to Zotero's PDF worker, and only the
first time you visit a page. What made the difference: font names are read by
regex once per font rather than once per glyph (the cache lives for one page),
medians sort a typed array instead of calling a comparator, and a formula's
band is worked out once rather than once per step size. Nothing grows with
the size of a page faster than its pieces do — a 640-piece matrix analyses in
5 ms (`tools/stress.cjs`) — and repeated analysis leaves the heap where it was
(`tools/leakcheck.mjs`).

The drawing units are square — x runs 0..100 across the page and y runs
0..100&times;aspect down it — so a corner radius, a blur and a slant are the
same size in both directions. With a plain 0..100 square viewBox they would all
come out visibly squashed on a page that is taller than it is wide.

Highlights are positioned as a percentage of the page box, using pdf.js's own
page matrix. That means zooming and rotating need no recomputation at all — the
ruler simply scales with the page. Switching step size re-reads only the page
in view.

Boxes are gathered into visual rows by how much they overlap vertically rather
than by an exact match on their extent, and every box in a row is drawn on that
row's band. An exponent arrives as a piece of its own with its own raised
extent, and left there it draws a box higher than the rest of the line — a step
in the middle of an otherwise flat highlight. Two consecutive lines of prose
barely overlap, so they stay the separate rows they are.

Each unit is drawn as **one** group: all of its boxes go into a single `<svg>`,
filled opaque, with the strength and the blend applied to the group as a whole.
Boxes composited one at a time darken wherever they overlap — a stronger patch
on exactly the glyph the reader is looking at — whereas overlapping boxes of
the same opaque colour inside one group are idempotent. Boxes that sit on top
of one another within a line are merged away as well, so the common cases never
arise in the first place; the group is what makes the rest impossible.

Two things produce those overlaps. Maths, as above. And ligatures: Zotero
normalises `ffi` to a three-character string while leaving it a single glyph
with a single rect, so each glyph is counted once when the boxes are built —
a box per character would stack three on the same glyph.

## Settings

Right-click the `¶` button for the in-reader menu, or open
**Zotero → Settings → Sentence Focus**. Both write the same preferences and
each follows the other.

**Counter.** The small number in the corner of the `¶` button is how many times `]` has moved
the ruler on in that tab — one count per step. Each tab counts for itself, and
closing the tab discards its count: it is held weakly against the tab's reader,
so nothing is left behind to clean up. Turning the ruler off and on keeps it.
Stepping back with `[` counts nothing, and neither does pressing `]` at the end
of a document. **Erase** at the top of the menu starts it again from zero. It
stays hidden until the first step.

**Reading**

- **Step by** — word, line, sentence or paragraph. All four are worked out from
  the same block text and the same index map, so they agree about what counts
  as text: an equation number dropped from a sentence is dropped from the line
  and the word list too, and a running head is not steppable at any size.

**Highlight**

- **Style** — six of them:

  | | |
  | --- | --- |
  | **Tint** | A flat wash with square edges. |
  | **Rounded** | The same wash with the corners taken off — enough to read as rounded, not so much that the lines of a wrapped sentence stop touching. |
  | **Soft** | Feathered edges that fade out instead of stopping. One blur over the whole unit, so neighbouring lines melt together rather than each growing its own halo. |
  | **Marker** | A chisel-tip stroke: slanted ends, a soft edge, and a gentle vertical gradient where the ink pools. |
  | **Underline** | A rule under each line; nothing covers the text at all. |
  | **Dim rest** | Veils the rest of the page instead of marking the unit. |

- **Colour** and **Strength**. Underline is drawn stronger than the setting
  asks, because a rule two pixels tall carries far less colour than a wash over
  a whole line and would otherwise read as much fainter at the same number.
- **Breathing room** — how much space the highlight leaves around the text. It
  is measured against the **size of the type**, not the height of the line's
  band: a line carrying a fraction has a band three times its type size, and
  room measured against that swallows the line above. It grows with the type
  rather than with the page, and a displayed formula gets three times as much of it sideways as
  running prose: a formula is set off from the text by blank space to begin
  with, and a box drawn tight against the outermost glyph reads as a clamp
  rather than a highlight. A unit carries its own line height for this, because
  a formula's box spans every row it occupies and padding it by a share of
  *that* would swallow the paragraph.
- **Keep the ink on top** — on by default. The highlight is *blended* with the
  page rather than laid over it, so the glyphs keep their full contrast the way
  a marker pen leaves ink alone. Turn it off for a flat wash.

  This is `mix-blend-mode: multiply` (`screen` when the page is dark), and it
  only works if nothing between the highlight and the page canvas forms a
  stacking context — one would isolate the blend, which silently degrades to
  ordinary alpha and leaves the text muddy. So the layer the boxes live in is
  `display: contents`: it has no box at all, and the boxes paint as direct
  children of the page div. Zotero's own annotation overlay does the same thing
  for the same reason.

**Scrolling**

- **Scroll the page** — *Never*, *Only when the unit is off screen* (the
  default), or *On every step*. Nudging the page on every step makes the text
  crawl under a stationary ruler, which is the opposite of what a reading ruler
  is for, so by default the page stays put until the ruler would leave the
  window.
- **Keep clear of top** — how far down the window the unit lands when the page
  does scroll, as a share of the window height. Landing flush against the top
  edge gives the eye nothing to lead into.

**Sentences**

- **Fold display equations into the surrounding sentence** — off by default, so
  a displayed formula is its own stop. Turn it on to read *…such that*, the
  equation, and *where…* as one sentence.

  Formulas are recognised either way; the setting only decides whether one is a
  stop of its own or part of the sentence around it. That matters because a
  displayed formula is set off with blank space *and* the layout puts a
  paragraph break either side of it, so both of the reasons a block would
  normally end have to be suspended where a formula meets the prose. Otherwise
  folding them in produces the opposite of what it promises: the part before
  the formula, the formula, and the part after, as three separate stops.
- **Clicking the page moves the ruler**.

Style, colour and strength repaint immediately. Changing the step size re-places
the ruler but keeps the analysis, since a cached page holds every granularity.
Only changing how equations are handled re-analyses the document — and it
discards *every* cached page, not just those of a reader that happens to have
its ruler switched on, or the setting would appear to do nothing on every page
already visited.

## Limits

- A sentence broken by a **page break** becomes two units. Column breaks within
  a page are stitched; page breaks are not.
- **Bad OCR** degrades gracefully rather than gracefully failing: if formula
  glyphs come back in a text font, equations read as ordinary prose and get
  folded into the sentences around them. Nothing crashes, but the units are
  coarser.
- Only the **PDF** reader. EPUB and snapshot views have no `¶` button.
- Rotated and vertical text gets a bounding box rather than a per-line box.

## Development

```sh
node test.js     # exercises the analysis on a synthetic page — no Zotero needed
node lint.js     # checks every function bootstrap.js calls actually exists
open preview.html   # a bench for the highlight styles
```

When the ruler marks the wrong thing in a real document, **Copy page
diagnostics** in the reader menu puts an account of how that page was read on
the clipboard: what each line was taken for, the numbers behind that call, and
the fonts it saw. Every wrong call so far has turned on one of those three, and
none of them can be guessed from a screenshot.

`lint.js` earns its place because most of `bootstrap.js` talks to a live reader
and cannot run here: a call to a function that was deleted or renamed sails
straight past `node --check` and only fails when a key is pressed in Zotero.
`node test.js` runs it too.

`preview.html` loads the real `bootstrap.js` and calls its real
`drawHighlight()`, so the styles it shows are the ones the reader draws. It is
the quickest way to tune a radius or a slant without a round trip through
Zotero. Neither file ships in the `.xpi`.

**Real PDFs, offline.** `tools/` runs Zotero's own pdf.js — extracted from the
installed Zotero, so the characters are exactly the ones the reader sees — on
real papers in Node, and draws what the plugin makes of a page on top of the
rendered page. Nothing in it ships, and neither the papers nor Zotero's code are
committed.

```sh
cd tools && npm install
unzip -o -j "/Applications/Zotero.app/Contents/Resources/app/omni.ja" \
  resource/reader/pdf/build/pdf.mjs resource/reader/pdf/build/pdf.worker.mjs -d vendor
node harness.mjs pdfs/paper.pdf 14          # the diagnostics report for a page
node overlay.mjs pdfs/paper.pdf 1-10 --out out   # pages with their units drawn on
node snapshot.mjs before.json pdfs/*.pdf    # every page's units, to diff after a change
node diff.cjs before.json after.json        # what a change did, page by page
node check-corpus.mjs                       # the reported cases, on the real papers
node profile.mjs pdfs/*.pdf                 # analysis time per page, slowest pages
node --expose-gc leakcheck.mjs pdfs/*.pdf   # the heap across repeated analysis
```

A change to the analysis is made against the whole corpus: snapshot, change,
snapshot, diff, and look at the pages that moved.

`test.js` builds the same per-character stream Zotero produces from a compact
description of a page, so every rule above is pinned down by a test that reads
like the PDF it stands for.
