// node tools/debug-test.js "heading text"  — rerun one test block from test.js
// with segmentPage replaced by a version that prints describePage first.
const fs = require("fs");
const s = fs.readFileSync(__dirname + "/../test.js", "utf8");
const head = s.slice(0, s.indexOf("// --- prose, wrapped"));
const fr = s.slice(s.indexOf("// --- a page rebuilt from a diagnostics report"), s.indexOf("// A bracket on the top row of a two-row formula"));
const at = s.indexOf(process.argv[2]);
if (at < 0) throw new Error("no such test");
const brace = s.indexOf("\n{\n", at);
// Test blocks open and close in column 0; braces inside them are indented or
// in strings, so counting them is wrong.
const end = s.indexOf("\n}\n", brace) + 2;
const body = s.slice(brace + 1, end);
const src = head.replace('require("./bootstrap.js")', 'require(__dirname + "/../bootstrap.js")')
	+ fr + "\nconst __seg = segmentPage;\n"
	+ (process.argv[3] === "--plain" ? body : body.replace(/segmentPage\(/g, "((c, v, o) => { console.log(describePage(c, v, o)); return __seg(c, v, o); })("));
fs.writeFileSync(__dirname + "/_debug_run.cjs", src);
try { require("./_debug_run.cjs"); console.log("--- block passed"); }
catch (e) { console.log("--- " + e.message.slice(0, 300)); }
finally { fs.unlinkSync(__dirname + "/_debug_run.cjs"); }
