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
	/** Optional tooltip on the tag chip. */
	tagTitle?: string;
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
	/**
	 * Called to persist the search string. Typing re-filters the list in
	 * place — the input element is never recreated mid-keystroke, so the
	 * caller must NOT re-render here, only store the value.
	 */
	onSearch: (value: string) => void;
	/** Bounded display capacity: rows shown at once. */
	capacity?: number;
	placeholder?: string;
	emptyText?: string;
}

export function renderFlatList(container: HTMLElement, options: FlatListOptions): void {
	const capacity = options.capacity ?? 100;
	container.replaceChildren();

	const search = document.createElement("input");
	search.type = "search";
	search.className = "list-search";
	search.placeholder = options.placeholder ?? "filter by prefix…";
	search.value = options.search;
	const body = document.createElement("div");
	container.append(search, body);

	const renderRows = (filter: string): void => {
		body.replaceChildren();
		const matches = options.rows.filter((row) => row.name.startsWith(filter));
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
			if (row.tagTitle !== undefined) tag.title = row.tagTitle;
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
		body.append(list);

		if (matches.length === 0) {
			const empty = document.createElement("p");
			empty.className = "hint";
			empty.textContent =
				filter === ""
					? (options.emptyText ?? "nothing here")
					: `nothing matches “${filter}”`;
			body.append(empty);
		} else if (matches.length > capacity) {
			const more = document.createElement("p");
			more.className = "hint list-more";
			more.textContent = `+${matches.length - capacity} more — refine the search to see them`;
			body.append(more);
		}
	};

	search.addEventListener("input", () => {
		options.onSearch(search.value);
		renderRows(search.value);
	});
	renderRows(options.search);
}
