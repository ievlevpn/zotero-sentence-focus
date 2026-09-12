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

Two more things are not words, though they are spelled with letters. An
**operator name** — `min`, `max`, `log`, `det` — is set in roman inside a
formula, and counting it as prose is what made the range under a union sign,
`n_min ≤ m ≤ n_max`, read as a sentence with two words in it. And a line's type
size is taken as its **75th percentile**, not its median: on that same range
the indices outnumber the letters they belong to, so the median size *is* the
size of a subscript, and against that ruler nothing on the line looks like a
subscript at all — which is how `n` and `min` came to be read as the single
four-letter word `nmin`.

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

**Display equations.** A line is scored on how much of it is formula, how few
real words it has, whether it carries a relation symbol, whether it is centred
in its column or indented from it, and whether it ends in a right-margin
equation number. Score high enough and it becomes its own unit rather than part
of the prose around it. Consecutive display lines — an `align` environment —
merge into one. The equation number itself is dropped: it is neither
highlighted nor treated as text.

A displayed formula is also *highlighted* differently: as the single area it
occupies, rather than glyph by glyph. Maths is set in two dimensions — a
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
like `min` not counting as one. Anything with a word in it is prose, whatever
it overlaps.

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

**Sentence boundaries.** Every `.`, `?`, `!` and `…` is a candidate, and most
of the work is in throwing candidates out:

| Looks like a full stop | Why it isn't |
| --- | --- |
| `f.g`, `x_{i.j}` | the period is in a formula font |
| `3.14`, `Version 2.0` | digits on both sides |
| `see Fig. 3`, `by Thm. 2.1`, `i.e. the map` | a known abbreviation before it |
| `J. R. R. Tolkien` | a run of author initials |
| `1. the first case` | a list label at the start of a line |
| `1.2. State of the art` | a run-in section heading's number |
| `the bound holds.¹² The rest` | a raised footnote marker read as a decimal |
| `... and then` | an ellipsis not followed by a capital |
| `[12] Smith, J. A. Some paper.` | a bibliography entry, kept whole |

A candidate that survives all of those still has to be followed by something
that opens a sentence — a capital, a digit, an opening bracket or quote, or a
formula. `Appendix A. We now conclude.` breaks; `J. R. Smith` does not.

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

An item's own continuation is set in **under its label**, which is what a
hanging indent is, so a line set in under a block that opens with a label is
the rest of that item however it reads on its own — and it has to be the *next*
line, at ordinary leading. Both conditions are needed. A formula displayed
under a list item is set in from the label exactly as the item's continuation
is, and reads as a formula just as that does; what a continuation does not have
is the space above it that sets a display apart from the text.

**Tables.** A row reaches the plugin in one of two shapes. Sometimes it is one
piece per cell, spread right across the measure, and read a cell at a time it
says nothing — *theorem*, then *O(n) tests*. Sometimes the layout sees a single
baseline and hands over the whole row as **one line**, cells and all, with the
column gaps internal to it.

Both are one line and are highlighted as the one band they occupy. The first is
found by clustering pieces that share a band; the second by counting the wide
gaps *inside* a line — several of them is a row, one of them is the run up to
an equation number, and justified prose never stretches a word space that far.
A row is also a block of its own: a table carries no full stops and often no
paragraph breaks either, so without that a whole table of figures reads as one
sentence.

A row of displayed maths is laid out like a table row and must not be caught by
this; where the pieces are separate, what separates them is words. A table's
cells carry them, a formula's pieces do not, so a row needs two cells with a
real word in them before it counts as a table.

A row is also *highlighted* as the one band it occupies, like a displayed
formula — a box per cell leaves the row in pieces with the column gaps cut out
of it. At line size a cell is still a line of its own, for stepping through a
row one entry at a time.

**Page furniture.** Running heads and page numbers are dropped, but only when
all of a margin position, a body-sized font, a short line — or a line with no
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
A page is kept **per step size**, not with all four worked out — analysing a
page produces all four in one pass, but a page's words outnumber its sentences
twenty to one, and keeping all four costs about ten times what keeping one
does. Sixty pages are kept per document, fifteen at word size, and four
documents at all, evicted least-recently-used so the document being read is
never the one dropped. The ceiling, every cache full, is about 6 MB. The analysis itself runs in about **1.5 ms** for
a dense page of around 3,500 glyphs, so what you wait on is the one round-trip
to Zotero's PDF worker, and only the first time you visit a page.

The drawing units are square — x runs 0..100 across the page and y runs
0..100&times;aspect down it — so a corner radius, a blur and a slant are the
same size in both directions. With a plain 0..100 square viewBox they would all
come out visibly squashed on a page that is taller than it is wide.

Highlights are positioned as a percentage of the page box, using pdf.js's own
page matrix. That means zooming and rotating need no recomputation at all — the
ruler simply scales with the page. Switching step size costs nothing either: a
page is analysed once and cached with all four granularities.

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
  is measured in **line heights**, so it grows with the type rather than with
  the page, and a displayed formula gets three times as much of it sideways as
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

`test.js` builds the same per-character stream Zotero produces from a compact
description of a page, so every rule above is pinned down by a test that reads
like the PDF it stands for.
