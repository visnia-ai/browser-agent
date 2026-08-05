(() => {
	const container = document.getElementById("lazy-scroll-container");
	const status = document.getElementById("status");
	if (!(container instanceof HTMLElement) || !(status instanceof HTMLElement)) {
		return;
	}

	const INITIAL_ITEMS = 8;
	const ITEMS_PER_BATCH = 10;
	const MAX_BATCHES = 5;
	const BOTTOM_THRESHOLD_PX = 16;
	let totalItems = 0;
	let loadedBatches = 0;
	let isLoading = false;
	let nearBottomTriggers = 0;

	const updateStatus = () => {
		status.textContent = `items=${totalItems}; batches=${loadedBatches}; triggers=${nearBottomTriggers}`;
	};

	const appendItems = (count) => {
		for (let i = 0; i < count; i++) {
			totalItems += 1;
			const row = document.createElement("div");
			row.className = `entry ${loadedBatches % 2 === 0 ? "batch-even" : ""}`.trim();
			row.textContent = `Lazy item ${totalItems}`;
			container.appendChild(row);
		}
	};

	const loadMore = async () => {
		if (isLoading) return;
		if (loadedBatches >= MAX_BATCHES) return;
		isLoading = true;
		await new Promise((resolve) => setTimeout(resolve, 120));
		appendItems(ITEMS_PER_BATCH);
		loadedBatches += 1;
		isLoading = false;
		updateStatus();
	};

	container.addEventListener("scroll", () => {
		const pxFromBottom =
			container.scrollHeight - (container.scrollTop + container.clientHeight);
		if (pxFromBottom <= BOTTOM_THRESHOLD_PX) {
			nearBottomTriggers += 1;
			void loadMore();
		}
	});

	window.__lazyScrollFixtureState = {
		mode: "lazy-scroll",
		get itemCount() {
			return totalItems;
		},
		get batchesLoaded() {
			return loadedBatches;
		},
		get nearBottomTriggers() {
			return nearBottomTriggers;
		},
		get scrollable() {
			return container.scrollHeight > container.clientHeight;
		},
		async triggerLoadBatch() {
			container.scrollTop = container.scrollHeight;
			await new Promise((resolve) => setTimeout(resolve, 220));
			return {
				itemCount: totalItems,
				batchesLoaded: loadedBatches,
				nearBottomTriggers,
				scrollHeight: container.scrollHeight,
				clientHeight: container.clientHeight,
			};
		},
	};

	appendItems(INITIAL_ITEMS);
	updateStatus();
})();
