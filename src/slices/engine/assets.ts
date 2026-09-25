/**
 * Asset acquisition for the needle3 engine.
 *
 * Three files, ~36 MB, fetched once from Hugging Face and then cached forever.
 * Nothing here runs on the prompt path — `/tiny-boss fetch` warms the cache, and
 * the hook only ever checks that the cache is already populated.
 */

import { mkdir, writeFile, readFile, access, constants, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const HF = "https://huggingface.co/Cactus-Compute/needle3/resolve/main";

export const CACHE_DIR = join(homedir(), ".cache", "pi-tiny-boss", "needle");

export const ASSETS = [
	{ name: "model", url: `${HF}/needle3.cact`, file: "needle3.cact", bytes: 35 * 1024 * 1024 },
	{ name: "wasm", url: `${HF}/wasm/needle.wasm`, file: "needle.wasm", bytes: 1024 * 1024 },
	{ name: "js", url: `${HF}/wasm/needle.js`, file: "needle.js", bytes: 60 * 1024 },
] as const;

export function assetPath(file: string): string {
	return join(CACHE_DIR, file);
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** Which assets are present, and how big they are. */
export interface AssetStatus {
	name: string;
	file: string;
	present: boolean;
	bytes: number;
}

export async function assetStatus(): Promise<AssetStatus[]> {
	const out: AssetStatus[] = [];
	for (const asset of ASSETS) {
		const path = assetPath(asset.file);
		let bytes = 0;
		if (await exists(path)) {
			try {
				bytes = (await stat(path)).size;
			} catch {
				bytes = 0;
			}
		}
		out.push({ name: asset.name, file: asset.file, present: bytes > 0, bytes });
	}
	return out;
}

/** True only when every asset is on disk. A half-download is not a cache hit. */
export async function assetsReady(): Promise<boolean> {
	const status = await assetStatus();
	return status.every((a) => a.present);
}

/** Stream one URL to disk, reporting progress as a 0..1 fraction. */
export async function downloadAsset(
	url: string,
	dest: string,
	onProgress?: (fraction: number) => void,
): Promise<number> {
	await mkdir(dirname(dest), { recursive: true });
	const res = await fetch(url);
	if (!res.ok || !res.body) {
		throw new Error(`download failed: ${res.status} ${res.statusText} for ${url}`);
	}
	const total = Number(res.headers.get("content-length") ?? "0");
	const chunks: Uint8Array[] = [];
	let received = 0;
	const reader = res.body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.length;
		if (total > 0) onProgress?.(received / total);
	}
	const buffer = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		buffer.set(chunk, offset);
		offset += chunk.length;
	}
	await writeFile(dest, buffer);
	return received;
}

/** Read the model bytes. Kept separate so the loader can stream-hash later. */
export async function readModelBytes(): Promise<Uint8Array> {
	return new Uint8Array(await readFile(assetPath("needle3.cact")));
}
