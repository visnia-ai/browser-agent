const DEFAULT_MIN_PORT = 9000;
const DEFAULT_MAX_PORT = 50000;

export class NoAvailablePortError extends Error {
	constructor(minPort: number, maxPort: number) {
		super(
			`No available Chrome debugging port found in range ${minPort}-${maxPort}.`,
		);
		this.name = "NoAvailablePortError";
	}
}

export function createPortAllocator(input: {
	isPortInUse: (port: number) => Promise<boolean>;
	minPort?: number;
	maxPort?: number;
}): {
	acquirePort: () => Promise<number>;
	releasePort: (port: number) => void;
} {
	const minPort = input.minPort ?? DEFAULT_MIN_PORT;
	const maxPort = input.maxPort ?? DEFAULT_MAX_PORT;
	const reservedPorts = new Set<number>();

	return {
		acquirePort: async () => {
			for (let port = minPort; port <= maxPort; port++) {
				if (reservedPorts.has(port)) continue;

				// Tentatively reserve before probing so concurrent calls cannot
				// race each other into choosing the same port.
				reservedPorts.add(port);
				try {
					if (await input.isPortInUse(port)) {
						reservedPorts.delete(port);
						continue;
					}
					return port;
				} catch (error) {
					reservedPorts.delete(port);
					throw error;
				}
			}
			throw new NoAvailablePortError(minPort, maxPort);
		},
		releasePort: (port: number) => {
			reservedPorts.delete(port);
		},
	};
}
