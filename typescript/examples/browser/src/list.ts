/**
 * The app's one browsing idiom: a flat list in a bounded container with a
 * prefix-matching search box and a content-type tag on every row. The left
 * pane uses it for group members (Group / Array), the JSON panel for the
 * selected node's keys (JSON Object / JSON Array / base64).
 */

export interface ListRow {
	/** Display name; the search box prefix-matches against it. */
	name: string;
	/** Content-type tag shown next to the name. */
	tag: string;
	/** CSS modifier for the tag chip (e.g. "tag-group"). */
	tagClass: string;
	/** Optional trailing detail (subtitle, byte size). */
	detail?: string;
	/** Value for data-path, so rows are addressable in tests. */
	path?: string;
	selected?: boolean;
	onSelect: () => void;
	/** When set, the row renders this expanded content beneath it. */
	expanded?: (slot: HTMLElement) => void;
}

export interface FlatListOptions {
	rows: ListRow[];
	search: string;
	onSearch: (value: string) => void;
	/** Bounded display capacity: rows shown at once. */
	capacity?: number;
	placeholder?: string;
	emptyText?: string;
}

export function renderFlatList(container: HTMLElement, options: FlatListOptions): void {
	const capacity = options.capacity ?? 100;
	// Each keystroke re-renders the list; keep the caret in the search box.
	const active = document.activeElement;
	const hadFocus =
		active instanceof HTMLElement &&
		container.contains(active) &&
		active.classList.contains("list-search");
	container.replaceChildren();

	const search = document.createElement("input");
	search.type = "search";
	search.className = "list-search";
	search.placeholder = options.placeholder ?? "filter by prefix…";
	search.value = options.search;
	search.addEventListener("input", () => options.onSearch(search.value));
	container.append(search);
	if (hadFocus) {
		search.focus();
		const end = search.value.length;
		try {
			search.setSelectionRange(end, end);
		} catch {
			// some input types refuse selection APIs; focus alone is fine
		}
	}

	const matches = options.rows.filter((row) => row.name.startsWith(options.search));
	const list = document.createElement("ul");
	list.className = "flat-list";
	for (const row of matches.slice(0, capacity)) {
		const item = document.createElement("li");
		item.className = `list-row${row.selected ? " selected" : ""}`;
		if (row.path !== undefined) item.dataset.path = row.path;
		const head = document.createElement("div");
		head.className = "list-row-head";
		const name = document.createElement("code");
		name.className = "list-name";
		name.textContent = row.name;
		const tag = document.createElement("span");
		tag.className = `chip ${row.tagClass}`;
		tag.textContent = row.tag;
		head.append(name, tag);
		if (row.detail !== undefined) {
			const detail = document.createElement("span");
			detail.className = "list-detail";
			detail.textContent = row.detail;
			head.append(detail);
		}
		head.addEventListener("click", row.onSelect);
		item.append(head);
		if (row.expanded !== undefined) {
			const slot = document.createElement("div");
			slot.className = "list-expansion";
			row.expanded(slot);
			item.append(slot);
		}
		list.append(item);
	}
	container.append(list);

	if (matches.length === 0) {
		const empty = document.createElement("p");
		empty.className = "hint";
		empty.textContent =
			options.search === ""
				? (options.emptyText ?? "nothing here")
				: `nothing matches “${options.search}”`;
		container.append(empty);
	} else if (matches.length > capacity) {
		const more = document.createElement("p");
		more.className = "hint list-more";
		more.textContent = `+${matches.length - capacity} more — refine the search to see them`;
		container.append(more);
	}
}
