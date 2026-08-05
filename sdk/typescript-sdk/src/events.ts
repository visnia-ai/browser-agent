export class ReplayEvents<T> {
	readonly #items: T[] = [];
	readonly #waiters = new Set<() => void>();
	#closed = false;

	publish(item: T): void {
		if (this.#closed) return;
		this.#items.push(item);
		this.#wake();
	}

	close(): void {
		this.#closed = true;
		this.#wake();
	}

	async *iterate(): AsyncIterable<T> {
		let index = 0;
		while (true) {
			while (index < this.#items.length) yield this.#items[index++]!;
			if (this.#closed) return;
			await new Promise<void>((resolve) => this.#waiters.add(resolve));
		}
	}

	#wake(): void {
		for (const resolve of this.#waiters) resolve();
		this.#waiters.clear();
	}
}
