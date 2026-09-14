// Static check: every function this file calls must actually exist here.
//
// bootstrap.js is mostly untestable from node — it talks to a live reader — so
// a call to a function that was deleted or renamed sails past `node --check`
// and only fails when someone presses a key in Zotero. This walks the source
// and flags any bare `name(...)` call with no matching declaration.
const fs = require("fs");

const GLOBALS = new Set(`
Array Boolean Components Date Error Infinity Intl JSON Map Math MutationObserver
Number Object Promise Proxy Reflect RegExp Set String Symbol TextDecoder TextEncoder
Uint8Array Uint16Array WeakMap WeakRef WeakSet FinalizationRegistry structuredClone queueMicrotask
Zotero clearTimeout console decodeURIComponent encodeURIComponent escape
isFinite isNaN module parseFloat parseInt require setTimeout undefined unescape
if for while switch catch return typeof instanceof new delete void do else async await
function class await yield throw case with super this
`.trim().split(/\s+/));

// Blank out comments, strings, templates and regex literals, keeping newlines
// so reported line numbers still line up. Without this every `(` inside a
// comment or a CSS string reads as a call.
function stripNonCode(src) {
	let out = "";
	let i = 0;
	let lastSignificant = "";
	const REGEX_OK = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", ""]);
	const blank = (text) => text.replace(/[^\n]/g, " ");
	while (i < src.length) {
		const c = src[i];
		const next = src[i + 1];
		if (c === "/" && next === "/") {
			const end = src.indexOf("\n", i);
			const stop = end === -1 ? src.length : end;
			out += blank(src.slice(i, stop));
			i = stop;
			continue;
		}
		if (c === "/" && next === "*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end === -1 ? src.length : end + 2;
			out += blank(src.slice(i, stop));
			i = stop;
			continue;
		}
		if (c === "\"" || c === "'" || c === "`") {
			let j = i + 1;
			while (j < src.length) {
				if (src[j] === "\\") { j += 2; continue; }
				if (src[j] === c) { j++; break; }
				j++;
			}
			out += blank(src.slice(i, j));
			i = j;
			continue;
		}
		if (c === "/" && REGEX_OK.has(lastSignificant)) {
			let j = i + 1, inClass = false;
			while (j < src.length) {
				if (src[j] === "\\") { j += 2; continue; }
				if (src[j] === "[") inClass = true;
				else if (src[j] === "]") inClass = false;
				else if (src[j] === "/" && !inClass) { j++; break; }
				else if (src[j] === "\n") break;
				j++;
			}
			while (j < src.length && /[a-z]/.test(src[j])) j++;   // flags
			out += blank(src.slice(i, j));
			i = j;
			continue;
		}
		out += c;
		if (!/\s/.test(c)) lastSignificant = c;
		i++;
	}
	return out;
}

function check(file) {
	const src = stripNonCode(fs.readFileSync(file, "utf8"));
	const declared = new Set(GLOBALS);
	// function foo(...)  |  const/let/var foo = ...  |  foo(...) => as a param
	for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
	for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
	// Destructured bindings: const { a, b } = ...
	for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
		for (const part of m[1].split(",")) {
			const name = part.split(":").pop().trim().replace(/=.*$/, "").trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
		}
	}
	// Arrow and function parameters, so callbacks passed by name are known.
	for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
		for (const part of m[1].split(",")) {
			const name = part.trim().replace(/=.*$/, "").trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
		}
	}

	const missing = new Map();
	const flag = (name, at) => {
		if (declared.has(name) || missing.has(name)) return;
		missing.set(name, src.slice(0, at).split("\n").length);
	};
	// A bare call: not a method (no leading dot) and not a declaration site.
	for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/gm)) {
		flag(m[2], m.index);
	}
	// Shorthand properties of `module.exports = { ... }`. A stale name there
	// throws on load rather than on use, and no call site mentions it.
	const exported = /module\.exports\s*=\s*\{([\s\S]*?)\n\s*\};/.exec(src);
	if (exported) {
		for (const part of exported[1].split(",")) {
			const name = part.trim();
			if (/^[A-Za-z_$][\w$]*$/.test(name)) flag(name, exported.index);
		}
	}
	return missing;
}

const FILES = ["bootstrap.js", "prefs.js"];

if (require.main === module) {
	let failed = false;
	for (const file of FILES) {
		for (const [name, line] of check(file)) {
			console.error(`${file}:${line}: calls ${name}(), which is not defined`);
			failed = true;
		}
	}
	if (failed) process.exit(1);
	console.log("lint: every call resolves");
}

module.exports = { check, stripNonCode, FILES };
