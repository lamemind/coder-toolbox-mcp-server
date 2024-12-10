import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import {ClassLocationSchema} from "./locateJavaClass.js";
import {getJavaRootPath, searchInDirectory} from "../utils/javaFileSearch.js";
import {applyFileEdits} from "../utils/fileEdits.js";
import path from "path";
import fs from "fs/promises";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const EditOperation = z.object({
    oldText: z.string().describe('Text to search for - must match exactly'),
    newText: z.string().describe('Text to replace with')
});

// Schema definition
export const ClassRewriteHeaderSchema = ClassLocationSchema.extend({
    edits: z.array(EditOperation),
    dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

// Tool declaration
export const classRewriteHeaderTool = {
    name: "class_rewrite_header",
    description: "Replace portions of a Java class header (everything between package declaration and class declaration). " +
        "Use this to modify imports, annotations, comments, extends or implements clauses.",
    inputSchema: zodToJsonSchema(ClassRewriteHeaderSchema) as ToolInput
};

// Function implementation
export async function rewriteClassHeader(
    projectPath: string,
    args: unknown
) {
    const parsed = ClassRewriteHeaderSchema.safeParse(args);
    if (!parsed.success)
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments for class_rewrite_header: ${parsed.error}`);

    try {
        const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);
        const result = await searchInDirectory(searchPath, parsed.data.className, projectPath);

        if (!result.found || !result.filepath)
            throw new McpError(ErrorCode.InvalidRequest, `Class file not found: ${parsed.data.className}`);

        const fullPath = path.join(projectPath, result.filepath);
        return await applyFileEdits(fullPath, parsed.data.edits, parsed.data.dryRun);
    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, `Failed to rewrite class header: ${error instanceof Error ? error.message : String(error)}`);
    }
}
