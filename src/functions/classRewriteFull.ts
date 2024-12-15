import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import {ClassLocationSchema} from "./locateJavaClass.js";
import {getJavaRootPath, searchInDirectory} from "../utils/javaFileSearch.js";

const MAX_FILE_SIZE = 15 * 1024; // 15KB

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Schema definition
export const ClassRewriteFullSchema = ClassLocationSchema.extend({
    content: z.string().min(1)
        .describe('The complete content of the Java class file')
});

// Tool declaration
export const classRewriteFullTool = {
    name: "class_rewrite_full",
    description: "Completely rewrite a Java class file. Use this for small files only (max 5KB). " +
        "The content must match the class name and package declaration with the file location.",
    inputSchema: zodToJsonSchema(ClassRewriteFullSchema) as ToolInput
};

function validateContent(content: string, className: string, packagePath?: string): void {
    // Extract package declaration
    const packageMatch = content.match(/^\s*package\s+([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*;/m);
    if (packagePath) {
        if (!packageMatch) {
            throw new McpError(ErrorCode.InvalidRequest, `Content must include package declaration matching: ${packagePath}`);
        }
        if (packageMatch[1] !== packagePath) {
            throw new McpError(ErrorCode.InvalidRequest,
                `Package declaration (${packageMatch[1]}) must match specified package path (${packagePath})`);
        }
    }

    // Extract class declaration
    const classMatch = content.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!classMatch) {
        throw new McpError(ErrorCode.InvalidRequest, "Content must include a class declaration");
    }
    if (classMatch[1] !== className) {
        throw new McpError(ErrorCode.InvalidRequest,
            `Class name in content (${classMatch[1]}) must match specified class name (${className})`);
    }
}

// Function implementation
export async function rewriteClassFull(
    projectPath: string,
    args: unknown
): Promise<string> {
    const parsed = ClassRewriteFullSchema.safeParse(args);
    if (!parsed.success) {
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments: ${parsed.error}`);
    }

    const {className, sourceType, packagePath, content} = parsed.data;

    if (content.length > MAX_FILE_SIZE) {
        throw new McpError(ErrorCode.InvalidRequest,
            `File content too large: ${content.length} bytes. Maximum allowed: ${MAX_FILE_SIZE} bytes`);
    }

    try {
        validateContent(content, className, packagePath);

        const searchPath = getJavaRootPath(projectPath, sourceType, packagePath);
        const result = await searchInDirectory(searchPath, className, projectPath);

        if (!result.found || !result.filepath) {
            throw new McpError(ErrorCode.InvalidRequest, `Class file not found: ${className}`);
        }

        const fullPath = path.join(projectPath, result.filepath);
        await fs.writeFile(fullPath, content, 'utf-8');

        return `Successfully rewrote ${result.filepath}`;
    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError,
            `Failed to rewrite class: ${error instanceof Error ? error.message : String(error)}`);
    }
}
