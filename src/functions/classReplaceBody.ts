import {z} from "zod";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ErrorCode, McpError, ToolSchema} from "@modelcontextprotocol/sdk/types.js";
import {ClassLocationSchema} from "./locateJavaClass.js";
import {getJavaRootPath, searchInDirectory} from "../utils/javaFileSearch.js";
import {applyFileEdits} from "../utils/fileEdits.js";

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

const EditOperation = z.object({
    oldText: z.string().describe('Text to search for - must match exactly'),
    newText: z.string().describe('Text to replace with')
});

// Schema definition
export const ClassReplaceBodySchema = ClassLocationSchema.extend({
    edits: z.array(EditOperation),
    dryRun: z.boolean().default(false).describe('Preview changes using git-style diff format')
});

// Tool declaration
export const classReplaceBodyTool = {
    name: "class_replace_body",
    description: "Replace the a portion of the existing Java class body with new content",
    inputSchema: zodToJsonSchema(ClassReplaceBodySchema) as ToolInput
};

// Function implementation
export async function replaceClassBody(
    projectPath: string,
    args: unknown
) {
    const parsed = ClassReplaceBodySchema.safeParse(args);
    if (!parsed.success)
        throw new McpError(ErrorCode.InvalidRequest, `Invalid arguments for class_replace_body: ${parsed.error}`);

    try {
        const searchPath = getJavaRootPath(projectPath, parsed.data.sourceType, parsed.data.packagePath);
        const result = await searchInDirectory(searchPath, parsed.data.className, projectPath);

        if (!result.found || !result.filepath)
            throw new McpError(ErrorCode.InvalidRequest, `Class file not found: ${parsed.data.className}`);

        return await applyFileEdits(result.filepath, parsed.data.edits, parsed.data.dryRun);
    } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(ErrorCode.InternalError, `Failed to replace class body: ${error instanceof Error ? error.message : String(error)}`);
    }
}
