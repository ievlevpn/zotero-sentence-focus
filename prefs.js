/* Preferences pane for Sentence Focus. Registered from bootstrap.js; runs in
 * the Zotero settings window.
 *
 * Zotero loads pane scripts BEFORE inserting the pane markup (see
 * Zotero_Preferences._loadPane), so nothing here can touch the DOM at load
 * time — getElementById would return null and take the whole script down.
 * Everything waits until the markup actually appears.
 *
 * The same settings are on the reader's ¶ button; both write the same prefs,
 * and bootstrap.js observes them, so whichever is open follows the other.
 */
{
	function init() {
		const { PREF, DEFAULTS } = Zotero.SentenceFocus;
		const get = (key) => {
			try {
				const v = Zotero.Prefs.get(PREF(key), true);
				if (v !== undefined && v !== null && v !== "") return v;
			} catch (e) { /* unset */ }
			return DEFAULTS[key];
		};
		const set = (key, value) => Zotero.Prefs.set(PREF(key), value, true);
		const $ = (id) => document.getElementById(id);

		// [element id, pref key] for each kind of control.
		const menus = [["sf-granularity", "granularity"], ["sf-style", "style"], ["sf-autoscroll", "autoScroll"],
			["sf-annotate-key", "annotateKey"], ["sf-click", "clickMoves"], ["sf-jump-key", "jumpKey"],
			["sf-toggle-key", "toggleKey"]];
		const checks = [["sf-behind", "behind"], ["sf-merge", "mergeDisplay"], ["sf-copy", "copyUnit"],
			["sf-count", "countReading"]];
		const sliders = [["sf-opacity", "opacity"], ["sf-padding", "padding"], ["sf-margin", "scrollMargin"]];

		for (const [id, key] of menus) {
			const el = $(id);
			if (!el) continue;
			el.value = String(get(key));
			el.addEventListener("change", () => set(key, el.value));
		}
		for (const [id, key] of checks) {
			const el = $(id);
			if (!el) continue;
			el.checked = !!get(key);
			el.addEventListener("change", () => set(key, el.checked));
		}
		for (const [id, key] of sliders) {
			const el = $(id);
			if (!el) continue;
			const out = $(id + "-out");
			const show = () => { if (out) out.textContent = `${el.value}%`; };
			el.value = String(get(key));
			show();
			// "input" rather than "change" so the ruler follows the drag.
			el.addEventListener("input", () => { show(); set(key, Number(el.value)); });
		}

		const color = $("sf-color");
		if (color) {
			color.value = String(get("color"));
			color.addEventListener("input", () => set("color", color.value));
		}
	}

	// The pane markup arrives after this script does, so wait for it.
	const ready = () => {
		if (!document.getElementById("sf-style")) return false;
		init();
		return true;
	};
	if (!ready()) {
		const observer = new MutationObserver(() => { if (ready()) observer.disconnect(); });
		observer.observe(document.documentElement, { childList: true, subtree: true });
		// A pane that never arrives — the window was closed while it loaded —
		// must not leave a watcher on the document for the rest of the session.
		if (typeof window !== "undefined") window.addEventListener("unload", () => observer.disconnect(), { once: true });
	}
}
