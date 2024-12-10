import path from 'path';
import fs from 'fs/promises';

export interface FileSearchResult {
    found: boolean;
    filepath?: string;
    content?: string;
}

/**
 * Recursively searches for a Java file in a directory
 */
export async function searchInDirectory(dirPath: string, className: string, projectPath: string): Promise<FileSearchResult> {
    try {
        const entries = await fs.readdir(dirPath, {withFileTypes: true});

        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                const result = await searchInDirectory(fullPath, className, projectPath);
                if (result.found)
                    return result;
            } else if (entry.isFile()) {
                const expectedFileName = `${className}.java`;
                if (entry.name === expectedFileName) {
                    const content = await fs.readFile(fullPath, 'utf-8');
                    const relativePath = path.relative(projectPath, fullPath);
                    return {
                        found: true,
                        filepath: relativePath.replace(/\\/g, '/'),
                        content
                    };
                }
            }
        }
    } catch (error) {
        console.error(`Error searching directory ${dirPath}:`, error);
    }
    return {found: false, filepath: dirPath};
}

/**
 * Gets the root path for Java source or test files
 */
export function getJavaRootPath(projectPath: string, sourceType: string | undefined, packagePath?: string): string {
    let searchPath;
    if (sourceType === 'test')
        searchPath = path.join(projectPath, 'src', 'test', 'java');
    else if (sourceType === 'source')
        searchPath = path.join(projectPath, 'src', 'main', 'java');
    else
        searchPath = path.join(projectPath, 'src');

    if (packagePath) {
        if (!sourceType)
            throw new Error('Cannot specify package path without source type');
        searchPath = path.join(searchPath, ...packagePath.split('.'));
    }

    return searchPath;
}
