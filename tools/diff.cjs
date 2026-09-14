const [a, b] = process.argv.slice(2).map((f) => require(f));
let changed = 0;
for (const k of Object.keys(a)) {
	const x = JSON.stringify(a[k].map((u) => [u[0], u[1]])), y = JSON.stringify(b[k].map((u) => [u[0], u[1]]));
	if (x === y) continue;
	changed++;
	const ka = a[k].map((u) => u[0] + ": " + u[1].slice(0, 70)), kb = b[k].map((u) => u[0] + ": " + u[1].slice(0, 70));
	const onlyA = ka.filter((t) => !kb.includes(t)), onlyB = kb.filter((t) => !ka.includes(t));
	console.log(`\n== ${k}`);
	for (const t of onlyA) console.log("  - " + t);
	for (const t of onlyB) console.log("  + " + t);
}
console.log("\nchanged pages:", changed);
