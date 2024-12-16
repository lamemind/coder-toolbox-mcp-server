import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import {ClassLocationSchema} from "./locateJavaClass.js";
import fs from 'fs/promises';
import path from 'path';
import {getJavaRootPath} from "../utils/javaFileSearch.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

export const JavaCodebaseRetrieveSchema = ClassLocationSchema.extend({
    package: z.string().min(1)
        .describe('Java package name from where to scan from java files'),
    scope: z.enum(['all', 'main', 'test'])
        .describe('Scope of the Java files to scan. "all" includes both main and test sources'),
    format: z.enum(['tree', 'complete'])
        .describe('Format of the codebase to retrieve. "tree" returns the codebase as a tree structure, "complete" returns the same tree structure but with the content of each file')
});

export const javaCodebaseRetrieveTool = {
    name: "java_codebase_retrieve",
    description: `Retrieve the codebase of a Java project. It must be filtered by package and scope and must specify the format of the output.`,
    inputSchema: zodToJsonSchema(JavaCodebaseRetrieveSchema) as ToolInput
};

interface TreeEntry {
    name: string;
    type: 'file' | 'directory';
    children?: TreeEntry[];
    path: string;
    content?: string;
    package?: string;
}

async function buildTree(dirPath: string, includeContent: boolean): Promise<TreeEntry[]> {
    const entries = await fs.readdir(dirPath, {withFileTypes: true});
    const tree: TreeEntry[] = [];

    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = path.relative(dirPath, fullPath).replace(/\\/g, '/');

        if (entry.isDirectory()) {
            const children = await buildTree(fullPath, includeContent);
            if (children.length > 0) {
                tree.push({
                    name: entry.name,
                    type: 'directory',
                    path: relativePath,
                    children
                });
            }
        } else if (entry.isFile() && entry.name.endsWith('.java')) {
            const fileEntry: TreeEntry = {
                name: entry.name,
                type: 'file',
                path: relativePath
            };

            if (includeContent) {
                const content = await fs.readFile(fullPath, 'utf-8');
                fileEntry.content = content;

                // Extract package name
                const packageMatch = content.match(/^\s*package\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*;/m);
                if (packageMatch) {
                    fileEntry.package = packageMatch[1];
                }
            }

            tree.push(fileEntry);
        }
    }

    return tree;
}

export async function javaCodebaseRetrieve(
    projectPath: string,
    args: unknown
) {
    const parsed = JavaCodebaseRetrieveSchema.safeParse(args);
    if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments: ${parsed.error}`);
    }

    try {
        let searchPaths = [];

        if (parsed.data.scope === 'all' || parsed.data.scope === 'main') {
            searchPaths.push(getJavaRootPath(projectPath, 'source', parsed.data.package));
        }
        if (parsed.data.scope === 'all' || parsed.data.scope === 'test') {
            searchPaths.push(getJavaRootPath(projectPath, 'test', parsed.data.package));
        }

        const tree: TreeEntry[] = [];

        for (const searchPath of searchPaths) {
            try {
                await fs.access(searchPath);
                const entries = await buildTree(searchPath, parsed.data.format === 'complete');
                tree.push(...entries);
            } catch (err) {
                console.warn(`Path not accessible: ${searchPath}`);
            }
        }

        return {
            content: [{
                type: 'text',
                text: JSON.stringify(tree, null, 2)
            }]
        };

    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError,
            `Failed to add content: ${error instanceof Error ? error.message : String(error)}`);
    }
}
