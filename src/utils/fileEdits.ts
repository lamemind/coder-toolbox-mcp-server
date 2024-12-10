import { createTwoFilesPatch } from 'diff';
import fs from "fs/promises";

/**
 * Normalizes line endings to \n
 */
export function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n/g, '\n');
}

/**
 * Creates a unified diff between original and new content
 */
export function createUnifiedDiff(originalContent: string, newContent: string, filepath: string = 'file'): string {
    const normalizedOriginal = normalizeLineEndings(originalContent);
    const normalizedNew = normalizeLineEndings(newContent);

    return createTwoFilesPatch(
        filepath,
        filepath,
        normalizedOriginal,
        normalizedNew,
        'original',
        'modified'
    );
}

/**
 * Applies edits to a file and returns the diff
 */
export async function applyFileEdits(
    filePath: string,
    edits: Array<{ oldText: string, newText: string }>,
    dryRun = false
): Promise<string> {
    const content = normalizeLineEndings(await fs.readFile(filePath, 'utf-8'));

    let modifiedContent = content;
    for (const edit of edits) {
        const normalizedOld = normalizeLineEndings(edit.oldText);
        const normalizedNew = normalizeLineEndings(edit.newText);

        if (modifiedContent.includes(normalizedOld)) {
            modifiedContent = modifiedContent.replace(normalizedOld, normalizedNew);
            continue;
        }

        const oldLines = normalizedOld.split('\n');
        const contentLines = modifiedContent.split('\n');
        let matchFound = false;

        for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
            const potentialMatch = contentLines.slice(i, i + oldLines.length);

            const isMatch = oldLines.every((oldLine, j) => {
                const contentLine = potentialMatch[j];
                return oldLine.trim() === contentLine.trim();
            });

            if (isMatch) {
                const originalIndent = contentLines[i].match(/^\s*/)?.[0] || '';
                const newLines = normalizedNew.split('\n').map((line, j) => {
                    if (j === 0) return originalIndent + line.trimStart();
                    const oldIndent = oldLines[j]?.match(/^\s*/)?.[0] || '';
                    const newIndent = line.match(/^\s*/)?.[0] || '';
                    if (oldIndent && newIndent) {
                        const relativeIndent = newIndent.length - oldIndent.length;
                        return originalIndent + ' '.repeat(Math.max(0, relativeIndent)) + line.trimStart();
                    }
                    return line;
                });

                contentLines.splice(i, oldLines.length, ...newLines);
                modifiedContent = contentLines.join('\n');
                matchFound = true;
                break;
            }
        }

        if (!matchFound) {
            throw new Error(`Could not find exact match for edit:\n${edit.oldText}`);
        }
    }

    const diff = createUnifiedDiff(content, modifiedContent, filePath);

    let numBackticks = 3;
    while (diff.includes('`'.repeat(numBackticks))) {
        numBackticks++;
    }
    const formattedDiff = `${'`'.repeat(numBackticks)}diff\n${diff}${'`'.repeat(numBackticks)}\n\n`;

    if (!dryRun) {
        await fs.writeFile(filePath, modifiedContent, 'utf-8');
    }

    return formattedDiff;
}
