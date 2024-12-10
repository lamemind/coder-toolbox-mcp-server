import path from 'path';
import * as os from "node:os";

/**
 * Normalizes a path to a consistent format
 */
export function normalizePath(p: string): string {
    return path.normalize(p).toLowerCase();
}

/**
 * Expands the tilde (~) in a filepath to the user's home directory
 */
export function expandHome(filepath: string): string {
    if (filepath.startsWith('~/') || filepath === '~') {
        return path.join(os.homedir(), filepath.slice(1));
    }
    return filepath;
}
